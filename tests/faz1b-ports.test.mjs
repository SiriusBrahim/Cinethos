import test from 'node:test';
import assert from 'node:assert/strict';
import { createTasteRebuildPort, MissingProfileRefError } from '../src/server/taste-rebuild-port.ts';
import {
  createOutboxEventPublisher,
  createMemoryOutboxBackend,
  OUTBOX_MAX_ATTEMPTS,
  outboxBackoffMs,
} from '../src/services/offline-event-publisher.ts';
import { createRelationshipServiceAdapter } from '../src/services/relationship-service-adapter.ts';
import { createRecommendationServiceAdapter } from '../src/services/recommendation-service-adapter.ts';
import { relationshipNodeKey } from '../src/core/relationship-explorer.ts';

/* ------------------------------------------------------------------ */
/* ③ TasteRebuildPort                                                  */
/* ------------------------------------------------------------------ */

test('taste-rebuild-port: profileId olmadan ret (K1)', async () => {
  const port = createTasteRebuildPort(async () => ({ ok: true, rebuilt: true }));
  await assert.rejects(() => port.triggerRebuild({ profileId: '' }), MissingProfileRefError);
});

test('taste-rebuild-port: tetikleme sonucu ve busy durumu', async () => {
  let calls = 0;
  const port = createTasteRebuildPort(async () => {
    calls += 1;
    assert.equal(port.isBusy(), true, 'çalışma sırasında busy olmalı');
    return { ok: true, rebuilt: true };
  });
  const result = await port.triggerRebuild({ profileId: 'p1', revision: 3 }, 'test');
  assert.equal(result.ok, true);
  assert.equal(result.rebuilt, true);
  assert.equal(calls, 1);
  assert.equal(port.isBusy(), false);
});

test('taste-rebuild-port: hata sonucu ok:false olarak raporlanır', async () => {
  const port = createTasteRebuildPort(async () => {
    throw new Error('depo kilitli');
  });
  const result = await port.triggerRebuild({ profileId: 'p1' });
  assert.equal(result.ok, false);
  assert.match(result.error, /depo kilitli/u);
});

/* ------------------------------------------------------------------ */
/* ④ Outbox (IEventPublisher + IEventSubscriber)                       */
/* ------------------------------------------------------------------ */

function makeEvent(overrides = {}) {
  return {
    eventId: 'evt-1',
    eventType: 'LibraryItemAdded',
    profileId: 'p1',
    occurredAt: '2026-11-16T12:00:00.000Z',
    schemaVersion: 1,
    payload: { mediaType: 'movie', list: 'watched' },
    ...overrides,
  };
}

test('outbox: publish kalıcı kuyruğa yazar', async () => {
  const backend = createMemoryOutboxBackend();
  const outbox = createOutboxEventPublisher({ backend });
  await outbox.publish(makeEvent());
  const stats = await outbox.stats();
  assert.equal(stats.pending, 1);
  assert.equal(stats.byType['LibraryItemAdded'], 1);
});

test('outbox: aynı eventId idempotent yazılır (çift olay yok)', async () => {
  const backend = createMemoryOutboxBackend();
  const outbox = createOutboxEventPublisher({ backend });
  await outbox.publish(makeEvent());
  await outbox.publish(makeEvent());
  const stats = await outbox.stats();
  assert.equal(stats.pending, 1);
});

test('outbox: eventId/profileId olmadan publish reddedilir (K1)', async () => {
  const outbox = createOutboxEventPublisher();
  await assert.rejects(() => outbox.publish(makeEvent({ eventId: '' })));
  await assert.rejects(() => outbox.publish(makeEvent({ profileId: '' })));
});

test('outbox: drain FIFO teslim eder, onaylanan kuyruktan düşer', async () => {
  const backend = createMemoryOutboxBackend();
  const outbox = createOutboxEventPublisher({ backend });
  await outbox.publish(makeEvent({ eventId: 'e1' }));
  await outbox.publish(makeEvent({ eventId: 'e2' }));

  const seen = [];
  const result = await outbox.drain((event) => {
    seen.push(event.eventId);
    return true;
  });
  assert.deepEqual(seen, ['e1', 'e2']);
  assert.equal(result.delivered, 2);
  assert.equal(result.remaining, 0);
});

test('outbox: onaylanmayan olay kuyrukta kalır (kalıcılık kuralı)', async () => {
  const backend = createMemoryOutboxBackend();
  const outbox = createOutboxEventPublisher({ backend });
  await outbox.publish(makeEvent({ eventId: 'e1' }));

  const result = await outbox.drain(() => false);
  assert.equal(result.delivered, 0);
  assert.equal(result.remaining, 1);

  // İkinci drain tekrar dener:
  const retry = await outbox.drain(() => true);
  assert.equal(retry.delivered, 1);
});

test('outbox: subscribe anında bildirir, unsubscribe çalışır', async () => {
  const outbox = createOutboxEventPublisher();
  const seen = [];
  const sub = outbox.subscribe('LibraryItemAdded', (event) => {
    seen.push(event.eventId);
  });
  await outbox.publish(makeEvent());
  assert.deepEqual(seen, ['evt-1']);
  sub.unsubscribe();
  await outbox.publish(makeEvent({ eventId: 'evt-2' }));
  assert.equal(seen.length, 1);
});

