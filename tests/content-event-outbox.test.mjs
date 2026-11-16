/**
 * MIA Faz 2 — Adım 2.3 (Dilim E): Transactional outbox / event kabul atomikliği.
 *
 * Kabul kriterleri (docs/mia/faz1-faz2-uygulama-plani.md 2.3):
 *  - Event kabul kaydı ve kuyruk kaydı tek SQLite transaction'ında oluşur.
 *  - Enqueue başarısızsa event kalıcı olarak "processed" işaretlenmez; tekrar
 *    denenebilir durumda kalır.
 *  - Aynı eventId ikinci kez geldiğinde ikinci iş üretilmez.
 *  - Aynı media_key için farklı eventId geldiğinde güncel payload kaybolmaz.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createContentEventSubscriber } from '../src/server/content-event-subscriber.ts';
import { createContentIntelligenceRepository } from '../src/server/content-intelligence-repository.ts';
import { createContentProcessingQueue } from '../src/server/content-processing-queue.ts';

function makeTempDir(prefix = 'cinethos-outbox-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeEvent(overrides = {}) {
  return {
    eventId: 'evt-outbox-1',
    eventType: 'LibraryItemAdded',
    profileId: 'profile-a',
    occurredAt: new Date().toISOString(),
    schemaVersion: 1,
    entityId: 'movie:550',
    payload: { mediaKey: 'movie:550', mediaType: 'movie' },
    ...overrides,
  };
}

test('Outbox: event kabulü ve kuyruk kaydı tek transactionda oluşur, event processed işaretlenir', async () => {
  const tmpDir = await makeTempDir();
  try {
    const repository = createContentIntelligenceRepository({ dataDir: tmpDir });
    const queue = createContentProcessingQueue({ repository });
    const subscriber = createContentEventSubscriber({ repository, queue });

    const result = await subscriber.handleEvent(makeEvent());

    assert.equal(result.handled, true);
    assert.equal(result.action, 'enqueued');
    assert.equal(repository.hasProcessedEvent('evt-outbox-1'), true);
    assert.equal(repository.getQueueStats().pending, 1);

    // Aynı eventId ikinci kez geldiğinde ikinci iş üretilmez (idempotency).
    const dup = await subscriber.handleEvent(makeEvent());
    assert.equal(dup.deduplicated, true);
    assert.equal(repository.getQueueStats().pending, 1);

    repository.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Outbox: enqueue başarısız olursa event processed işaretlenmez ve tekrar denenebilir', async () => {
  const tmpDir = await makeTempDir();
  try {
    const repository = createContentIntelligenceRepository({ dataDir: tmpDir });
    const queue = createContentProcessingQueue({ repository });

    // Repository'nin kuyruk yazımını bozan bir sarmalayıcı: transactional kabul
    // sırasında enqueueJob adımı hata fırlatır (disk dolu / kilit senaryosu).
    const failingRepository = new Proxy(repository, {
      get(target, prop) {
        if (prop === 'enqueueJob') {
          return () => {
            throw new Error('SQLITE_BUSY: kilitli');
          };
        }
        return Reflect.get(target, prop, target);
      },
    });

    const subscriber = createContentEventSubscriber({
      repository: failingRepository,
      queue,
    });

    await assert.rejects(
      () => subscriber.handleEvent(makeEvent()),
      /SQLITE_BUSY/
    );

    // Olay kalıcı olarak processed işaretlenmedi → tekrar denenebilir.
    assert.equal(repository.hasProcessedEvent('evt-outbox-1'), false);
    assert.equal(repository.getQueueStats().pending, 0);

    // Aynı olay sağlıklı repository ile tekrar işlenebilir.
    const healthySubscriber = createContentEventSubscriber({ repository, queue });
    const retry = await healthySubscriber.handleEvent(makeEvent());
    assert.equal(retry.action, 'enqueued');
    assert.equal(repository.hasProcessedEvent('evt-outbox-1'), true);

    repository.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('Outbox: aynı media_key için farklı eventId geldiğinde güncel payload kaybolmaz', async () => {
  const tmpDir = await makeTempDir();
  try {
    const repository = createContentIntelligenceRepository({ dataDir: tmpDir });
    const queue = createContentProcessingQueue({ repository });
    const subscriber = createContentEventSubscriber({ repository, queue });

    await subscriber.handleEvent(
      makeEvent({
        eventId: 'evt-first',
        payload: { mediaKey: 'movie:550', mediaType: 'movie' },
      })
    );

    const second = await subscriber.handleEvent(
      makeEvent({
        eventId: 'evt-second',
        eventType: 'CatalogItemEnriched',
        payload: { mediaKey: 'movie:550', mediaType: 'movie' },
      }),
      {
        id: 550,
        media_type: 'movie',
        title: 'Fight Club — Güncellenmiş Özet',
        overview: 'Güncellenmiş açıklama metni.',
      }
    );

    assert.equal(second.action, 'enqueued');
    // Kuyruk satırı tek kalır (aynı media_key için birleştirilir).
    const stats = repository.getQueueStats();
    assert.equal(stats.pending + stats.processing, 1);

    const record = repository.getByMediaKey('movie:550');
    assert.ok(record);
    // Stub metadata güncel payload ile zenginleştirilmiş olmalı.
    const stubJson = record.metadata_json || '';
    assert.ok(
      stubJson.includes('Güncellenmiş') || stubJson.includes('Güncellenmiş Özet'),
      'stub metadata güncel payloadı yansıtmalı'
    );

    repository.close();
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
