/**
 * MIA Faz 1 — Adım 1.2 (Dilim B/F): Gerçek sunucu yaşam döngüsü entegrasyon testi.
 *
 * Kabul kriterleri (docs/mia/faz1-faz2-uygulama-plani.md 1.2):
 *  - createCineTrackApp'in döndürdüğü runtime, gerçek sunucu açılış akışında
 *    startRuntimeModules() ile başlar; modüller healthCheck'te "healthy" olur.
 *  - Kapanışta stopRuntimeModules() modülleri ters sırada durdurur.
 *  - server-lifecycle kapatma akışı idempotenttir; SQLite kapatma ve
 *    zamanlayıcı temizliği tam olarak bir kez çalışır.
 *  - startRuntimeModules hatasında süreç hata ile başlatmayı reddeder.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createCineTrackApp } from '../src/server/app.ts';
import { createServerLifecycle } from '../src/server/server-lifecycle.ts';

async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'cinethos-lifecycle-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Sunucu yaşam döngüsü: modüller başlar, healthCheck healthy döner ve kapanışta durur', async () => {
  await withTempDir(async (dir) => {
    const runtime = createCineTrackApp({ dataDir: dir });

    await runtime.startRuntimeModules();

    const startedHealth = await runtime.moduleRegistry.healthCheckAll();
    const byId = new Map(startedHealth.map((h) => [h.moduleId, h.status]));
    assert.equal(byId.get('primary-storage'), 'healthy');
    assert.equal(byId.get('backup-sync'), 'healthy');
    // taste-engine aboneliği kurulduktan sonra healthy veya bootstrap pending olabilir.
    assert.ok(['healthy', 'degraded'].includes(byId.get('taste-engine') ?? ''));

    await runtime.stopRuntimeModules();

    const stoppedHealth = await runtime.moduleRegistry.healthCheckAll();
    const stoppedById = new Map(stoppedHealth.map((h) => [h.moduleId, h.status]));
    assert.equal(stoppedById.get('primary-storage'), 'degraded');
    assert.equal(stoppedById.get('backup-sync'), 'degraded');
  });
});

test('Sunucu yaşam döngüsü: kapatma idempotenttir, SQLite ve zamanlayıcılar tam bir kez temizlenir', async () => {
  let startCalls = 0;
  let stopCalls = 0;
  let storageCloseCalls = 0;
  const disposed = [];

  const lifecycle = createServerLifecycle({
    startRuntimeModules: async () => {
      startCalls += 1;
    },
    stopRuntimeModules: async () => {
      stopCalls += 1;
    },
    closeStorage: () => {
      storageCloseCalls += 1;
    },
    logger: { info: () => {}, warn: () => {} },
    exitProcess: () => {},
  });

  lifecycle.addCleanup(() => disposed.push('timer-1'));
  lifecycle.addCleanup(() => disposed.push('timer-2'));

  await lifecycle.start();
  await lifecycle.start(); // ikinci çağrı no-op
  assert.equal(startCalls, 1);

  await lifecycle.shutdown('test-1');
  await lifecycle.shutdown('test-2'); // idempotent

  assert.equal(stopCalls, 1);
  assert.equal(storageCloseCalls, 1);
  assert.deepEqual(disposed, ['timer-1', 'timer-2']);
  assert.equal(lifecycle.isShuttingDown(), true);
});

test('Sunucu yaşam döngüsü: modül başlatma hatası süreç başlatmayı başarısız kılar', async () => {
  const lifecycle = createServerLifecycle({
    startRuntimeModules: async () => {
      throw new Error('modül başlatılamadı');
    },
    stopRuntimeModules: async () => {},
    logger: { info: () => {}, warn: () => {} },
    exitProcess: () => {},
  });

  await assert.rejects(() => lifecycle.start(), /modül başlatılamadı/);
});

test('Sunucu yaşam döngüsü: kapatma sırasında modüller başlatılamaz', async () => {
  const lifecycle = createServerLifecycle({
    startRuntimeModules: async () => {},
    stopRuntimeModules: async () => {},
    logger: { info: () => {}, warn: () => {} },
    exitProcess: () => {},
  });

  await lifecycle.shutdown();
  await assert.rejects(() => lifecycle.start(), /kapatma aşamasında/);
});
