/**
 * Aşama 6 / B-20 — Lazy loading ve ilk paket sınırı testleri.
 *
 * Statik import grafiği `src/main.tsx`'ten yürünür (tip-only kenarlar hariç).
 * Ağır ekranların ilk yükleme grafiğinde OLMAMASI, buna karşılık dinamik
 * import ile erişilebilir olması doğrulanır. `lazyWithRetry` davranışı gerçek
 * modülle test edilir: bir kez yeniden dener, ikinci hatada hatayı iletir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { getModuleEdges, parseFile } from './helpers/source-ast.mjs';
import { lazyWithRetry, loadWithRetry } from '../src/app/lazy-with-retry.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'src/main.tsx');

const HEAVY_MODULES = [
  'src/components/RelationshipExplorer.tsx',
  'src/components/taste/TasteProfileDashboard.tsx',
  'src/components/TasteMapView.tsx',
  'src/modules/series/SeriesSection.tsx',
  'src/modules/operations/OperationsSection.tsx',
];

function resolveModule(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function collectStaticGraph(entryFile) {
  const visited = new Set();
  const packages = new Set();
  const queue = [entryFile];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const source = parseFile(file);
    for (const edge of getModuleEdges(source)) {
      if (edge.typeOnly) continue;
      if (!edge.module.startsWith('.')) {
        packages.add(edge.module);
        continue;
      }
      const resolved = resolveModule(file, edge.module);
      if (resolved) queue.push(resolved);
    }
  }
  return { files: visited, packages };
}

function dynamicImportTargets(file) {
  const text = fs.readFileSync(file, 'utf8');
  return [...text.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);
}

const graph = collectStaticGraph(ENTRY);

test('B-20 ağır ekranlar ilk statik paket grafiğinde yer almaz', () => {
  for (const relative of HEAVY_MODULES) {
    const absolute = path.join(ROOT, relative);
    assert.equal(
      graph.files.has(absolute),
      false,
      `${relative} ilk yüklemede statik olarak çekilmemeli`
    );
  }
});

test('B-20 graf motoru (react-force-graph-2d) ilk pakete girmiyor', () => {
  assert.equal(graph.packages.has('react-force-graph-2d'), false);
});

test('B-20 ağır ekranlar dinamik import ile erişilebilir', () => {
  const appTargets = dynamicImportTargets(path.join(ROOT, 'src/App.tsx'));
  assert.ok(appTargets.some((target) => target.includes('RelationshipExplorer')), 'ilişki keşfi lazy olmalı');
  assert.ok(
    appTargets.some((target) => target.includes('SeriesSection')),
    'seriler ekranı lazy olmalı'
  );
  assert.ok(
    appTargets.some((target) => target.includes('OperationsSection')),
    'işlem merkezi lazy olmalı'
  );

  const statsTabTargets = dynamicImportTargets(path.join(ROOT, 'src/components/ProfileStatsTab.tsx'));
  assert.ok(
    statsTabTargets.some((target) => target.includes('TasteProfileDashboard')),
    'zevk paneli profil sekmesinde lazy olmalı'
  );

  const universesTargets = dynamicImportTargets(path.join(ROOT, 'src/components/UniversesView.tsx'));
  assert.ok(
    universesTargets.some((target) => target.includes('RelationshipExplorer')),
    'zevk ağı grafı lazy olmalı'
  );
});

test('B-20 loadWithRetry: geçici yükleme hatasında bir kez yeniden dener', async () => {
  let attempts = 0;
  const component = () => null;
  const loaded = await loadWithRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('chunk yüklenemedi');
      return { default: component };
    },
    { wait: async () => {} }
  );

  assert.equal(attempts, 2);
  assert.equal(loaded.default, component);
});

test('B-20 loadWithRetry: kalıcı hatada özgün hatayı iletir (ErrorBoundary yakalar)', async () => {
  let attempts = 0;
  await assert.rejects(
    loadWithRetry(
      async () => {
        attempts += 1;
        throw new Error('chunk kalıcı olarak yüklenemedi');
      },
      { wait: async () => {} }
    ),
    /chunk kalıcı olarak yüklenemedi/
  );
  assert.equal(attempts, 2, 'yalnızca bir kez yeniden denenmeli');
});

test('B-20 lazyWithRetry React.lazy bileşeni üretir', () => {
  const lazy = lazyWithRetry(async () => ({ default: () => null }), { wait: async () => {} });
  assert.equal(lazy.$$typeof, Symbol.for('react.lazy'));
});
