/**
 * F5.3-05 — GitHub entegrasyon izolasyonu sınır testi.
 *
 * İki şeyi doğrular:
 *  1. Statik bağımlılık yönü: çekirdek/uygulama/servis katmanları GitHub
 *     modüllerini import etmez; yerel veri katmanı (persistent-store) motoru
 *     yalnızca saf port üzerinden kullanır ve kalan GitHub import'ları bilinen,
 *     dondurulmuş bir liste ile sınırlıdır.
 *  2. Davranış: GitHub motoru kayıtlı değilken uygulamanın yerel veri yolları
 *     çalışır, hiçbir ağ çağrısı yapılmaz ve senkron çağrıları yapılandırma
 *     hatası raporu döndürür.
 *
 * Bu dosya `app.ts` veya `github-sync/register.ts` import etmez; bu nedenle
 * kayıt defteri boş kalır ve "entegrasyon yok" senaryosu gerçekten koşulur.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PersistentDataStore } from '../src/server/persistent-store.ts';
import { createDataStorage } from '../src/server/storage.ts';
import { isRemoteSyncEngineRegistered } from '../src/server/persistence/remote-sync-registry.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

function listSourceFiles(dir, acc = []) {
  const abs = path.join(repoRoot, dir);
  if (!fs.existsSync(abs)) return acc;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(rel, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(rel);
  }
  return acc;
}

function importsOf(relPath) {
  const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  const specifiers = [];
  for (const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) specifiers.push(m[1]);
  for (const m of source.matchAll(/import\s+['"]([^'"]+)['"]/g)) specifiers.push(m[1]);
  return specifiers;
}

/** `import type` / `import { type X }` gibi derleme-zamanı bağlantıları ayıklar. */
function runtimeImportsOf(relPath) {
  const source = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  const runtime = [];
  for (const m of source.matchAll(/import\s+(?!type\b)([^;]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const clause = m[1].replace(/\{[^}]*\}/g, (block) =>
      block
        .slice(1, -1)
        .split(',')
        .filter((part) => part.trim() && !/^\s*type\s/.test(part))
        .join(',')
    );
    if (!/^\s*$/.test(clause.replace(/[{}]/g, '').replace(/,/g, ''))) runtime.push(m[2]);
  }
  for (const m of source.matchAll(/import\s+['"]([^'"]+)['"]/g)) runtime.push(m[1]);
  return runtime;
}

test('F5.3-05 çekirdek, uygulama, servis ve modüller GitHub modülü import etmez', () => {
  const layers = ['src/core', 'src/app', 'src/components', 'src/services', 'src/shared', 'src/modules'];
  const offenders = [];
  for (const layer of layers) {
    for (const file of listSourceFiles(layer)) {
      for (const spec of importsOf(file)) {
        if (/github/i.test(spec)) offenders.push(`${file} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `GitHub bağımlılığı sızıntısı: ${offenders.join(', ')}`);
});

test('F5.3-05 yerel veri katmanı senkronizasyon motorunu import etmez', () => {
  const specifiers = importsOf('src/server/persistent-store.ts');
  assert.equal(
    specifiers.some((s) => s.includes('github-bidirectional-sync') || s.includes('github-sync/')),
    false,
    'persistent-store.ts GitHub senkronizasyon modüllerini import etmemeli'
  );
});

test('F5.3-06 yerel veri katmanı GitHub modüllerini çalışma zamanında statik import etmez', () => {
  // F5.3-06: kalan GitHub bağlantıları yalnızca tip (`import type`) düzeyindedir;
  // çalışma zamanı yardımcıları GitHub'a özgü metotların içinde dinamik yüklenir.
  const runtime = runtimeImportsOf('src/server/persistent-store.ts');
  assert.deepEqual(
    runtime.filter((s) => /github/i.test(s)),
    [],
    'persistent-store.ts çalışma zamanında GitHub modülü yüklememeli'
  );
  assert.deepEqual(
    runtime.filter((s) => /github/i.test(s)).length,
    0,
    'yerel veri yolları GitHub kodunu çalıştırmamalı'
  );
});

test('F5.3-05 uzak senkronizasyon portu sağlayıcıdan bağımsızdır', () => {
  const portPath = 'src/server/persistence/remote-sync-port.ts';
  const raw = fs.readFileSync(path.join(repoRoot, portPath), 'utf8');
  // Yorumlar sağlayıcı adını yalnızca "bağımlı değildir" ifadesiyle anabilir;
  // kural, kod (tip/üye/import) düzeyinde sağlayıcı bağımsızlığıdır.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/github/i.test(code), false, 'port modülü kodunda sağlayıcı adı olmamalı');
  assert.deepEqual(
    importsOf(portPath).filter((s) => /github/i.test(s)),
    [],
    'port modülü GitHub import etmemeli'
  );
});

test('F5.3-05 GitHub motoru yalnızca tek kayıt noktasında bağlanır', () => {
  const callers = listSourceFiles('src').filter((file) =>
    /import\s+['"][^'"]*github-sync\/register\.ts['"]/.test(
      fs.readFileSync(path.join(repoRoot, file), 'utf8')
    )
  );
  assert.deepEqual(callers.sort(), ['src/server/app.ts']);
  const registrations = listSourceFiles('src').filter((file) =>
    fs.readFileSync(path.join(repoRoot, file), 'utf8').includes('registerRemoteSyncEngineFactory(')
  );
  assert.deepEqual(
    registrations.sort(),
    ['src/server/github-sync/register.ts', 'src/server/persistence/remote-sync-registry.ts']
  );
});

test('F5.3-05 motor kayıtlı değilken yerel veri yolları çalışır ve ağ çağrısı yapılmaz', async () => {
  assert.equal(isRemoteSyncEngineRegistered(), false, 'bu test sürecinde motor kayıtlı olmamalı');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-f53-isolation-'));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('ağ erişimi beklenmiyordu');
  };
  try {
    const store = new PersistentDataStore({
      dataDir: dir,
      githubSyncEnabled: false,
      githubToken: 'dummy-token-for-local-test',
      githubOwner: 'owner',
      githubRepo: 'repo',
    });
    store.attachDataStorage(createDataStorage({ dataDir: dir }));

    // Yerel yazma/okuma GitHub'dan bağımsız çalışır.
    store.upsertCatalogItems([{ id: 1, media_type: 'movie', title: 'Yerel' }]);
    assert.equal(store.readCatalog('movie')['movie:1'].title, 'Yerel');

    // Motor yoksa senkron çağrıları yapılandırma hatası raporu döndürür.
    const report = await store.pushToGitHub();
    assert.equal(report.ok, false);
    assert.equal(report.errors[0]?.category, 'config_error');
    assert.equal(fetchCalls, 0, 'uzak senkronizasyon yokken ağ çağrısı yapılmamalı');

    const status = store.getSyncStatus();
    assert.equal(status.githubSyncEnabled, false);
    assert.equal(status.syncInProgress, false);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
