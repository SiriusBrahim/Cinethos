/**
 * F5.3-06 — GitHub geliştirme entegrasyonunun sınır testleri.
 *
 * Kapsanan koşullar:
 *  - profil yedekleme ekranında GitHub'a yükleme seçeneği yok, yerel JSON/Excel/
 *    SQLite yedekleme düğmeleri duruyor,
 *  - PersistentDataStore yalnızca `dataDir` ile yerel işlemleri yapıyor,
 *  - uzak senkronizasyon ayarları ayrı `remoteSync` nesnesinde toplanıyor,
 *  - GitHub route'ları ayrı modülde ve kapalıyken yerel API'ler çalışıyor,
 *  - GitHub token'ı olmadan uygulama açılıp yerel veriyi sunuyor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import { PersistentDataStore } from '../src/server/persistent-store.ts';
import { createDataStorage } from '../src/server/storage.ts';
import {
  buildSyncFailure,
  registerGitHubSyncRoutes,
} from '../src/server/github-routes.ts';
import { createCineTrackApp } from '../src/server/app.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

function readSource(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

const passGuard = (_req, _res, next) => next();

test('F5.3-06 profil yedekleme ekranında GitHub yükleme seçeneği yok, yerel yedekler duruyor', () => {
  const source = readSource('src/components/ProfileBackupTab.tsx');
  for (const token of ['uploadExcelToGithub', 'uploadToGithub', 'githubUpload', 'remoteSyncInfo']) {
    assert.equal(source.includes(token), false, `ProfileBackupTab içinde '${token}' kalmamalı`);
  }
  for (const localFeature of [
    'JSON Yedeği İndir',
    'JSON Yedeği Yükle',
    'SQLite Arşivi İndir',
    'SQLite Arşivinden Geri Yükle',
    'Excel Profil Yedeği (.xlsx)',
  ]) {
    assert.equal(
      source.includes(localFeature),
      true,
      `yerel yedekleme özelliği korunmalı: '${localFeature}'`
    );
  }
  const modal = readSource('src/components/ProfileModal.tsx');
  const backupTabJsx = modal.match(/<ProfileBackupTab[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(backupTabJsx, 'ProfileModal yedekleme sekmesini render etmeli');
  assert.equal(
    backupTabJsx.includes('remoteSyncInfo'),
    false,
    'ProfileModal, yedekleme sekmesine GitHub durumu geçirmemeli'
  );
});

test('F5.3-06 PersistentDataStore yalnızca dataDir ile yerel işlemleri yapar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-f53-boundary-'));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('ağ erişimi beklenmiyordu');
  };
  try {
    const store = new PersistentDataStore({ dataDir: dir });
    store.attachDataStorage(createDataStorage({ dataDir: dir }));

    store.upsertCatalogItems([{ id: 7, media_type: 'movie', title: 'Sınır Testi' }]);
    assert.equal(store.readCatalog('movie')['movie:7'].title, 'Sınır Testi');

    store.upsertCatalogItems([{ id: 9, media_type: 'tv', title: 'Yerel Dizi' }]);
    assert.equal(store.readCatalog('tv')['tv:9'].title, 'Yerel Dizi');

    const status = store.getSyncStatus();
    assert.equal(status.mode, 'local_only');
    assert.equal(status.syncInProgress, false);
    assert.equal(fetchCalls, 0, 'GitHub yapılandırması yokken ağ çağrısı yapılmamalı');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-06 uzak senkronizasyon ayarları ayrı remoteSync nesnesinde toplanır', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-f53-config-'));
  try {
    const store = new PersistentDataStore({
      dataDir: dir,
      remoteSync: {
        enabled: false,
        token: 'test-token',
        owner: 'owner',
        repo: 'repo',
        branch: 'dev',
        isPublicRepo: false,
      },
    });
    store.attachDataStorage(createDataStorage({ dataDir: dir }));
    const status = store.getSyncStatus();
    assert.equal(status.githubSyncEnabled, false);
    assert.equal(status.configured, true);

    const legacy = new PersistentDataStore({ dataDir: dir, githubSyncEnabled: false });
    legacy.attachDataStorage(createDataStorage({ dataDir: dir }));
    assert.equal(legacy.getSyncStatus().githubSyncEnabled, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-06 GitHub route modülü kapalıyken yerel API çalışır, sync uçları 404 döner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-f53-routes-'));
  const store = new PersistentDataStore({ dataDir: dir, githubSyncEnabled: false });
  store.attachDataStorage(createDataStorage({ dataDir: dir }));

  const app = express();
  app.use(express.json());
  registerGitHubSyncRoutes({
    app,
    persistentStore: store,
    githubDevSyncEnabled: false,
    originGuard: passGuard,
    tokenGuard: passGuard,
    syncStatusGuard: passGuard,
  });
  // Yerel veri API'si route modülünden bağımsız kaydedilir.
  app.get('/api/catalog-local', (_req, res) => res.json({ ok: true, local: true }));

  const { server, baseUrl } = await listen(app);
  try {
    const statusRes = await fetch(`${baseUrl}/api/sync/status`);
    assert.equal(statusRes.status, 200);
    assert.equal((await statusRes.json()).githubSyncEnabled, false);

    const pushRes = await fetch(`${baseUrl}/api/sync/push`, { method: 'POST' });
    assert.equal(pushRes.status, 404);
    assert.equal((await pushRes.json()).code, 'github_dev_sync_disabled');

    const localRes = await fetch(`${baseUrl}/api/catalog-local`);
    assert.equal(localRes.status, 200);
    assert.deepEqual(await localRes.json(), { ok: true, local: true });
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F5.3-06 buildSyncFailure kilit çekişmesini 409, diğer hataları 500 ve maskelenmiş döndürür', () => {
  const contention = buildSyncFailure(
    Object.assign(new Error('kilit dolu'), { code: 'sync_lease_busy' }),
    'push',
    'yedek',
    ['secret-token']
  );
  assert.equal(contention.status, 409);
  assert.equal(contention.body.errors[0].category, 'sync_in_progress');

  const failure = buildSyncFailure(new Error('token=secret-token'), 'push', 'yedek', [
    'secret-token',
  ]);
  assert.equal(failure.status, 500);
  assert.equal(failure.body.errors[0].message.includes('secret-token'), false);
});

test('F5.3-06 GitHub token’ı olmadan uygulama açılır ve yerel veri API’si yanıt verir', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-f53-boot-'));
  const runtime = createCineTrackApp({ dataDir: dir });
  const { server, baseUrl } = await listen(runtime.app);
  try {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);

    const localRes = await fetch(`${baseUrl}/api/data`);
    assert.equal(localRes.status, 200);
    const localBody = await localRes.json();
    assert.equal(typeof localBody, 'object');

    const syncRes = await fetch(`${baseUrl}/api/sync/push`, { method: 'POST' });
    assert.equal(syncRes.status, 404);
    assert.equal((await syncRes.json()).code, 'github_dev_sync_disabled');
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
