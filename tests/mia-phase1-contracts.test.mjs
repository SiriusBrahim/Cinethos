import test from 'node:test';
import '../src/services/core-adapters.ts'; // F5-04: çekirdek portlarının adaptörleri
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ProfileConflictError,
  StaleRevisionError,
} from '../src/contracts/index.ts';
import { createModuleRegistry } from '../src/app/runtime-module-registry.ts';
import { createProfileContext } from '../src/app/ProfileContext.ts';
import {
  bridgeAppEventsToShellEvents,
  createAppEvent,
  createAppEventBus,
} from '../src/app/app-event-bus.ts';
import { resetShellEventsForTests, subscribeShellEvent } from '../src/app/shell-events.ts';
import { createContentIntelligenceService } from '../src/modules/content/content-intelligence-service.ts';
import { createDataStorage } from '../src/server/storage.ts';
import { createServerPrimaryDataRepository } from '../src/server/primary-data-repository.ts';
import { createCineTrackApp } from '../src/server/app.ts';
import { createHttpPrimaryDataRepository } from '../src/services/client-primary-repository.ts';
import { subscribeClientTasteSyncToEventBus } from '../src/services/taste-api.ts';
import { useItemActions } from '../src/hooks/useItemActions.ts';
import {
  appendTasteEventIdempotentForProfile,
  readTasteEventsForProfile,
  readTasteManifestForProfile,
  resolveTastePathsForProfile,
} from '../src/server/taste-store.ts';
import {
  createServerTasteServiceAdapter,
  subscribeTasteAdapterToEventBus,
  translateAppEventToTasteEvent,
} from '../src/server/taste-service-adapter.ts';
import { triggerTasteProfileRebuild } from '../src/server/taste-rebuild-coordinator.ts';
import { projectLearningSnapshot } from '../src/core/taste/taste-event-projector.ts';
import {
  enqueueOfflineSyncForProfile,
  enqueueOfflineSyncSnapshotDurable,
  flushOfflineQueueWithRepository,
  loadOfflineSyncSnapshot,
  loadOfflineSyncSnapshotAsync,
  resetOfflineQueueForTests,
} from '../src/services/offline-queue.ts';

function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeDoc(profileId = 'PROFILE-A', revision = 1) {
  return {
    version: 3,
    schemaVersion: 3,
    engineVersion: 'test',
    activeProfileId: profileId,
    profiles: [
      {
        id: profileId,
        name: 'Test Profili',
        createdAt: '2026-01-01T00:00:00.000Z',
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items: [{ id: 550, media_type: 'movie', title: 'Fight Club', list: 'watched', rating: 9 }],
        favoriteActors: [],
      },
    ],
    revision,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function installLocalStorageMock() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  };
  return map;
}

