/**
 * F5.3-02 — Yerel kalıcı veri yönetiminin güvenilirlik testleri.
 *
 * Kapsam: tek/art arda/eşzamanlı yazma, yazma ve rename hataları, bozuk JSON,
 * eksik dosya, eski geçerli verinin korunması, okuma sırasında yazma, yeniden
 * açılışta tutarlılık, türetilmiş profil tutarlılığı, kesintiye uğramış yazma
 * kurtarması ve kısmi veri kaybının engellenmesi.
 *
 * Tüm senaryolar gerçek geçici dizinlerde ve gerçek dosya sistemi üzerinde
 * koşar; ağ veya GitHub bağlantısı yoktur.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PersistentDataStore } from '../src/server/persistent-store.ts';

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-f53-local-'));
}

function makeStore(dir) {
  return new PersistentDataStore({ dataDir: dir, githubSyncEnabled: false });
}

function tmpFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

test('F5.3-02 tekil kayıt: katalog kaydı yazılır ve okunur', () => {
  const dir = makeDir();
  try {
    const store = makeStore(dir);
    const result = store.upsertCatalogItems([{ id: 550, media_type: 'movie', title: 'Fight Club' }]);
    assert.equal(result.inserted, 1);
    assert.equal(store.readCatalog('movie')['movie:550'].title, 'Fight Club');
    assert.deepEqual(tmpFiles(path.join(dir, 'catalog')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 art arda çoklu kayıt: sıralı yazmalar birbirini ezmez', () => {
  const dir = makeDir();
  try {
    const store = makeStore(dir);
    for (let i = 1; i <= 5; i += 1) {
      store.upsertCatalogItems([{ id: i, media_type: 'movie', title: `Film ${i}` }]);
    }
    const movies = store.readCatalog('movie');
    assert.equal(Object.keys(movies).length, 5);
    for (let i = 1; i <= 5; i += 1) {
      assert.equal(movies[`movie:${i}`].title, `Film ${i}`);
    }
    const manifest = store.readCatalogManifest();
    assert.equal(manifest.movieCount, 5);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 eşzamanlı kayıt: seri hale getirici tüm yazmaları korur', async () => {
  const dir = makeDir();
  try {
    const store = makeStore(dir);
    await Promise.all([
      store.upsertCatalogItemsSerialized([{ id: 10, media_type: 'movie', title: 'A' }]),
      store.upsertCatalogItemsSerialized([{ id: 11, media_type: 'movie', title: 'B' }]),
      store.upsertCatalogItemsSerialized([{ id: 12, media_type: 'tv', name: 'C' }]),
    ]);
    const movies = store.readCatalog('movie');
    assert.deepEqual(Object.keys(movies).sort(), ['movie:10', 'movie:11']);
    assert.deepEqual(Object.keys(store.readCatalog('tv')), ['tv:12']);
    assert.deepEqual(tmpFiles(path.join(dir, 'catalog')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 yazma hatası: önceki geçerli veri korunur, geçici dosya kalmaz', () => {
  const dir = makeDir();
  try {
    const store = makeStore(dir);
    store.upsertCatalogItems([{ id: 1, media_type: 'movie', title: 'Eski' }]);
    assert.throws(() =>
      store.upsertCatalogItems([{ id: 2, media_type: 'movie', title: 'Yeni' }], {
        beforeRenameHook: () => {
          throw new Error('disk yazma hatası (simülasyon)');
        },
      })
    );
    const movies = store.readCatalog('movie');
    assert.equal(movies['movie:1'].title, 'Eski');
    assert.equal(movies['movie:2'], undefined);
    assert.deepEqual(tmpFiles(path.join(dir, 'catalog')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 rename hatası: hedef yerinde dizin varken yazma başarısız olur, dizin korunur', () => {
  const dir = makeDir();
  try {
    const catalogDir = path.join(dir, 'catalog');
    fs.mkdirSync(path.join(catalogDir, 'movies.json'), { recursive: true });
    const store = makeStore(dir);
    assert.throws(() => store.upsertCatalogItems([{ id: 3, media_type: 'movie', title: 'X' }]));
    assert.equal(fs.statSync(path.join(catalogDir, 'movies.json')).isDirectory(), true);
    assert.deepEqual(tmpFiles(catalogDir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 bozuk JSON: kurtarılamayan dosya ezilmez ve hata bildirilir', () => {
  const dir = makeDir();
  try {
    const catalogDir = path.join(dir, 'catalog');
    fs.mkdirSync(catalogDir, { recursive: true });
    const corrupt = '{"movie:": ';
    fs.writeFileSync(path.join(catalogDir, 'movies.json'), corrupt);
    fs.writeFileSync(path.join(catalogDir, 'tv.json'), '{}');
    const store = makeStore(dir);
    assert.throws(() => store.upsertCatalogItems([{ id: 4, media_type: 'movie', title: 'Y' }]));
    assert.equal(fs.readFileSync(path.join(catalogDir, 'movies.json'), 'utf8'), corrupt);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 eksik dosya: okuma boş döner, hazırlık dosyaları oluşturur', async () => {
  const dir = makeDir();
  try {
    const store = makeStore(dir);
    assert.deepEqual(store.readCatalog('movie'), {});
    assert.equal(store.readCatalogManifest(), null);
    await store.ensureCatalogFilesAsync();
    for (const name of ['movies.json', 'tv.json', 'manifest.json']) {
      assert.equal(fs.existsSync(path.join(dir, 'catalog', name)), true, name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 okuma sırasında yazma: okunan içerik her zaman geçerli JSON olur', async () => {
  const dir = makeDir();
  try {
    const store = makeStore(dir);
    store.upsertCatalogItems([{ id: 1, media_type: 'movie', title: 'Başlangıç' }]);
    const pending = store.upsertCatalogItemsSerialized([
      { id: 2, media_type: 'movie', title: 'Sırada' },
      { id: 3, media_type: 'movie', title: 'Sırada 2' },
    ]);
    // Yazma sürerken oku: yarım kalmış JSON asla görünmemeli.
    const during = store.readCatalog('movie');
    assert.ok(during['movie:1']);
    const raw = fs.readFileSync(path.join(dir, 'catalog', 'movies.json'), 'utf8');
    assert.doesNotThrow(() => JSON.parse(raw));
    await pending;
    assert.equal(Object.keys(store.readCatalog('movie')).length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 yeniden açılış: yeni store örneği aynı veriyi ve manifesti okur', () => {
  const dir = makeDir();
  try {
    const first = makeStore(dir);
    first.upsertCatalogItems([
      { id: 1, media_type: 'movie', title: 'Kalıcı' },
      { id: 2, media_type: 'tv', name: 'Dizi' },
    ]);
    const second = makeStore(dir);
    assert.equal(second.readCatalog('movie')['movie:1'].title, 'Kalıcı');
    assert.equal(second.readCatalog('tv')['tv:2'].title, 'Dizi');
    assert.equal(second.readCatalogManifest().movieCount, 1);
    assert.equal(second.readCatalogManifest().tvCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 türetilmiş profil: içerik tutarlı, aynı içerik yeniden yazılmaz', () => {
  const dir = makeDir();
  try {
    const store = makeStore(dir);
    store.upsertCatalogItems([{ id: 1, media_type: 'movie', title: 'A' }]);
    const input = {
      profileId: 'PROFILE-A',
      profileFingerprint: 'fp-1',
      algorithmVersion: 'v1',
      items: { 'movie:1': { score: 0.8, reasons: ['test'] } },
    };
    const first = store.upsertDerivedProfile(input);
    assert.equal(first.updated, true);
    const mtime = fs.statSync(store.getProfileFilePath('PROFILE-A')).mtimeMs;
    const second = store.upsertDerivedProfile(input);
    assert.equal(second.updated, false);
    assert.equal(second.contentHash, first.contentHash);
    assert.equal(fs.statSync(store.getProfileFilePath('PROFILE-A')).mtimeMs, mtime);
    const doc = store.readDerivedProfile('PROFILE-A');
    assert.equal(doc.contentHash, first.contentHash);
    assert.equal(doc.sourceCatalogHash, store.readCatalogManifest().contentHash);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 kesintiye uğramış yazma: kalan .tmp dosyası temizlenir, veri korunur', () => {
  const dir = makeDir();
  try {
    const store = makeStore(dir);
    store.upsertCatalogItems([{ id: 1, media_type: 'movie', title: 'Sağlam' }]);
    const catalogDir = path.join(dir, 'catalog');
    const stale = path.join(catalogDir, `movies.json.${process.pid}.1.0.tmp`);
    fs.writeFileSync(stale, '{"movie:1": {"title": "yarım');
    // Yeniden açılış: yarım yazma artığı temizlenir.
    const reopened = makeStore(dir);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(reopened.readCatalog('movie')['movie:1'].title, 'Sağlam');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-02 kısmi veri kaybı: bozuk manifest kataloğu düşürmez', () => {
  const dir = makeDir();
  try {
    const store = makeStore(dir);
    store.upsertCatalogItems([{ id: 1, media_type: 'movie', title: 'Korunan' }]);
    const manifestPath = path.join(dir, 'catalog', 'manifest.json');
    fs.writeFileSync(manifestPath, '{bozuk manifest');
    const reopened = makeStore(dir);
    assert.equal(reopened.readCatalogManifest(), null);
    assert.equal(reopened.readCatalog('movie')['movie:1'].title, 'Korunan');
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), '{bozuk manifest');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
