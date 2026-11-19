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
import { readTasteEventsForProfile } from '../../src/server/taste-store.ts';
import { createBackgroundTaskRepository } from '../../src/server/background-task-repository.ts';
import { createBackgroundManager } from '../../src/modules/background/service.ts';
import { createLibraryItemAddedHandler } from '../../src/modules/background/handlers.ts';
import { createTasteEventSyncHandler } from '../../src/modules/background/taste-handlers.ts';

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

async function makeRuntime(tmpDir) {
  let clock = Date.UTC(2026, 0, 1, 0, 0, 0);
  const now = () => new Date((clock += 1000)).toISOString();
  const profileContext = createProfileContext({
    initialProfileId: 'profile-a',
    initialRevision: 1,
  });
  const adapter = createServerTasteServiceAdapter({
    dataDir: tmpDir,
    profileContext,
    rebuildOnEvent: false,
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

    const task = runtime.manager.listTasks().find((entry) => entry.handlerId === 'intelligence.taste-event-sync');
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
    assert.equal(runtime.manager.listTasks().find((entry) => entry.handlerId === 'intelligence.taste-event-sync')?.status, 'pending');

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

test('R2-A4 aktif profilin olayı da yarış penceresine karşı kalıcı outbox görevi alır', async () => {
  const tmpDir = await makeTempDir();
  const runtime = await makeRuntime(tmpDir);
  try {
    await runtime.manager.start();
    await runtime.manager.acceptEvent(makeEvent({ eventId: 'evt-a4-active' }));
    const tasks = runtime.manager.listTasks();
    assert.ok(tasks.some((task) => task.handlerId === 'intelligence.taste-event-sync'), 'aktif profilin canlı işleme öncesinde profil değişebilir; kalıcı Taste outbox görevi bulunmalı');
  } finally {
    await runtime.manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});


test('R2-A4 yarış: persistEvent sonrasında profil değişse de canlı atlanan olay outbox üzerinden kaybolmaz', async () => {
  const tmpDir = await makeTempDir();
  const profileContext = createProfileContext({ initialProfileId: 'profile-a', initialRevision: 1 });
  const adapter = createServerTasteServiceAdapter({ dataDir: tmpDir, profileContext, rebuildOnEvent: false });
  const repository = createBackgroundTaskRepository({ dataDir: tmpDir });
  const manager = createBackgroundManager({
    repository,
    handlers: [createLibraryItemAddedHandler(), createTasteEventSyncHandler(adapter)],
    profileContext,
  });
  const eventBus = createAppEventBus({
    persistEvent: async (event) => {
      await manager.acceptEvent(event);
      await profileContext.switchProfile('profile-b', 2);
    },
  });
  const skipped = [];
  const subscription = subscribeTasteAdapterToEventBus(
    eventBus, adapter, undefined,
    (event, outcome) => skipped.push({ eventId: event.eventId, code: outcome.code })
  );

  try {
    await eventBus.publish(makeEvent({
      eventId: 'evt-a4-profile-switch-race',
      ref: { profileId: 'profile-a', revision: 1 },
    }));
    assert.deepEqual(skipped, [{ eventId: 'evt-a4-profile-switch-race', code: 'profile-not-active' }]);
    assert.ok(manager.listTasks().some((task) => task.handlerId === 'intelligence.taste-event-sync'));

    await profileContext.switchProfile('profile-a', 3);
    await manager.start();
    await pumpUntil(manager, () => manager.listTasks()
      .filter((task) => task.handlerId === 'intelligence.taste-event-sync')
      .every((task) => task.status === 'completed'));

    assert.deepEqual(
      (await readTasteEventsForProfile('profile-a', tmpDir)).map((entry) => entry.eventId),
      ['evt-a4-profile-switch-race']
    );
    assert.deepEqual(await readTasteEventsForProfile('profile-b', tmpDir), []);
  } finally {
    subscription.unsubscribe();
    await manager.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('R2-A4 retry: event yazıldıktan sonra rebuild başarısız olursa aynı adapter yeniden rebuild yapar', async () => {
  const tmpDir = await makeTempDir();
  const profileContext = createProfileContext({ initialProfileId: 'profile-a', initialRevision: 1 });
  let rebuildAttempts = 0;
  const adapter = createServerTasteServiceAdapter({
    dataDir: tmpDir,
    profileContext,
    rebuildOnEvent: true,
    rebuildProfile: async () => {
      rebuildAttempts += 1;
      if (rebuildAttempts === 1) throw new Error('deterministic-first-rebuild-failure');
      return {};
    },
  });

  try {
    const event = makeEvent({
      eventId: 'evt-a4-rebuild-retry',
      ref: { profileId: 'profile-a', revision: 1 },
    });
    const first = await adapter.processDeferredEvent(event);
    assert.equal(first.ok, false);
    assert.equal(first.retryable, true);
    assert.deepEqual(
      (await readTasteEventsForProfile('profile-a', tmpDir)).map((entry) => entry.eventId),
      ['evt-a4-rebuild-retry']
    );

    const retry = await adapter.processDeferredEvent(event);
    assert.deepEqual(retry, { ok: true });
    assert.equal(rebuildAttempts, 2, 'eventId dedupe rebuild retry işlemini atlamamalı');
    assert.equal((await readTasteEventsForProfile('profile-a', tmpDir)).length, 1);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