// ---------------------------------------------------------------------------
// Adım 1 & Sınır Kontrolü: src/contracts/* bağımlılık yalıtımı
// ---------------------------------------------------------------------------
test('MIA Adım 1: src/contracts kendi kendine yeterlidir (core/services/server/app importu içermez)', async () => {
  const contractsDir = path.resolve('src/contracts');
  const entries = await fs.readdir(contractsDir);
  const tsFiles = entries.filter((name) => name.endsWith('.ts'));
  assert.ok(tsFiles.length >= 7, 'sözleşme dosyaları mevcut');

  for (const file of tsFiles) {
    const src = await fs.readFile(path.join(contractsDir, file), 'utf8');
    assert.doesNotMatch(
      src,
      /from\s+['"][^'"]*\/(core|services|server|app|modules)\//,
      `${file} iç katmanlardan import yapamaz`
    );
    assert.doesNotMatch(
      src,
      /from\s+['"]node:/,
      `${file} Node çalışma zamanına bağımlı olamaz`
    );
  }
});

// ---------------------------------------------------------------------------
// Adım 2 & 4: Content Intelligence sözleşmesi ve Content Manager sınırı
// ---------------------------------------------------------------------------
test('MIA Adım 2 & 4: ContentIntelligenceService ağa çıkmadan analiz, mood ayrımı ve benzerlik üretir', async () => {
  const ciSource = await fs.readFile(
    path.resolve('src/modules/content/content-intelligence-service.ts'),
    'utf8'
  );
  assert.doesNotMatch(
    ciSource,
    /(?:from|import)\s*['"][^'"]*(?:services\/api|taste-store|api-client)['"]|\bfetchTmdb\s*\(|\bapiFetch\s*\(/,
    'Content Intelligence TMDB ağına veya kullanıcı deposuna doğrudan erişemez'
  );

  const service = createContentIntelligenceService();
  const darkThriller = {
    mediaKey: 'movie:550',
    mediaType: 'movie',
    title: 'Karanlık Gece',
    genres: ['Thriller', 'Drama', 'Mystery'],
    genreIds: [53, 18, 9648],
    overview: 'Psikolojik gerilim, suç ve paranoya dolu karanlık bir soruşturma.',
    releaseDate: '1999-10-15',
    externalRating: 8.4,
    popularity: 85,
    keywords: [
      { id: 1, name: 'psychological thriller' },
      { id: 2, name: 'dark' },
    ],
  };

  const lightComedy = {
    mediaKey: 'movie:1200',
    mediaType: 'movie',
    title: 'Güneşli Tatil',
    genres: ['Comedy', 'Family'],
    genreIds: [35, 10751],
    overview: 'Neşeli ve sıcak bir aile tatilinde komik yanlış anlamalar.',
    releaseDate: '2022-06-10',
    externalRating: 6.7,
    popularity: 42,
    keywords: [{ id: 3, name: 'comedy' }],
  };

  const profile = await service.analyzeContent(darkThriller);
  assert.equal(profile.mediaKey, 'movie:550');
  assert.equal(profile.denseVector.length, 48);
  assert.ok(profile.signature.length > 0);

  const batch = await service.analyzeBatch([darkThriller, lightComedy]);
  assert.equal(batch.length, 2);

  const darkMoodA = await service.evaluateMood(darkThriller, 'dark');
  const darkMoodB = await service.evaluateMood(lightComedy, 'dark');
  assert.ok(
    darkMoodA.affinity > darkMoodB.affinity,
    `Karanlık ruh hâli puanı gerilim filminde daha yüksek olmalı (${darkMoodA.affinity} > ${darkMoodB.affinity})`
  );

  const comparison = await service.compareContents(darkThriller, lightComedy);
  assert.equal(comparison.sourceKey, 'movie:550');
  assert.equal(comparison.targetKey, 'movie:1200');
  assert.ok(comparison.cosineSimilarity >= 0 && comparison.cosineSimilarity <= 1);

  await service.invalidateSignature('movie:550');
  assert.equal(service.isInvalidated('movie:550'), true);
});

// ---------------------------------------------------------------------------
// Adım 3 & 8: AppEventBus, zorunlu mediaKey/sourceRevision ve shell köprüsü
// ---------------------------------------------------------------------------
test('MIA Adım 3 & 8: AppEventBus medya anahtarını zorunlu kılar, kalıcılık hatasını yutmaz ve shell kanalına köprüler', async () => {
  const ref = Object.freeze({ profileId: 'PROFILE-A', revision: 4 });
  const added = createAppEvent({
    eventType: 'LibraryItemAdded',
    ref,
    entityId: 'movie:550',
    payload: {
      mediaKey: 'movie:550',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
    },
  });
  assert.equal(added.payload.mediaKey, 'movie:550');
  assert.equal(added.sourceRevision, 4);

  const bus = createAppEventBus();
  const received = [];
  const sub = bus.subscribe('LibraryItemAdded', (ev) => {
    received.push(ev.payload.mediaKey);
  });

  const shellSaved = [];
  const offShell = subscribeShellEvent('item:saved', (payload) => {
    shellSaved.push(payload.key);
  });
  const unbridge = bridgeAppEventsToShellEvents(bus);

  await bus.publish(added);
  assert.deepEqual(received, ['movie:550']);
  assert.deepEqual(shellSaved, ['movie:550']);

  sub.unsubscribe();
  unbridge.unsubscribe();
  offShell();

  const failingBus = createAppEventBus({
    persistEvent: async () => {
      throw new Error('Disk dolu');
    },
  });
  await assert.rejects(() => failingBus.publish(added), /Disk dolu/);

  await assert.rejects(
    () =>
      bus.publish({
        ...added,
        sourceRevision: -1,
      }),
    /sourceRevision zorunludur/
  );
});

// ---------------------------------------------------------------------------
// Adım 5: ModuleRegistry yaşam döngüsü, ters sırada durdurma ve geri alım
// ---------------------------------------------------------------------------
test('MIA Adım 5: ModuleRegistry tek seferlik initialize, başlatma geri alımı ve sağlık raporu sağlar', async () => {
  const registry = createModuleRegistry();
  const calls = [];

  const modA = {
    id: 'mod-a',
    version: '1.0.0',
    layer: 'foreground',
    async initialize() {
      calls.push('a:init');
    },
    async start() {
      calls.push('a:start');
    },
    async stop() {
      calls.push('a:stop');
    },
    async healthCheck() {
      return { moduleId: 'mod-a', status: 'healthy' };
    },
  };

  let failStart = true;
  const modB = {
    id: 'mod-b',
    version: '1.0.0',
    layer: 'background',
    async initialize() {
      calls.push('b:init');
    },
    async start() {
      if (failStart) throw new Error('Modül B başlatılamadı');
      calls.push('b:start');
    },
    async stop() {
      calls.push('b:stop');
    },
    async healthCheck() {
      throw new Error('Sağlık yoklaması koptu');
    },
  };

  assert.throws(() => registry.register({ ...modA, id: ' ' }), /boş olamaz/);
  registry.register(modA);
  assert.throws(() => registry.register(modA), /zaten kayıtlı/);
  registry.register(modB);

  const bus = createAppEventBus();
  const profileCtx = createProfileContext({ initialProfileId: 'PROFILE-A', initialRevision: 1 });
  const ctx = {
    profile: profileCtx,
    events: bus,
    subscribe: bus,
    logger: { info() {}, warn() {}, error() {} },
  };

  await assert.rejects(() => registry.startAll(ctx), /Modül B başlatılamadı/);
  assert.deepEqual(calls, ['a:init', 'a:start', 'b:init', 'a:stop']);
  assert.equal(registry.isStarted('mod-a'), false);

  failStart = false;
  await registry.startAll(ctx);
  // Tekrar startAll çağrısında initialize ikinci kez çalışmaz
  assert.equal(calls.filter((c) => c === 'a:init').length, 1);
  assert.equal(calls.filter((c) => c === 'b:init').length, 1);
  assert.equal(registry.isStarted('mod-a'), true);
  assert.equal(registry.isStarted('mod-b'), true);

  const health = await registry.healthCheckAll();
  assert.deepEqual(health, [
    { moduleId: 'mod-a', status: 'healthy' },
    { moduleId: 'mod-b', status: 'unhealthy', detail: 'Sağlık yoklaması koptu' },
  ]);

  await registry.stopAll();
  assert.equal(calls.at(-2), 'b:stop');
  assert.equal(calls.at(-1), 'a:stop');
});

// ---------------------------------------------------------------------------
// Adım 6: ProfileContext asenkron profil izolasyonu ve revision koruması
// ---------------------------------------------------------------------------
test('MIA Adım 6: ProfileContext profil değişiminde eski asenkron yazımları reddeder', async () => {
  const bus = createAppEventBus();
  const switchedEvents = [];
  bus.subscribe('ProfileSwitched', (ev) => {
    switchedEvents.push(ev.payload);
  });

  let invalidated = 0;
  const profileCtx = createProfileContext({
    initialProfileId: 'PROFILE-A',
    initialRevision: 3,
    eventPublisher: bus,
    onInvalidateInFlight: () => {
      invalidated += 1;
    },
  });

  const capturedRef = profileCtx.getCurrent();
  assert.equal(capturedRef.profileId, 'PROFILE-A');
  assert.equal(capturedRef.revision, 3);
  profileCtx.assertWritable(capturedRef);

  await profileCtx.switchProfile('PROFILE-B', 5);
  assert.equal(invalidated, 1);
  assert.deepEqual(switchedEvents, [{ fromProfileId: 'PROFILE-A', toProfileId: 'PROFILE-B' }]);

  assert.throws(
    () => profileCtx.assertWritable(capturedRef),
    (err) => err instanceof ProfileConflictError && err.reason === 'profile-switched'
  );

  const refB = profileCtx.getCurrent();
  profileCtx.commitRevision(6, 'PROFILE-B');
  assert.throws(
    () => profileCtx.assertWritable(refB),
    (err) => err instanceof ProfileConflictError && err.reason === 'stale-revision'
  );
});

// ---------------------------------------------------------------------------
// Adım 7: PrimaryDataRepository (gerçek depolama + dürüst SQLite/JSON raporu)
// ---------------------------------------------------------------------------
test('MIA Adım 7: ServerPrimaryDataRepository iyimser kilitleme ve dürüst sürücü sağlığı raporlar', async () => {
  const tmpDir = await makeTempDir('cinetrack-repo-');
  try {
    const storage = createDataStorage({ dataDir: tmpDir, sqliteEnabled: false });
    const repo = createServerPrimaryDataRepository(storage);

    const initial = await repo.read();
    assert.equal(initial.health.driver, 'json');

    const saved = await repo.save(makeDoc('PROFILE-A', 0), {
      expectedRevision: 0,
      requirePrecondition: true,
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.revision, 1);

    const conflict = await repo.save(makeDoc('PROFILE-A', 0), {
      expectedRevision: 0,
      requirePrecondition: true,
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.revision, 1);

    await assert.rejects(
      () => repo.saveForProfileOrThrow(makeDoc('PROFILE-A', 0), { profileId: 'PROFILE-A', revision: 0 }),
      (err) => err instanceof StaleRevisionError
    );

    const degradedRepo = createServerPrimaryDataRepository({
      ...storage,
      sqliteStatus: () => ({
        enabled: true,
        available: false,
        driver: 'sqlite',
        dbPath: path.join(tmpDir, 'db.sqlite'),
        revision: null,
        updatedAt: null,
        lastError: 'SQLite sürücüsü yüklenemedi',
      }),
    });
    const degradedHealth = await degradedRepo.getHealth();
    assert.equal(degradedHealth.driver, 'json');
    assert.equal(degradedHealth.enabled, true);
    assert.equal(degradedHealth.available, false);
    assert.match(String(degradedHealth.lastError), /SQLite/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Adım 9 & 10: TasteStore kilitli idempotent yazım + Projector/Coordinator sınırı
// ---------------------------------------------------------------------------
test('MIA Adım 9 & 10: TasteServiceAdapter idempotent olay işler ve eventWatermark manifeste işlenir', async () => {
  const tmpDir = await makeTempDir('cinetrack-taste-');
  try {
    const profileCtx = createProfileContext({
      initialProfileId: 'PROFILE-A',
      initialRevision: 2,
    });
    const adapter = createServerTasteServiceAdapter({
      dataDir: tmpDir,
      profileContext: profileCtx,
      rebuildOnEvent: true,
    });

    const appEvent = createAppEvent({
      eventId: 'evt-unique-1',
      eventType: 'LibraryItemAdded',
      ref: profileCtx.getCurrent(),
      payload: {
        mediaKey: 'movie:550',
        mediaType: 'movie',
        list: 'watched',
        rating: 9,
      },
    });

    const first = await adapter.processEvent(appEvent);
    assert.equal(first.ok, true);

    // Aynı eventId tekrar işlendiğinde çift kayıt üretmez (idempotent)
    const duplicate = await adapter.processEvent(appEvent);
    assert.equal(duplicate.ok, true);

    const storedEvents = await readTasteEventsForProfile('PROFILE-A', tmpDir);
    assert.equal(storedEvents.length, 1);
    assert.equal(storedEvents[0].eventId, 'evt-unique-1');

    const manifest = await readTasteManifestForProfile('PROFILE-A', tmpDir);
    assert.ok(manifest, 'manifest oluşturulmuş olmalı');
    assert.equal(manifest.eventWatermark, 'evt-unique-1');

    // Eşzamanlı appendTasteEventIdempotent çağrıları yarış olmadan tekilleştirir
    const translated = translateAppEventToTasteEvent({
      ...appEvent,
      eventId: 'evt-concurrent-2',
    });
    assert.ok(translated);
    const [r1, r2] = await Promise.all([
      appendTasteEventIdempotentForProfile('PROFILE-A', translated, tmpDir),
      appendTasteEventIdempotentForProfile('PROFILE-A', translated, tmpDir),
    ]);
    assert.equal(Number(r1.added) + Number(r2.added), 1);

    // Saf projektör sınır doğrulaması
    const projection = projectLearningSnapshot(await readTasteEventsForProfile('PROFILE-A', tmpDir));
    assert.equal(projection.eventCount, 2);
    assert.equal(projection.eventWatermark, 'evt-concurrent-2');

    // Farklı profil adına gelen olay reddedilir
    const foreignEvent = createAppEvent({
      eventId: 'evt-foreign-3',
      eventType: 'LibraryItemRemoved',
      ref: { profileId: 'profile-other', revision: 2 },
      payload: {
        mediaKey: 'movie:550',
        previousList: 'watched',
      },
    });
    const rejected = await adapter.processEvent(foreignEvent);
    assert.equal(rejected.ok, false);
    assert.match(String(rejected.error), /Profil uyuşmazlığı|Profil değişti/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Adım 11: OfflineQueue WriteProfileRef ve PrimaryDataRepository uyarlaması
// ---------------------------------------------------------------------------
test('MIA Adım 11: OfflineQueue profil çakışmasında yazımı durdurur, eşleşmede boşaltır', async () => {
  installLocalStorageMock();
  resetOfflineQueueForTests();

  const profileCtx = createProfileContext({
    initialProfileId: 'PROFILE-A',
    initialRevision: 4,
  });

  await enqueueOfflineSyncForProfile(makeDoc('PROFILE-A', 4), profileCtx.getCurrent());
  assert.equal(loadOfflineSyncSnapshot()?.profileRef?.profileId, 'PROFILE-A');
  assert.equal(loadOfflineSyncSnapshot()?.profileRef?.revision, 4);

  // Profil B'ye geçilirse eski profilin bekleyen çevrimdışı yazımı üzerine yazılmaz
  await profileCtx.switchProfile('PROFILE-B', 4);
  let saveCalled = 0;
  const mockRepo = {
    async read() {
      return { document: null, revision: 4, health: { driver: 'json', enabled: true, available: true, revision: 4, updatedAt: null, lastError: null } };
    },
    async save() {
      saveCalled += 1;
      return { ok: true, revision: 5 };
    },
    async getRevision() {
      return 4;
    },
    async getHealth() {
      return { driver: 'json', enabled: true, available: true, revision: 4, updatedAt: null, lastError: null };
    },
  };

  const blocked = await flushOfflineQueueWithRepository(mockRepo, { profileContext: profileCtx });
  assert.equal(blocked.status, 'profile-conflict');
  assert.equal(saveCalled, 0);
  assert.ok(loadOfflineSyncSnapshot(), 'profil çakışmasında kuyruk korunmalı');

  // Tekrar profil A'ya dönünce başarıyla senkronlanır ve temizlenir
  await profileCtx.switchProfile('PROFILE-A', 4);
  const synced = await flushOfflineQueueWithRepository(mockRepo, { profileContext: profileCtx });
  assert.equal(synced.status, 'synced');
  assert.equal(synced.revision, 5);
  assert.equal(loadOfflineSyncSnapshot(), null);
  resetOfflineQueueForTests();
});

// ---------------------------------------------------------------------------
// Son Kabul — P1 EventBus + useItemActions + TasteServiceAdapter + Shell köprüsü
// ---------------------------------------------------------------------------
test('Son Kabul P1: useItemActions, TasteServiceAdapter ve bridgeAppEventsToShellEvents uçtan uca bağlanır ve çift yazım üretmez', async () => {
  const tmpDir = await makeTempDir('cinetrack-e2e-bus-');
  resetShellEventsForTests();
  try {
    const bus = createAppEventBus();
    const profileCtx = createProfileContext({
      initialProfileId: 'PROFILE-A',
      initialRevision: 3,
      eventPublisher: bus,
    });
    const adapter = createServerTasteServiceAdapter({
      dataDir: tmpDir,
      profileContext: profileCtx,
      rebuildOnEvent: true,
    });

    const adapterSub = subscribeTasteAdapterToEventBus(bus, adapter);
    const shellSub = bridgeAppEventsToShellEvents(bus);

    const shellSaved = [];
    const shellProfileChanged = [];
    const offSaved = subscribeShellEvent('item:saved', (p) => shellSaved.push(p.key));
    const offProf = subscribeShellEvent('profile:changed', (p) =>
      shellProfileChanged.push(p.profileId)
    );

    const savedList = [];
    const persistErrors = [];
    const actions = useItemActions({
      getSavedItems: () => savedList,
      onCommitSavedItem: (normalized) => {
        savedList.unshift(normalized);
      },
      profileContext: profileCtx,
      eventPublisher: bus,
      onEventPersistError: (err) => {
        persistErrors.push(err);
      },
    });

    actions.saveItem(
      {
        id: 550,
        media_type: 'movie',
        title: 'Fight Club',
        genre_ids: [18],
        vote_average: 8.4,
      },
      'completed',
      9
    );

    // Async subscriber handler'ların tamamlanmasını deterministik bekle
    const deadline = Date.now() + 2000;
    let storedAfterSave = await readTasteEventsForProfile('PROFILE-A', tmpDir);
    while (storedAfterSave.length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      storedAfterSave = await readTasteEventsForProfile('PROFILE-A', tmpDir);
    }

    assert.equal(persistErrors.length, 0);
    assert.deepEqual(shellSaved, ['movie:550'], 'item:saved kabuk olayı tek kez yayınlanmalı');

    assert.equal(storedAfterSave.length, 2, 'status_changed + rating_changed yazılmalı');

    // İlk EventBus yayınının fire-and-forget rebuild'inin geçici dizin temizliğiyle yarışmasını önle.
    await triggerTasteProfileRebuild('PROFILE-A', tmpDir);

    // Aynı olayı ikinci kez yayınlama -> TasteStore içinde çift kayıt üretmemeli
    const publishedHistory = bus.getRecentEvents();
    const addedEvent = publishedHistory.find((e) => e.eventType === 'LibraryItemAdded');
    assert.ok(addedEvent);
    await bus.publish(addedEvent);

    const storedAfterReplay = await readTasteEventsForProfile('PROFILE-A', tmpDir);
    assert.equal(
      storedAfterReplay.length,
      storedAfterSave.length,
      'aynı eventId ikinci kez işlendiğinde çift TasteEvent oluşmamalı'
    );

    // Profil değişimi yalnızca 1 kez profile:changed kabuk olayı üretir
    await profileCtx.switchProfile('PROFILE-B', 3);
    assert.deepEqual(shellProfileChanged, ['PROFILE-B']);

    // Kalıcılık hatası client sink'te sessizce yutulmaz
    const syncErrors = [];
    const clientSyncSub = subscribeClientTasteSyncToEventBus(bus, {
      sendDomainEvent: async () => {
        throw new Error('Sunucu disk hatası');
      },
      onError: (err) => {
        syncErrors.push(err instanceof Error ? err.message : String(err));
      },
    });

    // Plan 2.3 — EventBus hata yayılımı: abone hatası publish() çağrısına
    // AggregateError olarak bildirilmeli; diğer aboneler yine de çalışmalı.
    let publishError = null;
    try {
      await bus.publish(
        createAppEvent({
          eventType: 'LibraryRatingChanged',
          ref: profileCtx.getCurrent(),
          entityId: 'movie:603',
          payload: {
            mediaKey: 'movie:603',
            mediaType: 'movie',
            rating: 8,
            previousRating: null,
          },
        })
      );
    } catch (err) {
      publishError = err;
    }
    assert.ok(
      publishError instanceof AggregateError,
      'kritik abone hatası publish() çağrısına bildirilmeli (plan 2.3)'
    );
    assert.match(String(publishError?.message ?? ''), /LibraryRatingChanged/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(syncErrors.length, 1);
    assert.match(syncErrors[0], /Sunucu disk hatası/);

    clientSyncSub.unsubscribe();
    adapterSub.unsubscribe();
    shellSub.unsubscribe();
    offSaved();
    offProf();
  } finally {
    resetShellEventsForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R2-A3 regresyonu: aktif olmayan profile ait iç EventBus olayı Taste yazımını
// atlar; diğer aboneler çalışır ve publish AggregateError üretmez.
// ---------------------------------------------------------------------------
test('R2-A3: inactive-profile iç EventBus olayı diğer aboneleri engellemez', async () => {
  const tmpDir = await makeTempDir('cinetrack-inactive-profile-event-');
  const bus = createAppEventBus();
  const profileCtx = createProfileContext({
    initialProfileId: 'PROFILE-A',
    initialRevision: 1,
    eventPublisher: bus,
  });
  const adapter = createServerTasteServiceAdapter({
    dataDir: tmpDir,
    profileContext: profileCtx,
    rebuildOnEvent: false,
  });
  const tasteSub = subscribeTasteAdapterToEventBus(bus, adapter);
  let otherSubscriberCalls = 0;
  const otherSub = bus.subscribe('LibraryItemAdded', () => {
    otherSubscriberCalls += 1;
  });

  try {
    const foreignEvent = createAppEvent({
      eventId: 'inactive-profile-event-1',
      eventType: 'LibraryItemAdded',
      ref: { profileId: 'PROFILE-B', revision: 1 },
      entityId: 'movie:550',
      payload: { mediaKey: 'movie:550', mediaType: 'movie', list: 'watched' },
    });
    await assert.doesNotReject(() => bus.publish(foreignEvent));
    assert.equal(otherSubscriberCalls, 1);
    assert.deepEqual(await readTasteEventsForProfile('PROFILE-B', tmpDir), []);
    assert.deepEqual(await readTasteEventsForProfile('PROFILE-A', tmpDir), []);
  } finally {
    tasteSub.unsubscribe();
    otherSub.unsubscribe();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Son Kabul — P1 & P2: createCineTrackApp HTTP, PrimaryDataRepository, ModuleRegistry, TasteError
// ---------------------------------------------------------------------------
test('Son Kabul P1 & P2: createCineTrackApp PrimaryDataRepository, ModuleRegistry ve /api/taste uçlarını çalıştırır', async () => {
  const tmpDir = await makeTempDir('cinetrack-http-mia-');
  const runtime = createCineTrackApp({ dataDir: tmpDir });
  await runtime.startRuntimeModules();

  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. /api/health -> gerçek sürücü + 3 çalışma zamanı modülü sağlıklı
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.storage.driver, 'json');
    assert.equal(healthJson.storage.available, true);
    assert.ok(Array.isArray(healthJson.modules));
    assert.deepEqual(
      healthJson.modules.map((m) => [m.moduleId, m.status]),
      [
        ['primary-storage', 'healthy'],
        ['taste-engine', 'healthy'],
        ['backup-sync', 'healthy'],
        ['content-intelligence', 'healthy'],
        ['initial-indexer', 'healthy'],
      ]
    );

    // 2. PUT /api/data -> ServerPrimaryDataRepository revision ve profil uyuşmazlığını reddeder
    const putOkRes = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"rev-0"',
        'X-CineTrack-Profile-Id': 'PROFILE-A',
      },
      body: JSON.stringify(makeDoc('PROFILE-A', 0)),
    });
    assert.equal(putOkRes.status, 200);
    const putOkJson = await putOkRes.json();
    assert.equal(putOkJson.revision, 1);

    const stalePutRes = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"rev-0"',
      },
      body: JSON.stringify(makeDoc('PROFILE-A', 0)),
    });
    assert.equal(stalePutRes.status, 409);
    const stalePutJson = await stalePutRes.json();
    assert.equal(stalePutJson.code, 'revision_conflict');

    const profileMismatchRes = await fetch(`${baseUrl}/api/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': '"rev-1"',
        'X-CineTrack-Profile-Id': 'profile-wrong',
      },
      body: JSON.stringify(makeDoc('PROFILE-A', 1)),
    });
    assert.equal(profileMismatchRes.status, 409);
    const profileMismatchJson = await profileMismatchRes.json();
    assert.equal(profileMismatchJson.code, 'profile_conflict');

    // 3. /api/taste/domain-event -> tekrar gönderimde tek TasteEvent üretir
    const domEv = createAppEvent({
      eventId: 'http-domain-evt-1',
      eventType: 'LibraryItemAdded',
      ref: { profileId: 'PROFILE-A', revision: 1 },
      entityId: 'movie:550',
      payload: { mediaKey: 'movie:550', mediaType: 'movie', list: 'watched' },
    });
    const evRes1 = await fetch(`${baseUrl}/api/taste/domain-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: domEv }),
    });
    assert.equal(evRes1.status, 200);

    const evRes2 = await fetch(`${baseUrl}/api/taste/domain-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: domEv }),
    });
    assert.equal(evRes2.status, 200);
    // MIA Dilim F sonrası: PUT /api/data gerçek LibraryItemAdded olayını
    // yayımlar (movie:550) ve taste motoru bunu işler; ardından domain-event
    // gönderimi ikinci TasteEvent üretir. Aynı eventId'li ikinci POST
    // tekilleştirilir → toplam 2 kayıt.
    assert.equal((await readTasteEventsForProfile('PROFILE-A', tmpDir)).length, 2);

    // 4. Kurtarılamaz bozuk Taste events dosyasında HTTP 500 corrupt_json_file döner (sessiz []) yok
    const eventsPath = resolveTastePathsForProfile('PROFILE-A', tmpDir).paths.events;
    await fs.rm(`${eventsPath}.bak`, { force: true });
    await fs.writeFile(eventsPath, '{ bozuk taste events', 'utf8');

    const corruptRes = await fetch(`${baseUrl}/api/taste/events`);
    assert.equal(corruptRes.status, 500);
    const corruptJson = await corruptRes.json();
    assert.equal(corruptJson.code, 'corrupt_json_file');
  } finally {
    await runtime.stopRuntimeModules();
    assert.equal(runtime.moduleRegistry.isStarted('primary-storage'), false);
    assert.equal(runtime.moduleRegistry.isStarted('taste-engine'), false);
    assert.equal(runtime.moduleRegistry.isStarted('backup-sync'), false);
    assert.equal(runtime.moduleRegistry.isStarted('content-intelligence'), false);
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Son Kabul — P2 OfflineQueue WriteProfileRef zorunluluğu + IDB reload testi
// ---------------------------------------------------------------------------
test('Son Kabul P2: OfflineQueue profilsiz yazımı reddeder, IDB reload sonrasında WriteProfileRef korur ve HttpPrimaryDataRepository ile boşaltır', async () => {
  const { indexedDB } = await import('fake-indexeddb');
  const prevIdb = globalThis.indexedDB;
  const prevFetch = globalThis.fetch;
  globalThis.indexedDB = indexedDB;
  installLocalStorageMock();
  resetOfflineQueueForTests();

  try {
    // 1. Profilsiz / geçersiz revision'lı eski yazım reddedilir
    const docWithoutProfile = { ...makeDoc('PROFILE-A', 1), activeProfileId: '' };
    await assert.rejects(
      () => enqueueOfflineSyncSnapshotDurable(docWithoutProfile, 1),
      /WriteProfileRef/
    );
    await assert.rejects(
      () => enqueueOfflineSyncSnapshotDurable(makeDoc('PROFILE-A', 1), null),
      /WriteProfileRef/
    );
    await assert.rejects(
      () =>
        enqueueOfflineSyncForProfile(makeDoc('PROFILE-A', 2), {
          profileId: 'PROFILE-B',
          revision: 2,
        }),
      (err) => err instanceof ProfileConflictError && err.reason === 'profile-switched'
    );

    // 2. IDB yazımı + sayfa yenileme simülasyonu + HttpPrimaryDataRepository flush
    const profileCtx = createProfileContext({
      initialProfileId: 'PROFILE-A',
      initialRevision: 3,
    });
    const enq = await enqueueOfflineSyncForProfile(
      makeDoc('PROFILE-A', 3),
      profileCtx.getCurrent()
    );
    assert.equal(enq.storage, 'indexeddb');
    assert.equal(enq.persisted, true);

    resetOfflineQueueForTests(); // bellek sıfırlandı
    const reloaded = await loadOfflineSyncSnapshotAsync();
    assert.equal(reloaded?.profileRef?.profileId, 'PROFILE-A');
    assert.equal(reloaded?.profileRef?.revision, 3);

    // Farklı profil aktifken boşaltma reddedilir, kuyruk korunur
    await profileCtx.switchProfile('PROFILE-B', 3);
    const httpRepo = createHttpPrimaryDataRepository();
    const blocked = await flushOfflineQueueWithRepository(httpRepo, {
      profileContext: profileCtx,
    });
    assert.equal(blocked.status, 'profile-conflict');
    assert.ok(await loadOfflineSyncSnapshotAsync(), 'kuyruk silinmemeli');

    // Aynı profile dönünce HttpPrimaryDataRepository gerçek HTTP yazımıyla boşaltır ve revision ilerletir
    await profileCtx.switchProfile('PROFILE-A', 3);
    const seenHeaders = [];
    globalThis.fetch = async (_url, init) => {
      seenHeaders.push(init?.headers || {});
      return new Response(
        JSON.stringify({
          ok: true,
          revision: 4,
          updatedAt: '2026-11-16T00:00:00.000Z',
          profiles: 1,
          items: 1,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    };

    const flushed = await flushOfflineQueueWithRepository(httpRepo, {
      profileContext: profileCtx,
    });
    assert.equal(flushed.status, 'synced');
    assert.equal(flushed.revision, 4);
    assert.equal(profileCtx.getCurrent().revision, 4);
    assert.equal(await loadOfflineSyncSnapshotAsync(), null);
    assert.equal(seenHeaders[0]['X-CineTrack-Profile-Id'], 'PROFILE-A');
    assert.equal(seenHeaders[0]['If-Match'], '"rev-3"');
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.indexedDB = prevIdb;
    resetOfflineQueueForTests();
  }
});
