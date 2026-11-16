/**
 * P1-01: Sinema KünYESİ API çağrıları `null` yerine ayrıştırılmış sonuç döner.
 * Beklenen çevrimdışı durumu ile gerçek sunucu arızası ayrı sınıflandırılmalı.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchServerCinemaKunye,
  saveServerCinemaKunye,
} from '../src/services/api.ts';
import { createEmptyCinemaKunyeDocument } from '../src/core/cinema-kunye.ts';

const originalFetch = globalThis.fetch;

function stubFetch(impl) {
  globalThis.fetch = impl;
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('P1-01: ağ kesintisi "offline" olarak sınıflanır (arıza sayılmaz)', async () => {
  stubFetch(async () => {
    throw new TypeError('fetch failed');
  });
  const result = await fetchServerCinemaKunye();
  assert.equal(result.status, 'offline');
  assert.equal(result.document, undefined);
});

test('P1-01: 409 çakışma kodu ve mesajı korunur', async () => {
  stubFetch(async () =>
    jsonResponse(409, { error: 'Sürüm çakıştı', code: 'revision_conflict' })
  );
  const result = await saveServerCinemaKunye(createEmptyCinemaKunyeDocument(), 'merge');
  assert.equal(result.status, 'conflict');
  assert.equal(result.code, 'revision_conflict');
  assert.equal(result.message, 'Sürüm çakıştı');
});

test('P1-01: 401/503 oturum hataları auth olarak ayrılır', async () => {
  stubFetch(async () => jsonResponse(401, { error: 'Yetkisiz', code: 'auth_required' }));
  const result = await fetchServerCinemaKunye();
  assert.equal(result.status, 'auth');
  assert.equal(result.code, 'auth_required');
});

test('P1-01: 5xx sunucu hatası "server" olarak raporlanır', async () => {
  stubFetch(async () => jsonResponse(500, { error: 'Beklenmeyen sunucu hatası' }));
  const result = await saveServerCinemaKunye(createEmptyCinemaKunyeDocument(), 'overwrite');
  assert.equal(result.status, 'server');
  assert.equal(result.document, undefined);
});

test('P1-01: geçersiz gövde sessiz başarıya dönüşmez', async () => {
  stubFetch(async () => jsonResponse(200, { cinemaKunye: 'bozuk' }));
  const result = await fetchServerCinemaKunye();
  assert.equal(result.status, 'validation');
  assert.equal(result.document, undefined);
});

test('P1-01: başarılı yanıt normalize edilmiş belgeyle döner', async () => {
  stubFetch(async () =>
    jsonResponse(200, {
      cinemaKunye: {
        version: 1,
        updatedAt: '2026-01-01T00:00:00.000Z',
        entries: {
          'film-2020': { entries: { watched: true } },
        },
      },
    })
  );
  const result = await fetchServerCinemaKunye();
  assert.equal(result.status, 'ok');
  assert.ok(result.document);
  assert.equal(typeof result.document.entries, 'object');
});

test('P1-01: fetch sırasındaki her hata sessiz başarıya dönüşmez', async () => {
  // `apiFetch` ağ hatalarını ApiError(0) olarak sarar; sözleşme gereği bu "offline"dır,
  // ancak sonuç asla "ok" olmamalı ve kullanıcıya raporlanabilir bir mesaj taşımalı.
  stubFetch(async () => {
    throw new Error('beklenmeyen taşıma hatası');
  });
  const result = await saveServerCinemaKunye(createEmptyCinemaKunyeDocument(), 'merge');
  assert.notEqual(result.status, 'ok');
  assert.equal(result.status, 'offline');
  assert.equal(result.document, undefined);
  assert.ok(result.message && result.message.length > 0);
});
