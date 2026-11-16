/**
 * MIA Faz 2 — Adım 2.5 (Dilim F): Gerçek liste olayları uçtan uca entegrasyon.
 *
 * Kabul kriterleri (docs/mia/faz1-faz2-uygulama-plani.md 2.5):
 *  - Gerçek UI/API işlemi (PUT /api/data) → EventBus → Transactional Outbox →
 *    Queue → Repository sonucuna kadar uçtan uca çalışır.
 *  - Olay payload'ı ortak metadata deposuna kullanıcıya ait alan taşımaz.
 *  - LibraryRatingChanged kişisel puanı ortak metadata'ya yazmaz; yalnızca
 *    içerik henüz yoksa indekslemeyi tetikler.
 *  - LibraryItemRemoved ortak içerik kaydını silmez.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCineTrackApp } from '../src/server/app.ts';

function makeTempDir(prefix = 'cinethos-lib-events-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeMovie(overrides = {}) {
  return {
    id: 157336,
    media_type: 'movie',
    title: 'Interstellar',
    original_title: 'Interstellar',
    original_language: 'en',
    overview:
      'A team of explorers travel through a wormhole in space in an attempt to ensure humanity survival.',
    release_date: '2014-11-07',
    vote_average: 8.4,
    vote_count: 30000,
    popularity: 90,
    genre_ids: [12, 18, 878],
    status: 'completed',
    personal_rating: 9,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function drainQueue(runtime, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    const stats = runtime.contentIntelligence.repository.getQueueStats();
    if (stats.pending === 0 && stats.processing === 0) return;
    await runtime.contentIntelligence.queue.pumpOnce().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('Dilim F: PUT /api/data gerçek liste olayları EventBus → Outbox → Queue → Repository zincirini işletir', async () => {
  const tmpDir = await makeTempDir();
  const runtime = createCineTrackApp({ dataDir: tmpDir });
  await runtime.startRuntimeModules();

  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Kullanıcı Interstellar'ı İzledim listesine ekliyor ve 9 puan veriyor.
    const docV1 = {
      version: 3,
      schemaVersion: 3,
      engineVersion: 'test',
      activeProfileId: 'profile-a',
      profiles: [
        {
          id: 'profile-a',
          name: 'Kullanıcı A',
          createdAt: '2026-01-01T00:00:00.000Z',
          items: [makeMovie()],
          favoriteActors: [],
        },
      ],
    };

    const putRes = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"rev-0"',
        'X-CineTrack-Profile-Id': 'profile-a',
      },
      body: JSON.stringify(docV1),
    });
    assert.equal(putRes.status, 200);

    // Olay abonelikleri asenkron çalışır; kuyruğun boşalmasını bekle.
    await new Promise((r) => setTimeout(r, 100));
    await drainQueue(runtime);

    // Ortak içerik kaydı oluştu ve tamamlandı.
    const addedRecord = runtime.contentIntelligence.repository.getByMediaKey('movie:157336');
    assert.ok(addedRecord, 'LibraryItemAdded ortak içerik kaydı oluşturmalı');
    assert.equal(addedRecord.processing_status, 'completed');

    // Olay payload'ı kişisel veri taşımaz: ortak kayıtta puan/not/status yok.
    const recordJson = JSON.stringify(addedRecord);
    assert.ok(!recordJson.includes('personal_rating'));
    assert.ok(!recordJson.includes('Özel kişisel notum'));

    // 2. Puan güncelleniyor (9 → 7): LibraryRatingChanged tetiklenir ama ortak
    //    kayıt kişisel puanı YAZMAZ; mevcut kayıt değişmez.
    const docV2 = {
      ...docV1,
      profiles: [
        {
          ...docV1.profiles[0],
          items: [makeMovie({ personal_rating: 7 })],
        },
      ],
    };
    const putRes2 = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"rev-${(await putRes.json()).revision}"`,
        'X-CineTrack-Profile-Id': 'profile-a',
      },
      body: JSON.stringify(docV2),
    });
    assert.equal(putRes2.status, 200);

    await new Promise((r) => setTimeout(r, 100));
    await drainQueue(runtime);

    const afterRating = runtime.contentIntelligence.repository.getByMediaKey('movie:157336');
    assert.ok(afterRating);
    assert.ok(!JSON.stringify(afterRating).includes('personal_rating'));

    // 3. İçerik listeden siliniyor: LibraryItemRemoved ortak kaydı SİLMEZ.
    const docV3 = {
      ...docV2,
      profiles: [
        {
          ...docV2.profiles[0],
          items: [],
        },
      ],
    };
    const putRes3 = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': `"rev-${(await putRes2.json()).revision}"`,
        'X-CineTrack-Profile-Id': 'profile-a',
      },
      body: JSON.stringify(docV3),
    });
    assert.equal(putRes3.status, 200);

    await new Promise((r) => setTimeout(r, 100));
    await drainQueue(runtime);

    const preserved = runtime.contentIntelligence.repository.getByMediaKey('movie:157336');
    assert.ok(preserved, 'Remove olayı ortak içerik kaydını silmemeli');
    assert.equal(preserved.processing_status, 'completed');
  } finally {
    server.close();
    await runtime.stopRuntimeModules().catch(() => undefined);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
