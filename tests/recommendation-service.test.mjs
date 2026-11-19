import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRecommendationManager,
  createRecommendationService,
} from '../src/modules/recommendations/index.ts';
import {
  CATALOG_ITEMS,
  GENRES_MAP,
  PREFERENCES,
  SAVED_ITEMS,
  TASTE_MAP,
} from './fixtures/faz6-recommendation-dataset.mjs';

const snapshot = () => ({
  items: CATALOG_ITEMS,
  savedItems: SAVED_ITEMS,
  preferences: PREFERENCES,
  genresMap: GENRES_MAP,
  tasteMap: TASTE_MAP,
});

test('Faz 6 IRecommendationService: profile/revision-scoped önerileri üretir ve önbelleğe alır', async () => {
  let loads = 0;
  const service = createRecommendationService({
    loadSnapshot: async () => {
      loads += 1;
      return snapshot();
    },
  });
  const ref = { profileId: 'profile-a', revision: 7 };

  const first = await service.getRecommendations(ref, 10);
  const second = await service.getRecommendations(ref, 10);
  assert.deepEqual(first, second);
  assert.ok(first.length > 0);
  assert.ok(first.every((item) =>
    typeof item.mediaKey === 'string' &&
    Number.isFinite(item.score) &&
    typeof item.reason === 'string'
  ));
  assert.equal(loads, 1, 'aynı profile/revision/limit cache hit olmalı');

  const nextRevision = await service.getRecommendations({ ...ref, revision: 8 }, 10);
  assert.ok(nextRevision.length > 0);
  assert.equal(loads, 2, 'revision değişince eski cache kullanılmamalı');
});

test('Faz 6 IRecommendationService: stale profile sonucu cache hit olsa bile döndürülmez', async () => {
  let current = true;
  const service = createRecommendationService({
    loadSnapshot: async () => snapshot(),
    isCurrent: () => current,
  });
  const ref = { profileId: 'profile-a', revision: 1 };
  const cached = await service.getRecommendations(ref, 10);
  assert.ok(cached.length > 0);

  current = false;
  await assert.rejects(
    service.getRecommendations(ref, 10),
    (error) => error instanceof Error && error.message.includes('eski profile/revision')
  );
});
test('Faz 6 IRecommendationService: refresh profile cache alanını yeniler', async () => {
  let loads = 0;
  const service = createRecommendationService({
    loadSnapshot: async () => {
      loads += 1;
      return snapshot();
    },
  });
  const ref = { profileId: 'profile-a', revision: 2 };
  await service.getRecommendations(ref, 20);
  assert.deepEqual(await service.refresh(ref), { ok: true });
  assert.equal(loads, 2);
});

test('Faz 6 RecommendationManager: IRecommendationService portunu dışarı açar', () => {
  const service = createRecommendationService({ loadSnapshot: async () => snapshot() });
  const manager = createRecommendationManager({ service });
  assert.equal(manager.service, service);
  assert.equal(manager.id, 'recommendations');
});
