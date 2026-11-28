/**
 * Aşama 5.1 — F5.1-01 kabul testleri.
 *
 * `App.tsx`'ten çıkarılan saf modüllerin davranışını doğrudan çağrılarla
 * doğrular (kaynak metin taraması yoktur).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getCatalogTitles } from '../src/app/catalog-titles.ts';
import { collectDueReminders } from '../src/app/release-reminders.ts';
import { buildDisplayedItems } from '../src/app/displayed-items.ts';
import { buildSeriesUniverseData } from '../src/app/series-universe.ts';
import { normalizeSavedItem } from '../src/core/cinetrack-core.ts';

function saved(overrides = {}) {
  return normalizeSavedItem({
    id: 1,
    media_type: 'movie',
    title: 'Örnek',
    vote_average: 7,
    vote_count: 100,
    popularity: 10,
    genre_ids: [18],
    status: 'watchlist',
    ...overrides,
  });
}

function displayed(overrides = {}) {
  return buildDisplayedItems({
    tab: 'list',
    category: 'trending',
    forYouSubTab: 'recommendations',
    query: '',
    hideListedItems: false,
    listStatus: 'all',
    selectedType: 'all',
    selectedGenre: '',
    selectedSort: 'recent',
    savedItems: [],
    preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
    tasteMap: { entries: {} },
    dislikedItems: [],
    forYouItems: [],
    catalogItems: [],
    seriesItems: [],
    ...overrides,
  });
}

test('F5.1-01 getCatalogTitles: liste durumları, arama ve kategori başlıkları', () => {
  const counts = {
    allListCount: 12,
    watchingCount: 3,
    watchlistCount: 5,
    completedCount: 4,
    upcomingCount: 2,
    favoriteActorsCount: 6,
    dislikedCount: 1,
  };
  const base = {
    tab: 'list',
    query: '',
    listStatus: 'all',
    selectedType: 'movie',
    category: 'trending',
    forYouSubTab: 'recommendations',
    forYouExplanation: '',
    selectedGenre: '',
    genresMap: {},
    stockStats: { movieCount: 0, tvCount: 0 },
    tvdbCount: 0,
    counts,
  };

  assert.deepEqual(getCatalogTitles(base), {
    title: 'Tüm takip listem (12)',
    description: 'Listenizde toplam 12 kayıtlı film bulunuyor',
  });
  assert.equal(
    getCatalogTitles({ ...base, listStatus: 'watchlist' }).title,
    'İzlenecekler listem (5)'
  );
  assert.equal(getCatalogTitles({ ...base, listStatus: 'actors' }).description.includes('6 favori oyuncu'), true);
  assert.equal(getCatalogTitles({ ...base, tab: 'discover', query: 'dune' }).title, '"dune" için arama sonuçları');
  assert.equal(
    getCatalogTitles({ ...base, tab: 'discover', category: 'for-you', forYouSubTab: 'series' }).title,
    'Sana özel · Seriler'
  );
  assert.equal(
    getCatalogTitles({
      ...base,
      tab: 'discover',
      category: 'stock',
      stockStats: { movieCount: 500, tvCount: 500 },
      tvdbCount: 7,
    }).title,
    'Keşfet — 500 Film · 500 Dizi (TVDB: 7)'
  );
  assert.equal(
    getCatalogTitles({ ...base, tab: 'discover', category: 'bilinmeyen' }).title,
    'Güncel trendler'
  );
});

test('F5.1-01 collectDueReminders: tamamlananları ve bildirilmişleri atlar, bölüm etiketi üretir', () => {
  const today = new Date(2026, 10, 25);
  const airDate = '2026-11-25';
  const prefs = { disliked: [], providers: [], mood: '', reminders: true, notified: [] };

  const due = collectDueReminders(
    [
      saved({ id: 10, media_type: 'tv', title: 'Dizi', status: 'watching', next_episode_to_air: { air_date: airDate, season_number: 2, episode_number: 4 } }),
      saved({ id: 11, media_type: 'tv', title: 'Bitti', status: 'completed', next_episode_to_air: { air_date: airDate, season_number: 1, episode_number: 1 } }),
      saved({ id: 12, media_type: 'movie', title: 'Film', release_date: airDate }),
    ],
    prefs,
    today
  );

  assert.deepEqual(
    due.map((entry) => entry.key),
    ['tv:10:' + airDate, 'movie:12:' + airDate]
  );
  assert.equal(due[0].body, 'Dizi bugün yayınlanıyor (S2B4).');
  assert.equal(due[1].body, 'Film bugün yayınlanıyor.');

  const alreadyNotified = collectDueReminders(
    [saved({ id: 10, media_type: 'tv', title: 'Dizi', next_episode_to_air: { air_date: airDate, season_number: 2, episode_number: 4 } })],
    { ...prefs, notified: ['tv:10:' + airDate] },
    today
  );
  assert.deepEqual(alreadyNotified, []);

  assert.deepEqual(
    collectDueReminders([saved({ id: 13 })], { ...prefs, reminders: false }, today),
    []
  );
});

test('F5.1-01 buildDisplayedItems: tür filtresi, sıralama ve durum sekmeleri', () => {
  const movieA = saved({ id: 1, media_type: 'movie', title: 'Alfa', vote_average: 6 });
  const movieB = saved({ id: 2, media_type: 'movie', title: 'Beta', vote_average: 9 });
  const tv = saved({ id: 3, media_type: 'tv', title: 'Gama', vote_average: 7 });

  assert.deepEqual(
    displayed({ savedItems: [movieA, tv, movieB], selectedType: 'movie', selectedSort: 'rating' }).map((i) => i.id),
    [2, 1]
  );
  assert.deepEqual(
    displayed({ savedItems: [movieA, tv, movieB], selectedType: 'all', selectedSort: 'title' }).map((i) => i.id),
    [1, 2, 3]
  );

  const watching = saved({ id: 4, media_type: 'movie', title: 'İzlenen', status: 'watching' });
  assert.deepEqual(
    displayed({ savedItems: [movieA, watching], listStatus: 'watching' }).map((i) => i.id),
    [4]
  );

  const upcoming = saved({ id: 5, media_type: 'movie', title: 'Gelecek', release_date: '2099-01-01' });
  assert.deepEqual(
    displayed({ savedItems: [movieA, upcoming], listStatus: 'upcoming' }).map((i) => i.id),
    [5]
  );
});

test('F5.1-01 buildDisplayedItems: keşfet görünümünde sevilmmeyen ve listedeki kayıtlar filtrelenir', () => {
  const savedItem = saved({ id: 20, media_type: 'movie', title: 'Listede' });
  const disliked = saved({ id: 21, media_type: 'movie', title: 'Sevilmedi' });
  const fresh = saved({ id: 22, media_type: 'movie', title: 'Yeni' });

  const result = displayed({
    tab: 'discover',
    category: 'for-you',
    savedItems: [savedItem],
    forYouItems: [savedItem, disliked, fresh],
    preferences: { disliked: ['movie:21'], providers: [], mood: '', reminders: false, notified: [] },
    selectedSort: 'popular',
  });

  assert.deepEqual(
    result.map((item) => item.id),
    [22]
  );
});

test('F5.1-01 buildSeriesUniverseData: sevilmmeyen ve gizlenen eksik halkalar dışlanır', () => {
  const result = buildSeriesUniverseData({
    savedItems: [],
    disliked: ['movie:902'],
    hidden: ['movie:903'],
    includeStubs: false,
  });
  assert.deepEqual(result.items, []);
  assert.equal(result.universesCount, 0);
});
