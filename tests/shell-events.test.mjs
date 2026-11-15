/**
 * M1 — shell-events birim testleri.
 *
 * Tipli kabuk olay yolunun sözleşmesini doğrular:
 * dinleyici yok no-op, abonelik/iptal, hata izolasyonu ve test sıfırlama.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { emitShellEvent, subscribeShellEvent, resetShellEventsForTests } = await import(
  '../src/app/shell-events.ts'
);

test('dinleyici yokken yayın sessizce no-op olur (fırlatmaz)', () => {
  resetShellEventsForTests();
  assert.doesNotThrow(() => {
    emitShellEvent('item:saved', { key: 'movie:550' });
    emitShellEvent('profile:changed', { profileId: 'p1' });
  });
});

test('abone, yayınlanan payloadı tam olarak alır', () => {
  resetShellEventsForTests();
  const received = [];
  subscribeShellEvent('item:disliked', (payload) => received.push(payload));
  emitShellEvent('item:disliked', { key: 'tv:1399', disliked: true });
  emitShellEvent('item:disliked', { key: 'tv:1399', disliked: false });
  assert.deepEqual(received, [
    { key: 'tv:1399', disliked: true },
    { key: 'tv:1399', disliked: false },
  ]);
  resetShellEventsForTests();
});

test('abonelik iptali teslimatı durdurur', () => {
  resetShellEventsForTests();
  const received = [];
  const unsubscribe = subscribeShellEvent('sync:completed', (p) => received.push(p));
  emitShellEvent('sync:completed', { uploaded: 1, downloaded: 2, merged: 3 });
  unsubscribe();
  emitShellEvent('sync:completed', { uploaded: 9, downloaded: 9, merged: 9 });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { uploaded: 1, downloaded: 2, merged: 3 });
  resetShellEventsForTests();
});

test('hata fırlatan dinleyici diğer dinleyicileri bozmaz', () => {
  resetShellEventsForTests();
  const received = [];
  const originalWarn = console.warn;
  console.warn = () => {}; // tekrarlı uyarı gürültüsünü bastır
  try {
    subscribeShellEvent('item:saved', () => {
      throw new Error('kasıtlı test hatası');
    });
    subscribeShellEvent('item:saved', (p) => received.push(p));
    assert.doesNotThrow(() => emitShellEvent('item:saved', { key: 'movie:27205' }));
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(received, [{ key: 'movie:27205' }]);
  resetShellEventsForTests();
});

test('resetShellEventsForTests tüm dinleyicileri temizler', () => {
  const received = [];
  subscribeShellEvent('profile:changed', (p) => received.push(p));
  resetShellEventsForTests();
  emitShellEvent('profile:changed', { profileId: 'p2' });
  assert.equal(received.length, 0);
});
