import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeHttpRetryDelayMs,
  fetchWithHttpRetry,
  HTTP_RETRY_DEFAULTS,
  isRetryableHttpStatus,
} from '../src/services/http-retry.ts';

const BASE_NOW = 1_700_000_000_000;

function response(status, headers = {}) {
  return new Response(status === 204 ? null : '{}', { status, headers });
}

function harness(responses, options = {}) {
  const calls = [];
  const sleeps = [];
  return {
    calls,
    sleeps,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    options: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => BASE_NOW,
      random: () => 0,
      ...options,
    },
  };
}

test('B-30: 408/429/5xx/rate-limit 403 geçici; 400/401/403/404/409 kalıcı', () => {
  assert.equal(isRetryableHttpStatus(408), true);
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(400), false);
  assert.equal(isRetryableHttpStatus(401), false);
  assert.equal(isRetryableHttpStatus(404), false);
  assert.equal(isRetryableHttpStatus(409), false);
  assert.equal(isRetryableHttpStatus(403, new Headers({ 'x-ratelimit-remaining': '0' })), true);
  assert.equal(isRetryableHttpStatus(403, new Headers({ 'x-ratelimit-remaining': '9' })), false);
});

test('B-30: Retry-After ve X-RateLimit-Reset kırpılmadan ama üst sınırla uygulanır', () => {
  orEq(
    computeHttpRetryDelayMs(1, response(429, { 'retry-after': '2' }), { now: () => BASE_NOW }),
    2_000
  );
  orEq(
    computeHttpRetryDelayMs(1, response(429, { 'retry-after': '120' }), { now: () => BASE_NOW }),
    HTTP_RETRY_DEFAULTS.maxRetryAfterMs
  );
  orEq(
    computeHttpRetryDelayMs(
      1,
      response(429, { 'retry-after': new Date(BASE_NOW + 4_000).toUTCString() }),
      { now: () => BASE_NOW }
    ),
    4_000
  );
  orEq(
    computeHttpRetryDelayMs(
      1,
      response(403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(BASE_NOW / 1000) + 3),
      }),
      { now: () => BASE_NOW }
    ),
    3_000
  );
});

function orEq(actual, expected) {
  assert.equal(actual, expected);
}

test('B-30: üstel backoff + jitter ve üst sınır', () => {
  const noJitter = { random: () => 0, baseDelayMs: 500, maxDelayMs: 8_000 };
  assert.equal(computeHttpRetryDelayMs(1, null, noJitter), 500);
  assert.equal(computeHttpRetryDelayMs(2, null, noJitter), 1_000);
  assert.equal(computeHttpRetryDelayMs(3, null, noJitter), 2_000);
  assert.equal(computeHttpRetryDelayMs(10, null, noJitter), 8_000);

  const jittered = computeHttpRetryDelayMs(1, null, { baseDelayMs: 500, jitterMs: 200, random: () => 0.5 });
  assert.equal(jittered, 600);
});

test('B-30: 429 sonrası başarılı yanıt döner ve bekleme kaydedilir', async () => {
  const h = harness([
    response(429, { 'retry-after': '2' }),
    response(200),
  ]);
  const result = await fetchWithHttpRetry('https://example.test/api', {}, {
    ...h.options,
    fetchImpl: h.fetchImpl,
  });
  assert.equal(result.status, 200);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.sleeps, [2_000]);
});

test('B-30: kalıcı 4xx yeniden denenmez, geçici 5xx sınırlı denemeden sonra son yanıtı döner', async () => {
  const notFound = harness([response(404)]);
  const res404 = await fetchWithHttpRetry('https://example.test/api', {}, {
    ...notFound.options,
    fetchImpl: notFound.fetchImpl,
  });
  assert.equal(res404.status, 404);
  assert.equal(notFound.calls.length, 1);

  const failing = harness([response(503)]);
  const res503 = await fetchWithHttpRetry('https://example.test/api', {}, {
    ...failing.options,
    fetchImpl: failing.fetchImpl,
    maxAttempts: 3,
  });
  assert.equal(res503.status, 503);
  assert.equal(failing.calls.length, 3, 'en fazla maxAttempts deneme');
});

test('B-30: POST gibi tekrarlanamaz istekler asla yeniden denenmez', async () => {
  const h = harness([response(503), response(200)]);
  const res = await fetchWithHttpRetry(
    'https://example.test/api',
    { method: 'POST' },
    { ...h.options, fetchImpl: h.fetchImpl }
  );
  assert.equal(res.status, 503);
  assert.equal(h.calls.length, 1, 'çift yazma riski yok');
});

test('B-30: ağ hatası sınırlı denenir, son hata fırlatılır', async () => {
  const h = harness([new TypeError('fetch failed'), new TypeError('fetch failed')]);
  await assert.rejects(
    fetchWithHttpRetry('https://example.test/api', {}, {
      ...h.options,
      fetchImpl: h.fetchImpl,
      maxAttempts: 2,
    }),
    /fetch failed/
  );
  assert.equal(h.calls.length, 2);
  assert.equal(h.sleeps.length, 1);
});

test('B-30: abort edilen istek yeniden denenmez', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness([response(200)]);
  await assert.rejects(
    fetchWithHttpRetry('https://example.test/api', {}, { ...h.options, fetchImpl: h.fetchImpl, signal: controller.signal }),
    (error) => error.name === 'AbortError'
  );
  assert.equal(h.calls.length, 0);
});
