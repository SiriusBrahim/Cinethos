/**
 * P1-02: Görsel proxy sertleştirmesinin regresyon testleri.
 *
 * Kapsam: 8 MB üstü Content-Length, Content-Length'siz stream taşması,
 * MIME allowlist, aynı URL için uçuştaki istek paylaşımı, eşzamanlı indirme
 * sınırı (429) ve cache byte muhasebesi.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ReadableStream } from 'node:stream/web';
import express from 'express';

import { createTmdbProxyService } from '../src/server/tmdb-proxy.ts';

const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_BYTES = Buffer.from('fake-image-bytes');

function createStreamingBody(chunks, state, delayMs = 0) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (delayMs > 0) {
        // Ağ benzeri tembellik: tüm gövde tek seferde çekilmesin.
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

function imageResponse(bytes, options = {}) {
  const state = { cancelled: false, reads: 0 };
  const { contentType = 'image/jpeg', contentLength, chunkSize, delayMs } = options;
  const chunkArray = [];
  if (chunkSize) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      chunkArray.push(bytes.subarray(offset, offset + chunkSize));
    }
  } else {
    chunkArray.push(bytes);
  }
  const body = createStreamingBody(chunkArray, state, delayMs);
  const headers = { 'Content-Type': contentType };
  if (contentLength !== undefined) headers['Content-Length'] = String(contentLength);
  const response = new Response(body, { status: 200, headers });
  return { response, state };
}

async function startProxy(fetchImpl) {
  const service = createTmdbProxyService({ fetchImpl, tmdbApiKey: 'test-key' });
  const app = express();
  app.get('/img', service.handleTmdbImage);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/img`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function requestImage(baseUrl, pathSuffix) {
  return fetch(
    `${baseUrl}?path=${encodeURIComponent(pathSuffix)}&size=w500`
  );
}

test('P1-02: bildirilen boyut 8 MB üstündeyse gövde okunmadan reddedilir', async () => {
  const { response, state } = imageResponse(IMAGE_BYTES, {
    contentLength: MAX_BYTES + 1,
  });
  const ctx = await startProxy(async () => response);
  try {
    const res = await requestImage(ctx.baseUrl, 'huge-content-length.jpg');
    assert.equal(res.status, 502);
    assert.equal(state.reads, 0, 'gövde hiç okunmamalı');
  } finally {
    await ctx.close();
  }
});

test('P1-02: Content-Length yoksa stream sırasında sınır uygulanır ve iptal edilir', async () => {
  const chunk = Buffer.alloc(1024 * 1024, 1);
  const { response, state } = imageResponse(Buffer.concat(Array(20).fill(chunk)), {
    chunkSize: chunk.length,
    delayMs: 1,
  });
  const ctx = await startProxy(async () => response);
  try {
    const res = await requestImage(ctx.baseUrl, 'huge-stream.jpg');
    assert.equal(res.status, 502);
    assert.equal(state.cancelled, true, 'sınır aşılınca upstream iptal edilmeli');
  } finally {
    await ctx.close();
  }
});

test('P1-02: allowlist dışı MIME reddedilir ve gövde iptal edilir', async () => {
  const { response, state } = imageResponse(Buffer.from('<html></html>'), {
    contentType: 'text/html',
  });
  const ctx = await startProxy(async () => response);
  try {
    const res = await requestImage(ctx.baseUrl, 'not-an-image.jpg');
    assert.equal(res.status, 502);
    assert.equal(state.cancelled, true);
  } finally {
    await ctx.close();
  }
});

test('P1-02: aynı URL için eşzamanlı istekler tek upstream çağrısına iner', async () => {
  let calls = 0;
  const ctx = await startProxy(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 80));
    return imageResponse(IMAGE_BYTES).response;
  });
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => requestImage(ctx.baseUrl, 'shared-poster.jpg'))
    );
    assert.deepEqual(
      responses.map((res) => res.status),
      [200, 200, 200, 200, 200]
    );
    assert.equal(calls, 1, 'beş istek için tek upstream çağrısı');
    const badge = responses[0].headers.get('x-cinetrack-image-proxy');
    assert.ok(['miss', 'shared'].includes(badge), `beklenmeyen badge: ${badge}`);
  } finally {
    await ctx.close();
  }
});

test('P1-02: eşzamanlı indirme sınırı aşılırsa 429 döner', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const ctx = await startProxy(async () => {
    calls += 1;
    await gate;
    return imageResponse(IMAGE_BYTES).response;
  });
  try {
    const pending = Array.from({ length: 9 }, (_, index) =>
      requestImage(ctx.baseUrl, `concurrent-${index}.jpg`)
    );
    // 8 istek upstream'de beklerken 9. istek sınıra takılmalı.
    await new Promise((resolve) => setTimeout(resolve, 120));
    release();
    const responses = await Promise.all(pending);
    const statuses = responses.map((res) => res.status);
    assert.equal(statuses.filter((status) => status === 429).length, 1, statuses.join(','));
    assert.equal(statuses.filter((status) => status === 200).length, 8, statuses.join(','));
    assert.equal(calls, 8);
  } finally {
    await ctx.close();
  }
});

test('P1-02: cache byte muhasebesi aynı URL yeniden yazıldığında bozulmaz', async () => {
  let calls = 0;
  let payload = Buffer.from('a'.repeat(2048));
  const ctx = await startProxy(async () => {
    calls += 1;
    return imageResponse(payload).response;
  });
  try {
    const first = await requestImage(ctx.baseUrl, 'cache-budget.jpg');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-cinetrack-image-proxy'), 'miss');
    await first.arrayBuffer();

    const second = await requestImage(ctx.baseUrl, 'cache-budget.jpg');
    assert.equal(second.headers.get('x-cinetrack-image-proxy'), 'hit');
    await second.arrayBuffer();
    assert.equal(calls, 1, 'ikinci istek cache\'ten gelmeli');

    // Farklı URL'lerle cache büyüt; byte sayacı negatife düşmemeli.
    for (let index = 0; index < 5; index += 1) {
      payload = Buffer.from(String(index).repeat(1024));
      const res = await requestImage(ctx.baseUrl, `evict-${index}.jpg`);
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }

    const stillCached = await requestImage(ctx.baseUrl, 'evict-4.jpg');
    assert.equal(stillCached.status, 200);
    assert.equal(stillCached.headers.get('x-cinetrack-image-proxy'), 'hit');
  } finally {
    await ctx.close();
  }
});
