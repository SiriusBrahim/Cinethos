/**
 * Aşama 5.2 — F5.2-04 kabul testleri.
 *
 * Koordinatörden ayrılan uzak taraf incelemesi doğrudan test edilir. Ağ
 * çağrıları `globalThis.fetch` stub'ı ile karşılanır; kilit/journal davranışı
 * bu modülde yer almadığı için testler hızlı ve yalıtılmıştır.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchRemoteFileRaw,
  inspectRemoteSide,
} from '../src/server/github-sync/inspect-operation.ts';

const CFG = { token: 't', owner: 'o', repo: 'r', branch: 'main' };

function host(overrides = {}) {
  return {
    deps: {},
    maxBytes: 1_000_000,
    fetchGitBlobBySha: async () => ({ ok: false, error: { category: 'unknown', message: 'yok' } }),
    ...overrides,
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('F5.2-04 fetchRemoteFileRaw: 404 var olmayan dosya olarak raporlanır', async () => {
  const result = await withFetch(
    async () => jsonResponse({ message: 'Not Found' }, 404),
    () => fetchRemoteFileRaw(host(), 'data/catalog/movies.json', CFG)
  );
  assert.deepEqual(result, { ok: true, exists: false });
});

test('F5.2-04 fetchRemoteFileRaw: base64 içerik çözülür', async () => {
  const content = Buffer.from('{"movie:1":{}}', 'utf8').toString('base64');
  const result = await withFetch(
    async () =>
      jsonResponse({ sha: 'sha-1', content, encoding: 'base64', size: content.length }),
    () => fetchRemoteFileRaw(host(), 'data/catalog/movies.json', CFG)
  );
  assert.equal(result.ok, true);
  assert.equal(result.exists, true);
  assert.equal(result.content, '{"movie:1":{}}');
  assert.equal(result.sha, 'sha-1');
});

test('F5.2-04 fetchRemoteFileRaw: too_large yanıtında blob API üzerinden okunur', async () => {
  const calls = [];
  const result = await withFetch(
    async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/contents/data/catalog/movies.json')) {
        return jsonResponse({ message: 'too large', errors: [{ code: 'too_large' }] }, 403);
      }
      if (url.includes('/contents/data/catalog?ref=')) {
        return jsonResponse([{ name: 'movies.json', sha: 'big-sha', size: 2_000_000 }]);
      }
      return jsonResponse({ message: 'beklenmeyen' }, 500, init);
    },
    () =>
      fetchRemoteFileRaw(
        host({
          maxBytes: 3_000_000,
          fetchGitBlobBySha: async (sha) =>
            sha === 'big-sha'
              ? { ok: true, content: '{"movie:2":{}}' }
              : { ok: false, error: { category: 'unknown', message: 'sha' } },
        }),
        'data/catalog/movies.json',
        CFG
      )
  );
  assert.equal(result.ok, true);
  assert.equal(result.content, '{"movie:2":{}}');
  assert.equal(result.sha, 'big-sha');
  assert.ok(calls.some((url) => url.includes('/contents/data/catalog?ref=')));
});

test('F5.2-04 inspectRemoteSide: boş uzak depoyu taşıma hatası olmadan raporlar', async () => {
  const result = await withFetch(
    async () => jsonResponse({ message: 'Not Found' }, 404),
    () =>
      inspectRemoteSide(host({ deps: {} }), CFG, {
        includePersonalFiles: false,
        includeCatalogFiles: true,
        localProfilePaths: [],
      })
  );

  assert.equal(result.transportFailed, false);
  assert.deepEqual(result.bundle.movies, {});
  assert.deepEqual(result.bundle.tv, {});
  assert.equal(result.bundle.manifest, null);
  assert.deepEqual(result.bundle.errors, []);
  assert.deepEqual(result.rawRemoteContents, {});
});