test('outbox: abone hatası yayını bozmaz', async () => {
  const outbox = createOutboxEventPublisher();
  outbox.subscribe('LibraryItemAdded', () => {
    throw new Error('abone hatası');
  });
  await outbox.publish(makeEvent());
  const stats = await outbox.stats();
  assert.equal(stats.pending, 1);
});

test('outbox: backoff eğrisi offline-queue ile aynı', () => {
  assert.equal(outboxBackoffMs(1), 2000);
  assert.equal(outboxBackoffMs(2), 4000);
  assert.equal(OUTBOX_MAX_ATTEMPTS, 5);
});

/* ------------------------------------------------------------------ */
/* ⑤a İlişki servis adaptörü                                           */
/* ------------------------------------------------------------------ */

const ITEM_A = {
  id: 100,
  media_type: 'movie',
  title: 'Film A',
  genre_ids: [28, 878],
  overview: 'uzay zaman',
};
const ITEM_B = {
  id: 200,
  media_type: 'movie',
  title: 'Film B',
  genre_ids: [28, 878],
  overview: 'uzay zaman devam',
};
const ITEM_C = {
  id: 300,
  media_type: 'movie',
  title: 'Alakasız',
  genre_ids: [16],
  overview: 'animasyon komedi',
};

test('relationship-adapter: getRelated ağırlık sırasıyla kenar döner', async () => {
  const service = createRelationshipServiceAdapter({
    getSavedItems: () => [ITEM_A],
    getCandidates: () => [ITEM_B, ITEM_C],
  });
  const edges = await service.getRelated({ profileId: 'p1' }, relationshipNodeKey(ITEM_A));
  assert.ok(edges.length >= 1);
  // Film B (aynı tür + benzer özet) Alakasız'dan önce gelmeli:
  assert.equal(edges[0].toKey, relationshipNodeKey(ITEM_B));
  assert.ok(edges[0].weight > 0);
});

test('relationship-adapter: bilinmeyen düğüm boş döner', async () => {
  const service = createRelationshipServiceAdapter({
    getSavedItems: () => [ITEM_A],
    getCandidates: () => [],
  });
  const edges = await service.getRelated({ profileId: 'p1' }, 'yok');
  assert.deepEqual(edges, []);
});

test('relationship-adapter: profileId olmadan ret (K1)', async () => {
  const service = createRelationshipServiceAdapter({
    getSavedItems: () => [],
    getCandidates: () => [],
  });
  await assert.rejects(() => service.getRelated({ profileId: '' }, 'x'));
});

test('relationship-adapter: recomputeEdges Faz 5 öncesi açık ret döner', async () => {
  const service = createRelationshipServiceAdapter({
    getSavedItems: () => [],
    getCandidates: () => [],
  });
  const outcome = await service.recomputeEdges({ profileId: 'p1' }, ['x']);
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /faz5/u);
});

/* ------------------------------------------------------------------ */
/* ⑤b Öneri servis adaptörü                                            */
/* ------------------------------------------------------------------ */

test('recommendation-adapter: motor bağlıyken sonuç döner ve önbelleklenir', async () => {
  let calls = 0;
  const service = createRecommendationServiceAdapter({
    computeRecommendations: () => {
      calls += 1;
      return [{ mediaKey: 'movie-100', score: 0.9, reason: 'test' }];
    },
  });
  const ref = { profileId: 'p1', revision: 4 };
  const first = await service.getRecommendations(ref, 5);
  const second = await service.getRecommendations(ref, 5);
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(calls, 1, 'aynı profileId+revision için tek hesap');
});

test('recommendation-adapter: revision değişince önbellek geçersizleşir', async () => {
  let calls = 0;
  const service = createRecommendationServiceAdapter({
    computeRecommendations: () => {
      calls += 1;
      return [{ mediaKey: 'movie-100', score: 0.9, reason: 'test' }];
    },
  });
  await service.getRecommendations({ profileId: 'p1', revision: 4 });
  await service.getRecommendations({ profileId: 'p1', revision: 5 });
  assert.equal(calls, 2);
});

test('recommendation-adapter: refresh önbelleği geçersizleştirir', async () => {
  let calls = 0;
  const service = createRecommendationServiceAdapter({
    computeRecommendations: () => {
      calls += 1;
      return [{ mediaKey: 'movie-100', score: 0.9, reason: 'test' }];
    },
  });
  const ref = { profileId: 'p1', revision: 4 };
  await service.getRecommendations(ref);
  const outcome = await service.refresh(ref);
  assert.equal(outcome.ok, true);
  await service.getRecommendations(ref);
  assert.equal(calls, 2);
});

test('recommendation-adapter: motor bağlı değilken boş sonuç (açık davranış)', async () => {
  const service = createRecommendationServiceAdapter();
  const results = await service.getRecommendations({ profileId: 'p1', revision: 1 });
  assert.deepEqual(results, []);
});

test('recommendation-adapter: profileId olmadan ret (K1)', async () => {
  const service = createRecommendationServiceAdapter();
  await assert.rejects(() => service.getRecommendations({ profileId: '' }));
  const outcome = await service.refresh({ profileId: '' });
  assert.equal(outcome.ok, false);
});
