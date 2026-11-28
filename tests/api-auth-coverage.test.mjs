/**
 * P0-02: Tüm `/api` çağrıları ortak istemciden (`apiFetch`) geçmeli.
 *
 * F5-01: Bu dosya önceden kaynak metnini regex ile tarıyordu; çok satırlı
 * `fetch(...)` çağrılarını ve yorum içindeki örnekleri yanlış
 * değerlendirebiliyordu. Artık:
 *  - doğrudan `/api` fetch taraması AST üzerinden yapılır,
 *  - ortak istemcinin token/olay davranışı gerçek çağrı ile (davranışsal)
 *    doğrulanır,
 *  - servislerin ortak istemciyi kullanması AST import kontrolüyle denetlenir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { extractImports } from '../scripts/maintenance/architecture-boundaries.mjs';

const SRC_ROOT = path.resolve('src');
const ALLOWED_FILES = new Set([
  // Ortak istemcinin kendisi.
  path.join(SRC_ROOT, 'services', 'api-client.ts'),
]);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function parse(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/** AST üzerinden doğrudan `/api` hedefleyen `fetch` çağrılarını bulur. */
function findDirectApiFetches(sourceFile) {
  const hits = [];
  const isApiTarget = (node) => {
    if (ts.isStringLiteralLike(node)) {
      return node.text.startsWith('/api') || node.text.includes('${BASE}');
    }
    if (ts.isTemplateExpression(node)) {
      const head = node.head.text;
      return head.startsWith('/api') || head.includes('${BASE}');
    }
    return false;
  };
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'fetch' &&
      node.arguments.length > 0 &&
      isApiTarget(node.arguments[0])
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      hits.push(line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return hits;
}

test('P0-02: /api çağrıları doğrudan fetch yerine ortak apiFetch kullanır', () => {
  const offenders = [];
  for (const file of walk(SRC_ROOT)) {
    if (ALLOWED_FILES.has(file)) continue;
    const sourceFile = parse(file, fs.readFileSync(file, 'utf8'));
    for (const line of findDirectApiFetches(sourceFile)) {
      offenders.push(`${path.relative(SRC_ROOT, file)}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Doğrudan /api fetch kullanımı bulundu (ortak apiFetch kullanın):\n${offenders.join('\n')}`
  );
});

test('P0-02: apiFetch token başlığını ekler ve 401 durumunda kimlik olayı yayınlar', async () => {
  const store = new Map();
  const events = [];
  const original = {
    sessionStorage: globalThis.sessionStorage,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  globalThis.window = {
    dispatchEvent: (event) => {
      events.push(event);
      return true;
    },
  };
  let capturedHeaders;
  globalThis.fetch = async (_input, init) => {
    capturedHeaders = init?.headers;
    return new Response(JSON.stringify({ error: 'yetkisiz' }), { status: 401 });
  };

  try {
    const { apiFetch, setClientAuthToken, AUTH_REQUIRED_EVENT, getClientAuthToken } = await import(
      '../src/services/api-client.ts'
    );
    setClientAuthToken('  gizli-token  ');
    assert.equal(getClientAuthToken(), 'gizli-token', 'token kırpılarak saklanır');

    const response = await apiFetch('/api/data');
    assert.equal(response.status, 401);
    assert.equal(capturedHeaders['X-CineTrack-Token'], 'gizli-token', 'token başlığı eklendi');
    assert.equal(
      events.some((event) => event.type === AUTH_REQUIRED_EVENT),
      true,
      '401 kimlik olayı yayınlanmalı'
    );

    setClientAuthToken('');
    assert.equal(getClientAuthToken(), '', 'boş token temizler');
  } finally {
    globalThis.sessionStorage = original.sessionStorage;
    globalThis.window = original.window;
    globalThis.fetch = original.fetch;
  }
});

test('P0-02: taste ve stok servisleri ortak istemciyi AST düzeyinde içe aktarır', () => {
  const tastePath = path.join(SRC_ROOT, 'services', 'taste-api.ts');
  const stockPath = path.join(SRC_ROOT, 'services', 'stock-import-export.ts');
  const tasteImports = extractImports(fs.readFileSync(tastePath, 'utf8'), 'taste-api.ts');
  const stockImports = extractImports(fs.readFileSync(stockPath, 'utf8'), 'stock-import-export.ts');

  assert.ok(
    tasteImports.some((entry) => entry.specifier === './api-client.ts'),
    'taste servisi ortak istemciyi import etmeli'
  );
  assert.ok(
    stockImports.some((entry) => entry.specifier === './api-client.ts'),
    'stok servisi ortak istemciyi import etmeli'
  );

  const stockSource = fs.readFileSync(stockPath, 'utf8');
  assert.match(stockSource, /apiFetch\(/, 'stok servisi apiFetch kullanmalı');
  assert.match(stockSource, /readApiErrorMessage\(/, 'stok servisi ortak hata okuyucusunu kullanmalı');
});
