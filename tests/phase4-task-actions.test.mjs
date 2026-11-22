import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_STATUS_HUMAN,
  describeTaskFailure,
  explainTaskActionError,
  getTaskActionAvailability,
} from '../src/modules/operations/task-actions.ts';

function task(status, overrides = {}) {
  return {
    taskId: 't1',
    eventId: 'e1',
    handlerId: 'library-item-added-audit',
    profileId: 'p1',
    status,
    attempts: 1,
    maxAttempts: 3,
    nextRetryAt: null,
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-05-01T09:01:00.000Z',
    completedAt: null,
    lastError: null,
    ...overrides,
  };
}

test('retry yalnızca sunucunun kabul ettiği durumlarda etkin', () => {
  for (const status of ['failed', 'cancelled', 'retry_wait', 'completed']) {
    const availability = getTaskActionAvailability(task(status));
    assert.equal(availability.retry, true, `${status} yeniden denenebilmeli`);
    assert.equal(availability.retryReason, null);
  }
});

test('çalışan ve bekleyen görev için retry gerekçesiyle devre dışı', () => {
  const processing = getTaskActionAvailability(task('processing'));
  assert.equal(processing.retry, false);
  assert.match(processing.retryReason, /çalışıyor/);

  const pending = getTaskActionAvailability(task('pending'));
  assert.equal(pending.retry, false);
  assert.match(pending.retryReason, /kuyrukta/);
});

test('iptal tamamlanmış/iptal edilmiş görevde kapalı', () => {
  assert.equal(getTaskActionAvailability(task('completed')).cancel, false);
  assert.match(getTaskActionAvailability(task('completed')).cancelReason, /Tamamlanmış/);
  assert.equal(getTaskActionAvailability(task('cancelled')).cancel, false);
  assert.equal(getTaskActionAvailability(task('pending')).cancel, true);
  assert.equal(getTaskActionAvailability(task('processing')).cancel, true);
});

test('uçuşta istek veya kalıcı hata her iki eylemi kapatır ve neden açıklar', () => {
  const busy = getTaskActionAvailability(task('failed'), { busy: true });
  assert.equal(busy.retry, false);
  assert.equal(busy.cancel, false);
  assert.match(busy.retryReason, /istek sürüyor/);

  const blocked = getTaskActionAvailability(task('failed'), { blocked: true });
  assert.equal(blocked.retry, false);
  assert.match(blocked.retryReason, /reddetti/);
});

test('409 yanıtı kullanıcı diline çevrilir ve kalıcı sayılır', () => {
  const explanation = explainTaskActionError({
    message: 'Bu görev yeniden denenebilir durumda değil.',
    code: 'task_not_retryable',
    status: 409,
  });
  assert.equal(explanation.permanent, true);
  assert.match(explanation.message, /yeniden denenebilir durumda değil/);
  assert.match(explanation.technical, /HTTP 409/);
  assert.match(explanation.technical, /task_not_retryable/);
});

test('ağ/5xx hatası geçici sayılır ve mesaj korunur', () => {
  const explanation = explainTaskActionError(new Error('Ağ hatası'));
  assert.equal(explanation.permanent, false);
  assert.equal(explanation.message, 'Ağ hatası');
});

test('uzun son hata mesajı kısaltılır, teknik metin korunur', () => {
  const long = `Error: ${'a'.repeat(400)}`;
  const failure = describeTaskFailure(long);
  assert.ok(failure.summary.length <= 141);
  assert.ok(!failure.summary.startsWith('Error:'));
  assert.equal(failure.technical, long);
  assert.deepEqual(describeTaskFailure(null), { summary: '', technical: null });
});

test('her durum için Türkçe etiket tanımlı', () => {
  for (const status of ['pending', 'processing', 'completed', 'retry_wait', 'failed', 'cancelled']) {
    assert.equal(typeof TASK_STATUS_HUMAN[status], 'string');
    assert.ok(TASK_STATUS_HUMAN[status].length > 0);
  }
});
