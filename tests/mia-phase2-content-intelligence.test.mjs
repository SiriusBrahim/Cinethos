import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createAppEvent, createAppEventBus } from '../src/app/app-event-bus.ts';
import { createModuleRegistry } from '../src/app/runtime-module-registry.ts';
import { createProfileContext } from '../src/app/ProfileContext.ts';
import { createContentIntelligenceService } from '../src/modules/content/content-intelligence-service.ts';
import { createContentMetadataProcessor } from '../src/modules/content/content-metadata-processor.ts';
import { createContentFeatureExtractor } from '../src/modules/content/content-feature-extractor.ts';
import { createContentSemanticAnalyzer } from '../src/modules/content/content-semantic-analyzer.ts';
import {
  CONTENT_INTELLIGENCE_VERSION,
  CANONICAL_MOOD_IDS,
} from '../src/modules/content/types.ts';
import { createContentIntelligenceRepository } from '../src/server/content-intelligence-repository.ts';
import { TransientMetadataFetchError } from '../src/server/content-metadata-source.ts';
import { createContentProcessingCoordinator } from '../src/server/content-processing-coordinator.ts';
import { createCineTrackApp } from '../src/server/app.ts';

function makeTempDir(prefix = 'cinetrack-mia2-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeRichMovie(overrides = {}) {
  return {
    id: 550,
    media_type: 'movie',
    title: 'Fight Club',
    original_title: 'Fight Club',
    original_language: 'en',
    overview:
      'An insomniac office worker and a devil-may-care soap maker form an underground fight club that spirals into psychological chaos and dark anti-consumerist paranoia.',
    tagline: 'Mischief. Mayhem. Soap.',
    release_date: '1999-10-15',
    runtime: 139,
    vote_average: 8.4,
    vote_count: 29500,
    popularity: 85.4,
    genres: [
      { id: 18, name: 'Drama' },
      { id: 53, name: 'Thriller' },
    ],
    genre_ids: [18, 53],
    keywords: [
      { id: 825, name: 'support group' },
      { id: 4565, name: 'dystopia' },
      { id: 9826, name: 'psychological thriller' },
      { id: 1701, name: 'split personality' },
    ],
    credits: {
      crew: [{ id: 7467, name: 'David Fincher', job: 'Director', profile_path: '/fincher.jpg' }],
      cast: [{ id: 819, name: 'Edward Norton', order: 0, profile_path: '/norton.jpg' }],
    },
    imdb_id: 'tt0137523',
    origin_country: ['US'],
    // Görsel & kişisel sızıntı tuzakları (asla yazılmamalı)
    poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
    poster_url: 'https://image.tmdb.org/t/p/w500/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
    backdrop_path: '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
    profileId: 'user-secret-profile',
    status: 'watched',
    list: 'watched',
    personal_rating: 9.5,
    ratedAt: '2026-04-01T10:00:00.000Z',
    completedAt: '2026-04-01T09:50:00.000Z',
    addedAt: '2026-03-30T08:00:00.000Z',
    season_progress: { season: 1, episode: 1 },
    episodes_watched: 1,
    notes: 'Özel kişisel notum',
    ...overrides,
  };
}

function makeRichSeries(overrides = {}) {
  return {
    id: 1396,
    media_type: 'tv',
    name: 'Breaking Bad',
    original_name: 'Breaking Bad',
    original_language: 'en',
    overview:
      'A high school chemistry teacher diagnosed with inoperable lung cancer turns to manufacturing methamphetamine to secure his family future in a tense crime drama.',
    first_air_date: '2008-01-20',
    last_air_date: '2013-09-29',
    number_of_seasons: 5,
    number_of_episodes: 62,
    episode_run_time: [45],
    vote_average: 8.9,
    vote_count: 14500,
    popularity: 240.2,
    genres: [
      { id: 18, name: 'Drama' },
      { id: 80, name: 'Crime' },
    ],
    keywords: [
      { id: 1930, name: 'anti hero' },
      { id: 10051, name: 'moral ambiguity' },
      { id: 34079, name: 'crime syndicate' },
    ],
    imdb_id: 'tt0903747',
    origin_country: ['US'],
    poster_path: '/ggFHVNu6YYI5L9pCfOacjizRGt.jpg',
    backdrop_path: '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
    personal_rating: 10,
    status: 'watching',
    episodes_watched: 42,
    ...overrides,
  };
}

