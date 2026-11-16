import test from 'node:test';
import assert from 'node:assert/strict';

import { createKernel } from '../src/core/kernel/index.ts';
import {
  CONTENT_INTELLIGENCE_SERVICE,
  canonicalContentKey,
  createContentIntelligenceModule,
  decideDedupe,
  deriveFeatures,
  normalizeMediaType,
  parseContentKey,
  validateSourceMetadata,
} from '../src/core/content-intelligence/index.ts';

/**
 * MIA Faz 1 — Content Intelligence Manager: kimlik, tekilleştirme, özellik
 * çıkarımı, işlem durumu ve profil bağımsızlığı.
 */

const source = (overrides = {}) => ({
  mediaType: 'movie',
  tmdbId: 603,
  title: 'The Matrix',
  originalTitle: 'The Matrix',
  overview: 'Yapay zekâ gerçekliği',
  genreIds: [28, 878],
  genres: ['Aksiyon', 'Bilim Kurgu'],
  releaseYear: 1999,
  runtimeMinutes: 136,
  voteAverage: 8.2,
  voteCount: 24000,
  popularity: 120,
  originCountry: ['US'],
  keywords: ['Simülasyon', 'simülasyon', 'distopya'],
  cast: [{ id: 6384, name: 'Keanu Reeves' }],
  directors: [{ id: 9340, name: 'Lana Wachowski' }],
  provider: 'tmdb',
  fetchedAt: '2026-11-16T09:00:00.000Z',
  ...overrides,
});

test('Faz 1: içerik kimliği kanonik anahtar üretir ve geri çözülür', () => {
  assert.equal(canonicalContentKey('movie', 603), 'movie:603');
  assert.equal(canonicalContentKey('tv', 1396), 'tv:1396');
  assert.deepEqual(parseContentKey('tv:1396'), { mediaType: 'tv', tmdbId: 1396, key: 'tv:1396' });
  assert.equal(parseContentKey('movie:0'), null);
  assert.equal(parseContentKey('film:603'), null);
  assert.equal(normalizeMediaType('Dizi'), 'tv');
  assert.equal(normalizeMediaType('film'), 'movie');
  assert.equal(normalizeMediaType('podcast'), null);
});

test('Faz 1: tekilleştirme daha eski kaynağı yeniden yazmaz', () => {
  const record = {
    identity: { mediaType: 'movie', tmdbId: 603, key: 'movie:603' },
    source: source(),
    processing: { state: 'features_ready', attempts: 1, updatedAt: '2026-11-16T09:00:01.000Z' },
  };

  assert.deepEqual(decideDedupe(null, source()), { action: 'inserted', reason: 'yeni içerik' });
  assert.equal(decideDedupe(record, source()).action, 'skipped');
  assert.equal(
    decideDedupe(record, source({ fetchedAt: '2026-11-16T10:00:00.000Z' })).action,
    'updated'
  );
});

test('Faz 1: geçersiz kaynak doğrulamada reddedilir', () => {
  assert.equal(validateSourceMetadata(source()), null);
  assert.match(validateSourceMetadata(source({ title: '  ' })), /başlık/);
  assert.match(validateSourceMetadata(source({ tmdbId: -3 })), /TMDB/);
  assert.match(validateSourceMetadata(source({ mediaType: 'podcast' })), /medya türü/);
  assert.match(validateSourceMetadata(source({ fetchedAt: 'dün' })), /kaynak zamanı/);
});

test('Faz 1: özellik çıkarımı deterministik ve kaynak/türetim ayrımı korunuyor', () => {
  const clock = () => new Date('2026-11-16T12:00:00.000Z');
  const features = deriveFeatures(source(), { now: clock });

  assert.equal(features.key, 'movie:603');
  assert.equal(features.featureVersion, 1);
  assert.deepEqual(features.genreSet, ['Aksiyon', 'Bilim Kurgu']);
  assert.equal(features.primaryGenre, 'Aksiyon');
  assert.equal(features.decade, 1990);
  assert.equal(features.runtimeBucket, 'standard');
  assert.equal(features.popularityTier, 'high');
  assert.equal(features.qualityTier, 'high');
  assert.deepEqual(features.keywordTokens, ['distopya', 'simülasyon']);
  assert.deepEqual(features.castIds, [6384]);
  assert.deepEqual(features.directorIds, [9340]);
  assert.equal(features.computedAt, '2026-11-16T12:00:00.000Z');
  // Sağlayıcı alanı türetilmiş özelliğe sızmaz.
  assert.equal(features.title, undefined);
  assert.equal(features.voteAverage, undefined);
});

