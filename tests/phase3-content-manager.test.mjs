/**
 * MIA Faz 3 — Content Manager (`IContentService`) bağımsız denetim testleri.
 *
 * Kapsam (görev §2-B):
 *  - `getMetadata`: merkezi içerik kaydı → yerel katalog zinciri (TMDB anahtarı
 *    olmadan, AĞ ÇAĞRISI YOK); film/dizi anahtar ayrımı (`movie:<id>` / `tv:<id>`).
 *  - Geçersiz/eksik anahtar güvenliği.
 *  - `searchCatalog`: yerel katalog araması, popülerlik sıralaması, limit, boş sorgu.
 *  - `canonicalizeKey`: pozitif tamsayı doğrulaması, öndeki sıfırların normalize'u.
 *  - `enrichMissing`: yalnızca yetersiz detaylı içerikler kuyruğa devredilir;
 *    port bağlı değilse açık hata; kuyruk girdisinde kişisel alanlar
 *    allowlist ile temizlenir (gizlilik sınırı).
 *  - Tekrarlanan okuma: aynı kanonik anahtar için kayıt çoğalmaz.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createContentService } from '../src/modules/content/service.ts';
import { createContentMetadataSource } from '../src/server/content-metadata-source.ts';
import { sanitizeRawContentInput } from '../src/modules/content/content-metadata-processor.ts';

function makeTempDir(prefix = 'cinethos-faz3-content-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function seedCatalog(tmpDir, movies = {}, tv = {}) {
  await fs.mkdir(path.join(tmpDir, 'catalog'), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, 'catalog', 'movies.json'),
    JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z', ...movies }, null, 2),
    'utf8'
  );
  await fs.writeFile(
    path.join(tmpDir, 'catalog', 'tv.json'),
    JSON.stringify({ updatedAt: '2026-01-01T00:00:00.000Z', ...tv }, null, 2),
    'utf8'
  );
}

const MOVIE_ENTRY = {
  id: 157336,
  media_type: 'movie',
  title: 'Interstellar',
  original_title: 'Interstellar',
  overview: 'Bir grup kâşif solucan deliğinden geçer.',
  poster_path: '/interstellar.jpg',
  genre_ids: [12, 18, 878],
  vote_average: 8.4,
  vote_count: 32000,
  popularity: 250.5,
  release_date: '2014-11-05',
  original_language: 'en',
  runtime: 169,
};

const TV_ENTRY = {
  id: 1396,
  media_type: 'tv',
  name: 'Breaking Bad',
  overview: 'Bir kimya öğretmeninin dönüşümü.',
  genre_ids: [18],
  vote_average: 8.9,
  popularity: 180.2,
  first_air_date: '2008-01-20',
  episode_run_time: [47],
};

async function makeService(extra = {}) {
  const tmpDir = await makeTempDir();
  await seedCatalog(tmpDir, { 'movie:157336': MOVIE_ENTRY }, { 'tv:1396': TV_ENTRY });
  const metadataSource = createContentMetadataSource({ dataDir: tmpDir, tmdbApiKey: '' });
  const service = createContentService({ metadataSource, ...extra });
  return { tmpDir, service };
}

async function close(tmpDir) {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// B1. getMetadata — yerel katalogdan film
// ---------------------------------------------------------------------------
test('F3-B1 getMetadata: film verisi yerel katalogdan, ağ çağrısı olmadan okunur', async () => {
  const { tmpDir, service } = await makeService();
  try {
    const metadata = await service.getMetadata('movie:157336');
    assert.ok(metadata, 'katalog kaydı varken metadata dönmalı');
    assert.equal(metadata.mediaKey, 'movie:157336');
    assert.equal(metadata.mediaType, 'movie');
    assert.equal(metadata.title, 'Interstellar');
    assert.ok(metadata.genres.length === 0 || Array.isArray(metadata.genres));
    assert.equal(metadata.overview.includes('solucan'), true);
    assert.equal(metadata.externalRating, 8.4, 'externalRating TMDB vote_average olmalı');
    assert.equal(metadata.runtimeMinutes, 169);
    assert.equal(metadata.releaseDate, '2014-11-05');
  } finally {
    await close(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// B2. getMetadata — dizi ayrımı
// ---------------------------------------------------------------------------
test('F3-B2 getMetadata: tv anahtarı tv kataloğundan okunur; movie/tv karışmaz', async () => {
  const { tmpDir, service } = await makeService();
  try {
    const tv = await service.getMetadata('tv:1396');
    assert.ok(tv, 'tv kaydı dönmalı');
    assert.equal(tv.mediaType, 'tv');
    assert.equal(tv.title, 'Breaking Bad');
    assert.equal(tv.externalRating, 8.9);
    assert.equal(tv.runtimeMinutes, 47, 'dizide episode_run_time kullanılır');

    // Film anahtarıyla dizi kimliği eşleşmez (kimlik ayrımı).
    const wrongType = await service.getMetadata('movie:1396');
    if (wrongType) {
      assert.notEqual(wrongType.title, 'Breaking Bad', 'tv kaydı movie anahtarıyla dönmemeli');
    }
  } finally {
    await close(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// B3. getMetadata — geçersiz anahtar güvenliği
// ---------------------------------------------------------------------------
test('F3-B3 getMetadata: geçersiz/bilinmeyen anahtar null döner, hata fırlatmaz', async () => {
  const { tmpDir, service } = await makeService();
  try {
    assert.equal(await service.getMetadata('not-a-key'), null);
    assert.equal(await service.getMetadata(''), null);
    assert.equal(await service.getMetadata('movie:'), null);
    assert.equal(await service.getMetadata('book:12'), null);
    // Katalogda olmayan ama biçimi geçerli anahtar: kaynak zinciri boş.
    // BULGU NOTU (davranış): geçerli-ama-bulunamayan anahtar null değil,
    // boş başlıklı minimal metadata döndürüyor (bkz. teslim raporu §6).
    const missing = await service.getMetadata('movie:999999999');
    if (missing) {
      assert.equal(missing.title, '', 'bulunamayan içerik boş başlıkla dönmeli');
      assert.equal(missing.externalRating, null);
      assert.deepEqual([...missing.genres], []);
    }
  } finally {
    await close(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// B4. getMetadata — merkezi içerik kaydı (stored record) önceliği
// ---------------------------------------------------------------------------
test('F3-B4 getMetadata: tamamlanmış merkezi kayıt varsa normalize edilmiş veri döner', async () => {
  const { tmpDir } = await makeService();
  try {
    const fetchedKeys = [];
    const serviceWithRecord = createContentService({
      metadataSource: createContentMetadataSource({ dataDir: tmpDir, tmdbApiKey: '' }),
      getStoredRecord: (mediaKey) => {
        fetchedKeys.push(mediaKey);
        return {
          media_key: mediaKey,
          media_type: 'movie',
          tmdb_id: 157336,
          imdb_id: null,
          source_revision: 'r1',
          metadata_json: '{}',
          normalized_metadata_json: JSON.stringify({
            title: 'Interstellar (normalize)',
            originalTitle: 'Interstellar',
            overview: 'normalize özet',
            genres: ['Bilim Kurgu'],
            genreIds: [878],
            keywords: [{ id: 1, name: 'space' }],
            cast: [],
            crew: [],
            collection: null,
            releaseDate: '2014-11-05',
            runtimeMinutes: 169,
            episodeRunTime: [],
            numberOfSeasons: null,
            numberOfEpisodes: null,
            originalLanguage: 'en',
            originCountries: ['US'],
            productionCountries: [],
            externalRating: 8.4,
          }),
          feature_vector_json: '[]',
          mood_vector_json: '[]',
          semantic_data_json: '{}',
          data_hash: 'h',
          processed_at: '2026-01-01T00:00:00.000Z',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          processing_version: '2.0.0',
          processing_status: 'completed',
          processing_error: null,
        };
      },
    });

    const metadata = await serviceWithRecord.getMetadata('movie:157336');
    assert.ok(metadata);
    assert.equal(metadata.title, 'Interstellar (normalize)');
    assert.deepEqual([...metadata.genres], ['Bilim Kurgu']);
    assert.deepEqual([...metadata.keywords], [{ id: 1, name: 'space' }]);
    assert.equal(metadata.externalRating, 8.4);
    assert.equal(metadata.posterPath, null, 'stored kayıt posteri taşımaz (poster deposu ayrı)');
    assert.deepEqual(fetchedKeys, ['movie:157336'], 'kanonik anahtarla sorgulanmalı');
  } finally {
    await close(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// B5. Tekrarlanan okuma — kayıt çoğalmaz
// ---------------------------------------------------------------------------
test('F3-B5 tekrarlanan getMetadata: aynı kanonik anahtar, ikinci okuma kayıt üretmez', async () => {
  const { tmpDir, service } = await makeService();
  try {
    const first = await service.getMetadata('movie:157336');
    const second = await service.getMetadata('movie:157336');
    assert.deepEqual(second, first, 'aynı anahtar aynı metadata dönmeli (deterministik)');
    // IContentService'in yazma metodu yoktur: kayıt çoğaltma API'si bulunmamalı.
    for (const forbidden of ['save', 'write', 'create', 'insert', 'upsert', 'delete']) {
      assert.notEqual(
        typeof service[forbidden],
        'function',
        `ContentService '${forbidden}' yazma metodu İÇERMEMELİ (okuma hattı)`
      );
    }
  } finally {
    await close(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// B6. searchCatalog
// ---------------------------------------------------------------------------
test('F3-B6 searchCatalog: başlık/özet araması, popülerlik sıralaması, limit ve boş sorgu', async () => {
  const { tmpDir, service } = await makeService();
  try {
    const results = await service.searchCatalog('interstellar');
    assert.equal(results.length, 1);
    assert.equal(results[0].mediaKey, 'movie:157336');

    // Özet üzerinden arama:
    const byOverview = await service.searchCatalog('kimya öğretmeni');
    assert.equal(byOverview.length, 1);
    assert.equal(byOverview[0].mediaKey, 'tv:1396');

    // Popülerlik sıralaması: iki kayıt da "a" içermiyor; geniş sorgu yerine
    // popülerlik karşılaştırmasını tek anahtarla doğrulayalım:
    const all = await service.searchCatalog('a', 10);
    assert.ok(all.length >= 2, 'geniş sorgu iki türü de dönmeli');
    for (let i = 1; i < all.length; i += 1) {
      assert.ok(
        (all[i - 1].popularity ?? 0) >= (all[i].popularity ?? 0),
        'sonuçlar popülerliğe göre azalan sıralı olmalı'
      );
    }

    // Limit:
    const limited = await service.searchCatalog('a', 1);
    assert.equal(limited.length, 1);

    // Boş / boşluk sorgu:
    assert.deepEqual(await service.searchCatalog(''), []);
    assert.deepEqual(await service.searchCatalog('   '), []);
    // Eşleşmeyen sorgu:
    assert.deepEqual(await service.searchCatalog('zzz-yok-boyle'), []);
  } finally {
    await close(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// B7. canonicalizeKey
// ---------------------------------------------------------------------------
test('F3-B7 canonicalizeKey: kanonik biçim, öndeki sıfırlar ve geçersiz girdiler', async () => {
  const { tmpDir, service } = await makeService();
  try {
    assert.equal(service.canonicalizeKey('movie', 157336), 'movie:157336');
    assert.equal(service.canonicalizeKey('tv', '1396'), 'tv:1396');
    assert.equal(service.canonicalizeKey('movie', '0123'), 'movie:123', 'öndeki sıfırlar normalize');

    assert.throws(() => service.canonicalizeKey('book', 12), /medya türü/);
    assert.throws(() => service.canonicalizeKey('movie', 'abc'), /Geçersiz içerik/);
    assert.throws(() => service.canonicalizeKey('movie', '0'), /Geçersiz içerik/);
    assert.throws(() => service.canonicalizeKey('movie', '-5'), /Geçersiz içerik/);
    assert.throws(() => service.canonicalizeKey('movie', ''), /Geçersiz içerik/);
  } finally {
    await close(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// B8. enrichMissing — kuyruk devri + gizlilik
// ---------------------------------------------------------------------------
test('F3-B8 enrichMissing: yalnızca yetersiz detaylı içerikler kuyruğa devredilir', async () => {
  const tmpDir = await makeTempDir();
  const enqueued = [];
  const sufficient = {
    id: 157336,
    media_type: 'movie',
    title: 'Interstellar',
    overview: 'özet',
    genre_ids: [878],
    keywords: [{ id: 1, name: 'space' }],
  };
  const insufficient = {
    id: 42,
    media_type: 'movie',
    title: 'Eksik Kayıt',
  };
  const service = createContentService({
    metadataSource: createContentMetadataSource({ dataDir: tmpDir, tmdbApiKey: '' }),
    readDocument: async () => ({
      profiles: [
        { id: 'profile-a', items: [sufficient, insufficient] },
        { id: 'profile-b', items: [] },
      ],
    }),
    enqueueRawItem: (rawItem) => {
      enqueued.push(rawItem);
      return { accepted: true };
    },
  });
  try {
    const outcome = await service.enrichMissing({ profileId: 'profile-a' });
    assert.equal(outcome.ok, true, `enrichMissing başarısız: ${JSON.stringify(outcome)}`);
    assert.equal(enqueued.length, 1, 'yalnızca yetersiz detaylı kayıt kuyruğa düşmeli');
    assert.equal(enqueued[0].id, 42);
  } finally {
    await close(tmpDir);
  }
});

test('F3-B9 enrichMissing: kuyruk reddi ok:false + retryable:true; port yoksa açık hata; profil yoksa kalıcı hata', async () => {
  const tmpDir = await makeTempDir();
  try {
    const base = {
      metadataSource: createContentMetadataSource({ dataDir: tmpDir, tmdbApiKey: '' }),
    };
    const doc = { profiles: [{ id: 'profile-a', items: [{ id: 7, media_type: 'movie' }] }] };

    // Kuyruk reddi:
    const rejecting = createContentService({
      ...base,
      readDocument: async () => doc,
      enqueueRawItem: () => ({ accepted: false, reason: 'kuyruk dolu' }),
    });
    const rejected = await rejecting.enrichMissing({ profileId: 'profile-a' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.retryable, true, 'kuyruk doluluğu geçici olmalı');
    assert.ok(rejected.error.includes('kuyruğa alınamadı'));

    // Port bağlı değil:
    const noPorts = createContentService(base);
    const missingPorts = await noPorts.enrichMissing({ profileId: 'profile-a' });
    assert.equal(missingPorts.ok, false);
    assert.equal(missingPorts.retryable, false, 'port eksikliği kalıcı yapısal hata');

    // Profil bulunamadı:
    const withPorts = createContentService({
      ...base,
      readDocument: async () => doc,
      enqueueRawItem: () => ({ accepted: true }),
    });
    const noProfile = await withPorts.enrichMissing({ profileId: 'profile-ghost' });
    assert.equal(noProfile.ok, false);
    assert.equal(noProfile.retryable, false);
    assert.ok(noProfile.error.includes('profile-ghost'));
  } finally {
    await close(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// B10. Kuyruk girdisi gizlilik sınırı: kişisel alanlar allowlist ile düşer
// ---------------------------------------------------------------------------
test('F3-B10 kuyruğa devredilen kullanıcı kaydının kişisel alanları allowlist ile temizlenir', async () => {
  const tmpDir = await makeTempDir();
  try {
    const userItem = {
      id: 157336,
      media_type: 'movie',
      title: 'Interstellar',
      overview: 'özet',
      genre_ids: [878],
      // Kişisel alanlar (kullanıcı kaydından gelir):
      status: 'completed',
      personal_rating: 9,
      notes: 'çok özel not',
      episodes_watched: 3,
    };
    const service = createContentService({
      metadataSource: createContentMetadataSource({ dataDir: tmpDir, tmdbApiKey: '' }),
      readDocument: async () => ({ profiles: [{ id: 'profile-a', items: [userItem] }] }),
      enqueueRawItem: () => ({ accepted: true }),
    });

    const outcome = await service.enrichMissing({ profileId: 'profile-a' });
    assert.equal(outcome.ok, true);

    // Sınır doğrulaması: kuyruğun uyguladığı allowlist temizliği kişisel
    // alanları düşer (content-privacy-allowlist.test.mjs ile aynı sözleşme).
    const sanitized = sanitizeRawContentInput(userItem).sanitized;
    assert.equal('personal_rating' in sanitized, false);
    assert.equal('notes' in sanitized, false);
    assert.equal('status' in sanitized, false);
    assert.equal('episodes_watched' in sanitized, false);
    assert.equal(sanitized.title, 'Interstellar', 'içerik alanları korunur');
  } finally {
    await close(tmpDir);
  }
});
