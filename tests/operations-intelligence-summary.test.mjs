import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContentIntelligenceSummary } from '../src/services/operations-api.ts';

test('içerik zekâsı özeti stale, sayaç ve kuyruk alanlarını doğrular', () => {
  const summary = normalizeContentIntelligenceSummary({
    ok: true,
    started: true,
    stale: 12,
    counts: { total: 500, completed: 450, failed: 7, pending: 3, processing: 1, skipped: 2 },
    queue: { pending: 3, processing: 1, completed: 440, failed: 2 },
  });
  assert.ok(summary);
  assert.equal(summary.stale, 12);
  assert.equal(summary.completed, 450);
  assert.equal(summary.failed, 7);
  assert.equal(summary.queue.failed, 2);
});

test('geçersiz veya hatalı yanıt kabul edilmez', () => {
  assert.equal(normalizeContentIntelligenceSummary(null), null);
  assert.equal(normalizeContentIntelligenceSummary({ ok: false }), null);
  assert.equal(normalizeContentIntelligenceSummary('x'), null);
});

test('eksik alanlar sıfıra düşer, negatifler yok sayılır', () => {
  const summary = normalizeContentIntelligenceSummary({ ok: true, stale: -4 });
  assert.ok(summary);
  assert.equal(summary.stale, 0);
  assert.equal(summary.completed, 0);
  assert.equal(summary.queue.pending, 0);
});
