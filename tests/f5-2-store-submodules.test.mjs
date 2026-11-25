/**
 * Aşama 5.2 — F5.2-03 kabul testleri.
 *
 * Facade'dan ayrılan katalog ve türetilmiş profil alt mağazaları doğrudan
 * test edilir: atomik yazma, bozuk JSON kurtarması ve doğrulama davranışı
 * değişmeden korunmalıdır.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureCatalogFiles,
  ensureCatalogFilesAsync,
  readCatalog,
  readCatalogManifest,
} from '../src/server/persistent-store/catalog-store.ts';
import {
  readDerivedProfile,
  readDerivedProfileAsync,
  readValidatedDerivedProfile,
} from '../src/server/persistent-store/derived-profile-store.ts';

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-store-submodule-'));
  const catalogDir = path.join(root, 'catalog');
  const profilesDir = path.join(root, 'profiles');
  fs.mkdirSync(profilesDir, { recursive: true });
  return {
    root,
    profilesDir,
    context: {
      catalogDir,
      moviesFile: path.join(catalogDir, 'movies.json'),
      tvFile: path.join(catalogDir, 'tv.json'),
      manifestFile: path.join(catalogDir, 'manifest.json'),
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('F5.2-03 katalog mağazası: dosyaları ve manifesti oluşturur, geri okur', () => {
  const ws = workspace();
  try {
    ensureCatalogFiles(ws.context);
    assert.ok(fs.existsSync(ws.context.moviesFile));
    assert.ok(fs.existsSync(ws.context.tvFile));
    assert.deepEqual(readCatalog(ws.context, 'movie'), {});
    assert.deepEqual(readCatalog(ws.context, 'tv'), {});

    const manifest = readCatalogManifest(ws.context);
    assert.ok(manifest);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.movieCount, 0);
    assert.equal(manifest.tvCount, 0);
    assert.match(manifest.contentHash, /^[a-f0-9]{64}$/);

    fs.writeFileSync(
      ws.context.moviesFile,
      JSON.stringify({ 'movie:550': { key: 'movie:550', id: 550, title: 'Fight Club' } })
    );
    assert.equal(readCatalog(ws.context, 'movie')['movie:550'].title, 'Fight Club');
  } finally {
    ws.cleanup();
  }
});

test('F5.2-03 katalog mağazası: async hazırlık aynı dosya kümesini üretir', async () => {
  const ws = workspace();
  try {
    await ensureCatalogFilesAsync(ws.context);
    assert.ok(fs.existsSync(ws.context.manifestFile));
    assert.ok(fs.existsSync(ws.context.moviesFile));
    assert.ok(fs.existsSync(ws.context.tvFile));
  } finally {
    ws.cleanup();
  }
});

test('F5.2-03 katalog mağazası: bozuk JSON varsayılan olarak hata verir, izinle boş döner', () => {
  const ws = workspace();
  try {
    fs.mkdirSync(ws.context.catalogDir, { recursive: true });
    fs.writeFileSync(ws.context.moviesFile, '{bozuk json');
    assert.throws(() => readCatalog(ws.context, 'movie'), /movies\.json|JSON/i);
    assert.deepEqual(readCatalog(ws.context, 'movie', { allowEmptyOnCorrupt: true }), {});
  } finally {
    ws.cleanup();
  }
});

test('F5.2-03 türetilmiş profil mağazası: eksik belge null, geçerli belge okunur', () => {
  const ws = workspace();
  try {
    const context = {
      profileFilePath: (profileId) => path.join(ws.profilesDir, `${profileId.toLowerCase()}.json`),
    };
    assert.equal(readDerivedProfile(context, 'PROFILE-A'), null);

    const doc = {
      schemaVersion: 1,
      profileId: 'PROFILE-A',
      algorithmVersion: 'v3',
      profileFingerprint: 'fp',
      generatedAt: '2026-11-25T00:00:00.000Z',
      items: {},
    };
    fs.writeFileSync(path.join(ws.profilesDir, 'profile-a.json'), JSON.stringify(doc));
    assert.deepEqual(readDerivedProfile(context, 'PROFILE-A'), doc);
  } finally {
    ws.cleanup();
  }
});

test('F5.2-03 türetilmiş profil mağazası: bozuk dosya seçeneklere göre hata verir veya null döner', async () => {
  const ws = workspace();
  try {
    const context = {
      profileFilePath: (profileId) => path.join(ws.profilesDir, `${profileId.toLowerCase()}.json`),
    };
    fs.writeFileSync(path.join(ws.profilesDir, 'profile-a.json'), '{bozuk');
    assert.throws(() => readDerivedProfile(context, 'PROFILE-A'), /profile-a\.json|JSON/i);
    assert.equal(readDerivedProfile(context, 'PROFILE-A', { allowNullOnCorrupt: true }), null);
    assert.equal(
      await readDerivedProfileAsync(context, 'PROFILE-A', { allowNullOnCorrupt: true }),
      null
    );
  } finally {
    ws.cleanup();
  }
});

test('F5.2-03 türetilmiş profil mağazası: doğrulama imza/şema uyuşmazlığını reddeder', () => {
  const ws = workspace();
  try {
    const context = {
      profileFilePath: (profileId) => path.join(ws.profilesDir, `${profileId.toLowerCase()}.json`),
    };
    const doc = {
      schemaVersion: 2,
      profileId: 'PROFILE-A',
      algorithmVersion: 'v3',
      profileFingerprint: 'fp',
      sourceCatalogHash: 'hash-1',
      generatedAt: '2026-11-25T00:00:00.000Z',
      items: {},
    };
    fs.writeFileSync(path.join(ws.profilesDir, 'profile-a.json'), JSON.stringify(doc));

    const valid = readValidatedDerivedProfile(context, 'PROFILE-A', {
      profileFingerprint: 'fp',
      algorithmVersion: 'v3',
      sourceCatalogHash: 'hash-1',
    });
    assert.equal(valid.valid, true);

    const wrongFingerprint = readValidatedDerivedProfile(context, 'PROFILE-A', {
      profileFingerprint: 'baska',
      algorithmVersion: 'v3',
    });
    assert.equal(wrongFingerprint.valid, false);

    const missing = readValidatedDerivedProfile(context, 'PROFILE-B', {
      profileFingerprint: 'fp',
      algorithmVersion: 'v3',
    });
    assert.equal(missing.valid, false);
    assert.equal(missing.reason, 'missing_document');
  } finally {
    ws.cleanup();
  }
});
