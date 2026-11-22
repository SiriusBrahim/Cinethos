/**
 * Aşama 3 — B-11: film/dizi zevk kapsamlarının ayrıştırılması.
 *
 * Politika: her kapsam yalnızca kendi türünün geçmişinden kurulur, medya tipi
 * tercihi nötrlenir, türü boşsa işaretli soğuk başlangıç kullanılır, türler arası
 * otomatik puan/favori paylaşımı yoktur.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScopedTasteProfiles,
  makeMediaKey,
  scoreCandidatesV3,
} from '../src/core/cinetrack-core.ts';

const GENRES = { drama: 18, comedy: 35, horror: 27, scifi: 878, tvDrama: 18, tvComedy: 35 };

function movie(id, { genre = GENRES.drama, rating = 9, cast = [], crew = [] } = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    genre_ids: [genre],
    personal_rating: rating,
    status: 'completed',
    release_date: '2020-01-01',
    cast,
    crew,
  };
}

function tv(id, { genre = GENRES.drama, rating = 9, cast = [], crew = [] } = {}) {
  return {
    id,
    media_type: 'tv',
    name: `Dizi ${id}`,
    genre_ids: [genre],
    personal_rating: rating,
    status: 'completed',
    first_air_date: '2020-01-01',
    cast,
    crew,
  };
}

const MOVIE_ACTOR = { id: 101, name: 'Film Oyuncusu' };
const TV_ACTOR = { id: 202, name: 'Dizi Oyuncusu' };

test('B-11/1: film geçmişi çok büyük, dizi geçmişi küçük — dizi profili yalnızca dizi geçmişinden kurulur', () => {
  const items = [
    ...Array.from({ length: 50 }, (_, i) => movie(1000 + i, { cast: [MOVIE_ACTOR] })),
    tv(2001, { genre: GENRES.tvComedy, cast: [TV_ACTOR] }),
    tv(2002, { genre: GENRES.tvComedy, cast: [TV_ACTOR] }),
  ];
  const scoped = buildScopedTasteProfiles(items, { lambda: 1 });

  assert.equal(scoped.tvItemCount, 2);
  assert.equal(scoped.movieItemCount, 50);
  assert.equal(scoped.tvColdStart, false);
  // Dizi profilinde film oyuncusu yok; film profilinde dizi oyuncusu yok.
  assert.equal(scoped.tv.actors['101'], undefined);
  assert.ok(scoped.tv.actors['202']);
  assert.equal(scoped.movie.actors['202'], undefined);
  assert.ok(scoped.movie.actors['101']);
  // Film geçmişindeki drama türü dizi profilinin tür skorunu belirlemez.
  assert.equal(scoped.tv.genres[String(GENRES.tvComedy)] > 0, true);
  assert.equal(scoped.movie.genres[String(GENRES.tvComedy)], undefined);
});

test('B-11/2: dizi geçmişi çok büyük, film geçmişi küçük — film profili yalnızca film geçmişinden kurulur', () => {
  const items = [
    ...Array.from({ length: 40 }, (_, i) => tv(3000 + i, { genre: GENRES.tvDrama, cast: [TV_ACTOR] })),
    movie(4001, { genre: GENRES.horror, cast: [MOVIE_ACTOR] }),
  ];
  const scoped = buildScopedTasteProfiles(items, { lambda: 1 });
  assert.equal(scoped.movieItemCount, 1);
  assert.equal(scoped.movieColdStart, false);
  assert.ok(scoped.movie.genres[String(GENRES.horror)] > 0);
  assert.equal(scoped.movie.genres[String(GENRES.tvDrama)], undefined);
  assert.equal(scoped.movie.actors['202'], undefined);
});

test('B-11/3: dengeli geçmişte iki kapsam da kendi sinyallerini taşır ve medya tercihi nötrdür', () => {
  const items = [
    movie(5001, { genre: GENRES.scifi }),
    movie(5002, { genre: GENRES.scifi }),
    tv(5003, { genre: GENRES.tvComedy }),
    tv(5004, { genre: GENRES.tvComedy }),
  ];
  const scoped = buildScopedTasteProfiles(items, { lambda: 1 });
  assert.deepEqual(scoped.movie.mediaPreference, { movie: 0.5, tv: 0.5 });
  assert.deepEqual(scoped.tv.mediaPreference, { movie: 0.5, tv: 0.5 });
  assert.deepEqual(scoped.general.mediaPreference, { movie: 0.5, tv: 0.5 });
  assert.equal(scoped.movie.genres[String(GENRES.scifi)] > 0, true);
  assert.equal(scoped.tv.genres[String(GENRES.tvComedy)] > 0, true);
});

test('B-11/4: yalnızca film izleyen kullanıcıda dizi kapsamı işaretli soğuk başlangıçtır', () => {
  const items = [movie(6001), movie(6002), movie(6003)];
  const scoped = buildScopedTasteProfiles(items, { lambda: 1 });
  assert.equal(scoped.movieColdStart, false);
  assert.equal(scoped.tvColdStart, true);
  assert.deepEqual(scoped.tv.mediaPreference, { movie: 0.5, tv: 0.5 });
});

test('B-11/5: yalnızca dizi izleyen kullanıcıda film kapsamı işaretli soğuk başlangıçtır', () => {
  const items = [tv(7001), tv(7002)];
  const scoped = buildScopedTasteProfiles(items, { lambda: 1 });
  assert.equal(scoped.tvColdStart, false);
  assert.equal(scoped.movieColdStart, true);
});

test('B-11/6: her iki türde favori oyuncular kendi kapsamında kalır', () => {
  const items = [
    movie(8001, { cast: [MOVIE_ACTOR] }),
    tv(8002, { cast: [TV_ACTOR] }),
  ];
  const scoped = buildScopedTasteProfiles(items, { lambda: 1 });
  assert.equal(Object.keys(scoped.movie.actors).join(','), '101');
  assert.equal(Object.keys(scoped.tv.actors).join(','), '202');
});

test('B-11/7: ortak tür sevilse bile farklı puanlar türün kendi kapsamında kalır', () => {
  const items = [
    movie(9001, { genre: GENRES.drama, rating: 10 }),
    tv(9002, { genre: GENRES.tvDrama, rating: 2 }),
  ];
  const scoped = buildScopedTasteProfiles(items, { lambda: 1 });
  assert.ok(scoped.movie.genres[String(GENRES.drama)] > 0.2, 'film draması güçlü pozitif olmalı');
  assert.ok(scoped.tv.genres[String(GENRES.tvDrama)] < 0, 'dizi draması negatif olmalı');

  const movieCandidate = { id: 9101, media_type: 'movie', title: 'Drama Film', genre_ids: [GENRES.drama] };
  const tvCandidate = { id: 9102, media_type: 'tv', name: 'Drama Dizi', genre_ids: [GENRES.tvDrama] };

  const [scoredMovie] = scoreCandidatesV3([movieCandidate], scoped.movie);
  const [scoredTv] = scoreCandidatesV3([tvCandidate], scoped.tv);
  assert.ok(scoredMovie.parts.genre > 0.5, 'film kapsamında drama türü puanı yükseltmeli');
  assert.ok(scoredTv.parts.genre < 0.5, 'dizi kapsamında sevilmeyen drama türü puanı düşürmeli');
});

test('B-11: kapsam profilleri kaynak geçmişi değiştirmez', () => {
  const items = [movie(9501), tv(9502)];
  const snapshot = JSON.parse(JSON.stringify(items));
  buildScopedTasteProfiles(items, { lambda: 1 });
  assert.deepEqual(items, snapshot);
  assert.equal(makeMediaKey(items[0]), 'movie:9501');
});
