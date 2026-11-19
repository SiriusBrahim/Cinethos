import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('Faz 6 Discover state owns filters, results, loading and request gate', () => {
  const stateSource = fs.readFileSync(path.join(root, 'src/modules/discover/state.ts'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');

  for (const field of [
    'category', 'forYouSubTab', 'selectedGenre', 'selectedType', 'selectedSort',
    'selectedProvider', 'hideListedItems', 'genresMap', 'catalogItems',
    'catalogPage', 'catalogTotalPages', 'isLoading', 'loadingMore',
    'forYouItems', 'forYouReasons', 'forYouExplanation', 'forYouProgressStep',
    'requestGateRef',
  ]) {
    assert.ok(stateSource.includes(field), `Discover state alanı eksik: ${field}`);
  }
  assert.ok(appSource.includes("from './modules/discover/state.ts'"), 'App hook üzerinden Discover state kullanmalı');
  assert.ok(appSource.includes('const discoverState = useDiscoverState('));
  assert.equal(appSource.includes("const [catalogItems, setCatalogItems] = useState"), false);
  assert.equal(appSource.includes("const [forYouItems, setForYouItems] = useState"), false);
});
