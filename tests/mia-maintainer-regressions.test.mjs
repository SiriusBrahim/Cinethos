/**
 * MIA — Bakımcı düzeltmeleri için regresyon testleri (plan 2.3).
 *
 * Kapsam (docs/mia/faz1-faz2-uygulama-plani.md 2.3):
 *  1. Allowlist derinlik sınırı: depth > 6 alt ağacı düşer; ham nesne / kişisel
 *     alanlar sanitize çıktısına sızmaz.
 *  2. Opak event kimliği: diffLibraryEvents eventId'leri profileId, mediaKey
 *     veya favori oyuncu ID içermez (UUID biçimi).
 *  3. Eski kimlik migration'ı: lib-% event_id/trigger_event_id açılışta
 *     anonimleştirilir; dedupe satırları korunur.
 *  4. Queue payload yarışı: processing sırasında yeni metadata gelirse eski
 *     worker'ın snapshot'u completed/failed işaretleyemez; iş pending'e döner.
 *  5. Worker snapshot koruması: completion/retry/failure yalnızca beklenen
 *     updated_at sürümünü günceller.
 *  6. Duplicate claim: ikinci claim çalışan işi yanlışlıkla tamamlamaz.
 *  7. EventBus hata yayılımı: bir abone hata verse de diğer aboneler çalışır;
 *     hata AggregateError olarak publish çağrısına bildirilir.
 *  8. ProfileContext senkronizasyonu: açılış ve ana veri kaydı sonrası profil +
 *     revision bağlamı güncel kalır.
 *  9. Partial indexing: reddedilen kayıt varsa durum completed değil partial'dır.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { sanitizeRawContentInput } from '../src/modules/content/content-metadata-processor.ts';
import { diffLibraryEvents } from '../src/server/library-event-diff.ts';
import { createAppEvent, createAppEventBus } from '../src/app/app-event-bus.ts';
import { createContentIntelligenceRepository } from '../src/server/content-intelligence-repository.ts';
import { createContentProcessingCoordinator } from '../src/server/content-processing-coordinator.ts';
import { createCineTrackApp } from '../src/server/app.ts';

function makeTempDir(prefix = 'cinethos-maint-regress-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeSavedItem(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    overview: `Film ${id} özeti.`,
    genre_ids: [18],
    genres: [{ id: 18, name: 'Drama' }],
    keywords: [{ id: 1, name: 'drama' }],
    status: 'completed',
    personal_rating: 9,
    ...overrides,
  };
}

function makeDoc(profiles) {
  return {
    version: 3,
    schemaVersion: 3,
    revision: 0,
    activeProfileId: profiles[0]?.id ?? 'default',
    profiles,
  };
}

// ---------------------------------------------------------------------------
// 1. Allowlist derinlik sınırı
// ---------------------------------------------------------------------------
test('2.3.1 Allowlist derinlik sınırı: depth > 6 alt ağacı düşer, ham nesne ve kişisel alan sızmaz', () => {
  // 10 seviye derin gömülü ham nesne; en derin noktada kişisel sır var.
  const deep = { v: 'gizli-derin-sir' };
  for (let i = 0; i < 10; i += 1) deep.child = { v: `seviye-${i}`, secret: deep };

  const raw = {
    id: 550,
    media_type: 'movie',
    title: 'Fight Club',
    overview: 'Özet.',
    genre_ids: [18],
    keywords: [{ id: 1, name: 'drama' }],
    personal_rating: 9,
    notes: 'Çok kişisel not',
    my_private_field: 'kullanici-sirri',
    deep,
  };

  const { sanitized, strippedPersonalFields, strippedUnknownFields } =
    sanitizeRawContentInput(raw);

  const sanitizedJson = JSON.stringify(sanitized);

  // Derin alt ağaçtan hiçbir değer çıktıya sızmamalı.
  assert.ok(!sanitizedJson.includes('gizli-derin-sir'), 'derin sır sanitize çıktısına sızmamalı');
  assert.ok(!sanitizedJson.includes('seviye-9'), 'derin alt ağaç çıktıya sızmamalı');
  assert.ok(!sanitizedJson.includes('kullanici-sirri'), 'bilinmeyen alan sızmamalı');

  // Kişisel alanlar sanitize edilmiş nesnede YOK.
  assert.equal(sanitized.personal_rating, undefined);
  assert.equal(sanitized.notes, undefined);
  assert.equal(sanitized.my_private_field, undefined);
  assert.equal(sanitized.deep, undefined);

  // Kişisel/bilinmeyen alanlar raporlanmış olmalı (sessiz düşüş yok).
  assert.ok(strippedPersonalFields.includes('personal_rating'));
  assert.ok(strippedPersonalFields.includes('notes'));
  assert.ok(strippedUnknownFields.includes('my_private_field'));

  // Yüzeysel lisanslı ortak alanlar korunmalı.
  assert.equal(sanitized.title, 'Fight Club');
  assert.deepEqual(sanitized.genre_ids, [18]);
});

// ---------------------------------------------------------------------------
// 2. Opak event kimliği (deterministik — 200 tekrar)
// ---------------------------------------------------------------------------
// Not: Rastgele bir UUID ~%1,4 ihtimalle '777'/'888' gibi saf rakam dizileri
// içerir; bu yüzden saf rakamsal ID'ler alt-dizge olarak DEĞİL, yalnızca
// eşitlik ile denetlenir. Alt-dizge denetimi yalnızca hex dışı karakter
// içeren tanımlayıcılara (deterministik olarak asla UUID'de bulunamayan)
// uygulanır. Opaklığın asıl garantisi UUID biçim doğrulamasıdır.
test('2.3.2 Opak event kimliği (200 tekrar): eventId UUID biçiminde ve kimlik sızdırmaz', () => {
  const ITERATIONS = 200;
  const ACTOR_IDS = ['777', '888'];
  const seenEventIds = new Set();

  for (let i = 0; i < ITERATIONS; i += 1) {
    const before = makeDoc([
      {
        id: 'profile-secret-42',
        name: 'Gizli Profil',
        items: [makeSavedItem(550, { personal_rating: 7 })],
        favoriteActors: [{ id: 777, name: 'Aranan Oyuncu' }],
      },
    ]);
    const after = makeDoc([
      {
        id: 'profile-secret-42',
        name: 'Gizli Profil',
        items: [makeSavedItem(550, { personal_rating: 9 }), makeSavedItem(27205)],
        favoriteActors: [{ id: 777, name: 'Aranan Oyuncu' }, { id: 888, name: 'Yeni Oyuncu' }],
      },
    ]);

    const events = diffLibraryEvents(before, after);
    assert.ok(events.length >= 3, `tekrar ${i}: en az üç olay türetilmeli`);

    for (const ev of events) {
      const id = String(ev.eventId ?? '');

      // (a) Opaklık garantisi: her eventId kriptografik UUID biçiminde olmalı.
      assert.match(id, UUID_RE, `tekrar ${i}: eventId opak UUID olmalı: ${id}`);

      // (b) Gerçek sızıntı senaryosu 1 — profileId: 'p','o','l','s','t','r'
      //     hex dışı harfler içerir; bu alt-dizge bir UUID'de asla bulunamaz.
      assert.ok(
        !id.includes('profile-secret-42'),
        `tekrar ${i}: eventId profileId taşıyamaz: ${id}`
      );

      // (c) Gerçek sızıntı senaryosu 2 — mediaKey: ':' hex dışıdır; 'movie'
      //     'm','o','v' hex dışı harfler içerir; alt-dizge denetimi deterministiktir.
      assert.ok(!id.includes('movie:550'), `tekrar ${i}: eventId mediaKey taşıyamaz: ${id}`);
      assert.ok(!id.includes('movie-550'), `tekrar ${i}: eventId mediaKey taşıyamaz: ${id}`);

      // (d) Saf rakamsal oyuncu ID'leri: yalnızca eşitlik denetimi (alt-dizge
      //     değil) — rastgele UUID'de rakam dizisi bulunması sızıntı değildir.
      for (const actorId of ACTOR_IDS) {
        assert.notEqual(id, actorId, `tekrar ${i}: eventId doğrudan oyuncu ID olamaz`);
      }

      seenEventIds.add(id);
    }
  }

  // 200 tekrarda tek bir çakışan ID bile üretilememeli (rastgelelik kalitesi).
  assert.equal(seenEventIds.size, ITERATIONS * 3, 'her eventId benzersiz olmalı');

  // (e) Dedektör öz-denetimi: deterministik/kimlik taşıyan bir ID biçimi
  //     UUID doğrulamasına takılmalıdır — testin sızıntıyı gerçekten yakaladığını
  //     kanıtlar.
  assert.equal(UUID_RE.test('lib-profile-secret-42-movie-550'), false);
  assert.equal(UUID_RE.test('movie:550'), false);
  assert.equal(UUID_RE.test('777'), false);
});

// ---------------------------------------------------------------------------
// 3. Eski kimlik migration'ı
// ---------------------------------------------------------------------------
test('2.3.3 Eski kimlik migration: lib-% ID açılışta anonimleşir, dedupe satırları korunur', async () => {
  const tmpDir = await makeTempDir();
  try {
    // Şemayı ilk repository ile oluştur ve kapat.
    const first = createContentIntelligenceRepository({ dataDir: tmpDir });
    first.ensureInitialized();
    first.close();

    // Eski sürümden kalma profile-bearing kayıtları doğrudan yaz.
    const db = new DatabaseSync(path.join(tmpDir, 'cinetrack.db'));
    db.prepare(
      `INSERT INTO content_processed_events (event_id, event_type, media_key, processed_at)
       VALUES (?, ?, ?, ?)`
    ).run('lib-profile-a-movie-550', 'LibraryItemAdded', 'movie:550', new Date().toISOString());
    db.prepare(
      `INSERT INTO content_processed_events (event_id, event_type, media_key, processed_at)
       VALUES (?, ?, ?, ?)`
    ).run('evt-opaque-ok', 'LibraryRatingChanged', 'movie:27205', new Date().toISOString());
    db.prepare(
      `INSERT INTO content_processing_queue (
         media_key, media_type, tmdb_id, source_revision, payload_json,
         trigger_event_id, status, attempts, max_attempts, next_retry_at,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, ?, 'pending', 0, 3, NULL, NULL, ?, ?)`
    ).run(
      'movie:550',
      'movie',
      550,
      'lib-profile-a-evt-9',
      new Date().toISOString(),
      new Date().toISOString()
    );
    db.close();

    // İkinci açılış migration'ı çalıştırır.
    const second = createContentIntelligenceRepository({ dataDir: tmpDir });
    second.ensureInitialized();

    const raw = new DatabaseSync(path.join(tmpDir, 'cinetrack.db'));
    const libPrefixEvents = raw
      .prepare(`SELECT COUNT(*) AS c FROM content_processed_events WHERE event_id LIKE 'lib-%'`)
      .get();
    const totalEvents = raw.prepare(`SELECT COUNT(*) AS c FROM content_processed_events`).get();
    const legacyEvents = raw
      .prepare(`SELECT COUNT(*) AS c FROM content_processed_events WHERE event_id LIKE 'legacy-%'`)
      .get();
    const libPrefixTriggers = raw
      .prepare(
        `SELECT COUNT(*) AS c FROM content_processing_queue WHERE trigger_event_id LIKE 'lib-%'`
      )
      .get();
    const legacyTriggers = raw
      .prepare(
        `SELECT COUNT(*) AS c FROM content_processing_queue WHERE trigger_event_id LIKE 'legacy-%'`
      )
      .get();
    raw.close();

    assert.equal(Number(libPrefixEvents?.c ?? 0), 0, 'lib- önekli event_id kalmamalı');
    assert.equal(Number(totalEvents?.c ?? 0), 2, 'dedupe satırları korunmalı (silinmemeli)');
    assert.equal(Number(legacyEvents?.c ?? 0), 1, 'eski kayıt legacy- ile anonimleşmeli');
    assert.equal(Number(libPrefixTriggers?.c ?? 0), 0, 'lib- önekli trigger_event_id kalmamalı');
    assert.equal(Number(legacyTriggers?.c ?? 0), 1, 'queue trigger legacy- ile anonimleşmeli');

    // Mevcut opak kayıt dedupe olarak hâlâ çalışmalı.
    assert.equal(second.hasProcessedEvent('evt-opaque-ok'), true);
    second.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4 + 5. Queue payload yarışı ve worker snapshot koruması (repository düzeyi)
// ---------------------------------------------------------------------------
test('2.3.4 Queue payload yarışı: processing sırasında yeni metadata gelirse eski snapshot completed işaretleyemez', async () => {
  const tmpDir = await makeTempDir();
  try {
    const repository = createContentIntelligenceRepository({ dataDir: tmpDir });

    repository.enqueueJob({
      mediaKey: 'movie:550',
      mediaType: 'movie',
      tmdbId: 550,
      payload: { id: 550, media_type: 'movie', title: 'Eski Başlık' },
    });

    const claimed = repository.claimNextJobs(1);
    assert.equal(claimed.length, 1);
    const snapshotUpdatedAt = claimed[0].updated_at;
    assert.equal(claimed[0].status, 'processing');

    // Worker çalışırken aynı mediaKey için yeni metadata geliyor:
    // enqueueJob satırı günceller (yeni payload + daha ileri updated_at),
    // ancak çalışan işin snapshot'ını değiştirmez.
    const merge = repository.enqueueJob({
      mediaKey: 'movie:550',
      mediaType: 'movie',
      tmdbId: 550,
      payload: { id: 550, media_type: 'movie', title: 'Yeni Başlık' },
    });
    assert.equal(merge.enqueued, false);
    assert.equal(merge.status, 'processing');

    // Eski snapshot updated_at ile tamamlanmaya çalışılıyor → kabul EDİLMEMELİ.
    repository.markJobCompleted('movie:550', snapshotUpdatedAt);

    // İş completed DEĞİL; yeni payload ile pending'e dönmeli (attempts=0).
    assert.equal(repository.getQueueStats().completed, 0);
    const reclaimed = repository.claimNextJobs(1);
    assert.equal(reclaimed.length, 1, 'iş pending beklemeli');
    assert.equal(reclaimed[0].attempts, 1, 'pending dönüşünde attempts sıfırlanmış olmalı');
    assert.ok(
      (reclaimed[0].payload_json ?? '').includes('Yeni Başlık') &&
        !(reclaimed[0].payload_json ?? '').includes('Eski Başlık'),
      'kuyruk satırı güncel payload taşımalı'
    );

    // Güncel snapshot ile tamamlama artık kabul edilir.
    repository.markJobCompleted('movie:550', reclaimed[0].updated_at);
    assert.equal(repository.getQueueStats().completed, 1);
    assert.equal(repository.getQueueStats().pending, 0);

    repository.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('2.3.5 Worker snapshot koruması: completion/retry/failure yalnızca beklenen updated_at sürümünü günceller', async () => {
  const tmpDir = await makeTempDir();
  try {
    const repository = createContentIntelligenceRepository({ dataDir: tmpDir });
    const stale = '2000-01-01T00:00:00.000Z';

    // --- Completion koruması ---
    repository.enqueueJob({ mediaKey: 'movie:1', mediaType: 'movie', tmdbId: 1 });
    const c1 = repository.claimNextJobs(1);
    assert.equal(c1.length, 1);
    repository.markJobCompleted('movie:1', stale); // bayat snapshot → reddedilir
    assert.equal(repository.getQueueStats().completed, 0);
    const c2 = repository.claimNextJobs(1); // pending'e döndü
    assert.equal(c2.length, 1);
    repository.markJobCompleted('movie:1', c2[0].updated_at); // güncel snapshot → kabul
    assert.equal(repository.getQueueStats().completed, 1);

    // --- Retry koruması ---
    repository.enqueueJob({ mediaKey: 'movie:2', mediaType: 'movie', tmdbId: 2 });
    const r1 = repository.claimNextJobs(1);
    assert.equal(r1.length, 1);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    repository.scheduleJobRetry('movie:2', future, 'geçici hata', stale); // bayat → reddedilir
    // Bayat retry kabul edilmediği için iş pending'de ve retry planlanmadı:
    const r2 = repository.claimNextJobs(1);
    assert.equal(r2.length, 1, 'bayat retry sonrası iş hemen claim edilebilir olmalı');
    repository.scheduleJobRetry('movie:2', future, 'geçici hata', r2[0].updated_at); // güncel → kabul
    assert.equal(
      repository.claimNextJobs(1).length,
      0,
      'retry planlanan iş future next_retry_at ile claim edilememeli'
    );

    // --- Failure koruması ---
    repository.enqueueJob({ mediaKey: 'movie:3', mediaType: 'movie', tmdbId: 3 });
    const f1 = repository.claimNextJobs(1);
    assert.equal(f1.length, 1);
    repository.markJobFailed('movie:3', 'kalıcı hata', stale); // bayat → reddedilir
    assert.equal(repository.getQueueStats().failed, 0);
    const f2 = repository.claimNextJobs(1);
    assert.equal(f2.length, 1);
    repository.markJobFailed('movie:3', 'kalıcı hata', f2[0].updated_at); // güncel → kabul
    assert.equal(repository.getQueueStats().failed, 1);

    repository.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. Duplicate claim (queue düzeyi, gerçek worker akışı)
// ---------------------------------------------------------------------------
test('2.3.6 Duplicate claim: ikinci claim çalışan işi yanlışlıkla tamamlanmış işaretlemez', async () => {
  const tmpDir = await makeTempDir();
  try {
    let releaseFetcher;
    const gate = new Promise((resolve) => {
      releaseFetcher = resolve;
    });

    const coordinator = createContentProcessingCoordinator({
      dataDir: tmpDir,
      concurrency: 4,
      customFetcher: async () => {
        await gate;
        return {
          id: 550,
          media_type: 'movie',
          title: 'Fight Club',
          overview: 'Özet.',
          genre_ids: [18],
          keywords: [{ id: 1, name: 'drama' }],
        };
      },
    });
    coordinator.repository.ensureInitialized();

    // Yetersiz payload (başlık yok) → worker customFetcher'da bekleyecek.
    coordinator.queue.enqueue({
      mediaKey: 'movie:550',
      mediaType: 'movie',
      tmdbId: 550,
      payload: { id: 550, media_type: 'movie' },
    });

    const firstPump = coordinator.queue.pumpOnce();
    // İlk worker fetcher'da beklerken ikinci pump: claim edecek iş yok
    // (status=processing) → duplicate claim çalışanın işini bozmamalı.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await coordinator.queue.pumpOnce();
    assert.equal(coordinator.repository.getQueueStats().processing, 1);
    assert.equal(coordinator.repository.getQueueStats().completed, 0);

    releaseFetcher();
    await firstPump;

    const stats = coordinator.repository.getQueueStats();
    assert.equal(stats.completed, 1, 'iş tam olarak bir kez tamamlanmalı');
    assert.equal(stats.processing, 0);

    coordinator.repository.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. EventBus hata yayılımı
// ---------------------------------------------------------------------------
test('2.3.7 EventBus hata yayılımı: abone hatası diğerlerini durdurmaz, AggregateError publish çağrısına döner', async () => {
  const bus = createAppEventBus();
  const seen = [];

  bus.subscribe('LibraryRatingChanged', async () => {
    seen.push('birinci');
  });
  bus.subscribe('LibraryRatingChanged', async () => {
    seen.push('ikinci');
    throw new Error('abone-2-patladi');
  });
  bus.subscribe('LibraryRatingChanged', async () => {
    seen.push('üçüncü');
  });

  const event = createAppEvent({
    eventType: 'LibraryRatingChanged',
    ref: { profileId: 'profile-a', revision: 1 },
    entityId: 'movie:550',
    payload: { mediaKey: 'movie:550', rating: 9 },
  });

  await assert.rejects(
    () => bus.publish(event),
    (err) => {
      assert.ok(err instanceof AggregateError, 'hata AggregateError olmalı');
      assert.ok(
        String(err.message).includes('LibraryRatingChanged'),
        'hata mesajı olay tipini içermeli'
      );
      assert.ok(
        err.errors.some((e) => String(e?.message ?? e).includes('abone-2-patladi')),
        'alt hata korunmalı'
      );
      return true;
    }
  );

  assert.deepEqual(seen.sort(), ['birinci', 'ikinci', 'üçüncü'], 'tüm aboneler çalışmalı');
});

// ---------------------------------------------------------------------------
// 8. ProfileContext senkronizasyonu (açılış + ana veri kaydı)
// ---------------------------------------------------------------------------
test('2.3.8 ProfileContext senkronizasyonu: açılış ve PUT /api/data sonrası profil + revision güncel', async () => {
  const tmpDir = await makeTempDir();
  const runtime = createCineTrackApp({ dataDir: tmpDir });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // --- Açılış senkronizasyonu: birincil depoya belge yaz → modüller başlat ---
    const doc = makeDoc([
      {
        id: 'PROFILE-STARTUP',
        name: 'Açılış Profili',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [],
      },
    ]);
    doc.revision = 7;
    const seed = await runtime.primaryRepository.saveRaw(doc, { forceOverwrite: true });
    assert.equal(seed.ok, true);
    const seededRevision = seed.document?.revision ?? 7;

    await runtime.startRuntimeModules();

    let current = runtime.profileContext.getCurrent();
    assert.equal(current.profileId, 'PROFILE-STARTUP', 'açılışta profil bağlamı senkron olmalı');
    assert.equal(current.revision, seededRevision, 'açılışta revision senkron olmalı');

    // --- Ana veri kaydı senkronizasyonu: yeni aktif profil + yeni revision ---
    const doc2 = makeDoc([
      {
        id: 'PROFILE-STARTUP',
        name: 'Açılış Profili',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [],
      },
      {
        id: 'PROFILE-SWITCHED',
        name: 'Yeni Profil',
        createdAt: '2026-01-02T00:00:00.000Z',
        items: [makeSavedItem(550)],
      },
    ]);
    doc2.activeProfileId = 'PROFILE-SWITCHED';
    doc2.revision = seededRevision + 1;

    const putRes = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"rev-${seededRevision}"`,
        'x-cinetrack-profile-id': 'PROFILE-SWITCHED',
      },
      body: JSON.stringify(doc2),
    });
    const putRaw = await putRes.text();
    assert.equal(putRes.status, 200, `PUT /api/data başarılı olmalı: ${putRaw}`);
    const putBody = JSON.parse(putRaw);

    current = runtime.profileContext.getCurrent();
    assert.equal(current.profileId, 'PROFILE-SWITCHED', 'kayıt sonrası profil bağlamı güncel');
    assert.equal(
      current.revision,
      putBody?.revision ?? doc2.revision,
      'kayıt sonrası revision bağlamı güncel'
    );

    // Depodaki gerçek revision ile bağlam aynı sürümde olmalı.
    const raw = await runtime.primaryRepository.readRaw();
    assert.equal(current.revision, raw.revision);

    await runtime.stopRuntimeModules();
  } finally {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Partial indexing
// ---------------------------------------------------------------------------
test('2.3.9 Partial indexing: reddedilen kayıt varsa durum completed değil partial olur', async () => {
  const tmpDir = await makeTempDir();
  try {
    const coordinator = createContentProcessingCoordinator({ dataDir: tmpDir });
    coordinator.repository.ensureInitialized();

    const doc = makeDoc([
      {
        id: 'profile-a',
        name: 'A',
        items: [makeSavedItem(550), makeSavedItem(27205)],
      },
    ]);

    // Tüm kayıtlar kabul edilirse durum completed olmalı.
    const okStats = await coordinator.runInitialIndexing(doc, { pageSize: 25 });
    assert.equal(okStats.status, 'completed');
    assert.equal(okStats.rejected, 0);
    assert.equal(okStats.queued, 2);

    // Reddetme senaryosu: bir kayıt kuyruğa alınamıyor (kota/disk hatası simülasyonu).
    const originalEnqueueBatch = coordinator.queue.enqueueBatch.bind(coordinator.queue);
    coordinator.queue.enqueueBatch = async (items, options) => {
      const result = await originalEnqueueBatch(items, options);
      return { ...result, rejected: result.rejected + 1 };
    };

    const partialStats = await coordinator.runInitialIndexing(doc, { pageSize: 25 });
    assert.equal(partialStats.status, 'partial', 'reddedilen kayıt varsa durum partial olmalı');
    assert.notEqual(partialStats.status, 'completed');
    assert.ok(partialStats.rejected > 0);
    assert.ok(partialStats.lastError, 'kısmi indeksleme hatası raporlanmalı');

    // Kalıcı istatistik partial durumunu korumalı (sağlık API'si aynı kaynağı okur).
    const persistedStats = coordinator.getInitialIndexStats();
    assert.equal(persistedStats.status, 'partial');
    assert.equal(persistedStats.rejected, partialStats.rejected);

    coordinator.repository.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
