/**
 * P0-02: Tüm `/api` çağrıları ortak istemciden (`apiFetch`) geçmeli.
 * Doğrudan `fetch` kullanımı LAN tokenını ve 401/503 istemini atlar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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

/** `fetch` çağrısının hedefi `/api` ile başlıyor mu? */
function findDirectApiFetches(source) {
  const hits = [];
  const patterns = [
    /fetch\(\s*`\/api/g,
    /fetch\(\s*'\/api/g,
    /fetch\(\s*"\/api/g,
    /fetch\(\s*`\$\{BASE\}/g,
    /fetch\(\s*`\/api\/taste/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const line = source.slice(0, match.index).split('\n').length;
      hits.push(line);
    }
  }
  return hits;
}

test('P0-02: /api çağrıları doğrudan fetch yerine ortak apiFetch kullanır', () => {
  const offenders = [];
  for (const file of walk(SRC_ROOT)) {
    if (ALLOWED_FILES.has(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const lines = findDirectApiFetches(source);
    for (const line of lines) {
      offenders.push(`${path.relative(SRC_ROOT, file)}:${line}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Doğrudan /api fetch kullanımı bulundu (ortak apiFetch kullanın):\n${offenders.join('\n')}`
  );
});

test('P0-02: ortak istemci token başlığını ve kimlik olayını içerir', () => {
  const source = fs.readFileSync(path.join(SRC_ROOT, 'services', 'api-client.ts'), 'utf8');
  assert.match(source, /X-Cinethos-Token/);
  assert.match(source, /AUTH_REQUIRED_EVENT/);
  assert.match(source, /export async function apiFetch/);
  // Kimlik hatası tek yerden bildirilir.
  assert.match(source, /response\.status === 401 \|\| response\.status === 503/);
});

test('P0-02: taste ve stok servisleri ortak istemciyi içe aktarır', () => {
  const taste = fs.readFileSync(path.join(SRC_ROOT, 'services', 'taste-api.ts'), 'utf8');
  const stock = fs.readFileSync(path.join(SRC_ROOT, 'services', 'stock-import-export.ts'), 'utf8');

  assert.match(taste, /from ['"]\.\/api-client\.ts['"]/);
  assert.doesNotMatch(taste, /async function apiFetch</, 'yerel fetch yardımcısı kaldırılmalı');
  assert.match(stock, /apiFetch\(/);
  assert.match(stock, /readApiErrorMessage\(/);
  assert.match(stock, /serverSynced/);
});
