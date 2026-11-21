import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PersistentDataStore } from '../src/server/persistent-store.ts';
import { createDataStorage } from '../src/server/storage.ts';
import { GitHubBidirectionalSyncManager } from '../src/server/github-bidirectional-sync.ts';
import {
  acquireSyncFileLease,
  isSyncLeaseBusyError,
  tryAcquireSyncFileLease,
} from '../src/server/sync-file-lease.ts';
import { createSyncAttemptJournal } from '../src/server/sync-attempt-journal.ts';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function emptyDoc() {
  return {
    version: 3,
    schemaVersion: 3,
    engineVersion: 'test',
    activeProfileId: '',
    profiles: [],
    revision: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

function makeManager(dataDir) {
  return new GitHubBidirectionalSyncManager({
    dataDir,
    store: {},
    storage: { readDataAsync: async () => emptyDoc() },
    getGitHubConfig: () => ({ branch: 'main', isPublicRepo: false }),
    onSyncCompleted: () => {},
  });
}

test('B-10: yarım kalmış deneme günlüğü açılışta tespit edilir ve temizlenir', async () => {
  const dir = tmpDir('phase2-journal-');
  try {
    const journal = createSyncAttemptJournal({ dataDir: dir, now: () => '2026-01-01T00:00:00.000Z' });
    await journal.begin('reconcile');
    assert.equal(journal.read()?.operation, 'reconcile');

    // "Süreç çöktü" — yeni yönetici aynı dizinle açılır.
    const manager = makeManager(dir);
    await manager.runExclusive('recovery-barrier', async () => null);
    const recovered = manager.getRecoveredInterruption();
    assert.equal(recovered?.operation, 'reconcile');
    assert.equal(manager.getQueueStatus().recoveredInterrupted, 1);
    assert.equal(fs.existsSync(journal.getFilePath()), false, 'kesinti kaydı temizlenmeli');

    // İkinci açılışta tekrar raporlanmaz.
    const managerAgain = makeManager(dir);
    assert.equal(managerAgain.getRecoveredInterruption(), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-10: sync-state içindeki yarım "syncing" dosya durumu pending olarak kurtarılır', () => {
  const dir = tmpDir('phase2-syncstate-');
  try {
    fs.writeFileSync(
      path.join(dir, 'sync-state.json'),
      JSON.stringify({
        syncStateVersion: 1,
        fileStates: {
          'data/catalog/movies.json': {
            repoPath: 'data/catalog/movies.json',
            status: 'syncing',
            statusLabel: 'gönderiliyor',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          'data/catalog/tv.json': {
            repoPath: 'data/catalog/tv.json',
            status: 'succeeded',
            statusLabel: 'başarılı',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8'
    );
    const store = new PersistentDataStore({ dataDir: dir });
    store.attachDataStorage(createDataStorage({ dataDir: dir }));
    const status = store.getSyncStatus();
    assert.equal(status.fileStates['data/catalog/movies.json'].status, 'pending');
    assert.match(status.fileStates['data/catalog/movies.json'].error, /Kesinti/);
    assert.equal(status.fileStates['data/catalog/tv.json'].status, 'succeeded', 'başarılı iş bozulmamalı');
    assert.match(status.lastError || '', /Kesinti sonrası kurtarma/);
    assert.equal(status.syncStateVersion, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-10: gelecekteki sync-state şema sürümü yanlış yorumlanmadan yok sayılır', () => {
  const dir = tmpDir('phase2-syncstate-v3-');
  try {
    fs.writeFileSync(
      path.join(dir, 'sync-state.json'),
      JSON.stringify({ syncStateVersion: 99, lastSyncAt: '2030-01-01T00:00:00.000Z' }),
      'utf8'
    );
    const store = new PersistentDataStore({ dataDir: dir });
    store.attachDataStorage(createDataStorage({ dataDir: dir }));
    assert.equal(store.getSyncStatus().lastSyncAt, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-38/B-10: yönetici işlemi kuyruk, günlük ve süreçler arası kilidi kullanır', async () => {
  const dir = tmpDir('phase2-manager-');
  try {
    const manager = makeManager(dir);
    const report = await manager.pull({ conflictStrategy: 'merge' });
    assert.equal(report.ok, false, 'token yokken açık hata raporu dönmeli');
    assert.equal(manager.isBusy(), false);
    const queue = manager.getQueueStatus();
    assert.equal(queue.state, 'idle');
    assert.equal(queue.lastOutcome?.operation, 'pull');
    assert.equal(queue.lastOutcome?.status, 'succeeded');
    assert.equal(fs.existsSync(path.join(dir, 'sync-attempt.json')), false, 'günlük temizlenmeli');

    // Kilit serbest kaldı: aynı dizinde yeni kilit alınabilir.
    const lease = acquireSyncFileLease(path.join(dir, 'locks', 'github-sync.lock'));
    lease.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-38: bağımsız istek, aktif işlem beklerken kuyruğu atlayamaz', async () => {
  const dir = tmpDir('phase2-independent-');
  try {
    const manager = makeManager(dir);
    let markStarted;
    let releaseFirst;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    let secondStarted = false;
    const first = manager.runExclusive('outer', async () => {
      markStarted();
      await gate;
      return 'first';
    });
    await started;
    const second = manager.runExclusive('independent', async () => {
      secondStarted = true;
      return 'second';
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(secondStarted, false, 'bağımsız istek A bitmeden başlamamalı');
    releaseFirst();
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    assert.equal(secondStarted, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-38/B-10: ikinci yönetici aktif sürecin journal kaydını silemez', async () => {
  const dir = tmpDir('phase2-active-journal-');
  try {
    const firstManager = makeManager(dir);
    let markStarted;
    let releaseFirst;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    const first = firstManager.runExclusive('active', async () => {
      markStarted();
      await gate;
      return 'done';
    });
    await started;
    const journalPath = path.join(dir, 'sync-attempt.json');
    assert.equal(fs.existsSync(journalPath), true);
    const secondManager = makeManager(dir);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(journalPath), true, 'B açılışı A journal kaydını silmemeli');
    assert.equal(secondManager.getRecoveredInterruption(), null);
    releaseFirst();
    assert.equal(await first, 'done');
    assert.equal(fs.existsSync(journalPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-38: aynı makinede canlı PID stale süresini aşsa da kilit devralınamaz', () => {
  const dir = tmpDir('phase2-live-stale-');
  try {
    const lockPath = path.join(dir, 'locks', 'sync.lock');
    const lease = acquireSyncFileLease(lockPath, { staleMs: 1_000 });
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(lockPath, old, old);
    assert.equal(tryAcquireSyncFileLease(lockPath, { staleMs: 1_000, isProcessAlive: () => true }), null);
    assert.equal(lease.renew(), true);
    assert.equal(tryAcquireSyncFileLease(lockPath, { staleMs: 1_000, isProcessAlive: () => true }), null);
    lease.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-10: ölü sahibin journal kaydı lease alındıktan sonra kurtarılır', async () => {
  const dir = tmpDir('phase2-dead-owner-journal-');
  try {
    const journal = createSyncAttemptJournal({ dataDir: dir });
    await journal.begin('crashed-operation', 'dead-lease-token');
    const lockPath = path.join(dir, 'locks', 'github-sync.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      token: 'dead-lease-token',
      pid: 99999999,
      hostname: os.hostname(),
      acquiredAt: '2020-01-01T00:00:00.000Z',
    }));
    const manager = makeManager(dir);
    await manager.runExclusive('after-recovery', async () => 'ok');
    assert.equal(manager.getRecoveredInterruption()?.operation, 'crashed-operation');
    assert.equal(fs.existsSync(journal.getFilePath()), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-38: kuyruk içinden runExclusive çağrısı deadlock üretmez', async () => {
  const dir = tmpDir('phase2-nested-');
  try {
    const manager = makeManager(dir);
    const result = await manager.runExclusive('outer', async () =>
      manager.runExclusive('inner', async () => 'iç-sonuç')
    );
    assert.equal(result, 'iç-sonuç');
    assert.equal(manager.getQueueStatus().lastOutcome?.operation, 'outer');
    assert.equal(fs.existsSync(path.join(dir, 'sync-attempt.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-38: dosya kilidi sahiplik, serbest bırakma ve bayat devralma kuralları', () => {
  const dir = tmpDir('phase2-lease-');
  try {
    const lockPath = path.join(dir, 'locks', 'sync.lock');
    const lease = acquireSyncFileLease(lockPath);
    assert.equal(tryAcquireSyncFileLease(lockPath), null, 'canlı kilit ikinci kez alınamaz');
    assert.throws(() => acquireSyncFileLease(lockPath), (error) => {
      assert.ok(isSyncLeaseBusyError(error));
      assert.equal(error.code, 'sync_lease_busy');
      return true;
    });
    lease.release();
    assert.equal(fs.existsSync(lockPath), false);

    // Yabancı token: release başka sürecin kilidini silmemeli.
    acquireSyncFileLease(lockPath);
    const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    fs.writeFileSync(lockPath, JSON.stringify({ ...info, token: 'baska-token' }));
    lease.release();
    assert.equal(fs.existsSync(lockPath), true, 'yabancı kilit korunmalı');
    fs.rmSync(lockPath, { force: true });

    // Bayat kilit (yaş aşımı) devralınır.
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ token: 'eski', pid: 999999, hostname: os.hostname(), acquiredAt: '2020-01-01T00:00:00.000Z' })
    );
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(lockPath, old, old);
    const taken = tryAcquireSyncFileLease(lockPath, { staleMs: 1_000 });
    assert.ok(taken, 'bayat kilit devralınmalı');
    assert.notEqual(taken.token, 'eski');
    taken.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B-38: gerçek ikinci süreç kilidi alamaz; süreç çıkınca kilit devralınır', () => {
  const dir = tmpDir('phase2-lease-proc-');
  try {
    const lockPath = path.join(dir, 'locks', 'sync.lock');
    const moduleUrl = new URL('../src/server/sync-file-lease.ts', import.meta.url).href;
    const script = `
      import { tryAcquireSyncFileLease } from ${JSON.stringify(moduleUrl)};
      const lease = tryAcquireSyncFileLease(process.argv[1], { staleMs: 60000 });
      if (!lease) { console.log('BUSY'); process.exit(3); }
      console.log('ACQUIRED');
    `;
    const parentLease = acquireSyncFileLease(lockPath);
    const blocked = spawnSync(process.execPath, ['--input-type=module', '-e', script, lockPath], {
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(blocked.status, 3, `ikinci süreç kilit almamalı: ${blocked.stdout}${blocked.stderr}`);
    assert.match(blocked.stdout, /BUSY/);

    parentLease.release();
    const acquired = spawnSync(process.execPath, ['--input-type=module', '-e', script, lockPath], {
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(acquired.status, 0, acquired.stderr);
    assert.match(acquired.stdout, /ACQUIRED/);

    // Çocuk süreç kilidi bırakmadan çıktı: sahibi ölü olduğu için devralınabilir.
    const takeover = tryAcquireSyncFileLease(lockPath);
    assert.ok(takeover, 'ölü süreç kilidi devralınmalı');
    takeover.release();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
