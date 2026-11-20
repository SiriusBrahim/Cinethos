import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeGitHubRetryDelayMs,
  githubFetch,
  isRetryableGitHubStatus,
} from '../src/server/github-request.ts';

const BASE_NOW = 1_700_000_000_000;

function harness(responses, options = {}) {
  const calls = [];
  const sleeps = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return {
    calls,
    sleeps,
    restore() {
      globalThis.fetch = originalFetch;
    },
    retryOptions: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
      now: () => BASE_NOW,
      ...options,
    },
  };
}

function jsonResponse(status, body = '{}', headers = {}) {
  return new Response(body, { status, headers });
}

test('Retry sınıflandırması: 429/5xx/rate-limit 403 tekrar denenir, 401/404/409 denenmez', () => {
  assert.equal(isRetryableGitHubStatus(429), true);
  assert.equal(isRetryableGitHubStatus(503), true);
  assert.equal(isRetryableGitHubStatus(408), true);
  const rateLimited = new Headers({ 'x-ratelimit-remaining': '0' });
  assert.equal(isRetryableGitHubStatus(403, rateLimited), true);
  assert.equal(isRetryableGitHubStatus(403, new Headers({ 'x-ratelimit-remaining': '42' })), false);
  assert.equal(isRetryableGitHubStatus(401), false);
  assert.equal(isRetryableGitHubStatus(404), false);
  assert.equal(isRetryableGitHubStatus(409), false);
});

test('Retry-After saniye ve tarih biçimleri ile rate limit reset dikkate alınır', () => {
  const retryAfterSeconds = new Response('', { status: 429, headers: { 'retry-after': '3' } });
  assert.equal(computeGitHubRetryDelayMs(1, retryAfterSeconds, { now: () => BASE_NOW }), 3000);

  const longRetryAfter = new Response('', { status: 429, headers: { 'retry-after': '30' } });
  assert.equal(
    computeGitHubRetryDelayMs(1, longRetryAfter, { now: () => BASE_NOW }),
    30_000,
    'sunucunun 8 saniyeden uzun Retry-After talimatı kırpılmamalı'
  );

  const retryAfterDate = new Response('', {
    status: 429,
    headers: { 'retry-after': new Date(BASE_NOW + 5000).toUTCString() },
  });
  assert.equal(computeGitHubRetryDelayMs(1, retryAfterDate, { now: () => BASE_NOW }), 5000);

  const reset = new Response('', {
    status: 403,
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(BASE_NOW / 1000) + 2),
    },
  });
  assert.equal(computeGitHubRetryDelayMs(1, reset, { now: () => BASE_NOW }), 2000);

  const longReset = new Response('', {
    status: 403,
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(BASE_NOW / 1000) + 45),
    },
  });
  assert.equal(
    computeGitHubRetryDelayMs(1, longReset, { now: () => BASE_NOW }),
    45_000,
    'X-RateLimit-Reset sunucu süresi kırpılmamalı'
  );

  const exponential = [1, 2, 3].map((attempt) =>
    computeGitHubRetryDelayMs(attempt, null, { random: () => 0, now: () => BASE_NOW })
  );
  assert.deepEqual(exponential, [400, 800, 1600], 'exponential backoff');
});

test('Faz 3 · 9 — Ağ hatasında kontrollü yeniden deneme ve idempotent gövde', async () => {
  const env = harness(
    [new Error('ECONNRESET'), new Error('ETIMEDOUT'), jsonResponse(200, '{"ok":true}')],
    { maxAttempts: 4 }
  );
  try {
    const body = JSON.stringify({ same: 'payload' });
    const response = await githubFetch(
      'https://api.github.com/repos/o/r/contents/data/cinetrack-data.json',
      { method: 'PUT', body },
      env.retryOptions
    );
    assert.equal(response.status, 200);
    assert.equal(env.calls.length, 3, 'iki hata + bir başarı');
    assert.deepEqual(env.sleeps, [400, 800], 'artan bekleme');
    for (const call of env.calls) {
      assert.equal(call.init.body, body, 'yeniden denemeler aynı (idempotent) gövdeyi göndermeli');
    }
  } finally {
    env.restore();
  }
});

test('Faz 3 · 9 — Rate limit yanıtı Retry-After ile beklenip tamamlanır', async () => {
  const env = harness(
    [
      jsonResponse(429, '{"message":"secondary rate limit"}', { 'retry-after': '2' }),
      jsonResponse(200, '{"ok":true}'),
    ],
    { maxAttempts: 3 }
  );
  try {
    const response = await githubFetch('https://api.github.com/rate', {}, env.retryOptions);
    assert.equal(response.status, 200);
    assert.deepEqual(env.sleeps, [2000]);
  } finally {
    env.restore();
  }
});

test('Faz 3 · 10 — Yarım kalan işlem kaldığı yerden sürer; kalıcı hata raporlanır', async () => {
  const env = harness([jsonResponse(500, 'boom'), jsonResponse(200, '{"ok":true}')], {
    maxAttempts: 3,
  });
  try {
    const response = await githubFetch('https://api.github.com/blob', {}, env.retryOptions);
    assert.equal(response.status, 200);
    assert.equal(env.calls.length, 2);
  } finally {
    env.restore();
  }

  const failing = harness([jsonResponse(503, 'down')], { maxAttempts: 3 });
  try {
    const response = await githubFetch('https://api.github.com/blob', {}, failing.retryOptions);
    assert.equal(response.status, 503, 'denemeler tükenince son yanıt raporlanır (veri ezilmez)');
    assert.equal(failing.calls.length, 3);
    assert.deepEqual(failing.sleeps, [400, 800]);
  } finally {
    failing.restore();
  }
});

test('Faz 3 · 10 — Kalıcı 404 tekrar denenmez', async () => {
  const env = harness([jsonResponse(404, '{"message":"Not Found"}')], { maxAttempts: 4 });
  try {
    const response = await githubFetch('https://api.github.com/missing', {}, env.retryOptions);
    assert.equal(response.status, 404);
    assert.equal(env.calls.length, 1);
    assert.deepEqual(env.sleeps, []);
  } finally {
    env.restore();
  }
});