function makeCoordinatorModuleContext(coordinator, eventBus, profileId = 'profile-a') {
  const registry = createModuleRegistry();
  const profile = createProfileContext({ initialProfileId: profileId, initialRevision: 0 });
  registry.register(coordinator);
  return {
    registry,
    ctx: {
      profile,
      events: eventBus,
      subscribe: eventBus,
      logger: {
        info() {},
        warn() {},
        error() {},
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Senaryo 1, 2, 3, 14: Tekil kayıt, Movie vs TV ayrımı, Görsel & Kişisel sızıntı engeli
// ---------------------------------------------------------------------------
test('Faz 2 [1,2,3,14]: Aynı içerik iki kez eklenince tek SQLite kaydı tutar; Movie vs TV ayırır; poster ve kişisel veri asla saklamaz', async () => {
  const tmpDir = await makeTempDir();
  const coordinator = createContentProcessingCoordinator({ dataDir: tmpDir });
  const eventBus = createAppEventBus();
  const { registry, ctx } = makeCoordinatorModuleContext(coordinator, eventBus);

  try {
    await registry.startAll(ctx);

    const movie = makeRichMovie();
    const out1 = await coordinator.processImmediate(movie);
    const out2 = await coordinator.processImmediate(movie);

    assert.equal(out1.status, 'completed');
    assert.equal(out2.status, 'skipped');

    const seriesOut = await coordinator.processImmediate(makeRichSeries());
    assert.equal(seriesOut.status, 'completed');

    // SQLite tablo şeması ve benzersizlik kontrolü
    const db = new DatabaseSync(path.join(tmpDir, 'cinetrack.db'));
    try {
      const columns = db.prepare('PRAGMA table_info(content_intelligence)').all().map((c) => c.name);
      for (const requiredCol of [
        'media_key',
        'media_type',
        'tmdb_id',
        'imdb_id',
        'source_revision',
        'metadata_json',
        'normalized_metadata_json',
        'feature_vector_json',
        'mood_vector_json',
        'semantic_data_json',
        'data_hash',
        'processed_at',
        'created_at',
        'updated_at',
        'processing_version',
        'processing_status',
        'processing_error',
      ]) {
        assert.ok(columns.includes(requiredCol), `Eksik sütun: ${requiredCol}`);
      }

      const rows = db.prepare('SELECT * FROM content_intelligence').all();
      assert.equal(rows.length, 2);

      const movieRow = rows.find((r) => r.media_key === 'movie:550');
      const tvRow = rows.find((r) => r.media_key === 'tv:1396');
      assert.ok(movieRow);
      assert.ok(tvRow);
      assert.equal(movieRow.media_type, 'movie');
      assert.equal(tvRow.media_type, 'tv');
      assert.equal(movieRow.imdb_id, 'tt0137523');
      assert.equal(tvRow.imdb_id, 'tt0903747');
      assert.equal(movieRow.processing_version, CONTENT_INTELLIGENCE_VERSION);

      // Movie vs TV normalizasyon ayrımı
      const normMovie = JSON.parse(movieRow.normalized_metadata_json);
      const normTv = JSON.parse(tvRow.normalized_metadata_json);
      assert.equal(normMovie.releaseDate, '1999-10-15');
      assert.equal(normMovie.runtimeMinutes, 139);
      assert.equal(normMovie.firstAirDate, undefined);
      assert.equal(normTv.firstAirDate, '2008-01-20');
      assert.equal(normTv.numberOfSeasons, 5);
      assert.equal(normTv.numberOfEpisodes, 62);
      assert.deepEqual(normTv.episodeRunTime, [45]);

      // Senaryo 3 & 14: Görsel alanları ve kişisel alanlar ASLA tabloda olmamalı
      const serializedAll = JSON.stringify(rows);
      for (const forbiddenNeedle of [
        'poster_path',
        'poster_url',
        'backdrop_path',
        'profile_path',
        'pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK',
        'ggFHVNu6YYI5L9pCfOacjizRGt',
        'user-secret-profile',
        'personal_rating',
        'season_progress',
        'episodes_watched',
        'ratedAt',
        'completedAt',
        'addedAt',
        'Özel kişisel notum',
      ]) {
        assert.equal(
          serializedAll.includes(forbiddenNeedle),
          false,
          `Yasaklı alan/değer ortak tabloya sızdı: ${forbiddenNeedle}`
        );
      }

      // 8 ruh hali skoru ve 48 boyutlu vektör doğrulaması
      const moodData = JSON.parse(movieRow.mood_vector_json);
      for (const mId of CANONICAL_MOOD_IDS) {
        assert.equal(typeof moodData.moods[mId], 'number');
        assert.ok(moodData.moods[mId] >= 0 && moodData.moods[mId] <= 1);
      }
      assert.ok(moodData.moods.dark > moodData.moods.cheerful);

      const featData = JSON.parse(movieRow.feature_vector_json);
      assert.equal(featData.denseVector.length, 48);
    } finally {
      db.close();
    }
  } finally {
    await registry.stopAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Senaryo 4 & 5: Değişmeyen hash -> skip, Değişen metadata -> hash güncelle + reprocess
// ---------------------------------------------------------------------------
test('Faz 2 [4,5]: Aynı data_hash ile yeniden işlemeyi atlar; metaveri değişince hash günceller ve yeniden işler', async () => {
  const tmpDir = await makeTempDir();
  const coordinator = createContentProcessingCoordinator({ dataDir: tmpDir });
  const eventBus = createAppEventBus();
  const { registry, ctx } = makeCoordinatorModuleContext(coordinator, eventBus);

  try {
    await registry.startAll(ctx);

    const first = await coordinator.processImmediate(makeRichMovie());
    assert.equal(first.status, 'completed');
    const firstHash = first.record.data_hash;
    const firstProcessedAt = first.record.processed_at;

    // Aynı içerik (kişisel puan veya poster değişse bile hash değişmemeli!)
    const personalChangedOnly = makeRichMovie({
      personal_rating: 3,
      status: 'watching',
      poster_path: '/different_poster.jpg',
    });
    const skipped = await coordinator.processImmediate(personalChangedOnly);
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.record.data_hash, firstHash);
    assert.equal(skipped.record.processed_at, firstProcessedAt);

    // Gerçek içerik metaverisi değişince hash değişir ve yeniden işlenir
    const metadataUpdated = makeRichMovie({
      overview:
        'A completely rewritten psychological mind-bending thriller about memory loss, unreliable narration, and fractured time.',
      keywords: [
        { id: 101, name: 'mind-bending' },
        { id: 102, name: 'time loop' },
        { id: 103, name: 'psychological thriller' },
      ],
    });
    const reprocessed = await coordinator.processImmediate(metadataUpdated);
    assert.equal(reprocessed.status, 'completed');
    assert.notEqual(reprocessed.record.data_hash, firstHash);
  } finally {
    await registry.stopAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Senaryo 6, 7, 8, 13: not-interested/hidden, LibraryItemRemoved koruma, eventId dedupe, çoklu kullanıcı
// ---------------------------------------------------------------------------
test('Faz 2 [6,7,8,13]: not-interested işlenir, LibraryItemRemoved silmez, eventId tekilleştirilir ve çoklu kullanıcı tek kayıt paylaşır', async () => {
  const tmpDir = await makeTempDir();
  const coordinator = createContentProcessingCoordinator({ dataDir: tmpDir });
  const eventBus = createAppEventBus();
  const { registry, ctx } = makeCoordinatorModuleContext(coordinator, eventBus);

  try {
    await registry.startAll(ctx);

    // 1. Kullanıcı A (profile-a) içeriği "not-interested" olarak işaretliyor -> YİNE DE İŞLENİR (Senaryo 6)
    const evNotInterested = createAppEvent({
      eventId: 'evt-not-int-1',
      eventType: 'LibraryItemAdded',
      ref: { profileId: 'profile-a', revision: 1 },
      entityId: 'movie:27205',
      payload: { mediaKey: 'movie:27205', mediaType: 'movie', list: 'not-interested' },
    });
    coordinator.eventSubscriber.registerMetadataHint(
      evNotInterested.eventId,
      makeRichMovie({
        id: 27205,
        title: 'Inception',
        release_date: '2010-07-16',
        imdb_id: 'tt1375666',
        overview: 'A thief steals corporate secrets through dream-sharing technology.',
        genres: [
          { id: 28, name: 'Action' },
          { id: 878, name: 'Science Fiction' },
        ],
        list: 'not-interested',
        status: 'not-interested',
      })
    );
    await eventBus.publish(evNotInterested);

    // Aynı eventId ikinci kez gönderilirse deduplicate edilir (Senaryo 8)
    const dupRes = await coordinator.eventSubscriber.handleEvent(evNotInterested);
    assert.equal(dupRes.deduplicated, true);
    assert.equal(coordinator.repository.hasProcessedEvent(evNotInterested.eventId), true);

    await coordinator.drain();
    const afterAdd = coordinator.getByMediaKey('movie:27205');
    assert.ok(afterAdd);
    assert.equal(afterAdd.processing_status, 'completed');
    assert.equal(afterAdd.metadata_json.includes('not-interested'), false);

    // Gizlenen içerik de doğrudan işlenir (Senaryo 6)
    coordinator.enqueueHiddenOrDislikedItem('tv:1399', makeRichSeries({ id: 1399, name: 'Narcos' }));
    await coordinator.drain();
    assert.equal(coordinator.getByMediaKey('tv:1399')?.processing_status, 'completed');

    // 2. Kullanıcı B (profile-b) aynı içeriği ekliyor (Senaryo 13) -> Tek ortak kayıt kalır
    const evUserB = createAppEvent({
      eventId: 'evt-user-b-add',
      eventType: 'LibraryItemAdded',
      ref: { profileId: 'profile-b', revision: 1 },
      entityId: 'movie:27205',
      payload: { mediaKey: 'movie:27205', mediaType: 'movie', list: 'watched' },
    });
    await eventBus.publish(evUserB);
    await coordinator.drain();

    // 3. Kullanıcı A içerikten çıkarır (LibraryItemRemoved) -> Ortak kayıt SİLİNMEZ (Senaryo 7)
    const evRemoveA = createAppEvent({
      eventId: 'evt-user-a-remove',
      eventType: 'LibraryItemRemoved',
      ref: { profileId: 'profile-a', revision: 2 },
      entityId: 'movie:27205',
      payload: { mediaKey: 'movie:27205', mediaType: 'movie' },
    });
    const removeOutcome = await coordinator.eventSubscriber.handleEvent(evRemoveA);
    assert.equal(removeOutcome.action, 'preserved-on-remove');

    const preserved = coordinator.getByMediaKey('movie:27205');
    assert.ok(preserved);
    assert.equal(preserved.processing_status, 'completed');
    assert.equal(coordinator.listRecords().total, 2); // yalnızca movie:27205 ve tv:1399 (tekil)
  } finally {
    await registry.stopAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Senaryo 9: Aynı media_key için eşzamanlı çağrılarda tek uçuş / çakışmasız çalışma
// ---------------------------------------------------------------------------
test('Faz 2 [9]: Aynı media_key için eşzamanlı işleme çağrıları tek yürütmede birleştirilir', async () => {
  const tmpDir = await makeTempDir();
  let fetchCount = 0;
  const coordinator = createContentProcessingCoordinator({
    dataDir: tmpDir,
    customFetcher: async ({ existingPayload }) => {
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 30));
      return {
        ...(existingPayload ?? {}),
        keywords: [{ id: 1, name: 'neo-noir' }],
      };
    },
  });
  const eventBus = createAppEventBus();
  const { registry, ctx } = makeCoordinatorModuleContext(coordinator, eventBus);

  try {
    await registry.startAll(ctx);

    const payload = makeRichMovie({
      id: 680,
      title: 'Pulp Fiction',
      overview: 'A neo-noir interwoven crime story in Los Angeles.',
      keywords: undefined,
    });

    const results = await Promise.all([
      coordinator.processImmediate(payload),
      coordinator.processImmediate(payload),
      coordinator.processImmediate(payload),
    ]);

    assert.equal(fetchCount, 1);
    assert.equal(results.filter((r) => r.status === 'completed').length, 3);
    assert.equal(coordinator.listRecords().total, 1);
  } finally {
    await registry.stopAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Senaryo 10: Geçici API hatasında retry + backoff ve toparlanma
// ---------------------------------------------------------------------------
test('Faz 2 [10]: Geçici ağ/API hatalarında kontrollü retry/backoff uygular ve iyileşince tamamlar', async () => {
  const tmpDir = await makeTempDir();
  let attempt = 0;
  const coordinator = createContentProcessingCoordinator({
    dataDir: tmpDir,
    baseRetryDelayMs: 25,
    maxAttempts: 3,
    customFetcher: async ({ existingPayload }) => {
      attempt += 1;
      if (attempt < 2) {
        throw new TransientMetadataFetchError('TMDB 429 rate limit', 429);
      }
      return {
        ...(existingPayload ?? {}),
        overview: 'Recovered rich overview after rate limit backoff.',
        keywords: [{ id: 12, name: 'recovered' }],
      };
    },
  });
  const eventBus = createAppEventBus();
  const { registry, ctx } = makeCoordinatorModuleContext(coordinator, eventBus);

  try {
    await registry.startAll(ctx);

    coordinator.enqueueRawItem({
      id: 603,
      media_type: 'movie',
      title: 'The Matrix',
      genres: [{ id: 878, name: 'Science Fiction' }],
    });

    await coordinator.drain({ waitForRetries: true, timeoutMs: 5000 });

    assert.ok(attempt >= 2);
    const rec = coordinator.getByMediaKey('movie:603');
    assert.ok(rec);
    assert.equal(rec.processing_status, 'completed');
    assert.equal(coordinator.repository.getQueueStats().completed, 1);
  } finally {
    await registry.stopAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Senaryo 11: Bozuk metaveri sistemi çökertmez; failed durum + error mesajı kaydeder
// ---------------------------------------------------------------------------
test('Faz 2 [11]: Bozuk veya eksik metaveri çökme üretmez; processing_status = failed olarak kaydedilir', async () => {
  const tmpDir = await makeTempDir();
  const coordinator = createContentProcessingCoordinator({ dataDir: tmpDir });
  const eventBus = createAppEventBus();
  const { registry, ctx } = makeCoordinatorModuleContext(coordinator, eventBus);

  try {
    await registry.startAll(ctx);

    const corruptOutcome = await coordinator.processImmediate({
      id: 999999,
      media_type: 'movie',
      corrupt: true,
      title: 'Corrupt Payload',
    });

    assert.equal(corruptOutcome.status, 'failed');
    assert.ok(corruptOutcome.error);

    const rec = coordinator.getByMediaKey('movie:999999');
    assert.ok(rec);
    assert.equal(rec.processing_status, 'failed');
    assert.ok(rec.processing_error && rec.processing_error.length > 0);

    // Sistem diğer sağlam içerikleri işlemeye devam edebilmeli
    const healthyOutcome = await coordinator.processImmediate(makeRichMovie());
    assert.equal(healthyOutcome.status, 'completed');
  } finally {
    await registry.stopAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Senaryo 12: Yeniden başlatma (restart) sonrası yarım kalmış / bekleyen kuyruğu sürdürme
// ---------------------------------------------------------------------------
test('Faz 2 [12]: Sunucu yeniden başlatıldığında yarım kalan processing ve pending kuyruk işleri sürdürülür', async () => {
  const tmpDir = await makeTempDir();

  // 1. Oturum: işi pending/processing olarak SQLite'a bırak ve kapat
  const coord1 = createContentProcessingCoordinator({ dataDir: tmpDir });
  await coord1.initialize();
  coord1.enqueueRawItem(makeRichMovie({ id: 155, title: 'The Dark Knight' }));
  coord1.enqueueRawItem(makeRichSeries({ id: 1398, name: 'The Sopranos' }));

  // İlk işi yarıda kesilmiş 'processing' durumuna al (çökme simülasyonu)
  const db = new DatabaseSync(path.join(tmpDir, 'cinetrack.db'));
  try {
    db.prepare(`UPDATE content_processing_queue SET status = 'processing' WHERE media_key = 'movie:155'`).run();
  } finally {
    db.close();
  }
  await coord1.stop();

  // 2. Oturum (yeniden başlatma): ModuleRegistry ile başlatıldığında otomatik kurtarıp tamamlamalı
  const coord2 = createContentProcessingCoordinator({ dataDir: tmpDir });
  const eventBus2 = createAppEventBus();
  const { registry, ctx } = makeCoordinatorModuleContext(coord2, eventBus2);

  try {
    await registry.startAll(ctx);
    await coord2.drain({ waitForRetries: true, timeoutMs: 5000 });

    const knight = coord2.getByMediaKey('movie:155');
    const sopranos = coord2.getByMediaKey('tv:1398');
    assert.equal(knight?.processing_status, 'completed');
    assert.equal(sopranos?.processing_status, 'completed');
    assert.equal(coord2.repository.getQueueStats().pending, 0);
    assert.equal(coord2.repository.getQueueStats().processing, 0);
  } finally {
    await registry.stopAll();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Eksik alanlarda şeffaf confidence düşüşü ve saf analiz bileşenleri
// ---------------------------------------------------------------------------
test('Faz 2 Saf Analiz: Eksik alanlarda uydurma veri üretmez ve boyut confidence skorunu şeffaf düşürür', async () => {
  const processor = createContentMetadataProcessor();
  const extractor = createContentFeatureExtractor();
  const analyzer = createContentSemanticAnalyzer();
  const intel = createContentIntelligenceService();

  const sparseValidation = processor.validateAndNormalize({
    id: 4242,
    media_type: 'movie',
    title: 'Minimal Film',
    genres: [{ id: 18, name: 'Drama' }],
    poster_path: '/should_strip.jpg',
    personal_rating: 8,
  });

  assert.equal(sparseValidation.valid, true);
  assert.ok(sparseValidation.missingFields.includes('overview'));
  assert.ok(sparseValidation.missingFields.includes('keywords'));
  assert.ok(sparseValidation.strippedVisualFields.includes('poster_path'));
  assert.ok(sparseValidation.strippedPersonalFields.includes('personal_rating'));

  const bundle = extractor.extract(sparseValidation.normalized);
  assert.equal(bundle.confidence.themes, 0.15);
  assert.equal(bundle.confidence.era, 0);
  assert.ok(bundle.confidence.overallConfidence < 0.5);

  const moodVec = analyzer.analyzeMood(sparseValidation.normalized, bundle);
  assert.ok(moodVec.overallConfidence < 0.6);

  // Yüksek kaliteli iki içeriğin karşılaştırması
  const darkFilm = makeRichMovie();
  const similarFilm = makeRichMovie({
    id: 807,
    title: 'Se7en',
    release_date: '1995-09-22',
    imdb_id: 'tt0114369',
    overview: 'Two detectives hunt a serial killer in a bleak, rainy, psychological crime thriller.',
    keywords: [
      { id: 9826, name: 'psychological thriller' },
      { id: 1930, name: 'serial killer' },
    ],
  });
  const cmp = await intel.compareContents(
    {
      mediaKey: 'movie:550',
      mediaType: 'movie',
      tmdbId: 550,
      title: darkFilm.title,
      overview: darkFilm.overview,
      genreIds: [18, 53],
      keywords: darkFilm.keywords.map((k) => k.name),
      releaseDate: darkFilm.release_date,
      runtime: 139,
      voteAverage: 8.4,
      popularity: 85,
    },
    {
      mediaKey: 'movie:807',
      mediaType: 'movie',
      tmdbId: 807,
      title: similarFilm.title,
      overview: similarFilm.overview,
      genreIds: [18, 53, 80],
      keywords: similarFilm.keywords.map((k) => k.name),
      releaseDate: similarFilm.release_date,
      runtime: 127,
      voteAverage: 8.3,
      popularity: 79,
    }
  );
  assert.ok(cmp.cosineSimilarity > 0.4);
  assert.ok(cmp.atmosphereSimilarity > 0.3);
});

// ---------------------------------------------------------------------------
// HTTP Entegrasyon Testi: createCineTrackApp + /api/content-intelligence/* + /api/data + /api/taste/*
// ---------------------------------------------------------------------------
test('Faz 2 HTTP Entegrasyonu: PUT /api/data, /api/taste/* ve /api/content-intelligence/* uçları uçtan uca çalışır', async () => {
  const tmpDir = await makeTempDir('cinetrack-http-mia2-');
  const runtime = createCineTrackApp({ dataDir: tmpDir });
  await runtime.startRuntimeModules();

  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. İki farklı kullanıcı (/api/data ve /api/taste/domain-event) aynı içeriği ekliyor
    const movieA = makeRichMovie();
    const doc = {
      version: 3,
      schemaVersion: 3,
      engineVersion: 'test',
      activeProfileId: 'profile-a',
      profiles: [
        {
          id: 'profile-a',
          name: 'Kullanıcı A',
          createdAt: '2026-01-01T00:00:00.000Z',
          items: [movieA],
          favoriteActors: [],
          deletedKeys: ['tv:1396'],
          disliked: ['tv:1396'],
        },
        {
          id: 'profile-b',
          name: 'Kullanıcı B',
          createdAt: '2026-01-01T00:00:00.000Z',
          items: [makeRichMovie({ personal_rating: 4, status: 'watching' }), makeRichSeries()],
          favoriteActors: [],
          deletedKeys: [],
          disliked: [],
        },
      ],
    };

    const putRes = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"rev-0"',
        'X-CineTrack-Profile-Id': 'profile-a',
      },
      body: JSON.stringify(doc),
    });
    assert.equal(putRes.status, 200);

    // Gizlenmiş öğeyi raw taste event ile de gönder (not-interested/hide akışı)
    const hideEvRes = await fetch(`${baseUrl}/api/taste/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: {
          eventId: 'http-hide-1',
          eventType: 'hide',
          contentId: 'tv:1399',
          mediaType: 'tv',
          recordedAt: '2026-04-02T00:00:00.000Z',
          experiencedAt: '2026-04-02T00:00:00.000Z',
          timeSource: 'actual',
          timePrecision: 'exact',
          signal: { polarity: 'negative', reason: 'hidden' },
        },
        rawMetadata: makeRichSeries({ id: 1399, name: 'Hidden Series' }),
      }),
    });
    assert.equal(hideEvRes.status, 200);

    // Kuyruğu boşalt ve sonuçları HTTP API üzerinden sorgula
    const drainRes = await fetch(`${baseUrl}/api/content-intelligence/drain`, { method: 'POST' });
    assert.equal(drainRes.status, 200);
    const drainJson = await drainRes.json();
    assert.equal(drainJson.ok, true);
    assert.ok(
      drainJson.counts.completed >= 2,
      `Beklenen completed >= 2, alınan: ${JSON.stringify(drainJson)}`
    );

    const statusRes = await fetch(`${baseUrl}/api/content-intelligence/status`);
    assert.equal(statusRes.status, 200);
    const statusJson = await statusRes.json();
    assert.equal(statusJson.started, true);
    assert.equal(statusJson.repository.available, true);

    const itemRes = await fetch(`${baseUrl}/api/content-intelligence/items/movie:550`);
    assert.equal(itemRes.status, 200);
    const itemJson = await itemRes.json();
    assert.equal(itemJson.item.media_key, 'movie:550');
    assert.equal(itemJson.item.processing_status, 'completed');
    const serializedItem = JSON.stringify(itemJson.item);
    assert.equal(serializedItem.includes('poster_path'), false);
    assert.equal(serializedItem.includes('personal_rating'), false);

    // Anonim toplu istatistik uç noktası profil bilgisi taşımaz
    const statsRes = await fetch(`${baseUrl}/api/content-intelligence/stats`);
    assert.equal(statsRes.status, 200);
    const statsJson = await statsRes.json();
    assert.ok(statsJson.stats.completedRecords >= 2);
    assert.equal(JSON.stringify(statsJson).includes('profile-a'), false);
    assert.equal(JSON.stringify(statsJson).includes('profile-b'), false);

    // Related ve compare uç noktaları
    const relatedRes = await fetch(`${baseUrl}/api/content-intelligence/items/movie:550/related`);
    assert.equal(relatedRes.status, 200);
    const relatedJson = await relatedRes.json();
    assert.ok(Array.isArray(relatedJson.related));

    const compareRes = await fetch(
      `${baseUrl}/api/content-intelligence/compare?source=movie:550&target=tv:1396`
    );
    assert.equal(compareRes.status, 200);
    const compareJson = await compareRes.json();
    assert.equal(compareJson.comparison.sourceKey, 'movie:550');
    assert.equal(compareJson.comparison.targetKey, 'tv:1396');
  } finally {
    await runtime.stopRuntimeModules();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// Doğrudan repository dedupe / sanitize kontrolü
test('Faz 2 Repository: Doğrudan yazmada bile görsel ve kişisel alanları sızdırmaz', async () => {
  const tmpDir = await makeTempDir('cinetrack-repo-guard-');
  const repo = createContentIntelligenceRepository({ dataDir: tmpDir });
  try {
    repo.ensureInitialized();
    const record = repo.upsertFailedResult({
      mediaKey: 'movie:777',
      mediaType: 'movie',
      tmdbId: 777,
      sanitizedMetadata: {
        id: 777,
        title: 'Guarded Movie',
        poster_path: '/leak.jpg',
        personal_rating: 9,
        profileId: 'leak-user',
      },
      error: 'Test failure guard',
    });
    assert.equal(record.metadata_json.includes('poster_path'), false);
    assert.equal(record.metadata_json.includes('personal_rating'), false);
    assert.equal(record.metadata_json.includes('leak-user'), false);
  } finally {
    repo.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
