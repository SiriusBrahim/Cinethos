/**
 * İşlem Merkezi API'si — uçtan uca entegrasyon testi.
 *
 * Kapsam:
 *  1. `GET /api/background/tasks` yalnızca AKTİF profile ait görevleri döner.
 *  2. Yanıt iç dosya yollarını ve olay payload'ını taşımaz.
 *  3. `cancel` → `cancelled`, `retry` → `pending` geçişi gerçek kuyrukta olur.
 *  4. Başka profilin görevi üzerinde işlem `403 profile_mismatch` ile reddedilir.
 *  5. Geçersiz durum filtresi `400`, kimlik doğrulamasız yazma `401` döner.
 *
 * Testler gerçek Express uygulamasını ve gerçek SQLite görev deposunu kullanır;
 * repository mock'lanmaz.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createCineTrackApp } from '../src/server/app.ts';

const AUTH_TOKEN = 'gizli-islem-merkezi-token';

function makeEvent(overrides = {}) {
  const base = {
    eventId: 'evt-workspace-1',
    eventType: 'LibraryItemAdded',
    profileId: 'PROFILE-DEFAULT',
    entityId: 'movie:157336',
    schemaVersion: 1,
    sourceRevision: 1,
    occurredAt: '2026-05-01T09:00:00.000Z',
    payload: { mediaKey: 'movie:157336', mediaType: 'movie', list: 'watched' },
  };
  return { ...base, ref: { profileId: base.profileId, revision: base.sourceRevision }, ...overrides };
}

async function withRuntime(fn) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cinethos-operations-api-'));
  const runtime = createCineTrackApp({ dataDir, authToken: AUTH_TOKEN });
  const server = http.createServer(runtime.app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await fn({ baseUrl, runtime });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      runtime.storage.closeSqliteStore();
    } catch {
      /* zaten kapalı olabilir */
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function readJson(response) {
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

test('İşlem Merkezi API: aktif profil görevleri, sır arındırma, iptal ve yeniden deneme', async () => {
  await withRuntime(async ({ baseUrl, runtime }) => {
    const activeProfileId = runtime.profileContext.getCurrent().profileId;
    assert.ok(activeProfileId, 'aktif profil kimliği bulunmalı');

    await runtime.backgroundManager.acceptEvent(
      makeEvent({ profileId: activeProfileId, eventId: 'evt-own-1' })
    );
    await runtime.backgroundManager.acceptEvent(
      makeEvent({ profileId: 'PROFILE-OTHER', eventId: 'evt-other-1' })
    );

    // 1) Liste: yalnızca aktif profile ait görevler ve iç alanlar yok.
    const list = await readJson(await fetch(`${baseUrl}/api/background/tasks`));
    assert.equal(list.status, 200);
    assert.equal(list.body.ok, true);
    assert.equal(list.body.activeProfileId, activeProfileId);
    assert.ok(Array.isArray(list.body.tasks));
    assert.ok(list.body.tasks.length >= 1, 'aktif profilin görevi listelenmeli');
    for (const task of list.body.tasks) {
      assert.equal(task.profileId, activeProfileId, 'başka profilin görevi sızmamalı');
      assert.equal(Object.hasOwn(task, 'payload'), false);
      assert.equal(Object.hasOwn(task, 'filePath'), false);
    }
    assert.equal(
      list.text.includes('data/'),
      false,
      'yanıt gövdesi dosya yolu içermemeli'
    );

    const ownTask = list.body.tasks[0];

    // 2) Kimliksiz yazma reddedilir.
    const unauthorized = await fetch(`${baseUrl}/api/background/tasks/${ownTask.taskId}/cancel`, {
      method: 'POST',
    });
    assert.equal(unauthorized.status, 401);

    // 3) İptal → cancelled.
    const cancel = await readJson(
      await fetch(`${baseUrl}/api/background/tasks/${ownTask.taskId}/cancel`, {
        method: 'POST',
        headers: { 'X-CineTrack-Token': AUTH_TOKEN },
      })
    );
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.task.status, 'cancelled');

    // 4) Yeniden deneme → pending (deneme sayacı sıfırlanır).
    const retry = await readJson(
      await fetch(`${baseUrl}/api/background/tasks/${ownTask.taskId}/retry`, {
        method: 'POST',
        headers: { 'X-CineTrack-Token': AUTH_TOKEN },
      })
    );
    assert.equal(retry.status, 200);
    assert.equal(retry.body.task.status, 'pending');
    assert.equal(retry.body.task.attempts, 0);

    // 5) Başka profilin görevi üzerinde işlem yapılamaz.
    const otherTask = runtime.backgroundManager
      .listTasks({ profileId: 'PROFILE-OTHER' })
      .find(Boolean);
    assert.ok(otherTask, 'diğer profilin görevi kuyrukta olmalı');
    const crossProfile = await readJson(
      await fetch(`${baseUrl}/api/background/tasks/${otherTask.taskId}/retry`, {
        method: 'POST',
        headers: { 'X-CineTrack-Token': AUTH_TOKEN },
      })
    );
    assert.equal(crossProfile.status, 403);
    assert.equal(crossProfile.body.code, 'profile_mismatch');

    // 6) Geçersiz filtre ve bilinmeyen görev.
    const invalidFilter = await fetch(`${baseUrl}/api/background/tasks?status=uydurma`);
    assert.equal(invalidFilter.status, 400);
    const missing = await fetch(`${baseUrl}/api/background/tasks/yok/retry`, {
      method: 'POST',
      headers: { 'X-CineTrack-Token': AUTH_TOKEN },
    });
    assert.equal(missing.status, 404);
  });
});
