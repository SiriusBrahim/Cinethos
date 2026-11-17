/**
 * MIA Faz 3 — Library Manager (`ILibraryService`) bağımsız denetim testleri.
 *
 * Kapsam (görev §2-A ve §2-D):
 *  - Film ekleme (watched/watching/watchlist), durum değiştirme, puanlama.
 *  - Aynı içeriğin iki kez eklenmesinin engellenmesi (duplicate add).
 *  - Geçersiz medya anahtarı ve `not-interested` reddi.
 *  - Metadata kanal allowlist'i: kişisel alanlar metadata'dan yazılamaz.
 *  - TMDB puanı (`vote_average`) kullanıcı puanına yazılamaz.
 *  - İzleme ilerlemesi (progress) kullanıcı verisi olarak yazılır.
 *  - Silme: yalnızca kullanıcı kaydı + tombstone; tekrar ekleme tombstone'u temizler.
 *  - Profil izolasyonu: profil A yazımı profil B'yi etkilemez; profil değişince
 *    eski profil referansıyla yazım reddedilir (profile-switched).
 *  - Stale revision reddi (retryable: false).
 *  - EventBus entegrasyonu: LibraryItemAdded / LibraryRatingChanged / LibraryStatusChanged
 *    gerçek AppEventBus üzerinden yayımlanır; payload kişisel veri içermez.
 *  - Olay yayımı başarısızsa: kayıt kalıcıdır, sonuç `ok:false, retryable:true`
 *    (sessiz yutma yoktur — ARCHITECTURE.md §5.3 sözleşmesi).
 *
 * Bu testler YALNIZCA test/CI ajanına aittir; uygulama kodunu değiştirmez.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCineTrackApp } from '../src/server/app.ts';
import { createLibraryService } from '../src/modules/library/service.ts';

function makeTempDir(prefix = 'cinethos-faz3-library-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

function makeProfile(id, name, items = []) {
  return {
    id,
    name,
    createdAt: '2026-01-01T00:00:00.000Z',
    items,
  };
}

/**
 * Gerçek uygulama fabrikası ile izole runtime kurar: geçici dizin + iki profil.
 * LibraryService, gerçek ServerPrimaryDataRepository + ProfileContext +
 * AppEventBus üzerinde çalışır (mock repository YOK).
 */
async function makeRuntime() {
  const tmpDir = await makeTempDir();
  const runtime = createCineTrackApp({ dataDir: tmpDir });
  const doc = makeDoc([
    makeProfile('profile-a', 'Profil A'),
    makeProfile('profile-b', 'Profil B'),
  ]);
  const seed = await runtime.primaryRepository.saveRaw(doc, { forceOverwrite: true });
  assert.equal(seed.ok, true, `tohum belge yazılamadı: ${JSON.stringify(seed)}`);
  const revision = seed.document?.revision ?? 0;
  await runtime.startRuntimeModules();
  return { tmpDir, runtime, revision };
}

