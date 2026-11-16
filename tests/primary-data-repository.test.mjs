import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrimaryDataRepository } from '../src/server/primary-data-repository.ts';

/**
 * Yapısal sahte depolama — createDataStorage'ın adaptörün kullandığı yüzeyi.
 * Depolama mantığına dokunulmaz; yalnızca sözleşme eşlemesi doğrulanır.
 */
function fakeStorage(overrides = {}) {
  let document = {
    version: 3,
    schemaVersion: 3,
    activeProfileId: 'p1',
    profiles: [],
    revision: 5,
    updatedAt: '2026-11-16T00:00:00.000Z',
  };
  const base = {
    dataDir: '/tmp/x',
    dataFile: '/tmp/x/data.json',
    backupsDir: '/tmp/x/backups',
    maxDataBytes: 1024,
    hasUnrecoverableCorruption: () => false,
    readData: () => document,
    readDataAsync: async () => document,
    readIsolatedProfileAsync: async () => null,
    readIsolatedUserListsAsync: async () => null,
    saveData: () => ({ ok: true, document, totalItems: 0 }),
    saveDataSerialized: async (payload, options) => {
      if (options?.expectedRevision != null && options.expectedRevision !== document.revision) {
        return {
          ok: false,
          status: 409,
          code: 'revision_conflict',
          message: 'revision çelişkisi',
          currentRevision: document.revision,
          expectedRevision: options.expectedRevision,
        };
      }
      document = { ...payload, revision: document.revision + 1 };
      return { ok: true, document, totalItems: 0 };
    },
    backupExistingDataAsync: async () => null,
    createSafetySnapshotSerialized: async () => null,
    applySyncedDocumentSerialized: async () => null,
    listBackupsAsync: async () => [],
    restoreBackup: () => null,
    restoreBackupSerialized: async () => null,
    sqliteStatus: () => ({
      driver: 'json',
      enabled: false,
      available: false,
      revision: document.revision,
      updatedAt: document.updatedAt ?? null,
      filePath: '/tmp/x/data.json',
      lastError: null,
    }),
    closeSqliteStore: () => undefined,
  };
  return { ...base, ...overrides };
}

/** read() — belge + revision + sağlık tek atomda döner. */
test('primary-data-repository: read belge, revision ve sağlık döner', async () => {
  const repo = createPrimaryDataRepository(fakeStorage());
  const result = await repo.read();
  assert.equal(result.document.activeProfileId, 'p1');
  assert.equal(result.revision, 5);
  assert.equal(result.health.driver, 'json');
  assert.equal(result.health.revision, 5);
});

/** save() — başarılı yazım yeni revision döner. */
test('primary-data-repository: save yeni revision döner', async () => {
  const repo = createPrimaryDataRepository(fakeStorage());
  const doc = { version: 3, schemaVersion: 3, activeProfileId: 'p1', profiles: [] };
  const result = await repo.save(doc);
  assert.equal(result.ok, true);
  assert.equal(result.revision, 6);
});

/** save() — revision çelişkisi conflict:true ile işaretlenir (arıza değil). */
test('primary-data-repository: revision çelişkisi conflict olarak işaretlenir', async () => {
  const repo = createPrimaryDataRepository(fakeStorage());
  const doc = { version: 3, schemaVersion: 3, activeProfileId: 'p1', profiles: [] };
  const result = await repo.save(doc, { expectedRevision: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.match(result.error, /revision_conflict/u);
});

/** save() — diğer hatalar conflict:false olarak işaretlenir. */
test('primary-data-repository: diğer hatalar conflict değildir', async () => {
  const storage = fakeStorage({
    saveDataSerialized: async () => ({
      ok: false,
      status: 413,
      code: 'payload_too_large',
      message: 'belge çok büyük',
    }),
  });
  const repo = createPrimaryDataRepository(storage);
  const result = await repo.save({ version: 3, schemaVersion: 3, activeProfileId: 'p1', profiles: [] });
  assert.equal(result.ok, false);
  assert.equal(result.conflict, false);
});

/** getHealth() — gerçek aktif sürücü ve son hata görünür (§5.1). */
test('primary-data-repository: getHealth gerçek sürücü durumunu döner', async () => {
  const storage = fakeStorage({
    sqliteStatus: () => ({
      driver: 'sqlite',
      enabled: true,
      available: false,
      revision: null,
      updatedAt: null,
      filePath: '/tmp/x/data.sqlite',
      lastError: 'SQLite açılamadı',
    }),
  });
  const repo = createPrimaryDataRepository(storage);
  const health = await repo.getHealth();
  assert.equal(health.driver, 'sqlite');
  assert.equal(health.available, false);
  assert.equal(health.lastError, 'SQLite açılamadı');
});

/** getRevision() — yalnızca revision döner. */
test('primary-data-repository: getRevision güncel revision döner', async () => {
  const repo = createPrimaryDataRepository(fakeStorage());
  assert.equal(await repo.getRevision(), 5);
});
