#!/usr/bin/env node
/**
 * Faz 3 — Mimari bağımlılık döngüsü denetimi.
 *
 * `src/` altındaki yerel (relative) import'ları gezer ve dosya düzeyinde
 * döngüleri raporlar. Yeni bir bağımlılık kütüphanesi eklemeden çalışır; CI ve
 * `tests/architecture-cycles.test.mjs` bu betiği kullanır.
 *
 * Kullanım:
 *   node scripts/check-cycles.mjs            # rapor + çıkış kodu (döngü varsa 1)
 *   node scripts/check-cycles.mjs --json
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..', 'src');

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"](\.[^'"]+)['"]/g;
const SIDE_EFFECT_IMPORT_RE = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      listSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    base.replace(/\.(ts|tsx)$/, ''),
  ];
  for (const candidate of candidates) {
    try {
      const stats = statSync(candidate);
      if (stats.isFile() && /\.(ts|tsx)$/.test(candidate)) return candidate;
    } catch {}
  }
  return null;
}

/** Dosya düzeyinde import grafiğini kurar. */
export function buildImportGraph(rootDir = DEFAULT_ROOT) {
  const files = listSourceFiles(rootDir);
  const graph = new Map();
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const edges = new Set();
    for (const regex of [IMPORT_RE, SIDE_EFFECT_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const resolved = resolveSpecifier(file, match[1]);
        if (resolved) edges.add(resolved);
      }
    }
    graph.set(file, Array.from(edges));
  }
  return graph;
}

/** Güçlü bağlı bileşenlerden (SCC) döngüleri çıkarır; deterministik sıralar. */
export function findImportCycles(rootDir = DEFAULT_ROOT) {
  const graph = buildImportGraph(rootDir);
  const indexMap = new Map();
  const lowMap = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;

  const strongConnect = (node) => {
    indexMap.set(node, counter);
    lowMap.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) || []) {
      if (!indexMap.has(next)) {
        strongConnect(next);
        lowMap.set(node, Math.min(lowMap.get(node), lowMap.get(next)));
      } else if (onStack.has(next)) {
        lowMap.set(node, Math.min(lowMap.get(node), indexMap.get(next)));
      }
    }

    if (lowMap.get(node) === indexMap.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) components.push(component);
      else {
        const only = component[0];
        if ((graph.get(only) || []).includes(only)) components.push(component);
      }
    }
  };

  for (const node of Array.from(graph.keys()).sort()) {
    if (!indexMap.has(node)) strongConnect(node);
  }

  return components
    .map((component) =>
      component
        .map((file) => path.relative(path.resolve(rootDir, '..'), file).split(path.sep).join('/'))
        .sort()
    )
    .sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

function main() {
  const asJson = process.argv.includes('--json');
  const cycles = findImportCycles();
  if (asJson) {
    console.log(JSON.stringify({ cycleCount: cycles.length, cycles }, null, 2));
  } else if (cycles.length === 0) {
    console.log('Bağımlılık döngüsü bulunmadı.');
  } else {
    console.log(`Bağımlılık döngüsü sayısı: ${cycles.length}`);
    cycles.forEach((cycle, i) => {
      console.log(`  ${i + 1}. ${cycle.join(' -> ')}`);
    });
  }
  process.exit(cycles.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