async function closeRuntime(tmpDir, runtime, server) {
  if (server) server.close();
  try {
    await runtime.stopRuntimeModules();
  } catch {
    /* zaten durdurulmuş olabilir */
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
}

function ref(runtime, profileId) {
  return { profileId, revision: runtime.profileContext.getCurrent().revision };
}

const INTERSTELLAR = {
  metadata: {
    title: 'Interstellar',
    original_title: 'Interstellar',
    overview: 'Bir grup kâşif solucan deliğinden geçer.',
    poster_path: '/interstellar.jpg',
    genre_ids: [12, 18, 878],
    vote_average: 8.4,
    vote_count: 32000,
    release_date: '2014-11-05',
    original_language: 'en',
  },
};

// ---------------------------------------------------------------------------
// A1. Ekleme: watched + puan
// ---------------------------------------------------------------------------
test('F3-A1 addItem: watched + puan 9 → kayıt completed, ratedAt set, revision ve ProfileContext güncel', async () => {
  const { tmpDir, runtime, revision } = await makeRuntime();
  try {
    const outcome = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
      metadata: INTERSTELLAR.metadata,
    });
    assert.equal(outcome.ok, true, `addItem başarısız: ${JSON.stringify(outcome)}`);

    const raw = await runtime.primaryRepository.readRaw();
    const profile = raw.document.profiles.find((p) => p.id === 'profile-a');
    assert.equal(profile.items.length, 1, 'tam bir kayıt eklenmeli');
    const item = profile.items[0];
    assert.equal(item.id, 157336);
    assert.equal(item.media_type, 'movie');
    assert.equal(item.status, 'completed');
    assert.equal(item.personal_rating, 9, 'kullanıcı puanı kayda yazılmalı');
    assert.ok(item.ratedAt, 'ratedAt yeni puanda set edilmeli');
    assert.ok(item.completedAt, 'completed durumuna geçişte completedAt set edilmeli');
    assert.equal(item.title, 'Interstellar', 'metadata içerik alanları kopyalanmalı');
    assert.equal(item.vote_average, 8.4);

    assert.equal(
      runtime.profileContext.getCurrent().revision,
      raw.revision,
      'ProfileContext revision yazım sonrası senkron olmalı'
    );
    assert.ok(raw.revision > revision, 'revision artmalı');
    assert.equal(raw.document.profiles.find((p) => p.id === 'profile-b').items.length, 0);
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// A2. Çift ekleme engeli
// ---------------------------------------------------------------------------
test('F3-A2 duplicate add: aynı mediaKey ikinci kez eklendiğinde kayıt çoğalmaz, güncellenir', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const first = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watchlist',
      metadata: INTERSTELLAR.metadata,
    });
    assert.equal(first.ok, true);

    const second = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 8,
      metadata: INTERSTELLAR.metadata,
    });
    assert.equal(second.ok, true, `ikinci ekleme başarısız: ${JSON.stringify(second)}`);

    const raw = await runtime.primaryRepository.readRaw();
    const profile = raw.document.profiles.find((p) => p.id === 'profile-a');
    assert.equal(profile.items.length, 1, 'aynı içerik iki kez listeye girmemeli');
    assert.equal(profile.items[0].status, 'completed', 'ikinci ekleme durumu güncellemeli');
    assert.equal(profile.items[0].personal_rating, 8);
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// A3. Geçersiz girdiler
// ---------------------------------------------------------------------------
test('F3-A3 geçersiz medya anahtarı ve not-interested reddedilir; belge değişmez', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const before = await runtime.primaryRepository.readRaw();

    for (const mediaKey of ['550', 'movie:abc', 'book:550', 'movie:', '']) {
      const outcome = await runtime.libraryService.addItem({
        ref: ref(runtime, 'profile-a'),
        mediaKey,
        mediaType: 'movie',
        list: 'watchlist',
      });
      assert.equal(outcome.ok, false, `geçersiz anahtar reddedilmeli: "${mediaKey}"`);
      assert.ok(outcome.error, 'reddedilen işlemde açıklama olmalı');
    }

    const notInterested = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:550',
      mediaType: 'movie',
      list: 'not-interested',
    });
    assert.equal(notInterested.ok, false, '"not-interested" kütüphane durumu olmamalı');
    assert.ok(notInterested.retryable === false, 'geçersiz liste kalıcı hata olmalı');

    const after = await runtime.primaryRepository.readRaw();
    assert.equal(
      after.revision,
      before.revision,
      'reddedilen işlemler revision artırmamalı'
    );
    assert.equal(
      after.document.profiles.find((p) => p.id === 'profile-a').items.length,
      0,
      'reddedilen işlemler kayıt eklememeli'
    );
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// C. Metadata kanalı allowlist'i (kişisel alan sızması)
// ---------------------------------------------------------------------------
test('F3-C1 metadata kanalı: kişisel alanlar (status/puan/not/ilerleme/profil) kayda sızmaz', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const outcome = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
      metadata: {
        ...INTERSTELLAR.metadata,
        // Kişisel alanlar metadata kanalından enjekte edilmeye çalışılıyor:
        status: 'watchlist',
        personal_rating: 1,
        personal_rating_cleared: true,
        notes: 'gizli kullanıcı notu',
        profileId: 'profile-b',
        episodes_watched: 99,
        current_season: 9,
        season_progress: { 1: 99 },
      },
    });
    assert.equal(outcome.ok, true);

    const raw = await runtime.primaryRepository.readRaw();
    const item = raw.document.profiles.find((p) => p.id === 'profile-a').items[0];
    assert.equal(item.status, 'completed', 'durum yalnızca list girdisinden gelmeli');
    assert.equal(item.personal_rating, 9, 'puan yalnızca rating girdisinden gelmeli');
    assert.equal(item.notes, undefined, 'not metadata kanalından yazılamaz');
    // Not: normalizeSavedItem episodes_watched/current_season alanlarını her zaman
    // normalize eder (varsayılan 0); sızma denetimi ENJEKTİF değer üzerinedir:
    assert.notEqual(item.episodes_watched, 99, 'metadata’daki ilerleme değeri sızmamalı');
    assert.notEqual(item.current_season, 9, 'metadata’daki sezon değeri sızmamalı');
    assert.notDeepEqual(item.season_progress, { 1: 99 });
    assert.equal(item.title, 'Interstellar', 'içerik alanları ise kopyalanmalı');
    assert.equal(item.vote_average, 8.4);
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// C. TMDB puanı ≠ kullanıcı puanı
// ---------------------------------------------------------------------------
test('F3-C2 TMDB vote_average kullanıcı puanına asla yazılmaz', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const outcome = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      metadata: INTERSTELLAR.metadata, // rating verilmedi
    });
    assert.equal(outcome.ok, true);

    const raw = await runtime.primaryRepository.readRaw();
    const item = raw.document.profiles.find((p) => p.id === 'profile-a').items[0];
    assert.equal(
      item.personal_rating,
      '',
      'rating verilmediğinde kişisel puan boş kalmalı; TMDB puanı yazılamaz'
    );
    assert.equal(item.vote_average, 8.4, 'TMDB puanı ayrı içerik alanı olarak kalır');

    const got = await runtime.libraryService.getItem(
      { profileId: 'profile-a' },
      'movie:157336'
    );
    assert.equal(got.rating, null, 'getItem kişisel puanı null dönmeli');
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// A4. Güncelleme: durum + puan + ilerleme
// ---------------------------------------------------------------------------
test('F3-A4 updateItem: durum değişimi, puan güncellemesi ve izleme ilerlemesi kullanıcı verisi olarak yazılır', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'tv:1396',
      mediaType: 'tv',
      list: 'watching',
      metadata: { name: 'Breaking Bad', genre_ids: [18] },
    });
    assert.equal(added.ok, true);

    const updated = await runtime.libraryService.updateItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'tv:1396',
      rating: 10,
      progress: {
        episodesWatched: 7,
        currentSeason: 2,
        seasonProgress: { 1: 7, 2: 0 },
      },
    });
    assert.equal(updated.ok, true, `updateItem başarısız: ${JSON.stringify(updated)}`);

    const raw = await runtime.primaryRepository.readRaw();
    const item = raw.document.profiles.find((p) => p.id === 'profile-a').items[0];
    assert.equal(item.status, 'watching', 'liste verilmediğinde durum korunmalı');
    assert.equal(item.personal_rating, 10, 'puan güncellenmeli');
    assert.ok(item.ratedAt, 'puan değişince ratedAt yenilenmeli');
    assert.equal(item.completedAt, undefined, 'watching durumunda completedAt olmamalı');
    assert.equal(item.episodes_watched, 7, 'ilerleme kullanıcı verisi olarak yazılmalı');
    assert.equal(item.current_season, 2);
    assert.deepEqual(item.season_progress, { 1: 7, 2: 0 });
    // normalizeSavedItem `name` alanını `title` ile birleştirir:
    assert.equal(item.title, 'Breaking Bad');
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

