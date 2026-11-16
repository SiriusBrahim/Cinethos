/**
 * MIA Faz 2 — Adım 2.7 (Dilim G): Başlangıç indekslemesi ve hash/version pipeline.
 *
 * Kabul kriterleri (docs/mia/faz1-faz2-uygulama-plani.md 2.7 + 2.8):
 *  - Beş liste kapsamı: izledim, izleyeceğim, izliyorum, ilgilenmiyorum, gizlenen.
 *  - Aynı içerik birden fazla profilde varsa tek ortak media_key kaydı/işi oluşur.
 *  - Profil verisi kuyruğa gitmeden önce allowlist ile temizlenir.
 *  - Sağlık API'sinde ilk indeksleme durumu görünür.
 *  - Hash aynı ve processing_version güncelse işlem atlanır (idempotent).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCineTrackApp } from '../src/server/app.ts';
import { collectInitialIndexItems } from '../src/server/initial-indexer.ts';
import { CONTENT_INTELLIGENCE_VERSION } from '../src/modules/content/types.ts';

function makeTempDir(prefix = 'cinethos-init-index-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeItem(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    overview: `Film ${id} özeti.`,
    genre_ids: [18],
    genres: [{ id: 18, name: 'Drama' }],
    keywords: [{ id: 1, name: 'drama' }],
    vote_average: 7,
    vote_count: 100,
    popularity: 50,
    release_date: '2020-01-01',
    status: 'completed',
    personal_rating: 8,
    notes: 'Özel kişisel notum',
    profileId: 'profile-a',
    ...overrides,
  };
}

test('Dilim G: beş liste kapsamı toplanır, profiller arası tek mediaKey işi oluşur', () => {
  const doc = {
    version: 3,
    schemaVersion: 3,
    activeProfileId: 'profile-a',
    profiles: [
      {
        id: 'profile-a',
        name: 'A',
        items: [
          makeItem(100, { status: 'completed' }), // izledim
          makeItem(200, { status: 'watchlist' }), // izleyeceğim
          makeItem(300, { status: 'watching' }), // izliyorum
        ],
        preferences: { disliked: ['movie:400'], hidden: ['tv:500'] },
      },
      {
        id: 'profile-b',
        name: 'B',
        items: [makeItem(100, { status: 'watchlist' })], // aynı içerik → tek iş
        disliked: ['movie:400'], // aynı içerik → tek iş
      },
    ],
  };

  const items = collectInitialIndexItems(doc);
  const keys = items.map((i) => i.mediaKey).sort();

  assert.deepEqual(keys, ['movie:100', 'movie:200', 'movie:300', 'movie:400', 'tv:500']);
  assert.equal(items.length, 5);

  // Allowlist temizliği: kişisel alanlar payload'da yok.
  const movie100 = items.find((i) => i.mediaKey === 'movie:100');
  const payloadJson = JSON.stringify(movie100.payload);
  assert.ok(!payloadJson.includes('Özel kişisel notum'));
  assert.ok(!payloadJson.includes('personal_rating'));
  assert.ok(!payloadJson.includes('user-secret'));
});

test('Dilim G: sunucu açılışında başlangıç indekslemesi çalışır ve sağlık API raporlar', async () => {
  const tmpDir = await makeTempDir();
  const runtime = createCineTrackApp({ dataDir: tmpDir });

  // Modüller başlamadan önce birincil depoya veri yazılır (PUT /api/data akışı
  // yerine doğrudan repository — test odaklı kurulum).
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const doc = {
      version: 3,
      schemaVersion: 3,
      activeProfileId: 'profile-a',
      profiles: [
        {
          id: 'profile-a',
          name: 'A',
          createdAt: '2026-01-01T00:00:00.000Z',
          items: [makeItem(157336, { title: 'Interstellar', personal_rating: 9 })],
          preferences: { disliked: ['movie:27205'] },
        },
      ],
    };
    const putRes = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"rev-0"' },
      body: JSON.stringify(doc),
    });
    assert.equal(putRes.status, 200);

    // Sunucu açılış akışını taklit etmek için runtime modülleri şimdi başlatılır;
    // initial-indexer modülü birincil depodan belgeyi okuyup beş liste
    // kapsamını kuyruğa alır.
    await runtime.startRuntimeModules();

    const stats = runtime.contentIntelligence.getInitialIndexStats();
    assert.equal(stats.status, 'completed');
    assert.ok(stats.queued >= 2, `en az 2 iş kuyruğa alınmalı (items + disliked): ${stats.queued}`);

    // Sağlık API'sinde ilk indeksleme durumu görünür.
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = await healthRes.json();
    assert.ok(health.contentIntelligence, 'sağlık yanıtında contentIntelligence olmalı');
    assert.equal(health.contentIntelligence.initialIndex.status, 'completed');
    assert.ok(health.contentIntelligence.initialIndex.queued >= 2);

    // Kuyruk boşalana kadar pompa çalışır; ortak kayıtlar tamamlanır.
    for (let i = 0; i < 40; i += 1) {
      const q = runtime.contentIntelligence.repository.getQueueStats();
      if (q.pending === 0 && q.processing === 0) break;
      await runtime.contentIntelligence.queue.pumpOnce().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 25));
    }

    const rec1 = runtime.contentIntelligence.repository.getByMediaKey('movie:157336');
    assert.ok(rec1);
    assert.equal(rec1.processing_version, CONTENT_INTELLIGENCE_VERSION);
    // Kişisel veri ortak kayda sızamaz.
    assert.ok(!JSON.stringify(rec1).includes('Özel kişisel notum'));

    const rec2 = runtime.contentIntelligence.repository.getByMediaKey('movie:27205');
    assert.ok(rec2, 'ilgilenmiyorum içeriği de indekslenmeli');

    await runtime.stopRuntimeModules();
  } finally {
    server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Dilim G: hash aynı ve processing_version güncelse işlem atlanır', async () => {
  const tmpDir = await makeTempDir();
  try {
    const runtime = createCineTrackApp({ dataDir: tmpDir });
    await runtime.startRuntimeModules();

    const movie = makeItem(550, { title: 'Fight Club' });

    // İlk işleme
    const first = await runtime.contentIntelligence.processImmediate(movie);
    assert.equal(first.status, 'completed');
    const firstHash = first.record.data_hash;

    // Aynı veri ile ikinci işleme → hash aynı ve processing_version güncel → ATLANIR.
    const second = await runtime.contentIntelligence.processImmediate(movie);
    assert.equal(second.status, 'skipped');
    assert.equal(second.record.data_hash, firstHash);

    // Metadata değişirse hash değişmeli → yeniden işleme.
    const changed = await runtime.contentIntelligence.processImmediate({
      ...movie,
      overview: 'Tamamen değiştirilmiş özet metni.',
    });
    assert.equal(changed.status, 'completed');
    assert.notEqual(changed.record.data_hash, firstHash);

    await runtime.stopRuntimeModules();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
