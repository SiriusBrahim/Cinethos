import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeSeasonProgressLossless,
  setEpisodeWatched,
  setSeasonWatchedCount,
} from '../src/core/season-progress.ts';
import { advanceTvEpisodeProgress, deriveTvProgressSummary } from '../src/core/tv-progress.ts';
import { normalizeDataDocument } from '../src/core/cinetrack-core.ts';
import { reconcileUserDataDocumentsLossless } from '../src/core/user-data-merge.ts';

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-06-01T00:00:00.000Z';

function tvItem(overrides = {}) {
  return {
    id: 1399,
    media_type: 'tv',
    title: 'Test Dizisi',
    vote_average: 8,
    vote_count: 1000,
    popularity: 50,
    genre_ids: [18],
    status: 'watching',
    personal_rating: '',
    season_episode_counts: { 1: 10, 2: 10 },
    season_progress: { 1: 10 },
    ...overrides,
  };
}

test('Faz 3 · 4 — Dizi ilerlemesi geriye alınabilir (10 → 8)', () => {
  const local = tvItem({
    season_progress: { 1: 8 },
    progress_updated_at: { 1: T2 },
    watchedAt: T2,
  });
  const remote = tvItem({ season_progress: { 1: 10 }, progress_updated_at: { 1: T1 } });

  const merged = mergeSeasonProgressLossless(local, remote);
  assert.equal(merged.season_progress[1], 8, 'daha yeni damgalı bilinçli geri alma kazanmalı');
  assert.deepEqual(merged.watched_episodes[1], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(merged.conflictingSeasons.includes(1));

  const reversed = mergeSeasonProgressLossless(remote, local);
  assert.equal(reversed.season_progress[1], 8, 'sıra bağımsız (deterministik) olmalı');

  const newerRemote = mergeSeasonProgressLossless(
    tvItem({ season_progress: { 1: 8 }, progress_updated_at: { 1: T1 } }),
    tvItem({ season_progress: { 1: 10 }, progress_updated_at: { 1: T2 } })
  );
  assert.equal(newerRemote.season_progress[1], 10, 'uzak taraf daha yeniyse ilerleme korunur');
});

test('Faz 3 · 4 — Farklı sezonlar birbirini etkilemez', () => {
  const merged = mergeSeasonProgressLossless(
    tvItem({ season_progress: { 1: 3, 2: 9 }, progress_updated_at: { 1: T2, 2: T1 } }),
    tvItem({ season_progress: { 1: 5, 2: 4 }, progress_updated_at: { 1: T1, 2: T2 } })
  );
  assert.equal(merged.season_progress[1], 3, 'sezon 1: yerel daha yeni');
  assert.equal(merged.season_progress[2], 4, 'sezon 2: uzak daha yeni');
});

test('Faz 3 · 5 — Sırasız bölüm izleme temsil edilir (1, 3, 5)', () => {
  let item = tvItem({ season_progress: {}, current_season: 1 });
  for (const episode of [1, 3, 5]) {
    const patch = setEpisodeWatched(item, 1, episode, true, T2);
    item = { ...item, ...patch, status: 'watching' };
  }
  assert.deepEqual(item.watched_episodes[1], [1, 3, 5]);
  assert.equal(item.season_progress[1], 3);

  const summary = deriveTvProgressSummary(item);
  assert.equal(summary.watchedEpisodesCount, 3, 'toplam izlenen 3');
  assert.equal(summary.currentEpisode, 1, 'kesintisiz izlenen 1 → aktif bölüm 1');

  const advanced = advanceTvEpisodeProgress(item, '2026-07-01T00:00:00.000Z');
  assert.deepEqual(advanced.watched_episodes[1], [1, 2, 3, 5], 'sayaç 4 değil, 2. bölüm işaretlenmeli');
  assert.equal(advanced.season_progress[1], 4);
  assert.equal(advanced.watchedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(advanced.progress_updated_at[1], '2026-07-01T00:00:00.000Z');
});

test('Faz 3 · 5 — İzlenmedi işaretlemesi kalıcı ve senkronda geri dirilmez', () => {
  const local = {
    ...tvItem({ season_progress: { 1: 1, 2: 1 } }),
    watched_episodes: { 1: [1], 2: [1] },
    progress_updated_at: { 1: T1, 2: T2 },
  };
  const reverted = { ...local, ...setEpisodeWatched(local, 1, 1, false, '2026-08-01T00:00:00.000Z') };
  assert.equal(reverted.season_progress[1], 0);
  assert.equal(reverted.watched_episodes[1], undefined);

  const remote = {
    ...tvItem({ season_progress: { 1: 10 } }),
    watched_episodes: { 1: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
    progress_updated_at: { 1: T1 },
  };
  const merged = mergeSeasonProgressLossless(reverted, remote);
  assert.equal(merged.season_progress[1], 0, 'silinen bölümler geri diriltilmemeli');
  assert.equal(merged.watched_episodes[1], undefined);
});

test('Faz 3 · 4 — Legacy (damgasız) veri eski Math.max davranışını korur', () => {
  const merged = mergeSeasonProgressLossless(
    tvItem({ season_progress: { 1: 3 } }),
    tvItem({ season_progress: { 1: 7 } })
  );
  assert.equal(merged.season_progress[1], 7);
  assert.deepEqual(merged.watched_episodes[1], [1, 2, 3, 4, 5, 6, 7]);
});

test('Faz 3 · 6 — İki cihazın eşzamanlı değişikliği belge birleştirmede korunur', () => {
  const baseProfiles = (items) => [
    {
      id: 'PROFILE-DEFAULT',
      name: 'Profilim',
      createdAt: T1,
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items,
    },
  ];
  const localDoc = {
    version: 3,
    schemaVersion: 3,
    activeProfileId: 'PROFILE-DEFAULT',
    profiles: baseProfiles([
      tvItem({ season_progress: { 1: 2, 2: 5 }, progress_updated_at: { 1: T2, 2: T1 }, watchedAt: T2 }),
    ]),
  };
  const remoteDoc = {
    version: 3,
    schemaVersion: 3,
    activeProfileId: 'PROFILE-DEFAULT',
    profiles: baseProfiles([
      tvItem({ season_progress: { 1: 9, 2: 8 }, progress_updated_at: { 1: T1, 2: T2 }, watchedAt: T2 }),
    ]),
  };

  const { mergedDoc } = reconcileUserDataDocumentsLossless(
    normalizeDataDocument(localDoc),
    normalizeDataDocument(remoteDoc)
  );
  const merged = mergedDoc.profiles[0].items[0];
  assert.equal(merged.season_progress[1], 2, 'yerel cihazın yeni geri alması korunur');
  assert.equal(merged.season_progress[2], 8, 'uzak cihazın yeni ilerlemesi korunur');
  assert.equal(merged.watched_episodes[1].length, 2);
  assert.equal(merged.watched_episodes[2].length, 8);
});

test('Faz 3 · 4 — Sayaç ayarlama yardımcısı damga ve işaret üretir', () => {
  const item = tvItem({ season_progress: { 1: 10 } });
  const patch = setSeasonWatchedCount(item, 1, 8, T2);
  assert.equal(patch.season_progress[1], 8);
  assert.equal(patch.progress_updated_at[1], T2);
  assert.deepEqual(patch.watched_episodes[1], [1, 2, 3, 4, 5, 6, 7, 8]);
});
