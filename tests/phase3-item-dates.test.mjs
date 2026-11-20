import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getUserSignalV3,
  normalizeSavedItem,
  signalDecay,
} from '../src/core/cinetrack-core.ts';
import {
  backfillInteractionDates,
  resolveItemInteractionTimestampMs,
  resolveItemSignalDate,
  resolveItemWatchedDate,
} from '../src/core/item-dates.ts';
import { resolveItemTrackedDate } from '../src/core/wrapped-summary.ts';
import { exportItemsToCsv } from '../src/core/exporters.ts';

const NOW = new Date('2026-11-20T12:00:00.000Z');

function baseItem(overrides = {}) {
  return {
    id: 27205,
    media_type: 'movie',
    title: 'Inception',
    vote_average: 8.4,
    vote_count: 30000,
    popularity: 80,
    genre_ids: [878, 53],
    status: 'completed',
    personal_rating: 9,
    ...overrides,
  };
}

test('Faz 3 · 1 — Not/metadata düzenlemesi sinyal yaşını değiştirmez', () => {
  const ratedAt = '2020-01-01T00:00:00.000Z';
  const editedLater = '2026-11-01T00:00:00.000Z';
  const item = baseItem({ ratedAt, completedAt: '2020-02-01T00:00:00.000Z', updatedAt: editedLater });

  const signal = getUserSignalV3(item, NOW.getTime());
  assert.ok(signal, 'sinyal üretilmeli');
  assert.equal(resolveItemSignalDate(item), ratedAt, 'sinyal tarihi ratedAt olmalı');
  assert.equal(signal.decay, signalDecay(ratedAt, 730, NOW.getTime()));
  assert.ok(signal.decay < 0.25, `not düzenlemesi sinyali tazelememeli (decay=${signal.decay})`);

  const freshEditOnly = getUserSignalV3(
    baseItem({ ratedAt, completedAt: '2020-02-01T00:00:00.000Z', updatedAt: NOW.toISOString() }),
    NOW.getTime()
  );
  assert.equal(freshEditOnly.decay, signal.decay, 'updatedAt değişimi decay sonucunu değiştirmemeli');
});

test('Faz 3 · 1 — İzlenme tarihi updatedAt yerine completedAt/ratedAt kullanır', () => {
  const item = baseItem({
    ratedAt: '2019-05-05T00:00:00.000Z',
    completedAt: '2019-04-04T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(resolveItemWatchedDate(item), '2019-04-04T00:00:00.000Z');
  assert.equal(resolveItemInteractionTimestampMs(item), Date.parse('2019-05-05T00:00:00.000Z'));
});

test('Faz 3 · 2 — Eski kayıtlar yeni alanlarla uyumlu okunur (geri doldurma)', () => {
  const legacy = normalizeSavedItem(
    baseItem({
      status: 'completed',
      completedAt: '2018-03-03T00:00:00.000Z',
      addedAt: '2018-01-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      personal_rating: 8,
      ratedAt: undefined,
      watchedAt: undefined,
    })
  );
  assert.ok(legacy);
  assert.equal(legacy.watchedAt, undefined, 'updatedAt izlenme tarihi olarak uydurulmamalı');
  assert.equal(legacy.ratedAt, undefined, 'puan tarihi yoksa uydurulmamalı');

  const before = JSON.stringify([legacy]);
  const result = backfillInteractionDates([legacy]);
  const [migrated] = result.items;
  assert.equal(result.changedCount, 1);
  assert.equal(migrated.watchedAt, '2018-03-03T00:00:00.000Z', 'tamamlanmış kayıtta watchedAt completedAt olmalı');
  assert.equal(migrated.firstAddedAt, '2018-01-01T00:00:00.000Z');
  assert.equal(migrated.id, legacy.id);
  assert.equal(migrated.status, legacy.status);
  assert.equal(migrated.personal_rating, legacy.personal_rating);
  assert.notEqual(JSON.stringify([migrated]), before, 'migration alan eklemeli');

  const second = backfillInteractionDates(result.items);
  assert.equal(second.changedCount, 0, 'geri doldurma idempotent olmalı');
  assert.equal(JSON.stringify(second.items), JSON.stringify(result.items));

  const existingWatched = normalizeSavedItem(
    baseItem({ watchedAt: '2021-07-07T00:00:00.000Z', completedAt: '2021-08-08T00:00:00.000Z' })
  );
  assert.equal(existingWatched.watchedAt, '2021-07-07T00:00:00.000Z');
});

test('Faz 3 · 3 — Yıllık özet etkileşim tarihini kullanır', () => {
  const item = baseItem({
    completedAt: '2019-04-04T00:00:00.000Z',
    addedAt: '2019-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const tracked = resolveItemTrackedDate(item);
  assert.ok(tracked);
  assert.equal(tracked.getUTCFullYear(), 2019, 'updatedAt yılı özete sızmamalı');

  const legacyNoInteraction = baseItem({
    completedAt: undefined,
    ratedAt: undefined,
    addedAt: undefined,
    firstAddedAt: undefined,
    updatedAt: '2025-01-01T00:00:00.000Z',
  });
  assert.equal(resolveItemTrackedDate(legacyNoInteraction).getUTCFullYear(), 2025);
});

test('Faz 3 · 3 — CSV dışa aktarımı doğru izleme tarihini yazar', () => {
  const item = normalizeSavedItem(
    baseItem({
      ratedAt: '2019-05-05T00:00:00.000Z',
      completedAt: '2019-04-04T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  );
  const csv = exportItemsToCsv([item], {
    profile: {
      id: 'PROFILE-DEFAULT',
      name: 'Profilim',
      createdAt: '2018-01-01T00:00:00.000Z',
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items: [item],
    },
    activeProfileId: 'PROFILE-DEFAULT',
  });
  const rows = csv.split('\r\n');
  const headers = rows[0].split(',');
  const watchedIndex = headers.findIndex((header) => header.trim().toLowerCase() === 'watcheddate');
  assert.ok(watchedIndex >= 0, 'CSV başlığında WatchedDate sütunu olmalı');
  const cells = rows[1].split(',');
  assert.equal(cells[watchedIndex], '2019-04-04', 'İzleme Tarihi sütunu completedAt olmalı');
  assert.notEqual(cells[watchedIndex], '2026-01-01', 'updatedAt izleme tarihi olarak yazılmamalı');
});
