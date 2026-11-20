import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createContentProcessingCoordinator } from '../src/server/content-processing-coordinator.ts';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-ci-'));
}

const FETCHABLE = {
  id: 4242,
  media_type: 'movie',
  title: 'Yeniden İşleme Filmi',
  overview: 'Kayıp bir denizcinin dönüşünü anlatan karanlık bir hikâye.',
  genre_ids: [18, 53],
  keywords: [{ id: 259094, name: 'dark' }],
  vote_average: 7.8,
  vote_count: 1200,
  popularity: 44,
  release_date: '2021-05-01',
};

function makeCoordinator() {
  return createContentProcessingCoordinator({
    dataDir: tempDir(),
    customFetcher: async ({ tmdbId }) => ({ ...FETCHABLE, id: tmdbId }),
  });
}

test('yarım kalmış kayıt "stale" sayılır ve kuyruğa tek kez geri verilir', async () => {
  const coordinator = makeCoordinator();
  await coordinator.initialize();

  coordinator.repository.upsertPendingStub({
    mediaKey: 'movie:9001',
    mediaType: 'movie',
    tmdbId: 9001,
  });

  assert.equal(coordinator.countStaleRecords(), 1);
  assert.deepEqual(coordinator.listStaleRecords(10)[0].mediaKey, 'movie:9001');

  const first = await coordinator.reprocessStale({ limit: 10 });
  assert.equal(first.total, 1);
  assert.equal(first.accepted, 1);
  assert.equal(coordinator.repository.getQueueStats().pending, 1);

  await coordinator.reprocessStale({ limit: 10 });
  assert.equal(
    coordinator.repository.getQueueStats().pending,
    1,
    'aynı içerik için ikinci iş üretilmemeli (kuyruk koalesansı)'
  );

  await coordinator.stop();
});

test('başarıyla işlenen içerik stale sayılmaz; sürüm değişince yeniden işlemeye düşer', async () => {
  const coordinator = makeCoordinator();
  await coordinator.initialize();

  const outcome = await coordinator.processImmediate(FETCHABLE);
  assert.equal(outcome.status, 'completed');
  assert.equal(coordinator.countStaleRecords(), 0, 'güncel ve tamamlanmış kayıt yeniden işlenmemeli');

  assert.equal(
    coordinator.repository.countStaleRecords('v-eski-surum'),
    1,
    'processing_version uyuşmayan kayıt yeniden işleme adayı olmalı'
  );

  // Güncel sürümlü tamamlanmış kayıt kendiliğinden kuyruğa dönmez; eksik
  // bırakılmış bir kayıt eklendiğinde yalnızca o iş kuyruğa girer.
  coordinator.repository.upsertPendingStub({ mediaKey: 'tv:777', mediaType: 'tv', tmdbId: 777 });
  const requeued = await coordinator.reprocessStale({ limit: 10 });
  assert.equal(requeued.total, 1);
  assert.equal(coordinator.repository.getQueueStats().pending, 1);

  await coordinator.stop();
});

test('başarısız iş kaydı kuyruğa geri alınır ve tekrar denenebilir', async () => {
  const coordinator = createContentProcessingCoordinator({
    dataDir: tempDir(),
    customFetcher: async () => {
      throw new Error('geçici ağ hatası');
    },
    maxAttempts: 1,
    baseRetryDelayMs: 1,
  });
  await coordinator.initialize();

  const failed = await coordinator.processImmediate({ id: 555, media_type: 'movie' });
  assert.equal(failed.status, 'failed');

  assert.equal(coordinator.countStaleRecords(), 1);
  const requeued = await coordinator.reprocessStale({ limit: 10 });
  assert.equal(requeued.accepted, 1);

  await coordinator.stop();
});
