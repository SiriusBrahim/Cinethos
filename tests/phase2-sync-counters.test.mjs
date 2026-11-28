import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBidirectionalSyncCounters,
  combineSyncRecordCounts,
  countCatalogRecordChanges,
  countCinemaKunyeRecordChanges,
  countUserDataRecordChanges,
} from '../src/core/sync-counters.ts';

function item(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    status: 'watchlist',
    personal_rating: '',
    genre_ids: [18],
    ...overrides,
  };
}

function doc(items, profileId = 'profile-a') {
  return {
    version: 3,
    schemaVersion: 3,
    engineVersion: 'test',
    activeProfileId: profileId,
    profiles: [
      {
        id: profileId,
        name: 'Profil',
        createdAt: '2026-01-01T00:00:00.000Z',
        preferences: { disliked: [], hidden: [], providers: [], mood: '', reminders: false, notified: [] },
        items,
      },
    ],
    revision: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

test('B-39: kullanıcı kayıtları ekleme/güncelleme/değişmeyen olarak doğru sayılır', () => {
  const before = doc([item(1), item(2)]);
  const after = doc([item(1, { personal_rating: '9' }), item(3), item(2)]);
  assert.deepEqual(countUserDataRecordChanges(before, after), {
    added: 1,
    updated: 1,
    skipped: 1,
  });
});

test('B-39: yalnızca zaman damgası değişimi "güncellendi" sayılmaz', () => {
  const before = doc([item(1, { updatedAt: '2026-01-01T00:00:00.000Z' })]);
  const after = doc([item(1, { updatedAt: '2026-06-01T00:00:00.000Z' })]);
  assert.deepEqual(countUserDataRecordChanges(before, after), {
    added: 0,
    updated: 0,
    skipped: 1,
  });
});

test('B-39: aynı medya anahtarı farklı profillerde ayrı kayıt sayılır', () => {
  const before = {
    ...doc([item(1)], 'profile-a'),
    profiles: [
      { ...doc([item(1)], 'profile-a').profiles[0] },
      { ...doc([item(1)], 'profile-b').profiles[0] },
    ],
  };
  const after = {
    ...before,
    profiles: [
      { ...before.profiles[0], items: [item(1), item(2)] },
      { ...before.profiles[1], items: [item(1)] },
    ],
  };
  assert.deepEqual(countUserDataRecordChanges(before, after), {
    added: 1,
    updated: 0,
    // İki profildeki aynı medya anahtarı ayrı kayıt sayılır; ikisi de değişmedi.
    skipped: 2,
  });
});

test('B-39: katalog ve Sinema Künyesi kayıtları alan düzeyinde sayılır', () => {
  const movieBefore = { 'movie:1': { key: 'movie:1', title: 'A', vote_average: 7 } };
  const movieAfter = {
    'movie:1': { key: 'movie:1', title: 'A', vote_average: 8 },
    'movie:2': { key: 'movie:2', title: 'B' },
  };
  assert.deepEqual(countCatalogRecordChanges(movieBefore, movieAfter), {
    added: 1,
    updated: 1,
    skipped: 0,
  });

  const kunyeBefore = { entries: { 'movie:1': { year: 2020, genres: ['Drama'] } } };
  const kunyeAfter = { entries: { 'movie:1': { year: 2020, genres: ['Drama'] } } };
  assert.deepEqual(countCinemaKunyeRecordChanges(kunyeBefore, kunyeAfter), {
    added: 0,
    updated: 0,
    skipped: 1,
  });
});

test('B-39: iki tarafta eklenen aynı kayıt çift sayılmaz, farklı kayıtlar birleşir', () => {
  const localBefore = { userData: doc([item(1)]), movies: {}, tv: {} };
  const localAfter = { userData: doc([item(1), item(2)]), movies: {}, tv: {} };
  const remoteBefore = { userData: doc([item(1)]), movies: {}, tv: {} };
  const remoteAfter = { userData: doc([item(1), item(2)]), movies: {}, tv: {} };
  assert.deepEqual(
    buildBidirectionalSyncCounters({ localBefore, localAfter, remoteBefore, remoteAfter }),
    { added: 1, updated: 0, skipped: 1 },
    'aynı kayıt iki tarafta da eklendiyse tek kez sayılmalı'
  );

  const remoteDifferent = {
    userData: doc([item(1), item(9)]),
    movies: {},
    tv: {},
  };
  assert.deepEqual(
    buildBidirectionalSyncCounters({
      localBefore,
      localAfter,
      remoteBefore,
      remoteAfter: remoteDifferent,
    }),
    { added: 2, updated: 0, skipped: 1 },
    'iki tarafta farklı yeni kayıtlar ayrı sayılır; ortak değişmeyen kayıt tek kez'
  );
});

test('B-39: türetilmiş profil/önbellek sayaç kapsamına girmez', () => {
  const counts = buildBidirectionalSyncCounters({
    localBefore: { userData: doc([item(1)]), movies: {}, tv: {} },
    localAfter: { userData: doc([item(1)]), movies: {}, tv: {} },
    remoteBefore: { userData: doc([item(1)]), movies: {}, tv: {} },
    remoteAfter: { userData: doc([item(1)]), movies: {}, tv: {} },
  });
  assert.deepEqual(counts, { added: 0, updated: 0, skipped: 1 });
  assert.deepEqual(combineSyncRecordCounts(), { added: 0, updated: 0, skipped: 0 });
});

test('B-39: uzak taraf bilinmiyorsa yalnızca yerel değişim raporlanır', () => {
  const counts = buildBidirectionalSyncCounters({
    localBefore: { userData: doc([]), movies: {}, tv: {} },
    localAfter: { userData: doc([item(4)]), movies: {}, tv: {} },
    remoteBefore: null,
    remoteAfter: null,
  });
  assert.deepEqual(counts, { added: 1, updated: 0, skipped: 0 });
});
