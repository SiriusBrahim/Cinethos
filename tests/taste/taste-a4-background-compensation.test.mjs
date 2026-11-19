/**
 * MIA Faz 5 R2-A4 — BackgroundManager hedef profil korunumu ve atlanan taste
 * olaylarının kalıcı kuyruktan telafisi.
 *
 * Senaryolar:
 *  1. Aktif olmayan profile ait kütüphane olayı canlı abonelikte yazılmaz
 *     (`code: 'profile-not-active'`), kalıcı görev `pending` kalır ve deneme
 *     hakkı tükenmez.
 *  2. Hedef profil aktif olduğunda görev çalışır ve olay YALNIZCA o profilin
 *     taste deposuna yazılır (çapraz yazma yok).
 *  3. Aktif profilin olayı için telafi görevi üretilmez (canlı abonelik işler).
 *  4. Geçmiş `sourceRevision` değeri bugünkü revision'a eşit olmasa da telafi
 *     yazımı yapılır (yalnızca profil kimliği doğrulanır).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createAppEvent, createAppEventBus } from '../../src/app/app-event-bus.ts';
import { createProfileContext } from '../../src/app/ProfileContext.ts';
import { createServerTasteServiceAdapter, subscribeTasteAdapterToEventBus } from '../../src/server/taste-service-adapter.ts';
import { readTasteEventsForProfile, readTasteProfileForProfile, resolveTastePathsForProfile } from '../../src/server/taste-store.ts';
import { createBackgroundTaskRepository } from '../../src/server/background-task-repository.ts';
import { createBackgroundManager } from '../../src/modules/background/service.ts';
import { createLibraryItemAddedHandler } from '../../src/modules/background/handlers.ts';
import { createTasteEventSyncHandler, TASTE_EVENT_SYNC_HANDLER_ID } from '../../src/modules/background/taste-handlers.ts';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ct-taste-a4-compensation-'));
}

function makeEvent(overrides = {}) {
  return createAppEvent({
    eventId: 'evt-a4-1',
    eventType: 'LibraryItemAdded',
    ref: { profileId: 'profile-a', revision: 1 },
    entityId: 'movie:550',
    payload: { mediaKey: 'movie:550', mediaType: 'movie', list: 'watched' },
    ...overrides,
  });
}

async function makeRuntime(tmpDir, rebuildOnEvent = false) {
  let clock = Date.UTC(2026, 0, 1, 0, 0, 0);
  const now = () => new Date((clock += 1000)).toISOString();
  const profileContext = createProfileContext({
    initialProfileId: 'profile-a',
    initialRevision: 1,
  });
  const adapter = createServerTasteServiceAdapter({
    dataDir: tmpDir,
    profileContext,
    rebuildOnEvent,
  });
  const repository = createBackgroundTaskRepository({ dataDir: tmpDir, now });
  const manager = createBackgroundManager({
    repository,
    handlers: [createLibraryItemAddedHandler(), createTasteEventSyncHandler(adapter)],
    profileContext,
    now,
    baseRetryDelayMs: 10,
  });
  return { profileContext, adapter, repository, manager };
}

async function pumpUntil(manager, predicate, maxPumps = 20) {
  for (let i = 0; i < maxPumps; i += 1) {
    await manager.pumpOnce();
    if (predicate()) return true;
  }
  return predicate();
}

test('R2-A4 inactive-profile olayı taste yazımını atlar ve kalıcı görev pending kalır', async () => {
  const tmpDir = await makeTempDir();
  const runtime = await makeRuntime(tmpDir);
  try {
    await runtime.manager.start();
    // Olay 'profile-b' için; aktif profil 'profile-a'.
    const outcome = await runtime.adapter.processEvent(makeEvent({ ref: { profileId: 'profile-b', revision: 3 } }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'profile-not-active');
    assert.equal(outcome.retryable, false);

    await runtime.manager.acceptEvent(
      makeEvent({ eventId: 'evt-a4-pending', profileId: 'profile-b', ref: { profileId: 'profile-b', revision: 3 } })
    );
    await runtime.manager.pumpOnce();

    const task = runtime.manager.listTasks()[0];
    assert.equal(task.status, 'pending', 'hedef profil aktif değilken görev beklemeli');
    assert.equal(task.attempts, 0, 'deneme hakkı tüketilmemeli');
    assert.deepEqual(await readTasteEventsForProfile('profile-b', tmpDir), []);
    assert.deepEqual(await readTasteEventsForProfile('profile-a', tmpDir), []);
  } finally {
    await runtime.manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('R2-A4 hedef profil aktif olunca telafi yalnızca o profile yazar', async () => {
  const tmpDir = await makeTempDir();
  const runtime = await makeRuntime(tmpDir);
  try {
    await runtime.manager.start();
    await runtime.manager.acceptEvent(
      makeEvent({ eventId: 'evt-a4-compensate', profileId: 'profile-b', ref: { profileId: 'profile-b', revision: 2 } })
    );
    await runtime.manager.pumpOnce();
    assert.equal(runtime.manager.listTasks()[0].status, 'pending');

    await runtime.profileContext.switchProfile('profile-b', 9);
    const done = await pumpUntil(runtime.manager, () =>
      runtime.manager.listTasks().every((task) => task.status === 'completed')
    );
    assert.equal(done, true, 'profil aktif olunca görev tamamlanmalı');

    const eventsB = await readTasteEventsForProfile('profile-b', tmpDir);
    const eventsA = await readTasteEventsForProfile('profile-a', tmpDir);
    assert.deepEqual(eventsB.map((event) => event.eventId), ['evt-a4-compensate']);
    assert.deepEqual(eventsA, [], 'aktif olmayan profile yazılmamalı');
  } finally {
    await runtime.manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('R2-A4 geçmiş sourceRevision telafiyi engellemez (yalnızca profil kimliği doğrulanır)', async () => {
  const tmpDir = await makeTempDir();
  const runtime = await makeRuntime(tmpDir);
  try {
    await runtime.manager.start();
    await runtime.manager.acceptEvent(
      makeEvent({ eventId: 'evt-a4-stale-rev', profileId: 'profile-a', ref: { profileId: 'profile-a', revision: 1 } })
    );
    // Aktif profil aynı kalır ama revision ilerler (olay geçmişte kaldı).
    await runtime.profileContext.switchProfile('profile-a', 42);
    const outcome = await runtime.adapter.processDeferredEvent(
      makeEvent({ eventId: 'evt-a4-stale-rev', profileId: 'profile-a', ref: { profileId: 'profile-a', revision: 1 } })
    );
    assert.deepEqual(outcome, { ok: true });
    assert.deepEqual(
      (await readTasteEventsForProfile('profile-a', tmpDir)).map((event) => event.eventId),
      ['evt-a4-stale-rev']
    );
  } finally {
    await runtime.manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('R2-A4 aktif profilin olayı için telafi görevi üretilmez', async () => {
  const tmpDir = await makeTempDir();
  const runtime = await makeRuntime(tmpDir);
  try {
    await runtime.manager.start();
    await runtime.manager.acceptEvent(makeEvent({ eventId: 'evt-a4-active' }));
    const tasks = runtime.manager.listTasks();
    assert.equal(tasks.length, 1, 'yalnızca audit görevi üretilmeli');
    assert.notEqual(tasks[0].handlerId, 'intelligence.taste-event-sync');
  } finally {
    await runtime.manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('R2-A4 yarış: persistEvent sırasında aktif profil değişirse atlanan olay için telafi görevi kaybolmamalı', async () => {
  const tmpDir = await makeTempDir();
  const profileContext = createProfileContext({
    initialProfileId: 'profile-a',
    initialRevision: 1,
  });
  const adapter = createServerTasteServiceAdapter({
    dataDir: tmpDir,
    profileContext,
    rebuildOnEvent: false,
  });
  const repository = createBackgroundTaskRepository({ dataDir: tmpDir });
  const manager = createBackgroundManager({
    repository,
    handlers: [createLibraryItemAddedHandler(), createTasteEventSyncHandler(adapter)],
    profileContext,
  });
  const eventBus = createAppEventBus({
    persistEvent: async (event) => {
      // Persist aşamasında olay aktif profile ait; hemen ardından profil değişir.
      await manager.acceptEvent(event);
      await profileContext.switchProfile('profile-b', 2);
    },
  });
  const skipped = [];
  const subscription = subscribeTasteAdapterToEventBus(
    eventBus,
    adapter,
    undefined,
    (event, outcome) => {
      manager.ensureProfileScopedTasks(event);
      skipped.push({ eventId: event.eventId, code: outcome.code });
    }
  );

  try {
    const event = makeEvent({
      eventId: 'evt-a4-profile-switch-race',
      ref: { profileId: 'profile-a', revision: 1 },
    });
    await eventBus.publish(event);

    assert.deepEqual(skipped, [
      { eventId: 'evt-a4-profile-switch-race', code: 'profile-not-active' },
    ]);

    assert.ok(
      manager.listTasks().some((task) => task.handlerId === TASTE_EVENT_SYNC_HANDLER_ID),
      'canlı abonelikte profil değişimi nedeniyle atlanan olay için kalıcı telafi görevi bulunmalı'
    );

    await manager.start();
    await profileContext.switchProfile('profile-a', 3);
    const completed = await pumpUntil(manager, () =>
      manager.listTasks().every((task) => task.status === 'completed')
    );
    assert.equal(completed, true, 'profil geri açıldığında telafi görevi tamamlanmalı');
    assert.deepEqual(
      (await readTasteEventsForProfile('profile-a', tmpDir)).map((item) => item.eventId),
      ['evt-a4-profile-switch-race']
    );
    assert.deepEqual(await readTasteEventsForProfile('profile-b', tmpDir), []);
  } finally {
    subscription.unsubscribe();
    await manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});


test('R2-A4 retry: olay yazıldıktan sonra rebuild başarısızsa tekrar deneme profili yeniden oluşturmalı', async () => {
  const tmpDir = await makeTempDir();
  const runtime = await makeRuntime(tmpDir, true);
  try {
    const paths = resolveTastePathsForProfile('profile-a', tmpDir).paths;
    // Olay deposu yazılabilir kalırken profil çıktı dosyasını yazılamaz hâle getir.
    await fs.mkdir(paths.profile, { recursive: true });

    const event = makeEvent({
      eventId: 'evt-a4-rebuild-retry',
      ref: { profileId: 'profile-a', revision: 1 },
    });
    const first = await runtime.adapter.processDeferredEvent(event);
    assert.equal(first.ok, false, 'ilk rebuild yazma hatasıyla başarısız olmalı');
    assert.equal(first.retryable, true);
    assert.deepEqual(
      (await readTasteEventsForProfile('profile-a', tmpDir)).map((item) => item.eventId),
      ['evt-a4-rebuild-retry'],
      'kanıt olayı rebuild hatasına rağmen kalıcılaşmış olmalı'
    );

    // Altyapı hatası giderildi; aynı kuyruk görevi tekrar çalıştırılır.
    await fs.rm(paths.profile, { recursive: true, force: true });
    const retry = await runtime.adapter.processDeferredEvent(event);
    assert.deepEqual(retry, { ok: true });
    assert.ok(
      await readTasteProfileForProfile('profile-a', tmpDir),
      'event zaten var diye erken dönülmemeli; eksik profil rebuild edilmelidir'
    );
  } finally {
    await runtime.manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
