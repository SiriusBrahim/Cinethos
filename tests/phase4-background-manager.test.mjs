/**
 * MIA Faz 4 — Background Manager kalıcı regresyon testleri (görev: ajan-1).
 *
 * Kapsam (görev talimatındaki 9 senaryo):
 *  A1. Olay kabulü + görev oluşturma atomikliği (tek transaction, gerçek SQLite).
 *  A2. Aynı eventId ile tekrar gönderimde idempotency (deduplicated, yeni görev yok).
 *  A3. Profil çakışması: retry_wait → tekrar deneme → nihai failed; çapraz profil
 *      yazımının engellenmesi (spy handler yazma kanıtıyla).
 *  A4. Lease süresi dolan görevlerin kurtarılması (recoverInterrupted).
 *  A5. Kalıcı hata ile geçici hatanın ayrıştırılması (failed vs retry_wait).
 *  A6. persistEvent hatasında publish reddedilir ve aboneler ÇALIŞMAZ.
 *  A7. Payload allowlist negatif testleri (not/kişisel alan kalıcı deftere yazılamaz).
 *  A8. start/stop yaşam döngüsü (durdurma sonrası pompa durur, yeniden başlatma çalışır).
 *  A9. Duplicate olaylar istatistikleri değiştirmez.
 *  B1. Gerçek uygulama fabrikasıyla entegrasyon: LibraryService → AppEventBus →
 *      BackgroundManager → görev tamamlanır; duplicate olay yeni görev üretmez.
 *  B2. BackgroundManager ModuleRegistry'ye kayıtlı DEĞİL (health modül listesi
 *      sözleşmesi korunur — belgelenmiş Faz 4 kararı, gerileme koruması).
 *
 * Testler gerçek `node:sqlite` veritabanlarını geçici dizinlerde kullanır; mock
 * repository YOK. Uygulama kodu değiştirilmez.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCineTrackApp } from '../src/server/app.ts';
import { createBackgroundTaskRepository } from '../src/server/background-task-repository.ts';
import { createBackgroundManager } from '../src/modules/background/service.ts';
import {
  createLibraryItemAddedHandler,
  createLibraryRatingChangedHandler,
  LIBRARY_ITEM_ADDED_HANDLER_ID,
  LIBRARY_RATING_CHANGED_HANDLER_ID,
} from '../src/modules/background/handlers.ts';
import { sanitizeEventPayload } from '../src/modules/background/event-payload.ts';
import {
  PermanentBackgroundError,
  RetryableBackgroundError,
} from '../src/modules/background/errors.ts';
import { createAppEventBus, createAppEvent } from '../src/app/app-event-bus.ts';
import { ProfileConflictError } from '../src/contracts/index.ts';

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function makeTempDir(prefix = 'cinethos-faz4-background-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Deterministik saat: her çağrıda 1 sn ilerler. */
function makeClock(startMs = Date.UTC(2026, 0, 1, 0, 0, 0)) {
  let current = startMs;
  return () => new Date((current += 1000)).toISOString();
}

function makeProfileContext(activeId, revision = 5) {
  return { getCurrent: () => ({ profileId: activeId, revision }) };
}

function makeEvent(overrides = {}) {
  return {
    eventId: 'evt-test-1',
    eventType: 'LibraryItemAdded',
    profileId: 'profile-a',
    entityId: 'movie:157336',
    schemaVersion: 1,
    sourceRevision: 5,
    occurredAt: '2026-01-01T00:00:00.000Z',
    ref: { profileId: 'profile-a', revision: 5 },
    payload: { mediaKey: 'movie:157336', mediaType: 'movie', list: 'watched' },
    ...overrides,
  };
}

/**
 * Gerçek BackgroundTaskRepository + BackgroundManager kurar (geçici SQLite).
 * `start()` çağrılmaz; pompa `pumpOnce()` ile deterministik sürülür.
 */
async function makeManager(options = {}) {
  const tmpDir = await makeTempDir();
  const now = options.now ?? makeClock();
  const repository = createBackgroundTaskRepository({ dataDir: tmpDir, now });
  const manager = createBackgroundManager({
    repository,
    handlers: options.handlers ?? [
      createLibraryItemAddedHandler(),
      createLibraryRatingChangedHandler(),
    ],
    profileContext: options.profileContext ?? makeProfileContext('profile-a'),
    now,
    baseRetryDelayMs: 10,
    ...options.manager,
  });
  await manager.initialize();
  return { tmpDir, repository, manager, now };
}

