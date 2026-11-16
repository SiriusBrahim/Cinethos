/**
 * MIA Faz 3 — Veri sahipliği ve gizlilik denetimi (görev §2-C).
 *
 * Kapsam:
 *  - `pickContentFields` allowlist'i: kişisel alanlar ve bilinmeyen alanlar
 *    metadata kanalından kütüphane kaydına geçemez (birim düzeyi).
 *  - Dosya düzeyi: kullanıcı puanı/notu/durumu/ilerlemesi ortak katalog
 *    metadata'sına YAZILAMAZ (katalog dosyası bayt bayt korunur).
 *  - Kütüphaneden silme ortak katalog kaydını SİLMEZ.
 *  - Ortak içerik kaydı (content_records) kullanıcı işlemlerinden etkilenmez.
 *  - Profil A'nın yazımı profil B'nin belge dilimini değiştirmez.
 *  - TMDB `vote_average` kişisel puana kopyalanamaz.
 *
 * Testler salt-okunur denetim yapar; uygulama kodu değiştirilmez.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCineTrackApp } from '../src/server/app.ts';
import { pickContentFields } from '../src/modules/library/operations.ts';

function makeTempDir(prefix = 'cinethos-faz3-ownership-') {
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

const CATALOG_ENTRY = {
  id: 157336,
  media_type: 'movie',
  title: 'Interstellar',
  overview: 'Bir grup kâşif solucan deliğinden geçer.',
  poster_path: '/interstellar.jpg',
  genre_ids: [12, 18, 878],
  vote_average: 8.4,
  vote_count: 32000,
  popularity: 250.5,
  release_date: '2014-11-05',
};

async function makeRuntime(seedCatalog = true) {
  const tmpDir = await makeTempDir();
  if (seedCatalog) {
    await fs.mkdir(path.join(tmpDir, 'catalog'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, 'catalog', 'movies.json'),
      JSON.stringify({ 'movie:157336': CATALOG_ENTRY }, null, 2),
      'utf8'
    );
  }
  const runtime = createCineTrackApp({ dataDir: tmpDir });
  const doc = makeDoc([
    makeProfile('profile-a', 'Profil A'),
    makeProfile('profile-b', 'Profil B'),
  ]);
  const seed = await runtime.primaryRepository.saveRaw(doc, { forceOverwrite: true });
  assert.equal(seed.ok, true);
  await runtime.startRuntimeModules();
  return { tmpDir, runtime, revision: seed.document?.revision ?? 0 };
}

async function closeRuntime(tmpDir, runtime) {
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

// ---------------------------------------------------------------------------
// C1. Allowlist birim denetimi
// ---------------------------------------------------------------------------
test('F3-O1 pickContentFields: kişisel alanlar ve bilinmeyen alanlar metadata’dan seçilmez', () => {
  const metadata = {
    title: 'Interstellar',
    overview: 'özet',
    poster_path: '/x.jpg',
    genre_ids: [18],
    // Kişisel alanlar — asla kopyalanmamalı:
    status: 'watching',
    personal_rating: 3,
    personal_rating_cleared: true,
    notes: 'gizli not',
    profileId: 'profile-b',
    episodes_watched: 42,
    current_season: 3,
    season_progress: { 1: 42 },
    ratedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:00:00.000Z',
    deleted_keys: { 'movie:1': 'x' },
    // Bilinmeyen alanlar — default-deny:
    custom_private_field: 'sır',
    internal_cache_token: 'tok',
  };

  const picked = pickContentFields(metadata);
  assert.equal(picked.title, 'Interstellar');
  assert.equal(picked.overview, 'özet');
  assert.equal(picked.poster_path, '/x.jpg');
  assert.deepEqual([...picked.genre_ids], [18]);

  for (const forbidden of [
    'status',
    'personal_rating',
    'personal_rating_cleared',
    'notes',
    'profileId',
    'episodes_watched',
    'current_season',
    'season_progress',
    'ratedAt',
    'completedAt',
    'deleted_keys',
    'custom_private_field',
    'internal_cache_token',
  ]) {
    assert.equal(
      forbidden in picked,
      false,
      `allowlist kişisel/bilinmeyen alanı seçmemeli: ${forbidden}`
    );
  }
});

test('F3-O2 pickContentFields: null/boş girdi güvenli, prototip kirliliği taşımaz', () => {
  assert.deepEqual(pickContentFields(null), {});
  assert.deepEqual(pickContentFields(undefined), {});
  assert.deepEqual(pickContentFields('string'), {});
  const picked = pickContentFields({ title: 'X', __proto__: { polluted: true } });
  assert.equal(picked.title, 'X');
  assert.equal('polluted' in picked, false);
});

// ---------------------------------------------------------------------------
// C3. Dosya düzeyi: kullanıcı verisi ortak katalog metadata'sına yazılamaz
// ---------------------------------------------------------------------------
test('F3-O3 kullanıcı puanı/notu/durumu/ilerlemesi ortak katalog dosyasına yazılmaz', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const catalogPath = path.join(tmpDir, 'catalog', 'movies.json');
    const before = await fs.readFile(catalogPath, 'utf8');

    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
      metadata: {
        ...CATALOG_ENTRY,
        notes: 'benim özel notum',
        episodes_watched: 5,
      },
    });
    assert.equal(added.ok, true);

    const updated = await runtime.libraryService.updateItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      rating: 6,
      progress: { episodesWatched: 12, currentSeason: 1, seasonProgress: { 1: 12 } },
    });
    assert.equal(updated.ok, true);

    const after = await fs.readFile(catalogPath, 'utf8');
    assert.equal(after, before, 'kütüphane yazımları ortak katalog dosyasını değiştirmemeli');
    assert.equal(after.includes('benim özel notum'), false);

    // Kullanıcı verisi yalnızca kendi belgesinde:
    const raw = await runtime.primaryRepository.readRaw();
    const item = raw.document.profiles.find((p) => p.id === 'profile-a').items[0];
    assert.equal(item.personal_rating, 6);
    assert.equal(item.episodes_watched, 12);
    assert.equal(item.notes, undefined, 'not metadata kanalından yazılamaz');
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// C4. Silme ortak kaydı silmez
// ---------------------------------------------------------------------------
test('F3-O4 kütüphaneden silme ortak katalog kaydını silmez; tombstone yalnızca kullanıcı belgesinde', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const catalogPath = path.join(tmpDir, 'catalog', 'movies.json');

    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
    });
    assert.equal(added.ok, true);

    const removed = await runtime.libraryService.removeItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
    });
    assert.equal(removed.ok, true);

    const catalogRaw = await fs.readFile(catalogPath, 'utf8');
    const catalog = JSON.parse(catalogRaw);
    assert.ok(
      catalog['movie:157336'],
      'ortak katalog kaydı silinmemeli (kullanıcı silmesi yalnızca kendi kaydına dokunur)'
    );
    assert.equal(catalog['movie:157336'].title, 'Interstellar');

    const raw = await runtime.primaryRepository.readRaw();
    const profile = raw.document.profiles.find((p) => p.id === 'profile-a');
    assert.equal(profile.items.length, 0);
    assert.ok(profile.deleted_keys?.['movie:157336'], 'tombstone kullanıcı belgesinde');

    // İkinci profil aynı içeriği ekleyebilir (ortak metadata yaşıyor).
    const addB = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-b'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watchlist',
    });
    assert.equal(
      addB.ok,
      false,
      'B için ekleme aktif-profil kuralı nedeniyle reddedilir (aktif profil A kaldı)'
    );
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// C5. Ortak içerik kaydı (content_records) kullanıcı işlemlerinden etkilenmez
// ---------------------------------------------------------------------------
test('F3-O5 ortak içerik kaydı kullanıcı işlemlerinden kişisel veri taşımaz; silme ortak kaydı silmez', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
      metadata: {
        ...CATALOG_ENTRY,
        // Kişisel alanlar metadata kanalına enjekte ediliyor:
        notes: 'çok gizli kullanıcı notu',
        personal_rating: 3,
        status: 'watching',
        episodes_watched: 5,
      },
    });
    assert.equal(added.ok, true);

    const removed = await runtime.libraryService.removeItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
    });
    assert.equal(removed.ok, true);

    // Arka plan içerik işleyicisi ortak kayıt OLUŞTURABİLİR (meşru zenginştirme);
    // ancak bu kayıt asla kişisel veri TAŞIMAMALIDIR:
    const record = runtime.contentIntelligence.getByMediaKey('movie:157336');
    if (record) {
      const serialized = JSON.stringify(record);
      assert.equal(
        serialized.includes('çok gizli kullanıcı notu'),
        false,
        'kullanıcı notu ortak kayda sızmamalı'
      );
      assert.equal(serialized.includes('"personal_rating"'), false);
      assert.equal(serialized.includes('"episodes_watched"'), false);
      assert.equal(serialized.includes('"notes"'), false);
    }

    // Silme sonrası ortak katalog dosyası hâlâ kaydı içermeli:
    const catalog = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'catalog', 'movies.json'), 'utf8')
    );
    assert.ok(catalog['movie:157336'], 'kullanıcı silmesi ortak katalog kaydını silmemeli');
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// C6. Profil izolasyonu — belge dilimi düzeyinde
// ---------------------------------------------------------------------------
test('F3-O6 profil A yazımı profil B’nin belge dilimini bayt bayt değiştirmez', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const rawBefore = await runtime.primaryRepository.readRaw();
    const sliceB = JSON.stringify(rawBefore.document.profiles.find((p) => p.id === 'profile-b'));

    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
      metadata: CATALOG_ENTRY,
    });
    assert.equal(added.ok, true);

    const updated = await runtime.libraryService.updateItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      rating: 4,
    });
    assert.equal(updated.ok, true);

    const rawAfter = await runtime.primaryRepository.readRaw();
    const sliceBAfter = JSON.stringify(rawAfter.document.profiles.find((p) => p.id === 'profile-b'));
    assert.equal(sliceBAfter, sliceB, 'B profil dilimi A yazımlarından etkilenmemeli');

    // A'nın verisi B'nin sorgularında görünmez.
    assert.equal(
      await runtime.libraryService.getItem({ profileId: 'profile-b' }, 'movie:157336'),
      null
    );
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

// ---------------------------------------------------------------------------
// C7. TMDB puanı ayrımı — getItem düzeyinde
// ---------------------------------------------------------------------------
test('F3-O7 getItem: TMDB puanı hiçbir koşulda kişisel puan olarak dönmez', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const added = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watchlist',
      metadata: CATALOG_ENTRY, // vote_average: 8.4
    });
    assert.equal(added.ok, true);

    const got = await runtime.libraryService.getItem(
      { profileId: 'profile-a' },
      'movie:157336'
    );
    assert.deepEqual(got, { list: 'watchlist', rating: null });

    const raw = await runtime.primaryRepository.readRaw();
    const item = raw.document.profiles.find((p) => p.id === 'profile-a').items[0];
    assert.equal(item.personal_rating, '', 'kişisel puan boş kalmalı');
    assert.equal(item.vote_average, 8.4, 'TMDB puanı ayrı içerik alanı');
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});
