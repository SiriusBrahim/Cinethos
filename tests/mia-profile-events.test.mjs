import test from 'node:test';
import assert from 'node:assert/strict';

import { createEventBus } from '../src/core/kernel/event-bus.ts';
import { createProfileContext, StaleProfileTaskError } from '../src/core/kernel/profile-context.ts';
import { createInMemoryRepository } from '../src/core/kernel/repository-contracts.ts';

/**
 * MIA Faz 1 — profil bağlamı, olay yolu ve repository sözleşmesi.
 */

test('Faz 1: profil değişimi eski görevleri geçersiz kılar', () => {
  const profile = createProfileContext({ profileId: 'profile-a', revision: 5 });
  const task = profile.beginTask();

  assert.equal(profile.isTaskCurrent(task), true);
  assert.deepEqual(
    { profileId: task.profileId, revision: task.revision, epoch: task.epoch },
    { profileId: 'profile-a', revision: 5, epoch: 0 }
  );

  profile.switchProfile('profile-b', 0);

  assert.equal(profile.isTaskCurrent(task), false);
  assert.throws(() => profile.assertCurrent(task), StaleProfileTaskError);
  try {
    profile.assertCurrent(task);
  } catch (error) {
    assert.equal(error.name, 'StaleProfileTaskError');
    assert.equal(error.activeProfileId, 'profile-b');
  }

  const nextTask = profile.beginTask();
  assert.equal(nextTask.profileId, 'profile-b');
  assert.equal(nextTask.epoch, 1);
});

test('Faz 1: aynı profile yeni revizyon da eski görevi geçersiz kılar', () => {
  const profile = createProfileContext({ profileId: 'profile-a', revision: 5 });
  const task = profile.beginTask();

  const snapshot = profile.setRevision(6);
  assert.equal(snapshot.profileId, 'profile-a');
  assert.equal(snapshot.epoch, 1);
  assert.equal(profile.isTaskCurrent(task), false);

  // Aynı revizyon yeniden gönderilirse epoch artmaz (gereksiz iptal yok).
  profile.setRevision(6);
  assert.equal(profile.getSnapshot().epoch, 1);
});

test('Faz 1: profil geçişi profile.changed olayını yayınlar ve dinleyicilere bildirir', () => {
  const events = createEventBus();
  const received = [];
  const changes = [];
  events.subscribe('profile.changed', (event) => received.push(event));
  const profile = createProfileContext({ profileId: 'profile-a', revision: 3, events });
  profile.subscribe((snapshot) => changes.push(snapshot.profileId));

  profile.switchProfile('profile-b', 7);

  assert.equal(received.length, 1);
  assert.equal(received[0].payload.previousProfileId, 'profile-a');
  assert.equal(received[0].payload.profileId, 'profile-b');
  assert.equal(received[0].payload.revision, 7);
  assert.equal(received[0].profileId, 'profile-b');
  assert.deepEqual(changes, ['profile-b']);
});

test('Faz 1: olay zarfı standart alanları taşır ve abonelik yönetilir', () => {
  let clock = new Date('2026-11-16T10:00:00.000Z');
  const events = createEventBus({ now: () => clock, idFactory: () => 'evt-1' });
  const seen = [];

  const unsubscribe = events.subscribe('watchlist.changed', (event) => seen.push(event));
  assert.equal(events.listenerCount('watchlist.changed'), 1);

  const envelope = events.publish(
    'watchlist.changed',
    { contentKey: 'movie:603', status: 'watched', previousStatus: 'watchlist' },
    { profileId: 'profile-a', entityId: 'movie:603' }
  );

  assert.equal(envelope.id, 'evt-1');
  assert.equal(envelope.type, 'watchlist.changed');
  assert.equal(envelope.profileId, 'profile-a');
  assert.equal(envelope.entityId, 'movie:603');
  assert.equal(envelope.occurredAt, '2026-11-16T10:00:00.000Z');
  assert.equal(envelope.schemaVersion, 1);
  assert.deepEqual(seen, [envelope]);

  unsubscribe();
  assert.equal(events.listenerCount('watchlist.changed'), 0);
  events.publish('watchlist.changed', { contentKey: 'movie:603', status: 'watched' }, { profileId: 'profile-a' });
  assert.equal(seen.length, 1);
});

test('Faz 1: abone hatası diğer aboneleri durdurmaz ve profileId filtresi çalışır', () => {
  const failures = [];
  const events = createEventBus({ onError: (failure) => failures.push(failure) });
  const received = [];

  events.subscribe('taste.updated', () => {
    throw new Error('bozuk abone');
  });
  events.subscribe('taste.updated', (event) => received.push(event.profileId));
  events.subscribe(
    'taste.updated',
    (event) => received.push(`filtre:${event.profileId}`),
    { profileId: 'profile-b' }
  );

  events.publish('taste.updated', { reason: 'rating', evidenceCount: 2 }, { profileId: 'profile-a' });
  assert.deepEqual(received, ['profile-a']);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].type, 'taste.updated');
  assert.match(failures[0].error.message, /bozuk abone/);

  events.publish('taste.updated', { reason: 'rating', evidenceCount: 3 }, { profileId: 'profile-b' });
  assert.deepEqual(received, ['profile-a', 'profile-b', 'filtre:profile-b']);
});

test('Faz 1: once aboneliği tek sefer çalışır, geçersiz olay adı reddedilir', () => {
  const events = createEventBus();
  let count = 0;
  events.once('content.added', () => {
    count += 1;
  });

  events.publish('content.added', { contentKey: 'movie:1', mediaType: 'movie' }, { profileId: 'system' });
  events.publish('content.added', { contentKey: 'movie:2', mediaType: 'movie' }, { profileId: 'system' });
  assert.equal(count, 1);
  assert.equal(events.listenerCount('content.added'), 0);

  assert.throws(() => events.publish('ContentAdded', {}, { profileId: 'system' }), /domain\.action/);
  assert.throws(
    () => events.subscribe('content-added', () => undefined),
    /domain\.action/
  );
  assert.throws(
    () => events.publish('content.added', { contentKey: 'movie:1', mediaType: 'movie' }, { profileId: '' }),
    /profileId/
  );
});

test('Faz 1: in-memory repository revizyon ve çakışma sözleşmesini uygular', async () => {
  const repository = createInMemoryRepository({
    name: 'test-repo',
    keyOf: (value) => value.key,
  });

  const empty = await repository.get('movie:1');
  assert.equal(empty.ok, true);
  assert.equal(empty.value, null);

  const first = await repository.put({ key: 'movie:1', title: 'Film' });
  assert.equal(first.ok, true);
  assert.equal(first.value.revision, 1);

  const second = await repository.put({ key: 'movie:1', title: 'Film 2' }, { expectedRevision: 1 });
  assert.equal(second.ok, true);
  assert.equal(second.value.revision, 2);

  const stale = await repository.put({ key: 'movie:1', title: 'Eski' }, { expectedRevision: 1 });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'conflict');
  assert.equal(stale.error.details.currentRevision, 2);

  const list = await repository.list();
  assert.equal(list.value.length, 1);
  assert.equal(list.value[0].value.title, 'Film 2');

  const removed = await repository.delete('movie:1');
  assert.equal(removed.value, true);
  const gone = await repository.get('movie:1');
  assert.equal(gone.value, null);
});
