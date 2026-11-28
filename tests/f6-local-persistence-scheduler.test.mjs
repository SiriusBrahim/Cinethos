/**
 * Aşama 6 / B-21 — Yerel kalıcılık davranış testleri.
 *
 * Gerçek üretim modülleri (`StorageWriteScheduler`, `applyLocalStoragePlan`)
 * geçici bir bellek deposuyla çalıştırılır. Kapsam: hızlı ardışık güncelleme
 * birleştirme, son güncellemenin kazanması, gizlenme/kapanma flush'ı, kota
 * hatasında kırpma yapılmaması, yeniden açılışta verinin korunması.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyLocalStoragePlan,
  buildLocalStoragePlan,
} from '../src/app/persistence/persistence-plan.ts';
import { StorageWriteScheduler } from '../src/app/persistence/local-write-scheduler.ts';
import { listStorageKey } from '../src/app/profile-storage.ts';

const PREFERENCES = { disliked: [], providers: [], mood: '', reminders: false, notified: [] };

function savedItem(id, overview = 'kısa açıklama') {
  return {
    id,
    media_type: 'movie',
    title: `Film ${id}`,
    overview,
    status: 'watchlist',
    addedAt: '2026-01-01T00:00:00.000Z',
  };
}

function snapshotWith(savedItems) {
  return {
    profiles: [
      {
        id: 'profile-a',
        name: 'A',
        createdAt: '2026-01-01T00:00:00.000Z',
        preferences: PREFERENCES,
        items: savedItems,
      },
    ],
    activeProfileId: 'profile-a',
    profileName: 'A',
    preferences: PREFERENCES,
    favoriteActors: [],
    deletedKeys: {},
    savedItems,
  };
}

function memoryStorage(initial = {}, options = {}) {
  const data = new Map(Object.entries(initial));
  const failWhen = options.failWhen || (() => false);
  return {
    data,
    setItemCalls: 0,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      this.setItemCalls += 1;
      if (failWhen(key, value)) throw new Error('QuotaExceededError');
      data.set(key, value);
    },
  };
}

function fakeTimers() {
  let queue = [];
  return {
    setTimer(fn, delayMs) {
      const handle = { fn, delayMs };
      queue.push(handle);
      return handle;
    },
    clearTimer(handle) {
      queue = queue.filter((entry) => entry !== handle);
    },
    tick() {
      const ready = queue;
      queue = [];
      for (const entry of ready) entry.fn();
    },
    pendingCount() {
      return queue.length;
    },
  };
}

function makeScheduler(storage, timers, onResult) {
  return new StorageWriteScheduler({
    storage,
    delayMs: 250,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onResult,
  });
}

test('B-21 ilk yazma hemen uygulanır, ardışık 50 güncelleme tek yazımda birleşir', () => {
  const storage = memoryStorage();
  const timers = fakeTimers();
  const scheduler = makeScheduler(storage, timers);

  scheduler.request(snapshotWith([savedItem(1)]));
  assert.equal(scheduler.writeCount, 1, 'hidrasyon yazımı beklemeden uygulanmalı');
  assert.equal(storage.getItem(listStorageKey('profile-a')).includes('Film 1'), true);

  for (let i = 0; i < 50; i += 1) {
    scheduler.request(snapshotWith([savedItem(1), savedItem(2 + i)]));
  }
  assert.equal(scheduler.writeCount, 1, 'hızlı güncellemeler yazılmadan birleşmeli');
  assert.equal(timers.pendingCount(), 1);

  timers.tick();
  assert.equal(scheduler.writeCount, 2, 'tek bir gecikmeli yazım yapılmalı');

  const stored = JSON.parse(storage.getItem(listStorageKey('profile-a')));
  assert.deepEqual(
    stored.map((item) => item.id),
    [1, 51],
    'en son anlık görüntü yazılmalı (sıra korunur)'
  );
});

test('B-21 kota hatası: veri kırpılmaz, silinmez ve hata çağırana bildirilir', () => {
  const key = listStorageKey('profile-a');
  const longOverview = 'x'.repeat(500);
  const previous = JSON.stringify([savedItem(1)]);
  const storage = memoryStorage({ [key]: previous }, {
    failWhen: (writeKey) => writeKey === key,
  });
  const timers = fakeTimers();
  const results = [];
  const scheduler = makeScheduler(storage, timers, (result) => results.push(result));

  scheduler.request(snapshotWith([savedItem(2, longOverview)]));

  assert.equal(storage.getItem(key), previous, 'eski değer korunmalı');
  assert.equal(results.length, 1);
  assert.ok(results[0].failed.some((failure) => failure.key === key), 'hata raporlanmalı');
  assert.deepEqual(results[0].compacted, [], 'kırpılmış yedek yazımı olmamalı');
  assert.equal(storage.getItem(key).includes('x'.repeat(120)), false, 'kırpılmış veri yazılmamalı');
});

test('B-21 yeniden başarılı yazım hatayı temizler ve tam veriyi korur', () => {
  const key = listStorageKey('profile-a');
  let quotaFull = true;
  const storage = memoryStorage({}, { failWhen: (writeKey) => writeKey === key && quotaFull });
  const timers = fakeTimers();
  const failures = [];
  const successes = [];
  const scheduler = new StorageWriteScheduler({
    storage,
    delayMs: 250,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onResult: (result) => {
      if (result.failed.length > 0) failures.push(result.failed.length);
      else successes.push(1);
    },
  });

  const longOverview = 'y'.repeat(400);
  scheduler.request(snapshotWith([savedItem(5, longOverview)]));
  assert.equal(failures.length, 1);

  quotaFull = false;
  scheduler.request(snapshotWith([savedItem(5, longOverview)]));
  timers.tick();

  assert.equal(successes.length, 1, 'yeniden deneme başarılı olmalı');
  const stored = JSON.parse(storage.getItem(key));
  assert.equal(stored[0].overview.length, 400, 'açıklama kırpılmadan yazılmalı');
});

test('B-21 sekme gizlenirken/kapanırken bekleyen yazım flush edilir', () => {
  const storage = memoryStorage();
  const timers = fakeTimers();
  const scheduler = makeScheduler(storage, timers);

  scheduler.request(snapshotWith([savedItem(1)]));
  scheduler.request(snapshotWith([savedItem(1), savedItem(2)]));
  assert.equal(timers.pendingCount(), 1, 'yazım beklemede olmalı');

  scheduler.flush();
  assert.equal(timers.pendingCount(), 0, 'zamanlayıcı iptal edilmeli');
  assert.deepEqual(
    JSON.parse(storage.getItem(listStorageKey('profile-a'))).map((item) => item.id),
    [1, 2]
  );

  timers.tick();
  assert.equal(scheduler.writeCount, 2, 'flush sonrası ikinci yazım oluşmamalı');
});

test('B-21 yazım sırasında gelen güncelleme kaybolmaz, sonraki yazımda uygulanır', () => {
  const storage = memoryStorage();
  const timers = fakeTimers();
  let injected = false;
  const scheduler = new StorageWriteScheduler({
    storage,
    delayMs: 250,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    onResult: () => {
      if (injected) return;
      injected = true;
      // Yazım tamamlanırken yeni bir kullanıcı güncellemesi gelir.
      scheduler.request(snapshotWith([savedItem(1), savedItem(2), savedItem(3)]));
    },
  });

  scheduler.request(snapshotWith([savedItem(1)]));
  scheduler.flush();

  const stored = JSON.parse(storage.getItem(listStorageKey('profile-a')));
  assert.deepEqual(stored.map((item) => item.id), [1, 2, 3], 'son güncelleme de yazılmalı');
});

test('B-21 aynı veri tekrar yazılmaz (gereksiz maliyet yok)', () => {
  const storage = memoryStorage();
  const timers = fakeTimers();
  const scheduler = makeScheduler(storage, timers);

  const snapshot = snapshotWith([savedItem(1)]);
  scheduler.request(snapshot);
  const callsAfterFirst = storage.setItemCalls;

  scheduler.request(snapshot);
  timers.tick();
  assert.equal(
    storage.setItemCalls,
    callsAfterFirst,
    'değişmeyen anlık görüntü yeniden yazılmamalı'
  );
});

test('B-21 plan doğrudan uygulandığında da tam veri yazılır (yeniden açılış senaryosu)', () => {
  const storage = memoryStorage();
  const items = [savedItem(1, 'z'.repeat(1000)), savedItem(2)];
  const result = applyLocalStoragePlan(storage, buildLocalStoragePlan(snapshotWith(items)));

  assert.equal(result.failed.length, 0);
  const stored = JSON.parse(storage.getItem(listStorageKey('profile-a')));
  assert.equal(stored.length, 2);
  assert.equal(stored[0].overview.length, 1000, 'yeniden açılışta veri kaybı olmamalı');
});
