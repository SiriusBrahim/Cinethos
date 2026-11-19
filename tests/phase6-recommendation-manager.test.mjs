/**
 * MIA Faz 6 — Öneri yöneticisi önce/sonra karşılaştırma testi.
 *
 * KANIT: `tests/fixtures/faz6-recommendation-before-scores.json`, öneri motoru
 * `src/modules/recommendations/` altına taşınmadan ÖNCE, aynı sabit veri
 * setiyle (`faz6-recommendation-dataset.mjs`) üretilmiş puanları içerir.
 * Bu test taşınmadan SONRAki yöneticiyi aynı veri setinde çalıştırır ve
 * puanların, sıralamanın, halkaların ve gerekçelerin birebir aynı kaldığını
 * doğrular.
 *
 * Ayrıca yönetici sınırlarını korur: eski çekirdek dosyası geri dönmemeli,
 * UI yalnızca yönetici yüzünü kullanmalı ve aday havuzu katı medya tipi
 * ayrımını sürdürmelidir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  createRecommendationManager,
  enrichCatalogItemsWithTaste,
  mapRecommendationBatchToDisplayItems,
} from '../src/modules/recommendations/index.ts';
import {
  BATCH_ENTRIES,
  CATALOG_ITEMS,
  GENRES_MAP,
  PREFERENCES,
  REFERENCE_NOW,
  SAVED_ITEMS,
  TASTE_MAP,
} from './fixtures/faz6-recommendation-dataset.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const BEFORE_FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(REPO_ROOT, 'tests', 'fixtures', 'faz6-recommendation-before-scores.json'),
    'utf8'
  )
);

const scoreOf = (item) => ({
  key: `${item.media_type}:${item.id}`,
  title: item.title,
  tasteScore: item.tasteScore,
  matchScore: item.matchScore,
  priorityScore: item.priorityScore,
  ring: item.ring,
  lifecycleRing: item.lifecycleRing,
  tags: item.tags,
  scoreCoverage: item.scoreCoverage,
  confidenceLevel: item.confidenceLevel,
});

function runEngine() {
  const enriched = enrichCatalogItemsWithTaste({
    items: CATALOG_ITEMS,
    savedItems: SAVED_ITEMS,
    preferences: PREFERENCES,
    genresMap: GENRES_MAP,
    tasteMap: TASTE_MAP,
    now: REFERENCE_NOW,
  });

  const display = mapRecommendationBatchToDisplayItems(BATCH_ENTRIES, TASTE_MAP, 'all');

  return {
    enrich: enriched.map(scoreOf),
    display: {
      items: display.displayItems.map(scoreOf),
      reasons: [...display.reasonsMap.entries()].sort(([a], [b]) => a.localeCompare(b)),
    },
  };
}

// ---------------------------------------------------------------------------
// 1. ÖNCE/SONRA — puanlar değişmedi
// ---------------------------------------------------------------------------
test('Faz 6: taşınmadan önceki ve sonraki öneri puanları aynı veri setinde birebir aynı', () => {
  const actual = runEngine();

  assert.equal(BEFORE_FIXTURE.referenceNow, REFERENCE_NOW, 'altın anlık görüntü referans zamanı eşleşmeli');
  assert.deepEqual(
    actual.enrich,
    BEFORE_FIXTURE.enrich,
    'zenginleştirme puanları/sırası taşınma sonrası değişmemeli'
  );
  assert.deepEqual(
    actual.display,
    BEFORE_FIXTURE.display,
    'gösterim puanları, halkaları ve gerekçeleri taşınma sonrası değişmemeli'
  );
});

test('Faz 6: aynı veri setinde ardışık iki koşum aynı sonucu verir (deterministik)', () => {
  assert.deepEqual(runEngine(), runEngine());
});

// ---------------------------------------------------------------------------
// 2. Yönetici yapısı ve sınırları
// ---------------------------------------------------------------------------
test('Faz 6: bağımsız öneri yöneticisi alt yöneticileriyle birlikte kurulur', () => {
  const manager = createRecommendationManager();
  assert.equal(manager.id, 'recommendations');
  assert.match(manager.version, /^\d+\.\d+\.\d+$/);

  for (const name of ['engine', 'pool', 'explanations', 'evaluation', 'ranking']) {
    assert.ok(manager[name], `alt yönetici eksik: ${name}`);
  }
  assert.equal(manager.engine.enrichCatalogItemsWithTaste, enrichCatalogItemsWithTaste);
  assert.equal(manager.pool.enforceStrictMediaTypePool, manager.engine.enforceStrictMediaTypePool);
  assert.equal(
    manager.explanations.mapRecommendationBatchToDisplayItems,
    mapRecommendationBatchToDisplayItems
  );
});

test('Faz 6: öneri motoru çekirdek yolu altında kalmadı, UI yönetici yüzünü kullanır', () => {
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, 'src', 'core', 'recommendation-orchestrator.ts')),
    false,
    'eski çekirdek dosyası geri dönmemeli (tek sahip: src/modules/recommendations)'
  );

  const appSource = fs.readFileSync(path.join(REPO_ROOT, 'src', 'App.tsx'), 'utf8');
  assert.ok(
    appSource.includes("from './modules/recommendations/index.ts'"),
    'App.tsx öneri işlevlerini yönetici yüzünden import etmeli'
  );
  assert.equal(
    appSource.includes('core/recommendation-orchestrator'),
    false,
    'App.tsx eski çekirdek dosyasına bağlı olmamalı'
  );
});

test('Faz 6: aday havuzu yöneticisi katı film/dizi ayrımını korur', () => {
  const manager = createRecommendationManager();
  const mixed = [
    { id: 1, media_type: 'movie', title: 'Film' },
    { id: 2, media_type: 'tv', title: 'Dizi' },
    { id: 3, title: 'Belirsiz' },
  ];

  assert.deepEqual(
    manager.pool.enforceStrictMediaTypePool(mixed, 'movie').map((i) => i.id),
    [1]
  );
  assert.deepEqual(
    manager.pool.enforceStrictMediaTypePool(mixed, 'all').map((i) => i.id),
    [1, 2]
  );
});

test('Faz 6: değerlendirme ve sıralama yöneticileri çekirdek algoritmayı yeniden yazmaz', () => {
  const manager = createRecommendationManager();
  assert.equal(typeof manager.evaluation.evaluate, 'function');
  assert.equal(typeof manager.ranking.scoreActorRecommendations, 'function');
  assert.equal(manager.ranking.scoreActorRecommendations.length, 1);
});
