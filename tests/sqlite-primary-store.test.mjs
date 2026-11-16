import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDataStorage } from '../src/server/storage.ts';
import {
  createSqlitePrimaryStore,
  resolveStorageDriver,
} from '../src/server/sqlite-primary-store.ts';

function makeDocument(revision = 1, title = 'Film') {
  return {
    version: 3,
    activeProfileId: 'p1',
    revision,
    updatedAt: new Date(1700000000000 + revision * 1000).toISOString(),
    profiles: [
      {
        id: 'p1',
        name: 'Profil',
        createdAt: '2026-01-01T00:00:00.000Z',
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items: [
          {
            id: 42,
            media_type: 'movie',
            title,
            vote_average: 8,
            vote_count: 10,
            popularity: 1,
            genre_ids: [18],
            status: 'completed',
          },
        ],
      },
    ],
  };
}

test('SQLite: sürücü varsayılan olarak json ve depo dosyası oluşturmaz', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-sqlite-driver-'));
  try {
    assert.equal(resolveStorageDriver({}), 'json');
    assert.equal(resolveStorageDriver({ CINETHOS_STORAGE: 'sqlite' }), 'sqlite');
    assert.equal(resolveStorageDriver({ CINETHOS_STORAGE: ' SQLITE ' }), 'sqlite');

    const storage = createDataStorage({ dataDir: tmpDir, storageDriver: 'json' });
    assert.equal(storage.sqliteStatus().driver, 'json');
    assert.equal(storage.sqliteStatus().enabled, false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'cinethos.db')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SQLite: mevcut JSON dokümanı ilk açılışta migrate edilir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-sqlite-migrate-'));
  try {
    const jsonStorage = createDataStorage({ dataDir: tmpDir, storageDriver: 'json' });
    const saved = await jsonStorage.saveDataSerialized(makeDocument(3, 'Migrate Film'));
    assert.equal(saved.ok, true);

    const sqliteStorage = createDataStorage({ dataDir: tmpDir, storageDriver: 'sqlite' });
    const status = sqliteStorage.sqliteStatus();
    assert.equal(status.driver, 'sqlite');
    assert.equal(status.enabled, true);
    assert.equal(status.available, true, status.lastError ?? 'SQLite açılamadı');

    const doc = await sqliteStorage.readDataAsync();
    assert.equal(doc.profiles[0].items[0].title, 'Migrate Film');
    assert.equal(doc.revision, saved.document.revision);

    const row = createSqlitePrimaryStore({ dataDir: tmpDir, enabled: true }).read();
    assert.ok(row, 'SQLite satırı oluşmalı');
    assert.equal(row.revision, saved.document.revision);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SQLite: yazma sonrası JSON bozulsa bile veri SQLite üzerinden okunur', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-sqlite-primary-'));
  try {
    const storage = createDataStorage({ dataDir: tmpDir, storageDriver: 'sqlite' });
    assert.equal(storage.sqliteStatus().available, true);

    const first = await storage.saveDataSerialized(makeDocument(1, 'İlk Film'));
    assert.equal(first.ok, true);
    const second = await storage.saveDataSerialized(makeDocument(2, 'İkinci Film'), {
      expectedRevision: first.document.revision,
    });
    assert.equal(second.ok, true);

    // JSON ve .bak dosyalarını bozarak yalnızca SQLite bırakılır.
    fs.writeFileSync(path.join(tmpDir, 'cinethos-data.json'), '{ bozuk json', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'cinethos-data.json.bak'), '{ bozuk json', 'utf8');
    const backupsDir = path.join(tmpDir, 'backups');
    if (fs.existsSync(backupsDir)) {
      for (const file of fs.readdirSync(backupsDir)) {
        fs.rmSync(path.join(backupsDir, file), { force: true });
      }
    }

    const fresh = createDataStorage({ dataDir: tmpDir, storageDriver: 'sqlite' });
    const doc = await fresh.readDataAsync();
    assert.equal(doc.profiles[0].items[0].title, 'İkinci Film');
    assert.equal(doc.revision, second.document.revision);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('SQLite: JSON revizyonu daha yeniyse JSON kazanır ve SQLite güncellenir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-sqlite-newer-json-'));
  try {
    const storage = createDataStorage({ dataDir: tmpDir, storageDriver: 'sqlite' });
    const saved = await storage.saveDataSerialized(makeDocument(1, 'Eski'));
    assert.equal(saved.ok, true);

    // Dışarıdan daha yüksek revizyonlu JSON yazılır (ör. SQLite kaybı sonrası geri dönüş).
    fs.writeFileSync(
      path.join(tmpDir, 'cinethos-data.json'),
      JSON.stringify(makeDocument(9, 'Yeni JSON'), null, 2),
      'utf8'
    );

    const fresh = createDataStorage({ dataDir: tmpDir, storageDriver: 'sqlite' });
    const doc = await fresh.readDataAsync();
    assert.equal(doc.profiles[0].items[0].title, 'Yeni JSON');
    assert.equal(doc.revision, 9);

    const row = createSqlitePrimaryStore({ dataDir: tmpDir, enabled: true }).read();
    assert.equal(row?.revision, 9, 'SQLite JSON ile eşitlenmeli');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