test('F3-A5 updateItem: olmayan kayıt ve geçersiz liste reddedilir', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const missing = await runtime.libraryService.updateItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      rating: 5,
    });
    assert.equal(missing.ok, false, 'kayıt yoksa güncelleme reddedilmeli');

    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watchlist',
    });
    assert.equal(added.ok, true);

    const badList = await runtime.libraryService.updateItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      list: 'not-interested',
    });
    assert.equal(badList.ok, false, '"not-interested" güncelleme listesi olamaz');
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// A6. Silme: yalnızca kullanıcı kaydı + tombstone; tekrar ekleme tombstone'u temizler
// ---------------------------------------------------------------------------
test('F3-A6 removeItem: kullanıcı kaydı silinir, tombstone yazılır; re-add tombstone temizler', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
      metadata: INTERSTELLAR.metadata,
    });
    assert.equal(added.ok, true);

    const removed = await runtime.libraryService.removeItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
    });
    assert.equal(removed.ok, true, `removeItem başarısız: ${JSON.stringify(removed)}`);

    let raw = await runtime.primaryRepository.readRaw();
    const profile = raw.document.profiles.find((p) => p.id === 'profile-a');
    assert.equal(profile.items.length, 0, 'kullanıcı kaydı silinmeli');
    assert.ok(
      profile.deleted_keys && profile.deleted_keys['movie:157336'],
      'silme tombstone (deleted_keys) yazmalı'
    );
    assert.equal(
      await runtime.libraryService.getItem({ profileId: 'profile-a' }, 'movie:157336'),
      null
    );

    const reAdded = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watchlist',
    });
    assert.equal(reAdded.ok, true);
    raw = await runtime.primaryRepository.readRaw();
    const profileAfter = raw.document.profiles.find((p) => p.id === 'profile-a');
    assert.equal(profileAfter.items.length, 1, 'yeniden ekleme çalışmalı');
    assert.equal(
      profileAfter.deleted_keys?.['movie:157336'],
      undefined,
      'yeniden ekleme tombstone temizlemeli'
    );

    // Kayıt yeniden mevcut: silme tekrar başarılı, ardından "kayıt yok" reddi:
    const removedAgain = await runtime.libraryService.removeItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
    });
    assert.equal(removedAgain.ok, true);
    const missing = await runtime.libraryService.removeItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
    });
    assert.equal(missing.ok, false, 'olmayan kaydın silmesi "kayıt yok" demeli');
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// A7. getItem
// ---------------------------------------------------------------------------
test('F3-A7 getItem: liste + puan döner; bilinmeyen/geçersiz anahtar null', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    assert.equal(
      await runtime.libraryService.getItem({ profileId: 'profile-a' }, 'movie:157336'),
      null,
      'boş kütüphanede null'
    );

    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watching',
      rating: 7,
    });
    assert.equal(added.ok, true);

    const got = await runtime.libraryService.getItem(
      { profileId: 'profile-a' },
      'movie:157336'
    );
    assert.deepEqual(got, { list: 'watching', rating: 7 });

    assert.equal(
      await runtime.libraryService.getItem({ profileId: 'profile-a' }, 'movie:abc'),
      null,
      'geçersiz anahtar null'
    );
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// A8. Profil izolasyonu: yazım profiller arası sızmaz, profil değişimi yazımı keser
// ---------------------------------------------------------------------------
test('F3-A8 profil izolasyonu: A yazımı B’yi etkilemez; profil değişince eski ref yazımı reddedilir', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  let server;
  try {
    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
      metadata: INTERSTELLAR.metadata,
    });
    assert.equal(added.ok, true);

    // Aktif profili B'ye çevir (mevcut HTTP akışı — PUT /api/data).
    server = runtime.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const rawNow = await runtime.primaryRepository.readRaw();
    const doc2 = makeDoc([
      makeProfile('profile-a', 'Profil A', rawNow.document.profiles.find((p) => p.id === 'profile-a').items),
      makeProfile('profile-b', 'Profil B'),
    ]);
    doc2.activeProfileId = 'profile-b';
    doc2.revision = rawNow.revision + 1;
    const putRes = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"rev-${rawNow.revision}"`,
        'x-cinetrack-profile-id': 'profile-b',
      },
      body: JSON.stringify(doc2),
    });
    assert.equal(putRes.status, 200, `profil değişimi başarılı olmalı: ${await putRes.text()}`);

    const current = runtime.profileContext.getCurrent();
    assert.equal(current.profileId, 'profile-b');

    // Eski profil referansıyla yazım artık reddedilmeli (profile-switched).
    const staleProfileWrite = await runtime.libraryService.addItem({
      ref: { profileId: 'profile-a', revision: current.revision },
      mediaKey: 'movie:550',
      mediaType: 'movie',
      list: 'watchlist',
    });
    assert.equal(staleProfileWrite.ok, false, 'eski profil referansıyla yazım reddedilmeli');
    assert.equal(staleProfileWrite.retryable, false);

    // B profiline yazım çalışır; A'nın kayıtları dokunulmaz.
    const writeB = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-b'),
      mediaKey: 'movie:550',
      mediaType: 'movie',
      list: 'watchlist',
    });
    assert.equal(writeB.ok, true);

    const raw = await runtime.primaryRepository.readRaw();
    const profileA = raw.document.profiles.find((p) => p.id === 'profile-a');
    const profileB = raw.document.profiles.find((p) => p.id === 'profile-b');
    assert.equal(profileA.items.length, 1, 'A’nın kayıtları korunmalı');
    assert.equal(profileA.items[0].id, 157336);
    assert.equal(profileB.items.length, 1, 'B yalnızca kendi kaydını içermeli');
    assert.equal(profileB.items[0].id, 550);
    assert.equal(
      profileB.items.some((item) => item.id === 157336),
      false,
      'A’nın içeriği B’ye sızmamalı'
    );
  } finally {
    await closeRuntime(tmpDir, runtime, server);
  }
});

// ---------------------------------------------------------------------------
// A9. Stale revision
// ---------------------------------------------------------------------------
test('F3-A9 stale revision: bayat ref ile yazım reddedilir, belge değişmez', async () => {
  const { tmpDir, runtime, revision } = await makeRuntime();
  try {
    const outcome = await runtime.libraryService.addItem({
      ref: { profileId: 'profile-a', revision: revision + 42 },
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watchlist',
    });
    assert.equal(outcome.ok, false, 'bayat revision reddedilmeli');
    assert.equal(outcome.retryable, false, 'revision çelişkisi retryable olmamalı');

    const raw = await runtime.primaryRepository.readRaw();
    assert.equal(raw.revision, revision, 'reddedilen yazım revision artırmamalı');
    assert.equal(raw.document.profiles.find((p) => p.id === 'profile-a').items.length, 0);

    // revision'sız ref de reddedilmeli (WriteProfileRef sözleşmesi).
    const noRev = await runtime.libraryService.addItem({
      ref: { profileId: 'profile-a' },
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watchlist',
    });
    assert.equal(noRev.ok, false, 'revision’sız yazım referansı kabul edilmez');
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// D. EventBus entegrasyonu — gerçek AppEventBus
// ---------------------------------------------------------------------------
test('F3-D1 addItem/updateItem/removeItem doğru olayları kişisel veri içermeyen payload ile yayımlar', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  const seen = [];
  const watchedTypes = [
    'LibraryItemAdded',
    'LibraryItemUpdated',
    'LibraryStatusChanged',
    'LibraryRatingChanged',
    'LibraryItemRemoved',
  ];
  const subscriptions = watchedTypes.map((eventType) =>
    runtime.eventBus.subscribe(eventType, (event) => {
      seen.push(event);
    })
  );
  try {
    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
      metadata: INTERSTELLAR.metadata,
    });
    assert.equal(added.ok, true);

    const updated = await runtime.libraryService.updateItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      rating: 8,
    });
    assert.equal(updated.ok, true);

    const removed = await runtime.libraryService.removeItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
    });
    assert.equal(removed.ok, true);

    const types = seen.map((event) => event.eventType);
    assert.ok(types.includes('LibraryItemAdded'), 'LibraryItemAdded yayımlanmalı');
    assert.ok(types.includes('LibraryRatingChanged'), 'puan değişimi olayı yayımlanmalı');
    assert.ok(types.includes('LibraryItemRemoved'), 'silme olayı yayımlanmalı');

    const addedEvent = seen.find((event) => event.eventType === 'LibraryItemAdded');
    assert.equal(addedEvent.payload.mediaKey, 'movie:157336');
    assert.equal(addedEvent.payload.mediaType, 'movie');
    assert.equal(addedEvent.payload.list, 'watched');
    assert.equal(
      addedEvent.ref.profileId,
      'profile-a',
      'olay profil bağlamını taşımali'
    );
    assert.ok(
      Number.isSafeInteger(addedEvent.ref.revision),
      'olay sourceRevision taşımalı'
    );

    // Payload kişisel veri sızdırmaz: not/puan-ötesi kişisel alan yok.
    for (const event of seen) {
      const payloadKeys = Object.keys(event.payload ?? {});
      for (const forbidden of ['notes', 'profileId', 'personal_rating_cleared', 'episodes_watched']) {
        assert.equal(
          payloadKeys.includes(forbidden),
          false,
          `olay payload'ı kişisel alan içermemeli: ${event.eventType}.${forbidden}`
        );
      }
      assert.equal(
        JSON.stringify(event.payload ?? {}).includes('gizli kullanıcı notu'),
        false,
        'payload içinde not metni olmamalı'
      );
    }
  } finally {
    for (const subscription of subscriptions) subscription.unsubscribe();
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// D2. Olay yayımı başarısızlığı sözleşmesi (sessiz yutma yok)
// ---------------------------------------------------------------------------
test('F3-D2 olay yayımı başarısızsa: kayıt kalıcı, sonuç ok:false + retryable:true + revizyon mesajda', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const failingBus = {
      publish: async () => {
        throw new Error('olay yolu çöktü');
      },
      subscribe: () => ({ unsubscribe: () => {} }),
    };
    const service = createLibraryService({
      repository: runtime.primaryRepository,
      profileContext: runtime.profileContext,
      eventPublisher: failingBus,
    });

    const current = runtime.profileContext.getCurrent();
    const outcome = await service.addItem({
      ref: { profileId: 'profile-a', revision: current.revision },
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
    });

    assert.equal(outcome.ok, false, 'yayım hatası sonuca yansımalı (sessiz yutma yok)');
    assert.equal(outcome.retryable, true, 'yayım hatası retryable bildirilmeli');
    assert.ok(
      outcome.error.includes('olay yolu çöktü'),
      'hata mesajı yayım hatasını içermeli'
    );
    assert.ok(
      /rev/i.test(outcome.error),
      'mesaj kalıcı revizyonu belirtmeli (ARCHITECTURE.md §5.3)'
    );

    // Kayıt yine de kalıcı olmalı.
    const raw = await runtime.primaryRepository.readRaw();
    const items = raw.document.profiles.find((p) => p.id === 'profile-a').items;
    assert.equal(items.length, 1, 'kalıcı yazım olay hatasından etkilenmemeli');
    assert.equal(items[0].personal_rating, 9);
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// D3. Tekrarlanan işlem: aynı addItem iki kez → tek kayıt, olaylar tutarlı
// ---------------------------------------------------------------------------
test('F3-D3 tekrarlanan addItem: idempotent kayıt, ikinci ekleme LibraryItemAdded üretmez', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  const seen = [];
  const subscriptions = ['LibraryItemAdded', 'LibraryItemUpdated'].map((eventType) =>
    runtime.eventBus.subscribe(eventType, (event) => {
      seen.push(event.eventType);
    })
  );
  try {
    for (let i = 0; i < 2; i += 1) {
      const outcome = await runtime.libraryService.addItem({
        ref: ref(runtime, 'profile-a'),
        mediaKey: 'movie:157336',
        mediaType: 'movie',
        list: 'watched',
        rating: 9,
        metadata: INTERSTELLAR.metadata,
      });
      assert.equal(outcome.ok, true, `tekrar ${i + 1} başarısız`);
    }
    const raw = await runtime.primaryRepository.readRaw();
    assert.equal(
      raw.document.profiles.find((p) => p.id === 'profile-a').items.length,
      1,
      'tekrarlanan ekleme çoğaltmamalı'
    );
    assert.equal(seen.filter((t) => t === 'LibraryItemAdded').length, 1,
      'LibraryItemAdded yalnızca ilk eklemede bir kez');
  } finally {
    for (const subscription of subscriptions) subscription.unsubscribe();
    await closeRuntime(tmpDir, runtime);
  }
});
