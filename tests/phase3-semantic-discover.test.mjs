import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSemanticAffinityMap,
  mergeSemanticAffinityMaps,
  rankBySemanticAffinity,
  semanticBoostFor,
} from '../src/core/semantic-ranking.ts';

function candidate(id, mediaType = 'movie', popularity = 50) {
  return { id, media_type: mediaType, title: `Aday ${id}`, popularity };
}

test('Faz 3 · 11 — Anlamsal ve atmosferik benzerlik tek afinite haritasında birleşir', () => {
  const map = buildSemanticAffinityMap([
    { targetKey: 'movie:1', cosineSimilarity: 0.9, atmosphereSimilarity: 0.9, confidence: 1 },
    { targetKey: 'tv:2', cosineSimilarity: 0.4 },
    { targetKey: 'geçersiz', cosineSimilarity: 1 },
    { targetKey: 'movie:3', cosineSimilarity: 0 },
  ]);
  assert.equal(map.size, 2, 'geçersiz/boş sinyaller haritaya girmez');
  assert.ok(map.get('movie:1') > 0.8);
  assert.ok(map.get('tv:2') > 0.3 && map.get('tv:2') < 0.6);
  const boost = semanticBoostFor(map, 'movie:1');
  assert.ok(boost > 0 && boost <= 8, `katkı sınırlı olmalı (${boost})`);
  assert.equal(semanticBoostFor(map, 'movie:99'), 0);

  const merged = mergeSemanticAffinityMaps(map, new Map([['movie:3', 0.5]]));
  assert.equal(merged.size, 3);
});

test('Faz 3 · 11 — Keşfet sıralaması semantik afiniteyi kullanır, analizi olmayanı cezalandırmaz', () => {
  const items = [candidate(1), candidate(2), candidate(3), candidate(4)];
  const hints = new Map([['movie:3', 0.9]]);
  const ranked = rankBySemanticAffinity(items, hints);
  assert.equal(ranked[0].id, 3, 'semantik olarak yakın içerik öne alınır');
  assert.deepEqual(
    ranked.slice(1).map((item) => item.id),
    [1, 2, 4],
    'diğerleri mevcut sırasını korur (ceza yok)'
  );
});

test('Faz 3 · 11 — Sunucu verisi yoksa keşif sıralaması değişmez (güvenli dönüş)', () => {
  const items = [candidate(1), candidate(2), candidate(3)];
  assert.deepEqual(rankBySemanticAffinity(items, null).map((it) => it.id), [1, 2, 3]);
  assert.deepEqual(rankBySemanticAffinity(items, new Map()).map((it) => it.id), [1, 2, 3]);
});

test('Faz 3 · 11 — Eşit katkıda sıralama kararlıdır', () => {
  const items = [candidate(5), candidate(6), candidate(7)];
  const hints = new Map([
    ['movie:5', 0.5],
    ['movie:6', 0.5],
    ['movie:7', 0.5],
  ]);
  assert.deepEqual(rankBySemanticAffinity(items, hints).map((it) => it.id), [5, 6, 7]);
});
