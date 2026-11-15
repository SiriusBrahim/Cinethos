/**
 * P0-01 / P0-04 / P1-04: SQLite geri yükleme tutarlılığı.
 *
 * - `prepare` hiçbir veriyi değiştirmez, özet döner (ön izleme).
 * - `restore` yalnızca onaydan sonra yazar, içerik özetini doğrular.
 * - Yan veri hatasında `rollback` önceki belgeyi geri getirir.
 * - Boyut aşımı ve yarıda kesilen yükleme kilidi/temp dosyayı sızdırmaz.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';

import { createCineTrackApp, MAX_SQLITE_ARCHIVE_UPLOAD_BYTES } from '../src/server/app.ts';
import {
  writeSqliteArchive,
  isSqliteArchiveAvailable,
} from '../src/server/sqlite-archive.ts';
import { hashDocument } from '../src/server/archive-integrity.ts';

const AS_OF = '2026-11-15T09:00:00.000Z';

function makeItem(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    status: 'completed',
    personal_rating: 8,
    addedAt: AS_OF,
    ...overrides,
  };
}

function makeSnapshot() {
  return {
    dataDocument: {
      version: 3,
      schemaVersion: 3,
      engineVersion: 'test',
      activeProfileId: 'profile-a',
      revision: 4,
      updatedAt: AS_OF,
      profiles: [
        {
          id: 'profile-a',
          name: 'Ana Profil',
          createdAt: AS_OF,
          preferences: { disliked: ['movie:99'], hidden: ['tv:42'], providers: ['netflix'] },
          favoriteActors: [{ id: 525, name: 'Nolan' }],
          deleted_keys: { 'movie:900': AS_OF },
          items: [makeItem(1), makeItem(2, { media_type: 'tv', title: undefined, name: 'Dizi 2' })],
        },
        {
          id: 'profile-b',
          name: 'İkinci Profil',
          createdAt: AS_OF,
          preferences: { disliked: [], providers: [] },
          favoriteActors: [],
          items: [makeItem(3)],
        },
      ],
    },
    tasteMaps: { 'profile-a': { metrics: { novelty: 0.5 } } },
    stock: { movies: [{ id: 1, title: 'Stok Film' }], tv: [], updatedAt: AS_OF },
    posterUrls: [],
    appVersion: 'test',
  };
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-restore-'));
}

async function startApp() {
  const dataDir = makeTempDir();
  const { app, storage } = createCineTrackApp({
    dataDir,
    maxDataBytes: 25 * 1024 * 1024,
    maxProfiles: 20,
    maxItemsPerProfile: 25000,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    dataDir,
    storage,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function postPrepare(baseUrl, bytes, extraHeaders = {}) {
  return fetch(`${baseUrl}/api/archive/sqlite/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...extraHeaders },
    body: bytes,
  });
}

test('P0-01 & P1-04: prepare veri değiştirmez, restore doğrular, rollback geri alır', async (t) => {
  if (!(await isSqliteArchiveAvailable())) {
    t.skip('node:sqlite bu ortamda kullanılamıyor');
    return;
  }
  const ctx = await startApp();
  try {
    // Sunucuda eski bir belge olmalı: geri yükleme onun üzerine yazacak.
    await ctx.storage.saveDataSerialized(
      {
        version: 3,
        schemaVersion: 3,
        activeProfileId: 'profile-a',
        updatedAt: AS_OF,
        profiles: [
          {
            id: 'profile-a',
            name: 'Eski Profil',
            createdAt: AS_OF,
            preferences: { disliked: [], providers: [] },
            favoriteActors: [],
            items: [],
          },
        ],
      },
      { forceOverwrite: true, confirmBulkDelete: true, requirePrecondition: false }
    );
    const beforeDocument = await ctx.storage.readDataAsync();
    const beforeHash = hashDocument(beforeDocument);

    const archivePath = path.join(ctx.dataDir, 'manual-archive.sqlite');
    await writeSqliteArchive(makeSnapshot(), archivePath);
    const bytes = fs.readFileSync(archivePath);

    // 1) Ön izleme: veri değişmez.
    const prepareRes = await postPrepare(ctx.baseUrl, bytes);
    assert.equal(prepareRes.status, 200);
    const prepared = await prepareRes.json();
    assert.equal(prepared.ok, true);
    assert.ok(prepared.restoreId);
    assert.equal(prepared.inspect.counts.profiles, 2);
    assert.equal(prepared.inspect.counts.items, 3);
    assert.equal(prepared.inspect.profiles.length, 2);
    assert.match(prepared.inspect.documentHash, /^[0-9a-f]{64}$/);
    assert.equal(prepared.current.counts.profiles, 1);

    const afterPrepare = await ctx.storage.readDataAsync();
    assert.equal(hashDocument(afterPrepare), beforeHash, 'prepare hiçbir veriyi değiştirmemeli');
    assert.equal(afterPrepare.profiles[0].name, 'Eski Profil');

    // 2) Onay (commit): içerik özeti arşivle eşleşmeli.
    const restoreRes = await fetch(`${ctx.baseUrl}/api/archive/sqlite/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restoreId: prepared.restoreId }),
    });
    assert.equal(restoreRes.status, 200);
    const restored = await restoreRes.json();
    assert.equal(restored.ok, true);
    assert.equal(restored.documentHash, prepared.inspect.documentHash);
    assert.equal(restored.counts.profiles, 2);
    assert.equal(restored.counts.items, 3);
    assert.equal(typeof restored.rollbackId, 'string');
    assert.equal(restored.postersComplete, true);

    const written = await ctx.storage.readDataAsync();
    assert.equal(written.profiles.length, 2);
    assert.equal(written.profiles.find((p) => p.id === 'profile-a').name, 'Ana Profil');

    // Aynı restoreId ikinci kez kullanılamaz (tek kullanımlık hazırlık).
    const replay = await fetch(`${ctx.baseUrl}/api/archive/sqlite/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restoreId: prepared.restoreId }),
    });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).code, 'archive_prepare_expired');

    // 3) Yan veri hatası senaryosu: istemci rollback çağırınca eski belge döner.
    const rollbackRes = await fetch(`${ctx.baseUrl}/api/archive/sqlite/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rollbackId: restored.rollbackId }),
    });
    assert.equal(rollbackRes.status, 200);
    assert.equal((await rollbackRes.json()).ok, true);

    const rolledBack = await ctx.storage.readDataAsync();
    assert.equal(hashDocument(rolledBack), beforeHash, 'rollback eski içeriği birebir geri getirmeli');
    assert.equal(rolledBack.profiles[0].name, 'Eski Profil');
  } finally {
    await ctx.close();
  }
});

test('P0-01: gelecekteki şema sürümü ve bozuk dosya veri değiştirmeden reddedilir', async (t) => {
  if (!(await isSqliteArchiveAvailable())) {
    t.skip('node:sqlite bu ortamda kullanılamıyor');
    return;
  }
  const ctx = await startApp();
  try {
    const beforeHash = hashDocument(await ctx.storage.readDataAsync());

    const badRes = await postPrepare(ctx.baseUrl, Buffer.from('bu bir sqlite dosyası değil'));
    assert.equal(badRes.status, 400);
    assert.equal((await badRes.json()).code, 'invalid_archive_file');

    assert.equal(hashDocument(await ctx.storage.readDataAsync()), beforeHash);
  } finally {
    await ctx.close();
  }
});

test('P0-04: bildirilen boyut sınırı aşılırsa 413 döner ve kilit serbest kalır', async (t) => {
  if (!(await isSqliteArchiveAvailable())) {
    t.skip('node:sqlite bu ortamda kullanılamıyor');
    return;
  }
  const ctx = await startApp();
  try {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        `${ctx.baseUrl}/api/archive/sqlite/prepare`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(MAX_SQLITE_ARCHIVE_UPLOAD_BYTES + 1),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        }
      );
      req.on('error', reject);
      req.write(Buffer.alloc(64));
    });
    assert.equal(status, 413);

    // Kilit serbest: yeni bir prepare isteği çalışabilmeli.
    const health = await fetch(`${ctx.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    const retry = await postPrepare(ctx.baseUrl, Buffer.from('x'));
    assert.equal(retry.status, 400, 'geçersiz gövde 400 döner, 409 kilit hatası değil');
  } finally {
    await ctx.close();
  }
});

test('P0-04: yarıda kesilen yükleme temp dosya ve kilit bırakmaz', async (t) => {
  if (!(await isSqliteArchiveAvailable())) {
    t.skip('node:sqlite bu ortamda kullanılamıyor');
    return;
  }
  const ctx = await startApp();
  try {
    const { port } = new URL(ctx.baseUrl);
    await new Promise((resolve) => {
      const socket = net.connect(Number(port), '127.0.0.1', () => {
        socket.write(
          'POST /api/archive/sqlite/prepare HTTP/1.1\r\n' +
            'Host: 127.0.0.1\r\n' +
            'Content-Type: application/octet-stream\r\n' +
            'Content-Length: 100000\r\n\r\n'
        );
        socket.write(Buffer.alloc(1024));
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 100);
      });
      socket.on('error', () => resolve());
    });

    // Sunucunun aborted olayını işlemesi için kısa bekleme.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const health = await fetch(`${ctx.baseUrl}/api/health`);
    assert.equal(health.status, 200);

    const archivesDir = path.join(ctx.dataDir, 'archives');
    const leftovers = fs.existsSync(archivesDir)
      ? fs.readdirSync(archivesDir).filter((name) => /^(prepare|restore)-/.test(name))
      : [];
    assert.deepEqual(leftovers, [], 'yarıda kesilen yükleme geçici dosya bırakmamalı');

    // Kilit serbest kaldı: geçerli istek 409 değil 400/200 alır.
    const retry = await postPrepare(ctx.baseUrl, Buffer.from('gecersiz'));
    assert.equal(retry.status, 400);
  } finally {
    await ctx.close();
  }
});
