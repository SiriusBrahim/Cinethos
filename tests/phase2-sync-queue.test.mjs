import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SyncAbortedError,
  SyncOperationQueue,
  SyncQueueFullError,
  SyncQueueTimeoutError,
} from '../src/core/sync-operation-queue.ts';

function makeClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => new Date(Date.UTC(2026, 0, 1) + now).toISOString(),
    monotonicNow: () => now,
    setTimer(handler, ms) {
      const timer = { at: now + ms, handler, cancelled: false };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cancelled = true;
      timers.delete(timer);
    },
    advance(ms) {
      now += ms;
      for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
        if (timer.cancelled || timer.at > now) continue;
        timers.delete(timer);
        timer.handler();
      }
    },
  };
}

function makeQueue(clock, options = {}) {
  return new SyncOperationQueue({
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options,
  });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('B-10: kuyruk FIFO çalışır, isBusy bekleyen işi de görür ve durum geçişleri doğrudur', async () => {
  const clock = makeClock();
  const queue = makeQueue(clock);
  const order = [];
  let releaseFirst;
  const first = queue.enqueue('pull', async () => {
    order.push('pull:start');
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    order.push('pull:end');
    return 'pull-result';
  });
  const second = queue.enqueue('push', async () => {
    order.push('push:start');
    return 'push-result';
  });

  assert.equal(queue.isBusy(), true, 'bekleyen iş varken de meşgul sayılmalı');
  assert.equal(queue.getDepth(), 2);
  const queuedSnapshot = queue.getSnapshot();
  assert.equal(queuedSnapshot.state, 'queued');
  assert.equal(queuedSnapshot.queuedOperations.length, 2);

  await flush();
  const running = queue.getSnapshot();
  assert.equal(running.state, 'running');
  assert.equal(running.runningOperation, 'pull');
  assert.equal(running.queuedOperations.length, 1, 'çalışan iş dışında 1 bekleyen olmalı');
  assert.equal(running.depth, 2, 'depth çalışan + bekleyen toplamıdır');

  releaseFirst();
  assert.equal(await first, 'pull-result');
  assert.equal(await second, 'push-result');
  await flush();

  assert.deepEqual(order, ['pull:start', 'pull:end', 'push:start']);
  const idle = queue.getSnapshot();
  assert.equal(idle.state, 'idle');
  assert.equal(idle.depth, 0);
  assert.equal(idle.lastOutcome.status, 'succeeded');
  assert.equal(idle.totalSucceeded, 2);
});

test('B-38: aynı dedupeKey ile gelen ikinci istek yeni iş açmaz, aynı sonucu paylaşır', async () => {
  const clock = makeClock();
  const queue = makeQueue(clock);
  let runs = 0;
  const task = async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { ok: true };
  };
  const first = queue.enqueue('pull', task, { dedupeKey: 'pull:merge' });
  const second = queue.enqueue('pull', task, { dedupeKey: 'pull:merge' });
  assert.equal(first, second, 'aynı promise dönmeli');
  assert.deepEqual(await first, { ok: true });
  assert.equal(runs, 1, 'işlem yalnızca bir kez çalışmalı');
});

test('B-38: görev hata fırlatsa da kuyruk serbest kalır ve sonraki iş çalışır', async () => {
  const clock = makeClock();
  const queue = makeQueue(clock);
  const failed = queue.enqueue('pull', async () => {
    throw new Error('patladı');
  });
  const next = queue.enqueue('push', async () => 'tamam');

  await assert.rejects(failed, /patladı/);
  assert.equal(await next, 'tamam');
  const snapshot = queue.getSnapshot();
  assert.equal(snapshot.running, false);
  assert.equal(snapshot.totalFailed, 1);
  assert.equal(snapshot.totalSucceeded, 1);
});

test('B-10: kuyruk kapasitesi aşılırsa açık hata koduyla reddedilir', async () => {
  const clock = makeClock();
  const queue = makeQueue(clock, { maxDepth: 1 });
  let release;
  const first = queue.enqueue('pull', () => new Promise((resolve) => (release = resolve)));
  const overflow = queue.enqueue('push', async () => 'olmamalı');

  await assert.rejects(overflow, (error) => {
    assert.ok(error instanceof SyncQueueFullError);
    assert.equal(error.code, 'sync_queue_full');
    return true;
  });
  release('bitti');
  assert.equal(await first, 'bitti');
});

test('B-10: kuyrukta bekleme süresi aşılınca işlem iptal edilir, çalışan iş etkilenmez', async () => {
  const clock = makeClock();
  const queue = makeQueue(clock, { waitTimeoutMs: 100 });
  let release;
  const first = queue.enqueue('pull', () => new Promise((resolve) => (release = resolve)));
  const waiting = queue.enqueue('push', async () => 'geç kaldı', { waitTimeoutMs: 100 });

  await flush();
  clock.advance(100);
  await assert.rejects(waiting, (error) => {
    assert.ok(error instanceof SyncQueueTimeoutError);
    assert.equal(error.code, 'sync_queue_timeout');
    return true;
  });
  assert.equal(queue.getSnapshot().running, true, 'çalışan iş iptal edilmemeli');
  release('tamam');
  assert.equal(await first, 'tamam');
  assert.equal(queue.getSnapshot().totalCancelled, 1);
});

test('Kesinti: kuyrukta bekleyen işlem abort ile kuyruktan çıkar ve çalışmaz', async () => {
  const clock = makeClock();
  const queue = makeQueue(clock);
  let release;
  const first = queue.enqueue('pull', () => new Promise((resolve) => (release = resolve)));
  const controller = new AbortController();
  let ran = false;
  const aborted = queue.enqueue(
    'push',
    async () => {
      ran = true;
    },
    { signal: controller.signal }
  );

  controller.abort();
  await assert.rejects(aborted, (error) => error instanceof SyncAbortedError);
  assert.equal(ran, false, 'iptal edilen iş çalışmamalı');
  release('bitti');
  assert.equal(await first, 'bitti');
});

test('Deadlock yok: eşzamanlı çok sayıda iş sırayla ve eksiksiz tamamlanır', async () => {
  const clock = makeClock();
  const queue = makeQueue(clock, { maxDepth: 10 });
  const completed = [];
  const promises = Array.from({ length: 6 }, (_, index) =>
    queue.enqueue(`op-${index}`, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      completed.push(index);
      return index;
    })
  );
  assert.deepEqual(await Promise.all(promises), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(completed, [0, 1, 2, 3, 4, 5], 'FIFO sırası korunmalı');
  assert.equal(queue.isBusy(), false);
});

test('Kurtarma: önceki süreçten kalan yarım işlem sayısı raporlanır', () => {
  const clock = makeClock();
  const queue = makeQueue(clock);
  queue.markRecoveredInterrupted(2);
  assert.equal(queue.getSnapshot().recoveredInterrupted, 2);
  assert.equal(queue.isBusy(), false, 'kurtarma yeni iş başlatmaz');
});