test('Faz 1: modül kayıt defterinde çalışır, içerik işlenir ve öneri motoru özellik okur', async () => {
  const kernel = createKernel();
  kernel.register(createContentIntelligenceModule());
  const contentEvents = [];
  kernel.events.subscribe('content.added', (event) => contentEvents.push(event));

  const report = await kernel.bootstrap();
  assert.deepEqual(report.started, [CONTENT_INTELLIGENCE_SERVICE]);

  const content = kernel.registry.getService(CONTENT_INTELLIGENCE_SERVICE);
  const first = await content.ingest(source());
  assert.equal(first.ok, true);
  assert.equal(first.value.action, 'inserted');
  assert.equal(first.value.record.processing.state, 'features_ready');
  assert.equal(first.value.record.derived.decade, 1990);

  const second = await content.ingest(source());
  assert.equal(second.ok, true);
  assert.equal(second.value.action, 'skipped');

  const refreshed = await content.ingest(source({ fetchedAt: '2026-11-16T11:00:00.000Z' }));
  assert.equal(refreshed.value.action, 'updated');

  const features = await content.getFeatures('movie:603');
  assert.equal(features.ok, true);
  assert.equal(features.value.genreSet.length, 2);

  const batch = await content.getFeaturesBatch(['movie:603', 'movie:999', 'bozuk-anahtar']);
  assert.equal(batch.ok, true);
  assert.equal(batch.value.length, 1);

  const stats = await content.stats();
  assert.deepEqual(stats.value, { total: 1, ready: 1, failed: 0, pending: 0, featureVersion: 1 });

  assert.equal(contentEvents.length, 1);
  assert.equal(contentEvents[0].profileId, 'system');

  const health = await kernel.healthCheck();
  assert.equal(health.ok, true);
  assert.equal(health.modules[0].metrics.total, 1);
});

test('Faz 1: içerik kaydı profil verisi taşımaz (profil bağımsızlığı)', async () => {
  const kernel = createKernel({ profileId: 'profile-a' });
  kernel.register(createContentIntelligenceModule());
  await kernel.bootstrap();
  const content = kernel.registry.getService(CONTENT_INTELLIGENCE_SERVICE);

  await content.ingest(source());
  kernel.profile.switchProfile('profile-b', 0);
  await content.ingest(source({ tmdbId: 604, title: 'The Matrix Reloaded', fetchedAt: '2026-11-16T09:30:00.000Z' }));

  const record = await content.getRecord('movie:603');
  assert.equal(record.ok, true);
  assert.equal(JSON.stringify(record.value).includes('profileId'), false);
  assert.equal(JSON.stringify(record.value).includes('profile-'), false);

  const stats = await content.stats();
  assert.equal(stats.value.total, 2, 'profil değişse de içerik tek kopya');
});

test('Faz 1: işlem hatası kayda yazılır, sağlık bozulur ve içerik okunmaz', async () => {
  const kernel = createKernel();
  kernel.register(
    createContentIntelligenceModule({
      extractFeatures: () => {
        throw new Error('özellik çıkarımı çöktü');
      },
    })
  );
  await kernel.bootstrap();
  const content = kernel.registry.getService(CONTENT_INTELLIGENCE_SERVICE);

  const result = await content.ingest(source());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'processing_failed');

  const status = await content.getStatus('movie:603');
  assert.equal(status.value.state, 'failed');
  assert.match(status.value.lastError, /çöktü/);

  const features = await content.getFeatures('movie:603');
  assert.equal(features.value, null);

  const health = await kernel.healthCheck();
  assert.equal(health.ok, false);
  assert.match(health.modules[0].detail, /içerik işlenemedi/);

  const reprocess = await content.reprocess('movie:603');
  assert.equal(reprocess.ok, false);
  assert.equal(reprocess.error.code, 'processing_failed');
});

test('Faz 1: content.removed katalog kaydını düşürür', async () => {
  const kernel = createKernel();
  kernel.register(createContentIntelligenceModule());
  await kernel.bootstrap();
  const content = kernel.registry.getService(CONTENT_INTELLIGENCE_SERVICE);
  await content.ingest(source());

  kernel.events.publish('content.removed', { contentKey: 'movie:603' }, { profileId: 'system' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const record = await content.getRecord('movie:603');
  assert.equal(record.value, null);
});
