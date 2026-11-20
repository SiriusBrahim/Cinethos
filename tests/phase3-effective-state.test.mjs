import test from 'node:test';
import assert from 'node:assert/strict';

import {
  collectEffectiveStateConflicts,
  filterRecommendableItems,
  resolveEffectiveItemState,
} from '../src/core/item-effective-state.ts';
import { filterCatalogItemsByPreferences } from '../src/app/catalog-loader.ts';
import { exportItemsToCsv } from '../src/core/exporters.ts';

const basePreferences = { disliked: [], hidden: [], providers: [], mood: '', reminders: false, notified: [] };

function saved(id, mediaType = 'movie') {
  return {
    id,
    media_type: mediaType,
    title: `İçerik ${id}`,
    vote_average: 7.5,
    vote_count: 500,
    popularity: 40,
    genre_ids: [18],
    status: 'completed',
    personal_rating: 8,
    addedAt: '2024-01-01T00:00:00.000Z',
    completedAt: '2024-02-01T00:00:00.000Z',
  };
}

function candidate(id, mediaType = 'movie') {
  return {
    id,
    media_type: mediaType,
    title: `Aday ${id}`,
    vote_average: 7.8,
    vote_count: 900,
    popularity: 55,
    genre_ids: [18],
    overview: 'Bir hikâye',
  };
}

test('Faz 3 · 7 — İlgilenmiyorum kütüphane kaydından üstündür', () => {
  const input = {
    savedItems: [saved(1), saved(2)],
    preferences: { ...basePreferences, disliked: ['movie:1'] },
  };
  const resolved = resolveEffectiveItemState(input, { id: 1, media_type: 'movie' });
  assert.equal(resolved.state, 'disliked');
  assert.equal(resolved.inLibrary, true, 'kayıt silinmez, uygunluk değişir');

  const visible = filterRecommendableItems(input, [candidate(1), candidate(2), candidate(3)]);
  assert.deepEqual(visible.map((item) => item.id), [2, 3], 'ilgilenmiyorum öneri yollarından elenir');
});

test('Faz 3 · 7 — Gizli içerik de aynı şekilde elenir', () => {
  const input = { savedItems: [], preferences: { ...basePreferences, hidden: ['tv:99'] } };
  const visible = filterRecommendableItems(input, [candidate(99, 'tv'), candidate(5)]);
  assert.deepEqual(visible.map((item) => item.id), [5]);
});

test('Faz 3 · 7 — Keşfet/arama katalog yolu aynı filtreyi uygular', () => {
  const items = [candidate(1), candidate(2), candidate(3)];
  const preferences = { ...basePreferences, disliked: ['movie:2'] };
  const visible = filterCatalogItemsByPreferences({ savedItems: [saved(1)], preferences }, items);
  const ids = visible.map((item) => item.id);
  assert.ok(!ids.includes(2), 'ilgilenmiyorum adayı keşif sonucuna sızmamalı');
  assert.ok(ids.includes(1) && ids.includes(3));
});

test('Faz 3 · 8 — Tercih geri alınınca içerik yeniden görünür', () => {
  const items = [candidate(1), candidate(2)];
  const disliked = filterCatalogItemsByPreferences(
    { savedItems: [], preferences: { ...basePreferences, disliked: ['movie:1'] } },
    items
  );
  assert.ok(!disliked.some((item) => item.id === 1));

  const restored = filterCatalogItemsByPreferences(
    { savedItems: [], preferences: { ...basePreferences, disliked: [] } },
    items
  );
  assert.ok(restored.some((item) => item.id === 1), 'tercih kaldırılınca içerik geri gelmeli');
});

test('Faz 3 · 3 — CSV yedeği çakışmayı görünür kılar', () => {
  const item = saved(7);
  const profile = {
    id: 'PROFILE-DEFAULT',
    name: 'Profilim',
    createdAt: '2024-01-01T00:00:00.000Z',
    preferences: { ...basePreferences, disliked: ['movie:7'] },
    items: [item],
  };
  const conflicts = collectEffectiveStateConflicts(profile);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].mediaKey, 'movie:7');
  assert.equal(conflicts[0].state, 'disliked');

  const csv = exportItemsToCsv([item], { profile, activeProfileId: 'PROFILE-DEFAULT' });
  assert.ok(csv.includes('#StateConflict'), 'CSV çakışma satırı içermeli');
  assert.ok(csv.includes('movie:7|disliked'));
});

test('Faz 3 · 3 — Silme, gizleme ve ilgilenmeme ayrı durumlardır', () => {
  const input = {
    savedItems: [saved(1)],
    preferences: { ...basePreferences, hidden: ['movie:2'], disliked: ['movie:3'] },
  };
  assert.equal(resolveEffectiveItemState(input, { id: 1, media_type: 'movie' }).state, 'saved');
  assert.equal(resolveEffectiveItemState(input, { id: 2, media_type: 'movie' }).state, 'hidden');
  assert.equal(resolveEffectiveItemState(input, { id: 3, media_type: 'movie' }).state, 'disliked');
  assert.equal(resolveEffectiveItemState(input, { id: 4, media_type: 'movie' }).state, 'available');
});
