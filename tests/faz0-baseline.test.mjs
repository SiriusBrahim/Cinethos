import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildTasteProfileV3, scoreCandidatesV3 } from '../src/core/cinethos-core.ts';
import { createDataStorage } from '../src/server/storage.ts';

/**
 * Faz 0 — mevcut davranışı kayıt altına alan baseline testleri.
 * Amaç yeni özellik eklemek değil: bugünkü öneri puanlarını, profil izolasyonunu
 * ve silme/geri yükleme davranışını sabitleyip sonraki fazlarda regresyonu görünür kılmak.
 */

const HISTORY = [
  {
    id: 1,
    media_type: 'movie',
    title: 'A',
    status: 'completed',
    personal_rating: 9,
    genre_ids: [878, 12],
    vote_average: 8,
    vote_count: 1000,
    popularity: 20,
    overview: 'uzay yolculuğu bilim kurgu',
    release_date: '2010-01-01',
  },
  {
    id: 2,
    media_type: 'movie',
    title: 'B',
    status: 'completed',
    personal_rating: 8,
    genre_ids: [53, 18],
    vote_average: 7.5,
    vote_count: 800,
    popularity: 15,
    overview: 'gerilim dram',
    release_date: '2012-01-01',
  },
  {
    id: 3,
    media_type: 'movie',
    title: 'C',
    status: 'watchlist',
    genre_ids: [878],
    vote_average: 6.5,
    vote_count: 400,
    popularity: 12,
    overview: 'bilim kurgu',
    release_date: '2015-01-01',
  },
];

const CANDIDATES = [
  {
    id: 101,
    media_type: 'movie',
    title: 'Yakın',
    genre_ids: [878, 53],
    vote_average: 8.1,
    vote_count: 900,
    popularity: 18,
    overview: 'uzay bilim kurgu gerilim',
    release_date: '2014-01-01',
  },
  {
    id: 102,
    media_type: 'movie',
    title: 'Uzak',
    genre_ids: [10749],
    vote_average: 5.5,
    vote_count: 120,
    popularity: 3,
    overview: 'romantik komedi',
    release_date: '2020-01-01',
  },
];

