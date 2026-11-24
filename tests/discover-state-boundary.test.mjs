import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import { extractImports } from '../scripts/maintenance/architecture-boundaries.mjs';

const root = path.resolve(import.meta.dirname, '..');

function parse(file, source) {
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
}

/** Dosyadaki tüm tanımlayıcı adlarını toplar (yorum/metin hariç). */
function collectIdentifiers(sourceFile) {
  const names = new Set();
  const visit = (node) => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** `const [a, setA] = useState(...)` biçimindeki state adlarını toplar. */
function collectUseStateNames(sourceFile) {
  const names = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isArrayBindingPattern(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'useState'
    ) {
      const first = node.name.elements[0];
      if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) {
        names.add(first.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

test('Faz 6 Discover state sahipliği AST üzerinden doğrulanır', () => {
  const statePath = path.join(root, 'src/modules/discover/state.ts');
  const appPath = path.join(root, 'src/App.tsx');
  const stateIdentifiers = collectIdentifiers(parse(statePath, fs.readFileSync(statePath, 'utf8')));
  const appSource = fs.readFileSync(appPath, 'utf8');
  const appFile = parse(appPath, appSource);

  for (const field of [
    'category',
    'forYouSubTab',
    'selectedGenre',
    'selectedType',
    'selectedSort',
    'selectedProvider',
    'hideListedItems',
    'genresMap',
    'catalogItems',
    'catalogPage',
    'catalogTotalPages',
    'isLoading',
    'loadingMore',
    'forYouItems',
    'forYouReasons',
    'forYouExplanation',
    'forYouProgressStep',
    'requestGateRef',
  ]) {
    assert.ok(stateIdentifiers.has(field), `Discover state alanı eksik: ${field}`);
  }

  const appImports = extractImports(appSource, 'App.tsx');
  assert.ok(
    appImports.some((entry) => entry.specifier === './modules/discover/state.ts'),
    'App, Discover state hook’unu modülünden import etmeli'
  );

  const stateNames = collectUseStateNames(appFile);
  assert.equal(
    stateNames.has('catalogItems'),
    false,
    'catalogItems App içinde useState ile tutulmamalı (Discover state sahibi)'
  );
  assert.equal(
    stateNames.has('forYouItems'),
    false,
    'forYouItems App içinde useState ile tutulmamalı (Discover state sahibi)'
  );
});