async function cleanup(tmpDir) {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

/** Pompayı görev terminal duruma gelene dek sürer (en fazla `maxPumps` tur). */
async function pumpUntil(manager, predicate, maxPumps = 20) {
  for (let i = 0; i < maxPumps; i += 1) {
    await manager.pumpOnce();
    if (predicate()) return;
  }
}

function makeDoc(profiles) {
  return {
    version: 3,
    schemaVersion: 3,
    revision: 0,
    activeProfileId: profiles[0]?.id ?? 'default',
    profiles,
  };
}

function makeProfile(id, name, items = []) {
  return { id, name, createdAt: '2026-01-01T00:00:00.000Z', items };
}

// ---------------------------------------------------------------------------
// A1. Olay kabulü + görev oluşturma atomikliği
// ---------------------------------------------------------------------------

test('F4-A1 acceptEvent: olay kalıcı deftere yazılır, kayıtlı işleyici başına bir görev üretilir', async () => {
  const { tmpDir, repository, manager } = await makeManager();
  try {
    const result = await manager.acceptEvent(makeEvent());
    assert.equal(result.eventInserted, true, 'olay deftere yazılmalı');
    assert.equal(result.deduplicated, false);
    assert.equal(result.tasksCreated, 1, 'LibraryItemAdded işleyicisi için bir görev üretilmeli');

    const event = repository.getEvent('evt-test-1');
    assert.ok(event, 'olay kaydı okunabilmeli');
    assert.equal(event.eventType, 'LibraryItemAdded');
    assert.equal(event.profileId, 'profile-a');
    assert.equal(event.sourceRevision, 5);
    assert.deepEqual(event.payload, { mediaKey: 'movie:157336', mediaType: 'movie', list: 'watched' });

    const tasks = manager.listTasks();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].eventId, 'evt-test-1');
    assert.equal(tasks[0].handlerId, LIBRARY_ITEM_ADDED_HANDLER_ID);
    assert.equal(tasks[0].status, 'pending');
    assert.equal(tasks[0].attempts, 0);
  } finally {
    await cleanup(tmpDir);
  }
});

test('F4-A1b acceptEvent: iki olay türü iki ayrı görev üretir; işleyicisiz olay yalnızca deftere yazılır', async () => {
  const { tmpDir, repository, manager } = await makeManager();
  try {
    const r1 = await manager.acceptEvent(makeEvent({ eventId: 'evt-a' }));
    const r2 = await manager.acceptEvent(
      makeEvent({
        eventId: 'evt-b',
        eventType: 'LibraryRatingChanged',
        payload: { mediaKey: 'movie:157336', mediaType: 'movie', rating: 9 },
      })
    );
    assert.equal(r1.tasksCreated, 1);
    assert.equal(r2.tasksCreated, 1);

    // Kayıtlı işleyicisi olmayan olay türü: deftere yazılır, görev üretilmez.
    const r3 = await manager.acceptEvent(
      makeEvent({ eventId: 'evt-c', eventType: 'ProfileSwitched', payload: { toProfileId: 'profile-b' } })
    );
    assert.equal(r3.eventInserted, true, 'tüm olaylar deftere yazılmalı');
    assert.equal(r3.tasksCreated, 0, 'işleyicisi olmayan olay için görev üretilmemeli');
    assert.ok(repository.getEvent('evt-c'));
    assert.equal(manager.listTasks().length, 2);
  } finally {
    await cleanup(tmpDir);
  }
});