const round = (value, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

test('Faz 0 baseline: öneri motoru puanları sabit (aynı girdi → aynı çıktı)', () => {
  const profile = buildTasteProfileV3(HISTORY, { lambda: 1 });
  const scored = scoreCandidatesV3(CANDIDATES, profile, {
    genreNames: { 878: 'Bilim Kurgu', 53: 'Gerilim', 10749: 'Romantik' },
  });

  assert.equal(scored.length, 2);
  const [near, far] = scored;

  // Kayıt altına alınan değerler (2026-11-16, dal: freebuff/faz0-f47140).
  assert.equal(near.candidate.id, 101);
  assert.equal(round(near.tasteScore), 66);
  assert.equal(round(near.priorityScore), 66);
  assert.equal(near.ring, 'ring0');
  assert.equal(round(near.parts.genre, 3), 0.742);
  assert.equal(round(near.parts.keywords, 3), 0.704);
  assert.equal(round(near.parts.story, 3), 1);
  assert.equal(round(near.parts.lovedSim, 3), 0.608);
  assert.equal(round(near.parts.quality, 3), 0.81);

  assert.equal(far.candidate.id, 102);
  assert.equal(round(far.tasteScore), 49);
  assert.equal(round(far.priorityScore), 49);
  assert.equal(round(far.parts.genre, 3), 0.5);
  assert.equal(round(far.parts.keywords, 3), 0.5);
  assert.equal(round(far.parts.story, 3), 0.3);
  assert.equal(round(far.parts.lovedSim, 3), 0.272);
  assert.equal(round(far.parts.quality, 3), 0.61);

  // Sıralama değişmemeli: zevke yakın içerik uzak olandan yüksek puan alır.
  assert.ok(near.tasteScore > far.tasteScore);
});

function makeDocument(activeProfileId, profiles, revision) {
  return {
    version: 3,
    schemaVersion: 3,
    engineVersion: 'v3.2.0',
    activeProfileId,
    revision,
    updatedAt: new Date(1_700_000_000_000 + revision * 1000).toISOString(),
    profiles: profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      createdAt: '2026-01-01T00:00:00.000Z',
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items: profile.items.map((item) => ({
        id: item.id,
        media_type: 'movie',
        title: item.title,
        status: item.status ?? 'watchlist',
        personal_rating: '',
        poster_path: '',
        backdrop_path: '',
        overview: '',
        vote_average: 7,
        vote_count: 100,
        popularity: 5,
        genre_ids: [18],
        genres: [],
        release_date: '2020-01-01',
        first_air_date: '',
        addedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
      favoriteActors: [],
      ...(profile.deleted_keys ? { deleted_keys: profile.deleted_keys } : {}),
    })),
  };
}

test('Faz 0 baseline: profil değişimi diğer profilin kayıtlarını bozmaz', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-profile-isolation-'));
  try {
    const storage = createDataStorage({ dataDir: tmpDir, storageDriver: 'json' });

    const first = await storage.saveDataSerialized(
      makeDocument(
        'profile-one',
        [
          { id: 'profile-one', name: 'Bir', items: [{ id: 11, title: 'Birinci Kullanıcı Filmi' }] },
          { id: 'profile-two', name: 'İki', items: [] },
        ],
        1
      )
    );
    assert.equal(first.ok, true);

    // İkinci profile geçiş: yalnızca activeProfileId değişir, profile-one kayıtları korunur.
    const switched = await storage.saveDataSerialized(
      makeDocument(
        'profile-two',
        [
          { id: 'profile-one', name: 'Bir', items: [{ id: 11, title: 'Birinci Kullanıcı Filmi' }] },
          { id: 'profile-two', name: 'İki', items: [{ id: 22, title: 'İkinci Kullanıcı Filmi' }] },
        ],
        2
      ),
      { expectedRevision: 1 }
    );
    assert.equal(switched.ok, true);
    if (!switched.ok) return;

    const after = await storage.readDataAsync();
    assert.equal(after.activeProfileId, 'profile-two');
    const one = after.profiles.find((profile) => profile.id === 'profile-one');
    const two = after.profiles.find((profile) => profile.id === 'profile-two');
    assert.equal(one?.items.length, 1);
    assert.equal(one?.items[0].title, 'Birinci Kullanıcı Filmi');
    assert.equal(two?.items.length, 1);
    assert.equal(two?.items[0].title, 'İkinci Kullanıcı Filmi');

    // Eski revizyondan yazma denemesi çakışma döndürmeli (yarış koruması).
    const stale = await storage.saveDataSerialized(
      makeDocument('profile-one', [{ id: 'profile-one', name: 'Bir', items: [] }], 3),
      { expectedRevision: 1 }
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) {
      assert.equal(stale.status, 409);
      assert.equal(stale.code, 'revision_conflict');
      assert.equal(stale.currentRevision, 2);
    }

    const unchanged = await storage.readDataAsync();
    assert.equal(unchanged.revision, 2);
    assert.equal(
      unchanged.profiles.find((profile) => profile.id === 'profile-one')?.items.length,
      1,
      'eski revizyonlu yazma diske uygulanmamalı'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Faz 0 baseline: silme mezar taşı bırakır, geri yükleme kaydı geri getirir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-delete-restore-'));
  try {
    const storage = createDataStorage({ dataDir: tmpDir, storageDriver: 'json' });
    const saved = await storage.saveDataSerialized(
      makeDocument(
        'profile-one',
        [{ id: 'profile-one', name: 'Bir', items: [{ id: 11, title: 'Silinecek Film' }] }],
        1
      )
    );
    assert.equal(saved.ok, true);
    if (!saved.ok) return;

    // Silme: kayıt listeden çıkar, mezar taşı 30 günlük TTL ile yazılır.
    const deleted = await storage.saveDataSerialized(
      makeDocument('profile-one', [{ id: 'profile-one', name: 'Bir', items: [], deleted_keys: { 'movie:11': '2026-11-16T00:00:00.000Z' } }], 2),
      { expectedRevision: saved.document.revision }
    );
    assert.equal(deleted.ok, true);
    if (!deleted.ok) return;

    const afterDelete = await storage.readDataAsync();
    assert.equal(afterDelete.profiles[0].items.length, 0);
    assert.equal(afterDelete.profiles[0].deleted_keys?.['movie:11'], '2026-11-16T00:00:00.000Z');

    // Geri yükleme: mezar taşı temizlenip kayıt yeniden eklenir.
    const restored = await storage.saveDataSerialized(
      makeDocument('profile-one', [{ id: 'profile-one', name: 'Bir', items: [{ id: 11, title: 'Geri Gelen Film' }] }], 3),
      { expectedRevision: deleted.document.revision }
    );
    assert.equal(restored.ok, true);
    if (!restored.ok) return;

    const afterRestore = await storage.readDataAsync();
    assert.equal(afterRestore.profiles[0].items.length, 1);
    assert.equal(afterRestore.profiles[0].items[0].title, 'Geri Gelen Film');
    assert.equal(
      afterRestore.profiles[0].deleted_keys?.['movie:11'],
      undefined,
      'yeniden eklenen kayıt mezar taşında kalmamalı'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
