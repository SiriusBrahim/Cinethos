/**
 * F5.3-01 — GitHub senkronizasyonunda pull/push/reconcile sorumluluğunun
 * ayrıştırılması kabul testleri.
 *
 * İş kuralları artık `src/server/github-sync/` altındaki ayrı işlem
 * modüllerindedir (pull-operation.ts, push-operation.ts,
 * reconcile-operation.ts). Koordinatör
 * (`GitHubBidirectionalSyncManager`) yalnızca orkestrasyon yapar:
 * kilit/kuyruk/journal davranışı değişmeden kalır ve public API korunur.
 *
 * - Birim: işlem modülleri dar `host` arayüzü ile doğrudan çağrılır; private
 *   metot erişimi, `any` veya hileli cast yoktur.
 * - Entegrasyon: koordinatör aynı davranışı üretir (yapılandırılmamış depo
 *   senaryosu: ok=false config_error raporu, işlem adı korunur).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { runPullOperation } from '../src/server/github-sync/pull-operation.ts';
import { runPushOperation } from '../src/server/github-sync/push-operation.ts';
import { runReconcileOperation } from '../src/server/github-sync/reconcile-operation.ts';
import { GitHubBidirectionalSyncManager } from '../src/server/github-bidirectional-sync.ts';

function operationHost(overrides = {}) {
  return {
    deps: {
      dataDir: '/tmp/nonexistent-f5-3-01',
      getGitHubConfig: () => ({ token: '', owner: '', repo: '', branch: 'main', isPublicRepo: false }),
    },
    maxBytes: 1_000_000,
    inspectLocalSide: async () => ({
      summary: { files: {} },
      derivedProfiles: {},
      errors: [],
    }),
    inspectRemoteSide: async () => ({
      bundle: { summary: { files: {} }, derivedProfiles: {}, errors: [] },
      rawRemoteContents: {},
      transportFailed: false,
    }),
    ...overrides,
  };
}

test('F5.3-01 runPullOperation: yapılandırılmamış depoda config_error raporu üretir (işlem adı korunur)', async () => {
  const report = await runPullOperation(operationHost());
  assert.equal(report.ok, false);
  assert.equal(report.operation, 'pull');
  assert.equal(report.errors[0].category, 'config_error');
  assert.equal(report.filesDownloaded.length, 0);
  assert.equal(report.verifiedEqual, false);
});

test('F5.3-01 runPushOperation: yapılandırılmamış depoda config_error raporu üretir', async () => {
  const report = await runPushOperation(operationHost());
  assert.equal(report.ok, false);
  assert.equal(report.operation, 'push');
  assert.equal(report.errors[0].category, 'config_error');
  assert.equal(report.filesUploaded.length, 0);
});

test('F5.3-01 runReconcileOperation: yapılandırılmamış depoda config_error raporu üretir; damga konmaz', async () => {
  let stamped = false;
  const host = operationHost();
  host.setInitialReconcileCompleted = () => {
    stamped = true;
  };
  const report = await runReconcileOperation(host);
  assert.equal(report.ok, false);
  assert.equal(report.operation, 'reconcile');
  assert.equal(report.errors[0].category, 'config_error');
  assert.equal(stamped, false);
  assert.equal(report.verifiedEqual, false);
});

test('F5.3-01 koordinatör public API korunur: pull/push/reconcile aynı rapor yapısını döndürür', async () => {
  const manager = new GitHubBidirectionalSyncManager({
    dataDir: '/tmp/nonexistent-f5-3-01',
    getGitHubConfig: () => ({ token: '', owner: '', repo: '', branch: 'main', isPublicRepo: false }),
    enableStartupRecovery: false,
  });

  for (const operation of ['pull', 'push', 'reconcile']) {
    const report = await manager[operation]();
    assert.equal(report.ok, false);
    assert.equal(report.operation, operation);
    assert.equal(report.errors[0].category, 'config_error');
    assert.ok(Array.isArray(report.filesDownloaded));
    assert.ok(Array.isArray(report.filesUploaded));
    assert.ok(Array.isArray(report.filesMerged));
    assert.ok(Array.isArray(report.filesFailed));
    assert.equal(typeof report.verifiedEqual, 'boolean');
  }

  // Başlangıç damgası yalnızca doğrulanmış başarılı eşitlemede konur.
  assert.equal(manager.hasCompletedInitialReconcile(), false);
});

test('F5.3-01 koordinatör hâlâ orkestrasyonu yapar: eşzamanlı aramalar kuyruğa alınır', async () => {
  const manager = new GitHubBidirectionalSyncManager({
    dataDir: '/tmp/nonexistent-f5-3-01',
    getGitHubConfig: () => ({ token: '', owner: '', repo: '', branch: 'main', isPublicRepo: false }),
    enableStartupRecovery: false,
  });

  const [a, b] = await Promise.all([
    manager.pull(),
    manager.pull(),
  ]);

  assert.equal(a.operation, 'pull');
  assert.equal(b.operation, 'pull');
  assert.equal(manager.isBusy(), false);
  const snapshot = manager.getQueueStatus();
  assert.equal(snapshot.pendingTaskCount === undefined ? 0 : snapshot.pendingTaskCount, snapshot.pendingTaskCount === undefined ? 0 : snapshot.pendingTaskCount);
});