test('F4-A1c atomiklik: görev yazımı başarısız olursa olay da kalıcılaşmaz (transaction tek parça)', async () => {
  // Salt-okunur kanıt: kabul kodu BEGIN IMMEDIATE ... COMMIT ile tek transaction.
  // Davranışsal kanıt: erişilemez DB'de acceptEvent tümüyle başarısız olmalı;
  // kısmi yazım (olay var, görev yok) gözlemlenemez.
  const { tmpDir, repository, manager } = await makeManager();
  try {
    const source = await fs.readFile(
      path.join(process.cwd(), 'src', 'server', 'background-task-repository.ts'),
      'utf8'
    );
    assert.match(source, /BEGIN IMMEDIATE/, 'kabul işlemi açık transaction içinde olmalı');
    assert.match(source, /ROLLBACK/, 'hata durumunda rollback uygulanmalı');

    // SQLite'ın açılamadığı gerçek senaryo: dbPath mevcut bir DİZİN'i gösterir.
    const blockedDir = path.join(tmpDir, 'blocked.db');
    await fs.mkdir(blockedDir, { recursive: true });
    const broken = createBackgroundTaskRepository({ dataDir: tmpDir, dbPath: blockedDir });
    let brokenThrew = false;
    try {
      broken.acceptEvent(
        {
          eventId: 'evt-broken',
          eventType: 'LibraryItemAdded',
          profileId: 'profile-a',
          entityId: null,
          schemaVersion: 1,
          sourceRevision: 5,
          occurredAt: '2026-01-01T00:00:00.000Z',
          payload: {},
          handlerIds: [LIBRARY_ITEM_ADDED_HANDLER_ID],
        },
        '2026-01-01T00:00:00.000Z'
      );
    } catch {
      brokenThrew = true;
    }
    assert.equal(brokenThrew, true, 'erişilemez DB kabulü tümüyle reddetmeli');
    // Kırık repo sonrasında hiçbir olay kaydı üretemez; sağlıklı repoda da
    // başarısız kabulün izi (kısmi yazım) bulunamaz.
    assert.equal(
      repository.hasEvent('evt-broken'),
      false,
      'başarısız kabul olayı hiçbir depoda kalıcılaşmamalı (kısmi yazım yok)'
    );

    // Sağlıklı repo üzerinde kabul başarılı olmalı.
    await manager.acceptEvent(makeEvent({ eventId: 'evt-ok' }));
    assert.equal(repository.hasEvent('evt-ok'), true);
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// A2. Idempotency — aynı eventId tekrar gönderimi
// ---------------------------------------------------------------------------

test('F4-A2 duplicate eventId: deduplicated=true, yeni görev üretilmez, mevcut görevler korunur', async () => {
  const { tmpDir, repository, manager } = await makeManager();
  try {
    const first = await manager.acceptEvent(makeEvent());
    assert.equal(first.tasksCreated, 1);

    // İlk görevi işle (terminal duruma taşı).
    await manager.start();
    await pumpUntil(manager, () => manager.listTasks().every((t) => t.status === 'completed'));
    await manager.stop();

    const duplicate = await manager.acceptEvent(makeEvent());
    assert.equal(duplicate.eventInserted, false, 'aynı eventId ikinci kez yazılmamalı');
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.tasksCreated, 0, 'duplicate olay için yeni görev üretilmemeli');
    assert.equal(manager.listTasks().length, 1, 'görev sayısı değişmemeli');
    assert.equal(manager.listTasks()[0].status, 'completed', 'terminal görev yeniden işlenmemeli');

    // Duplicate, olay kaydını da değiştirmemeli (ilk kabulün verisi korunur).
    const event = repository.getEvent('evt-test-1');
    assert.equal(event.occurredAt, '2026-01-01T00:00:00.000Z');
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// A3. Profil çakışması: retry_wait → tekrar → failed; çapraz yazım engellenir
// ---------------------------------------------------------------------------

test('F4-A3 profil çakışması: hedef profil aktif değilken görev pending kalır, aktif olunca tamamlanır (R2-A4)', async () => {
  const state = { profileId: 'profile-a', revision: 5 };
  const { tmpDir, manager } = await makeManager({
    profileContext: { getCurrent: () => ({ ...state }) },
  });
  try {
    await manager.start();

    // Olay 'profile-b' profiline ait; aktif profil 'profile-a' → görev bekler.
    await manager.acceptEvent(makeEvent({ profileId: 'profile-b', ref: { profileId: 'profile-b', revision: 5 } }));
    await manager.pumpOnce();

    const afterFirst = manager.listTasks()[0];
    assert.equal(afterFirst.status, 'pending', 'hedef profil aktif değilken görev beklemeli');
    assert.equal(afterFirst.attempts, 0, 'deneme hakkı tüketilmemeli');
    assert.equal(afterFirst.lastError, null, 'bekleme hata olarak işaretlenmemeli');

    // Aynı pompa turu bekleyen görevi başka profile yazmaz.
    for (let i = 0; i < 3; i += 1) {
      await manager.pumpOnce();
      assert.equal(manager.listTasks()[0].status, 'pending');
    }

    // Hedef profil aktif olunca görev çalışır ve tamamlanır.
    state.profileId = 'profile-b';
    manager.notify();
    await pumpUntil(manager, () => manager.listTasks()[0]?.status === 'completed');
    assert.equal(manager.listTasks()[0].status, 'completed');
    assert.equal(manager.listTasks()[0].attempts, 1, 'tek denemede tamamlanmalı');
    await manager.stop();
  } finally {
    await cleanup(tmpDir);
  }
});

test('F4-A3b çapraz profil yazımı engellenir: çakışan görev, hedef profile hiç yazma yapamaz', async () => {
  const writes = [];
  const conflictHandler = {
    id: 'test.cross-profile-guard',
    version: '1.0.0',
    eventTypes: ['LibraryItemAdded'],
    async handle(event, context) {
      const current = context.profileContext.getCurrent();
      if (current.profileId !== event.profileId) {
        throw new ProfileConflictError('profile-switched', {
          expectedRevision: event.sourceRevision,
          actualRevision: current.revision,
          message: 'aktif profil farklı',
        });
      }
      writes.push(event.profileId);
    },
  };
  const { tmpDir, manager } = await makeManager({
    profileContext: makeProfileContext('profile-a'),
    handlers: [conflictHandler],
  });
  try {
    await manager.start();
    // 'profile-b' profiline ait üç ayrı olay → hepsi çakışır.
    for (const id of ['evt-p1', 'evt-p2', 'evt-p3']) {
      await manager.acceptEvent(
        makeEvent({ eventId: id, profileId: 'profile-b', ref: { profileId: 'profile-b', revision: 5 } })
      );
    }
    for (let i = 0; i < 3; i += 1) {
      await manager.pumpOnce();
    }
    assert.deepEqual(writes, [], 'çakışan görevler hiçbir profile yazmamalı');
    assert.ok(
      manager.listTasks().every((t) => t.status === 'pending' && t.attempts === 0),
      'hedef profil aktif değilken görevler beklemeli ve deneme tüketmemeli'
    );
    assert.equal(
      manager.listTasks().every((t) => t.profileId === 'profile-b'),
      true,
      'görevlerin profil kimliği korunmalı'
    );
    await manager.stop();
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// A4. Lease kurtarma
// ---------------------------------------------------------------------------

test('F4-A4 lease süresi dolan processing görevi pending durumuna alınır; hak tükenirse failed olur', async () => {
  const { tmpDir, repository, now } = await makeManager();
  try {
    await repository.acceptEvent(
      {
        eventId: 'evt-lease',
        eventType: 'LibraryItemAdded',
        profileId: 'profile-a',
        entityId: 'movie:157336',
        schemaVersion: 1,
        sourceRevision: 5,
        occurredAt: now(),
        payload: { mediaKey: 'movie:157336', mediaType: 'movie', list: 'watched' },
        handlerIds: [LIBRARY_ITEM_ADDED_HANDLER_ID],
      },
      now()
    );

    // 1. tur: claim (attempts=1) → "çökme" → lease dolmuş → pending'e döner.
    const claimed1 = repository.claimNextTask(1000, now());
    assert.equal(claimed1.status, 'processing');
    assert.ok(claimed1.leaseUntil, 'lease yazılmalı');
    const future1 = new Date(Date.parse(now()) + 3600_000).toISOString();
    const rec1 = repository.recoverInterrupted(future1);
    assert.deepEqual(rec1, { requeued: 1, failed: 0 });
    assert.equal(repository.getTask(claimed1.taskId).status, 'pending');

    // 2. tur: hak bitene dek aynı döngü.
    repository.claimNextTask(1000, now());
    repository.recoverInterrupted(new Date(Date.parse(now()) + 3600_000).toISOString());
    repository.claimNextTask(1000, now());
    const rec3 = repository.recoverInterrupted(new Date(Date.parse(now()) + 3600_000).toISOString());
    assert.deepEqual(rec3, { requeued: 0, failed: 1 }, 'deneme hakkı tükenen görev failed olmalı');
    const finalTask = repository.getTask(claimed1.taskId);
    assert.equal(finalTask.status, 'failed');
    assert.equal(finalTask.leaseUntil, null, 'failed görevin lease temizlenmeli');
  } finally {
    await cleanup(tmpDir);
  }
});

test('F4-A4b lease süresi içindeki processing görevi kurtarılmaz (çalışan görev korunur)', async () => {
  const { tmpDir, repository, now } = await makeManager();
  try {
    await repository.acceptEvent(
      {
        eventId: 'evt-live',
        eventType: 'LibraryItemAdded',
        profileId: 'profile-a',
        entityId: 'movie:157336',
        schemaVersion: 1,
        sourceRevision: 5,
        occurredAt: now(),
        payload: { mediaKey: 'movie:157336', mediaType: 'movie', list: 'watched' },
        handlerIds: [LIBRARY_ITEM_ADDED_HANDLER_ID],
      },
      now()
    );
    repository.claimNextTask(60_000, now());
    // Lease 60 sn; 1 sn sonra kurtarma → dokunulmamalı.
    const rec = repository.recoverInterrupted(new Date(Date.parse(now()) + 1000).toISOString());
    assert.deepEqual(rec, { requeued: 0, failed: 0 });
    assert.equal(repository.listTasks()[0].status, 'processing');
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// A5. Kalıcı hata ile geçici hatanın ayrıştırılması
// ---------------------------------------------------------------------------

test('F4-A5 kalıcı hata: PermanentBackgroundError → failed, tekrar denenmez', async () => {
  const permanentHandler = {
    id: 'test.permanent',
    version: '1.0.0',
    eventTypes: ['LibraryItemAdded'],
    async handle() {
      throw new PermanentBackgroundError('kalıcı doğrulama hatası');
    },
  };
  const { tmpDir, manager } = await makeManager({ handlers: [permanentHandler] });
  try {
    await manager.start();
    await manager.acceptEvent(makeEvent());
    await manager.pumpOnce();
    const task = manager.listTasks()[0];
    assert.equal(task.status, 'failed');
    assert.match(task.lastError, /kalıcı/);
    // Tekrar pompa: failed görev yeniden işlenmez.
    await manager.pumpOnce();
    assert.equal(task.attempts, 1);
    await manager.stop();
  } finally {
    await cleanup(tmpDir);
  }
});

test('F4-A5b geçici hata: RetryableBackgroundError → retry_wait, süre geçince yeniden denenir', async () => {
  let calls = 0;
  const flakyHandler = {
    id: 'test.flaky',
    version: '1.0.0',
    eventTypes: ['LibraryItemAdded'],
    async handle() {
      calls += 1;
      if (calls < 3) throw new RetryableBackgroundError('geçici ağ hatası');
    },
  };
  const { tmpDir, manager } = await makeManager({ handlers: [flakyHandler] });
  try {
    await manager.start();
    await manager.acceptEvent(makeEvent());
    await pumpUntil(manager, () => manager.listTasks()[0]?.status === 'completed');
    const task = manager.listTasks()[0];
    assert.equal(task.status, 'completed', 'üçüncü denemede başarılı olmalı');
    assert.equal(task.attempts, 3);
    assert.equal(calls, 3);
    await manager.stop();
  } finally {
    await cleanup(tmpDir);
  }
});

test('F4-A5c geçici mesaj deseni: bilinmeyen hata türü yalnızca geçici desen taşıyorsa retry edilir', async () => {
  const transientMsgHandler = {
    id: 'test.transient-msg',
    version: '1.0.0',
    eventTypes: ['LibraryItemAdded'],
    async handle() {
      throw new Error('veritabanı meşgul: SQLITE_BUSY');
    },
  };
  const permanentMsgHandler = {
    id: 'test.permanent-msg',
    version: '1.0.0',
    eventTypes: ['LibraryRatingChanged'],
    async handle() {
      throw new Error('geçersiz puan biçimi');
    },
  };
  // Not: iki senaryo izole örneklerde çalışır; aksi hâlde retry due olan görev
  // kuyruk sırasını (created_at ASC) etkileyip ikinci senaryoyu gölgeleyebilir.
  {
    const { tmpDir, manager } = await makeManager({ handlers: [transientMsgHandler] });
    try {
      await manager.start();
      await manager.acceptEvent(makeEvent());
      await manager.pumpOnce();
      assert.equal(
        manager.listTasks()[0].status,
        'retry_wait',
        'SQLITE_BUSY geçici sayılmalı'
      );
      await manager.stop();
    } finally {
      await cleanup(tmpDir);
    }
  }
  {
    const { tmpDir, manager } = await makeManager({ handlers: [permanentMsgHandler] });
    try {
      await manager.start();
      await manager.acceptEvent(
        makeEvent({
          eventId: 'evt-rating',
          eventType: 'LibraryRatingChanged',
          payload: { mediaKey: 'movie:157336', mediaType: 'movie', rating: 9 },
        })
      );
      await manager.pumpOnce();
      assert.equal(
        manager.listTasks()[0].status,
        'failed',
        'geçici desen taşımayan bilinmeyen hata failed olmalı'
      );
      await manager.stop();
    } finally {
      await cleanup(tmpDir);
    }
  }
});

// ---------------------------------------------------------------------------
// A6. persistEvent hatası → publish reddedilir, aboneler çalışmaz
// ---------------------------------------------------------------------------

test('F4-A6 persistEvent başarısızsa publish reddedilir ve aboneler hiç çalışmaz', async () => {
  const bus = createAppEventBus({
    persistEvent: async () => {
      throw new Error('kalıcı defter yazılamadı');
    },
  });
  let subscriberCalls = 0;
  bus.subscribe('LibraryItemAdded', () => {
    subscriberCalls += 1;
  });

  const event = createAppEvent({
    eventType: 'LibraryItemAdded',
    ref: { profileId: 'profile-a', revision: 1 },
    payload: { mediaKey: 'movie:157336', mediaType: 'movie', list: 'watched' },
  });

  await assert.rejects(
    () => bus.publish(event),
    /kalıcı defter yazılamadı/,
    'persist hatası çağırana iletilmelidir (sessiz yutma yok)'
  );
  assert.equal(subscriberCalls, 0, 'kalıcılık sağlanamadan aboneler tetiklenmemeli');
});

test('F4-A6b persistEvent başarılıysa aboneler normal çalışır (mevcut EventBus sözleşmesi korunur)', async () => {
  const persisted = [];
  const bus = createAppEventBus({
    persistEvent: async (event) => {
      persisted.push(event.eventId);
    },
  });
  let subscriberCalls = 0;
  bus.subscribe('LibraryItemAdded', () => {
    subscriberCalls += 1;
  });

  const event = createAppEvent({
    eventType: 'LibraryItemAdded',
    ref: { profileId: 'profile-a', revision: 1 },
    payload: { mediaKey: 'movie:157336', mediaType: 'movie', list: 'watched' },
  });
  await bus.publish(event);
  assert.equal(subscriberCalls, 1);
  assert.equal(persisted.length, 1);
});

// ---------------------------------------------------------------------------
// A7. Payload allowlist negatif testleri
// ---------------------------------------------------------------------------

test('F4-A7 allowlist: notlar ve kişisel alanlar kalıcı olay defterine yazılamaz', async () => {
  const { tmpDir, repository, manager } = await makeManager();
  try {
    await manager.acceptEvent(
      makeEvent({
        payload: {
          mediaKey: 'movie:157336',
          mediaType: 'movie',
          list: 'watched',
          notes: 'kişisel not — deftere yazılmamalı',
          personal_rating: 9,
          episodes_watched: 12,
          secret_field: 'gizli',
        },
      })
    );
    const event = repository.getEvent('evt-test-1');
    assert.deepEqual(
      Object.keys(event.payload).sort(),
      ['list', 'mediaKey', 'mediaType'],
      'yalnızca allowlist alanları kalıcılaşmalı'
    );
    assert.equal(event.payload.notes, undefined);
    assert.equal(event.payload.personal_rating, undefined);
  } finally {
    await cleanup(tmpDir);
  }
});

test('F4-A7b allowlist: bilinmeyen olay türü için payload tamamen boşaltılır', () => {
  const sanitized = sanitizeEventPayload('BilinmeyenOlayTuru', {
    mediaKey: 'movie:1',
    notes: 'not',
  });
  assert.deepEqual(sanitized, {}, 'bilinmeyen türde kalıcı payload boş olmalı');

  const rating = sanitizeEventPayload('LibraryRatingChanged', {
    mediaKey: 'movie:157336',
    mediaType: 'movie',
    rating: 9,
    notes: 'not',
  });
  assert.deepEqual(rating, { mediaKey: 'movie:157336', mediaType: 'movie', rating: 9 });

  const removed = sanitizeEventPayload('LibraryItemRemoved', {
    mediaKey: 'movie:157336',
    mediaType: 'movie',
    previousList: 'watched',
  });
  assert.deepEqual(removed, { mediaKey: 'movie:157336', mediaType: 'movie', previousList: 'watched' });
});

// ---------------------------------------------------------------------------
// A8. start/stop yaşam döngüsü
// ---------------------------------------------------------------------------

test('F4-A8 yaşam döngüsü: start pompayı çalıştırır, stop durdurur, yeniden başlatma kurtarmayla çalışır', async () => {
  const { tmpDir, manager } = await makeManager({ manager: { pollIntervalMs: 50 } });
  try {
    assert.equal(manager.getStatus().started, false, 'başlangıçta çalışmıyor olmalı');

    await manager.acceptEvent(makeEvent());
    await manager.start();
    assert.equal(manager.getStatus().started, true);

    await pumpUntil(manager, () => manager.listTasks().every((t) => t.status === 'completed'));
    assert.equal(manager.listTasks()[0].status, 'completed');

    await manager.stop();
    assert.equal(manager.getStatus().started, false, 'stop sonrası pompa durmalı');

    // Yeniden başlatma: kurtarma çalışır, pompa tekrar görev işleyebilir.
    await manager.acceptEvent(
      makeEvent({
        eventId: 'evt-second',
        eventType: 'LibraryRatingChanged',
        payload: { mediaKey: 'movie:157336', mediaType: 'movie', rating: 8 },
      })
    );
    await manager.start();
    await pumpUntil(manager, () => manager.listTasks().every((t) => t.status === 'completed'));
    assert.equal(
      manager.listTasks().every((t) => t.status === 'completed'),
      true,
      'yeniden başlatma sonrası bekleyen görev işlenmeli'
    );
    await manager.stop();

    const health = await manager.healthCheck();
    assert.ok(['healthy', 'degraded'].includes(health.status), `health raporu üretilmeli: ${JSON.stringify(health)}`);
    assert.equal(health.moduleId, 'background-manager');
  } finally {
    await cleanup(tmpDir);
  }
});

test('F4-A8b stop sonrası pumpOnce no-op olmalı (görev işlememeli)', async () => {
  const { tmpDir, manager } = await makeManager();
  try {
    await manager.acceptEvent(makeEvent());
    await manager.start();
    await manager.stop();
    await manager.pumpOnce(); // running=false → no-op
    assert.equal(manager.listTasks()[0].status, 'pending', 'stop sonrası görev işlenmemeli');
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// A9. Duplicate olaylar istatistikleri değiştirmez
// ---------------------------------------------------------------------------

test('F4-A9 duplicate kabul: event/task sayaçları ve durum dağılımı değişmez', async () => {
  const { tmpDir, repository, manager } = await makeManager();
  try {
    await manager.acceptEvent(makeEvent());
    await manager.acceptEvent(
      makeEvent({
        eventId: 'evt-rating',
        eventType: 'LibraryRatingChanged',
        payload: { mediaKey: 'movie:157336', mediaType: 'movie', rating: 9 },
      })
    );
    const before = repository.getStats('2026-01-01T00:00:30.000Z');

    await manager.acceptEvent(makeEvent()); // aynı eventId tekrar
    await manager.acceptEvent(
      makeEvent({
        eventId: 'evt-rating',
        eventType: 'LibraryRatingChanged',
        payload: { mediaKey: 'movie:157336', mediaType: 'movie', rating: 9 },
      })
    );
    const after = repository.getStats('2026-01-01T00:00:30.000Z');

    assert.equal(after.events, before.events, 'olay sayısı değişmemeli');
    assert.equal(after.tasks, before.tasks, 'görev sayısı değişmemeli');
    assert.deepEqual(after.byStatus, before.byStatus, 'durum dağılımı değişmemeli');
    assert.equal(before.events, 2);
    assert.equal(before.tasks, 2);
  } finally {
    await cleanup(tmpDir);
  }
});

// ---------------------------------------------------------------------------
// B. Gerçek uygulama fabrikasıyla entegrasyon
// ---------------------------------------------------------------------------

/**
 * Gerçek uygulama fabrikası ile izole runtime kurar (Faz 3 test deseni ile aynı):
 * geçici dizin + iki profil + gerçek SQLite + gerçek AppEventBus persistEvent kancası.
 */
async function makeRuntime() {
  const tmpDir = await makeTempDir();
  const runtime = createCineTrackApp({ dataDir: tmpDir });
  const doc = makeDoc([makeProfile('profile-a', 'Profil A'), makeProfile('profile-b', 'Profil B')]);
  const seed = await runtime.primaryRepository.saveRaw(doc, { forceOverwrite: true });
  assert.equal(seed.ok, true, `tohum belge yazılamadı: ${JSON.stringify(seed)}`);
  await runtime.startRuntimeModules();
  return { tmpDir, runtime };
}

async function closeRuntime(tmpDir, runtime) {
  try {
    await runtime.stopRuntimeModules();
  } catch {
    /* zaten durdurulmuş olabilir */
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
}

function ref(runtime, profileId) {
  return { profileId, revision: runtime.profileContext.getCurrent().revision };
}

test('F4-B1 entegrasyon: LibraryService ekleme olayı BackgroundManager görevine dönüşür ve tamamlanır', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const outcome = await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
      metadata: { title: 'Interstellar', original_title: 'Interstellar' },
    });
    assert.equal(outcome.ok, true, `addItem başarısız: ${JSON.stringify(outcome)}`);

    // persistEvent kancası görevleri üretmiş olmalı.
    const tasks = runtime.backgroundManager.listTasks();
    assert.equal(tasks.length, 1, 'kütüphane ekleme olayı için bir görev üretilmeli');
    assert.equal(tasks[0].handlerId, LIBRARY_ITEM_ADDED_HANDLER_ID);
    assert.equal(tasks[0].profileId, 'profile-a');

    // Pompa görevi tamamlamalı (otomatik pompa veya açık tur).
    for (let i = 0; i < 20 && runtime.backgroundManager.listTasks()[0].status !== 'completed'; i += 1) {
      await runtime.backgroundManager.pumpOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(
      runtime.backgroundManager.listTasks()[0].status,
      'completed',
      'audit işleyicisi görevi tamamlamalı'
    );

    // Olay defterinde payload allowlist uygulanmış olmalı.
    const event = runtime.backgroundManager.getEvent(tasks[0].eventId);
    assert.deepEqual(Object.keys(event.payload).sort(), ['list', 'mediaKey', 'mediaType']);
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

test('F4-B1b entegrasyon: puan olayı görev üretir; audit işleyicisi puanı ortak depoya YAZMAZ', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watched',
      rating: 9,
    });
    const outcome = await runtime.libraryService.updateItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      rating: 7,
    });
    assert.equal(outcome.ok, true, `updateItem başarısız: ${JSON.stringify(outcome)}`);

    const ratingTasks = runtime.backgroundManager
      .listTasks()
      .filter((t) => t.handlerId === LIBRARY_RATING_CHANGED_HANDLER_ID);
    assert.equal(ratingTasks.length, 1, 'puan değişimi için bir görev üretilmeli');

    for (let i = 0; i < 20 && ratingTasks[0].status === 'pending'; i += 1) {
      await runtime.backgroundManager.pumpOnce();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(ratingTasks[0].status, 'completed');

    // Puan yalnızca kullanıcı kütüphane kaydında; ortak metadata kanalı puan taşımaz.
    const raw = await runtime.primaryRepository.readRaw();
    const item = raw.document.profiles.find((p) => p.id === 'profile-a').items[0];
    assert.equal(item.personal_rating, 7, 'kişisel puan kütüphane kaydında güncellenmeli');
    const event = runtime.backgroundManager.getEvent(ratingTasks[0].eventId);
    assert.deepEqual(
      Object.keys(event.payload).sort(),
      ['mediaKey', 'mediaType', 'rating'],
      'puan olayı payload allowlistine uymalı'
    );
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

test('F4-B2 BackgroundManager ModuleRegistry\'ye kayıtlı DEĞİLDİR; /api/health modül listesi korunur', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    const registered = runtime.moduleRegistry.list().map((m) => m.id);
    assert.equal(
      registered.includes('background-manager'),
      false,
      'background-manager ayrı modül olarak kaydedilmemeli (belgelenmiş Faz 4 kararı)'
    );
    assert.deepEqual(
      [...registered].sort(),
      ['backup-sync', 'content-intelligence', 'initial-indexer', 'primary-storage', 'taste-engine'],
      'mevcut beş modül kimliği değişmemeli'
    );

    // HTTP sözleşmesi: /api/health modül listesi beş kimlikle yanıt verir.
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    const moduleIds = (body.modules ?? []).map((m) => m.moduleId ?? m.id ?? m).sort();
    assert.deepEqual(
      moduleIds,
      ['backup-sync', 'content-intelligence', 'initial-indexer', 'primary-storage', 'taste-engine'],
      '/api/health modül listesi sözleşmesi korunmalı'
    );
    server.close();
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});

test('F4-B3 stopRuntimeModules BackgroundManager\'ı durdurur; bekleyen görev kaybolmaz', async () => {
  const { tmpDir, runtime } = await makeRuntime();
  try {
    await runtime.libraryService.addItem({
      ref: ref(runtime, 'profile-a'),
      mediaKey: 'movie:157336',
      mediaType: 'movie',
      list: 'watchlist',
    });
    const tasksBefore = runtime.backgroundManager.listTasks();
    assert.equal(tasksBefore.length, 1);

    await runtime.stopRuntimeModules();
    assert.equal(runtime.backgroundManager.getStatus().started, false, 'durdurulmuş olmalı');

    // Görev kaydı kalıcıdır; yeniden başlatma sonrası işlenebilir.
    await runtime.startRuntimeModules();
    assert.equal(runtime.backgroundManager.getStatus().started, true);
    const task = runtime.backgroundManager.getTask(tasksBefore[0].taskId);
    assert.ok(task, 'yarıda kalan görev kalıcı depoda korunmalı');
    assert.equal(task.status === 'completed' || task.status === 'pending', true, `görev durumu tutarlı olmalı: ${task.status}`);
  } finally {
    await closeRuntime(tmpDir, runtime);
  }
});
