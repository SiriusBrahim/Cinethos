/**
 * F5.3-02 — PersistentStore yazma işlemlerinin modülerleştirilmesi kabul
 * testleri.
 *
 * Katalog, türetilmiş profil, sinema künyesi, stok ve GitHub commit yazma
 * sorumlulukları `src/server/persistent-store/` altındaki ayrı modüllere
 * taşınmıştır. Bu testler yalnızca yeni modülleri değil; veri kaybı, bozuk
 * JSON üzerinde ezme koruması ve gereksiz dosya yazımı engelleme
 * senaryolarını da kapsar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureCatalogFiles,
  readCatalog,
  readCatalogManifest,
} from '../src/server/persistent-store/catalog-store.ts';
import {
  upsertCatalogItemsOp,
  upsertCatalogItemsAsyncOp,
} from '../src/server/persistent-store/catalog-write-store.ts';
import {
  upsertDerivedProfileOp,
  upsertDerivedProfileAsyncOp,
} from '../src/server/persistent-store/derived-profile-write-store.ts';
import { saveCinemaKunyeOp } from '../src/server/persistent-store/cinema-kunye-write-store.ts';
import { saveStockSnapshotUploadOp } from '../src/server/persistent-store/stock-write-store.ts';
import {
  commitFileToGitHubImpl,
  fetchBlobTextByShaImpl,
} from '../src/server/persistent-store/github-commit-store.ts';
import { normalizeDerivedProfileItem } from '../src/core/derived-profile-cache.ts';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-f53-02-'));
  const catalogDir = path.join(root, 'catalog');
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.mkdirSync(profilesDir, { recursive: true });
  const context = {
    catalogDir,
    moviesFile: path.join(catalogDir, 'movies.json'),
    tvFile: path.join(catalogDir, 'tv.json'),
    manifestFile: path.join(catalogDir, 'manifest.json'),
  };
  return {
    root,
    profilesDir,
    context,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function derivedContext(ws) {
  return {
    profileFilePath: (profileId) => path.join(ws.profilesDir, `${profileId}.json`),
    readCatalogManifest: () => readCatalogManifest(ws.context),
    readCatalogManifestAsync: async () => readCatalogManifest(ws.context),
    readExisting: (profileId) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ws.profilesDir, `${profileId}.json`), 'utf8'));
      } catch {
        return null;
      }
    },
    readExistingAsync: async (profileId) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ws.profilesDir, `${profileId}.json`), 'utf8'));
      } catch {
        return null;
      }
    },
  };
}

const DP_BASE = {
  algorithmVersion: 'v1',
  profileFingerprint: 'fp-1',
};

test('F5.3-02 katalog yazma: kayıt ekler, manifest üretir ve hash doğruluğu sağlar', () => {
  const ws = workspace();
  try {
    ensureCatalogFiles(ws.context);
    const result = upsertCatalogItemsOp(ws.context, [
      { id: 550, media_type: 'movie', title: 'Fight Club' },
      { id: 1399, media_type: 'tv', name: 'Band of Brothers' },
    ]);
    assert.equal(result.inserted, 2);
    assert.equal(result.updated, 0);
    assert.equal(result.total, 2);
    assert.match(result.contentHash, /^[a-f0-9]{64}$/);
    assert.equal(readCatalog(ws.context, 'movie')['movie:550'].title, 'Fight Club');

    const manifest = readCatalogManifest(ws.context);
    assert.equal(manifest.movieCount, 1);
    assert.equal(manifest.tvCount, 1);
    assert.equal(manifest.contentHash, result.contentHash);
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 katalog no-op: aynı içerik geldiğinde manifest dosyası yeniden yazılmaz', () => {
  const ws = workspace();
  try {
    ensureCatalogFiles(ws.context);
    const items = [{ id: 550, media_type: 'movie', title: 'Fight Club' }];
    upsertCatalogItemsOp(ws.context, items);
    const manifestBefore = fs.readFileSync(ws.context.manifestFile, 'utf8');
    const mtimeBefore = fs.statSync(ws.context.manifestFile).mtimeMs;

    const second = upsertCatalogItemsOp(ws.context, items);
    assert.equal(second.inserted, 0);
    assert.equal(second.unchanged, 1);
    assert.equal(fs.statSync(ws.context.manifestFile).mtimeMs, mtimeBefore);
    assert.equal(fs.readFileSync(ws.context.manifestFile, 'utf8'), manifestBefore);
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 bozuk JSON ezme koruması: kurtarılamayan movies.json üzerine yazmaz', () => {
  const ws = workspace();
  try {
    const corrupt = '{"movie:": '; // eksik JSON
    fs.writeFileSync(ws.context.moviesFile, corrupt);
    fs.writeFileSync(ws.context.tvFile, '{}');

    assert.throws(() => upsertCatalogItemsOp(ws.context, [{ id: 550, media_type: 'movie', title: 'X' }]));
    // Veri kaybı yok: bozuk dosya ezilmedi.
    assert.equal(fs.readFileSync(ws.context.moviesFile, 'utf8'), corrupt);
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 katalog async yazma: manifest yoksa oluşturur, mıncık yazım atomic kalır', async () => {
  const ws = workspace();
  try {
    const result = await upsertCatalogItemsAsyncOp(ws.context, [
      { id: 500, media_type: 'movie', title: 'Memento' },
    ]);
    assert.equal(result.inserted, 1);
    const manifest = readCatalogManifest(ws.context);
    assert.ok(manifest);
    assert.equal(manifest.movieCount, 1);
    // .bak kurtarma dosyası atomik yazıcı tarafından oluşturulur.
    assert.ok(fs.existsSync(ws.context.moviesFile));
  } finally {
    ws.cleanup();
  }
});

function dpInput(profileId, items, extra = {}) {
  const normalized = {};
  for (const [k, v] of Object.entries(items)) {
    const n = normalizeDerivedProfileItem(k, v);
    if (n) normalized[n.mediaKey] = n;
  }
  return {
    ...DP_BASE,
    profileId,
    items: normalized,
    ...extra,
  };
}

// Not: `normalizeProfileId` kanonik kimliği büyük harfe normalize eder
// (PROFILE_ID_PATTERN). Modül, facade'ın `upsertDerivedProfile` akışında
// olduğu gibi bu kanonik kimliği bağlamına iletir; dosya adı da kanonik
// kimlikten üretilir.
const CANONICAL_PROFILE_A = 'PROFILE-A';

test('F5.3-02 türetilmiş profil yazma: aynı bağlamda ve aynı içerikte no-op', () => {
  const ws = workspace();
  try {
    const ctx = derivedContext(ws);
    const input = dpInput(CANONICAL_PROFILE_A, { 'movie:550': { score: 0.9, reasons: ['a'] } });
    const first = upsertDerivedProfileOp(ctx, input);
    assert.equal(first.updated, true);
    assert.equal(first.count, 1);

    const second = upsertDerivedProfileOp(ctx, input);
    assert.equal(second.updated, false);
    assert.equal(second.contentHash, first.contentHash);
    assert.equal(second.count, 1);
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 türetilmiş profil yazma: bağlam değişiminde eski önbellek taşınmaz', () => {
  const ws = workspace();
  try {
    const ctx = derivedContext(ws);
    upsertDerivedProfileOp(ctx, dpInput(CANONICAL_PROFILE_A, { 'movie:550': { score: 0.9, reasons: ['a'] } }));
    // Profil imzası değişti: bağlam değişimi.
    const next = upsertDerivedProfileOp(ctx, dpInput(CANONICAL_PROFILE_A, { 'movie:42': { score: 0.5, reasons: ['b'] } }, { profileFingerprint: 'fp-2' }));
    assert.equal(next.updated, true);
    // Dosya yolu kanonik kimlikten üretilir: PROFILE-A.json.
    const doc = JSON.parse(fs.readFileSync(path.join(ws.profilesDir, `${CANONICAL_PROFILE_A}.json`), 'utf8'));
    assert.ok(!doc.items['movie:550']);
    assert.ok(doc.items['movie:42']);
    assert.equal(doc.profileFingerprint, 'fp-2');
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 türetilmiş profil: bozuk mevcut dosyada CorruptJsonFileError yerine doğrudan hata fırlatmaz, üzerine yazmaz', () => {
  const ws = workspace();
  try {
    const ctx = derivedContext(ws);
    // Bozuk dosya, modülün yazma hedefiyle AYNI yolda olmalı (kanonik kimlik).
    const filePath = path.join(ws.profilesDir, `${CANONICAL_PROFILE_A}.json`);
    const corrupt = '{ bozuk';
    fs.writeFileSync(filePath, corrupt);
    ctx.readExisting = () => {
      throw new Error('CorruptJsonFileError(deny overwrite)');
    };
    assert.throws(() => upsertDerivedProfileOp(ctx, dpInput(CANONICAL_PROFILE_A, { 'movie:550': { score: 0.9, reasons: ['a'] } })));
    // Bozuk dosya ezilmedi (veri kaybı senaryosu).
    assert.equal(fs.readFileSync(filePath, 'utf8'), corrupt);
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 türetilmiş profil async: geçersiz profil kimliği reddedilir', async () => {
  const ws = workspace();
  try {
    const ctx = derivedContext(ws);
    await assert.rejects(
      () => upsertDerivedProfileAsyncOp(ctx, dpInput('', { 'movie:550': { score: 0.9, reasons: ['a'] } })),
      /Geçersiz profil kimliği/
    );
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 sinema künyesi yazma: merge mevcut girdileri korur, overwrite değiştirir', async () => {
  const ws = workspace();
  try {
    const filePath = path.join(ws.root, 'sinema-kunyesi.json');
    // Gerçek şema: entries, contentId anahtarlı CinemaKunyeEntry kayıtlarıdır.
    const entryA = {
      title: 'Film A',
      year: 1999,
      mediaType: 'movie',
      tmdbId: 550,
      genreIds: [28],
      genres: [{ id: 28, name: 'Aksiyon' }],
      actors: [],
    };
    const entryB = {
      title: 'Dizi B',
      year: 2001,
      mediaType: 'tv',
      tmdbId: 1399,
      genreIds: [18],
      genres: [{ id: 18, name: 'Dram' }],
      actors: [],
    };
    const first = await saveCinemaKunyeOp(
      { filePath, readExisting: async () => null },
      { entries: [entryA] },
      { mode: 'merge' }
    );
    assert.equal(first.ok, true);
    assert.equal(first.entriesCount, 1);
    // İlk yazımda hedef dosya henüz mevcut olmadığından `.bak` üretilmez;
    // `.bak` yalnızca mevcut dosyanın üzerine yazmadan önce oluşturulur.

    const second = await saveCinemaKunyeOp(
      { filePath, readExisting: async () => JSON.parse(fs.readFileSync(filePath, 'utf8')) },
      { entries: [entryB] },
      { mode: 'merge' }
    );
    assert.equal(second.merged, true);
    // İkinci yazımda mevcut dosya geçerli olduğundan `.bak` üretilir.
    assert.ok(fs.existsSync(`${filePath}.bak`));
    const merged = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const titles = Object.values(merged.entries).map((e) => e.title);
    assert.ok(titles.includes('Film A'));
    assert.ok(titles.includes('Dizi B'));

    const third = await saveCinemaKunyeOp(
      { filePath, readExisting: async () => JSON.parse(fs.readFileSync(filePath, 'utf8')) },
      { entries: [entryA] },
      { mode: 'overwrite' }
    );
    assert.equal(third.merged, false);
    const overwritten = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(Object.keys(overwritten.entries).length, 1);
    assert.equal(Object.values(overwritten.entries)[0].title, 'Film A');
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 stok yazma: boş yükleme mevcut yedeği korur, duplikatlar temizlenir', async () => {
  const ws = workspace();
  try {
    const stockFilePath = path.join(ws.root, 'stock.json');
    const ctx = {
      stockFilePath,
      readSnapshot: () => ({ movies: [{ id: 550 }], tv: [], updatedAt: 't0', schemaVersion: 1 }),
    };
    const preserved = await saveStockSnapshotUploadOp(ctx, { movies: [], tv: [] });
    assert.equal(preserved.preservedExistingEmptyUpload, true);
    assert.equal(preserved.moviesCount, 1);

    const written = await saveStockSnapshotUploadOp(ctx, {
      movies: [
        { id: 550 },
        { id: 550 },
        { id: 0 },
      ],
      tv: [{ id: 1399 }],
    });
    assert.equal(written.duplicatesRemoved, 1);
    // Not: `dedupList` yalnızca pozitif tamsayı id'leri geçerli sayar; `0`
    // geçersizdir, boş olmayan string id ise (orijinal davranışla aynı) geçerlidir.
    assert.equal(written.skippedInvalid, 1);
    assert.equal(written.moviesCount, 1);
    assert.equal(written.tvCount, 1);
    const doc = JSON.parse(fs.readFileSync(stockFilePath, 'utf8'));
    assert.equal(doc.schemaVersion, 1);
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 GitHub commit: yapılandırma eksikse config_error; benzer içerik no-op', async () => {
  const unconfigured = await commitFileToGitHubImpl(
    {
      token: undefined,
      owner: undefined,
      repo: undefined,
      branch: 'main',
      getKnownSecretsForRedaction: () => [],
      recoverGitHubTokenOn401: async () => null,
      fetchBlobTextBySha: async () => null,
    },
    'data/catalog/movies.json',
    '{}',
    'test'
  );
  assert.equal(unconfigured.ok, false);
  assert.equal(unconfigured.errorCategory, 'config_error');

  // no-op: uzakta aynı içerik — GET 200 döner, PUT çağrılmaz.
  const content = '{"a":1}';
  const originalFetch = globalThis.fetch;
  let putCalled = false;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith(`contents/data/x.json?ref=${encodeURIComponent('main')}`) || url.includes('contents/data/x.json?ref=')) {
      return new Response(
        JSON.stringify({
          sha: 'abc',
          content: Buffer.from(content, 'utf8').toString('base64'),
          encoding: 'base64',
          size: 7,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    putCalled = true;
    throw new Error('beklenmeyen PUT/istek: ' + url);
  });
  try {
    const noop = await commitFileToGitHubImpl(
      {
        token: 't',
        owner: 'o',
        repo: 'r',
        branch: 'main',
        getKnownSecretsForRedaction: () => [],
        recoverGitHubTokenOn401: async () => null,
        fetchBlobTextBySha: async () => null,
      },
      'data/x.json',
      content.trim(),
      'no-op commit'
    );
    assert.equal(noop.ok, true);
    assert.equal(noop.skippedNoop, true);
    assert.equal(putCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('F5.3-02 GitHub blob yardımcısı: 200 dışı yanıtta null döner', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{"message":"nope"}', { status: 404 }));
  try {
    const text = await fetchBlobTextByShaImpl({ token: 't', owner: 'o', repo: 'r' }, 'sha-1');
    assert.equal(text, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('F5.3-02 katalog yazma: geçersiz kayıtlar güvenle atlanır, geçerli kayıt yazılır', () => {
  const ws = workspace();
  try {
    ensureCatalogFiles(ws.context);
    const result = upsertCatalogItemsOp(ws.context, [
      null,
      undefined,
      'bozuk',
      42,
      [],
      { title: 'Kimliksiz' },
      { id: 0, media_type: 'movie', title: 'Sıfır kimlik' },
      { id: -3, media_type: 'movie', title: 'Negatif kimlik' },
      { id: 'abc', media_type: 'movie', title: 'Metin kimlik' },
      { id: 1.5, media_type: 'movie', title: 'Kesirli kimlik' },
      { id: 9, media_type: 'movie', title: 'Geçerli' },
    ]);

    // Yalnızca geçerli kayıt sayılır; geçersizler sessizce atlanır, hata fırlatılmaz.
    assert.equal(result.inserted, 1);
    assert.equal(result.total, 1);

    const movies = readCatalog(ws.context, 'movie');
    assert.deepEqual(Object.keys(movies), ['movie:9']);
    assert.equal(movies['movie:9'].title, 'Geçerli');
    assert.deepEqual(readCatalog(ws.context, 'tv'), {});

    const manifest = readCatalogManifest(ws.context);
    assert.equal(manifest.movieCount, 1);
    assert.equal(manifest.tvCount, 0);
    assert.equal(manifest.contentHash, result.contentHash);

    // Geçersiz kayıtlar dosyaya yazılmaz ve geçici dosya bırakmaz.
    const catalogEntries = fs.readdirSync(ws.context.catalogDir);
    assert.deepEqual(catalogEntries.filter((name) => name.endsWith('.tmp')), []);
    assert.doesNotThrow(() =>
      JSON.parse(fs.readFileSync(ws.context.moviesFile, 'utf8'))
    );
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 katalog yazma: yalnızca geçersiz kayıt gelirse hiçbir şey yazılmaz', () => {
  const ws = workspace();
  try {
    ensureCatalogFiles(ws.context);
    upsertCatalogItemsOp(ws.context, [{ id: 1, media_type: 'movie', title: 'Eski' }]);
    const moviesBefore = fs.readFileSync(ws.context.moviesFile, 'utf8');
    const manifestBefore = fs.readFileSync(ws.context.manifestFile, 'utf8');
    const manifestMtime = fs.statSync(ws.context.manifestFile).mtimeMs;

    const result = upsertCatalogItemsOp(ws.context, [null, { title: 'Kimliksiz' }, { id: 0 }]);
    assert.equal(result.total, 0);

    assert.equal(fs.readFileSync(ws.context.moviesFile, 'utf8'), moviesBefore);
    assert.equal(fs.readFileSync(ws.context.manifestFile, 'utf8'), manifestBefore);
    assert.equal(fs.statSync(ws.context.manifestFile).mtimeMs, manifestMtime);
    assert.equal(readCatalog(ws.context, 'movie')['movie:1'].title, 'Eski');
  } finally {
    ws.cleanup();
  }
});

test('F5.3-02 yazma sırası: katalog → manifest imzası → türetilmiş profil kaynak imzası', () => {
  const ws = workspace();
  try {
    ensureCatalogFiles(ws.context);
    const ctx = derivedContext(ws);
    const profilePath = path.join(ws.profilesDir, `${CANONICAL_PROFILE_A}.json`);
    const items = { 'movie:550': { score: 0.9, reasons: ['a'] } };

    // 1) Katalog yazımı manifest imzasını üretir.
    const firstCatalog = upsertCatalogItemsOp(ws.context, [
      { id: 550, media_type: 'movie', title: 'Fight Club' },
    ]);
    const firstManifest = readCatalogManifest(ws.context);
    assert.equal(firstManifest.contentHash, firstCatalog.contentHash);

    // 2) Türetilmiş profil, o sıradaki katalog imzasını kaynak olarak alır.
    assert.equal(upsertDerivedProfileOp(ctx, dpInput(CANONICAL_PROFILE_A, items)).updated, true);
    const firstDoc = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.equal(firstDoc.sourceCatalogHash, firstManifest.contentHash);

    // 3) Katalog büyür: manifest imzası değişir, eski imza geçersizleşir.
    const secondCatalog = upsertCatalogItemsOp(ws.context, [
      { id: 1399, media_type: 'tv', name: 'Band of Brothers' },
    ]);
    const secondManifest = readCatalogManifest(ws.context);
    assert.notEqual(secondManifest.contentHash, firstManifest.contentHash);
    assert.equal(secondManifest.contentHash, secondCatalog.contentHash);
    assert.equal(secondManifest.tvCount, 1);

    // 4) Aynı profil imzasıyla yazım artık no-op değildir: kaynak katalog değişti.
    assert.equal(upsertDerivedProfileOp(ctx, dpInput(CANONICAL_PROFILE_A, items)).updated, true);
    const secondDoc = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    assert.equal(secondDoc.sourceCatalogHash, secondManifest.contentHash);
    assert.notEqual(secondDoc.sourceCatalogHash, firstDoc.sourceCatalogHash);

    // 5) Katalog ve içerik sabitken tekrar yazım no-op kalır.
    assert.equal(upsertDerivedProfileOp(ctx, dpInput(CANONICAL_PROFILE_A, items)).updated, false);
  } finally {
    ws.cleanup();
  }
});
