/**
 * MIA Faz 7 — Arayüz ↔ yönetici servisleri bağlama testi.
 *
 * KANIT (davranış):
 * - Mobil ve masaüstü arayüzü aynı `ClientLibraryService` hattını kullanır.
 *   Aynı komut dizisi iki ayrı "çağıran" (mobil kart / masaüstü modal) için de
 *   birebir aynı kaydı üretir ve tek sink çağrısı yapar.
 * - Kütüphane komutlarının tamamı (`save`, `rate`, `set-status`, `remove`,
 *   `advance-episode`, `merge-duplicates`, `dislike`, `hide`) tek hattan geçer;
 *   tombstone/yan etki kancaları istemci tarafından enjekte edilir.
 * - `useItemActions` artık adaptördür: verilen servisi kullanır, yeni bir hat
 *   kurmaz ve kendi kural kopyasını taşımaz.
 *
 * KANIT (statik bağlama):
 * - `App.tsx` tek servis örneği kurar ve `useItemActions`'a verir.
 * - Mobil alt gezinme `src/presentation/layouts/MobileLayout.tsx` üzerinden
 *   modül kayıt defterinden türetilir; App kendi sekme listesini tutmaz.
 * - Masaüstü üst sekmeleri `HEADER_NAV_ITEMS` kaydından gelir; geçersiz
 *   `identity` / `universes` sekme kimlikleri geri dönmez.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  CLIENT_LIBRARY_COMMANDS,
  CLIENT_LIBRARY_PIPELINE_ID,
  createClientLibraryService,
} from '../src/modules/library/client-service.ts';
import { useItemActions } from '../src/hooks/useItemActions.ts';
import { MOBILE_NAV_ITEMS } from '../src/presentation/layouts/MobileLayout.tsx';
import { HEADER_NAV_ITEMS, MOBILE_OVERFLOW_ITEMS } from '../src/app/navigation.ts';
import { MODULES } from '../src/app/module-registry.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const FIXED_NOW = '2026-11-18T09:00:00.000Z';

function read(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

/** Mobil kart / masaüstü modal gibi davranan tek bir arayüz çağıranı. */
function createUiCaller(label, initialItems = []) {
  const calls = { applied: [], lists: [], tombstones: [], removed: [] };
  let items = [...initialItems];

  const service = createClientLibraryService({
    getSavedItems: () => items,
    applySavedItem: (normalized) => {
      const index = items.findIndex(
        (entry) => `${entry.media_type}:${entry.id}` === `${normalized.media_type}:${normalized.id}`
      );
      items = index >= 0 ? items.map((entry, i) => (i === index ? normalized : entry)) : [normalized, ...items];
      calls.applied.push(`${label}:${normalized.media_type}:${normalized.id}`);
    },
    applySavedItems: (next) => {
      items = next;
      calls.lists.push(`${label}:${next.map((entry) => `${entry.media_type}:${entry.id}`).join(',')}`);
    },
    applyTombstone: (mediaKey) => {
      calls.tombstones.push(`${label}:${mediaKey}`);
    },
    onItemRemoved: (removed, mediaKey) => {
      calls.removed.push(`${label}:${mediaKey}:${removed.title}`);
    },
    now: () => FIXED_NOW,
  });

  return {
    label,
    service,
    calls,
    getItems: () => items,
  };
}

const MOVIE = {
  id: 4242,
  media_type: 'movie',
  title: 'Faz 7 Hattı',
  genre_ids: [18, 53],
  release_date: '2025-03-01',
};

// ---------------------------------------------------------------------------
// 1. Mobil ve masaüstü aynı hattı kullanır: birebir aynı çıktı
// ---------------------------------------------------------------------------
test('F7-1 mobil ve masaüstü çağıranları aynı komut dizisinde birebir aynı kaydı üretir', () => {
  const mobile = createUiCaller('mobil');
  const desktop = createUiCaller('masaüstü');

  const run = (caller) => {
    const saved = caller.service.saveItem(MOVIE, 'watchlist', '');
    const rated = caller.service.rateItem(MOVIE, 8);
    const status = caller.service.setItemStatus(MOVIE, 'watching');
    return { saved, rated, status };
  };

  const mobileResult = run(mobile);
  const desktopResult = run(desktop);

  assert.deepEqual(mobileResult, desktopResult, 'aynı girdi aynı kaydı üretmeli');
  assert.deepEqual(mobile.getItems(), desktop.getItems(), 'iki arayüzün listesi aynı olmalı');
  assert.equal(mobileResult.rated.status, 'completed', 'puan verme izlenecekler kaydını izlendiye taşımalı');
  assert.equal(mobileResult.rated.personal_rating, 8);
  assert.equal(mobileResult.status.personal_rating, 8, 'durum değişikliği puanı korumalı');
  assert.deepEqual(
    mobile.calls.applied,
    ['mobil:movie:4242', 'mobil:movie:4242', 'mobil:movie:4242'],
    'her komut tek sink çağrısı yapmalı (çift yazım yok)'
  );
});

// ---------------------------------------------------------------------------
// 2. Bütün komutlar tek hattan geçer
// ---------------------------------------------------------------------------
test('F7-2 kütüphane komutlarının tamamı ClientLibraryService üzerinden yürür', () => {
  assert.equal(CLIENT_LIBRARY_PIPELINE_ID, 'library-client');
  assert.deepEqual(
    [...CLIENT_LIBRARY_COMMANDS].sort(),
    ['advance-episode', 'dislike', 'hide', 'merge-duplicates', 'rate', 'remove', 'save', 'set-status']
  );

  const caller = createUiCaller('hat');
  caller.service.saveItem(MOVIE, 'watchlist', '');

  const removed = caller.service.removeItem({ id: 4242, media_type: 'movie', title: 'Faz 7 Hattı' });
  assert.equal(removed?.title, 'Faz 7 Hattı');
  assert.deepEqual(caller.calls.tombstones, ['hat:movie:4242'], 'kaldırma tombstone yazmalı');
  assert.deepEqual(caller.calls.removed, ['hat:movie:4242:Faz 7 Hattı']);
  assert.deepEqual(caller.getItems(), [], 'kayıt listeden çıkmalı');

  // Dizi ilerlemesi + çift kayıt birleştirme aynı hattan geçer.
  caller.service.saveItem(
    { id: 77, media_type: 'tv', name: 'Faz 7 Dizisi', number_of_episodes: 4 },
    'watching',
    ''
  );
  const advanced = caller.service.advanceEpisode(caller.getItems().find((entry) => entry.id === 77));
  assert.ok(advanced, 'ilerleme sonucu dönmeli');
  assert.equal(advanced.item.episodes_watched, 1);

  const merged = caller.service.mergeDuplicates(77, 78, 'tv');
  assert.equal(merged, null, 'eşleşen çift yoksa birleştirme null döner');

  assert.equal(caller.service.dislikeItem('movie:4242')?.eventType, 'content_disliked');
  assert.equal(caller.service.hideItem('tv:77')?.eventType, 'content_hidden');
  assert.equal(caller.service.dislikeItem('gecersiz'), null, 'geçersiz anahtar olay üretmemeli');
});

// ---------------------------------------------------------------------------
// 3. useItemActions adaptördür: verilen hattı paylaşır, kendi hattını kurmaz
// ---------------------------------------------------------------------------
test('F7-3 useItemActions verilen servisi kullanır ve ikinci bir hat kurmaz', () => {
  const caller = createUiCaller('ortak');
  let serviceCalls = 0;
  const originalSave = caller.service.saveItem.bind(caller.service);
  caller.service.saveItem = (...args) => {
    serviceCalls += 1;
    return originalSave(...args);
  };

  const actions = useItemActions({
    getSavedItems: () => caller.getItems(),
    onCommitSavedItem: () => {
      throw new Error('adaptör kendi sink’ini çağırmamalı');
    },
    service: caller.service,
  });

  const result = actions.saveItem(MOVIE, 'watchlist', '');
  assert.ok(result);
  assert.equal(serviceCalls, 1, 'çağrı paylaşılan hatta düşmeli');
  assert.deepEqual(caller.calls.applied, ['ortak:movie:4242']);
});

// ---------------------------------------------------------------------------
// 4. Statik bağlama: App + mobil/masaüstü gezinme tek kaynak
// ---------------------------------------------------------------------------
test('F7-4 App tek kütüphane hattı kurar, mobil ve masaüstü gezinme kayıttan türer', () => {
  const app = read('src/App.tsx');

  assert.ok(
    app.includes("from './modules/library/client-service.ts'"),
    'App tek istemci kütüphane hattını import etmeli'
  );
  assert.ok(app.includes('createClientLibraryService({'), 'App hattı kurmalı');
  assert.ok(
    /useItemActions\(\{[\s\S]*?service: libraryService/.test(app),
    'App aynı hattı useItemActions’a vermeli (ikinci hat kurulmamalı)'
  );
  for (const method of ['libraryService.removeItem', 'libraryService.advanceEpisode', 'libraryService.mergeDuplicates']) {
    assert.ok(app.includes(method), `App ${method} çağrısını hattan yapmalı`);
  }
  assert.equal(
    /buildLibraryItem\(|resolveItemActionTimestamps\(/.test(app),
    false,
    'App kütüphane kuralını kendisi uygulamamalı (tek hat)'
  );

  assert.ok(app.includes("from './presentation/layouts/MobileLayout.tsx'"));
  assert.ok(app.includes('<MobileBottomNav'), 'mobil gezinme sunum katmanından render edilmeli');
  assert.equal(
    /className=\{`mobile-tab-btn/.test(app),
    false,
    'App kendi mobil sekme listesini tutmamalı'
  );

  const registryIds = MODULES.map((module) => module.id);
  // Mobil dock dört birincil sekmeyi taşır; kalan modüller taşma sayfasındadır.
  // Birlikte tam kayıt defterini kapsamalı (hiçbir modül erişilemez kalmaz).
  assert.deepEqual(
    [...MOBILE_NAV_ITEMS.map((item) => item.id), ...MOBILE_OVERFLOW_ITEMS.map((item) => item.id)],
    registryIds,
    'mobil gezinme (dock + taşma) modül kayıt defterinden türetilmeli'
  );
  assert.deepEqual(
    HEADER_NAV_ITEMS.map((item) => item.id),
    registryIds,
    'masaüstü gezinme modül kayıt defterinden türetilmeli'
  );

  const header = read('src/components/Header.tsx');
  assert.ok(header.includes('HEADER_NAV_ITEMS'), 'Header sekmeleri kayıttan türetmeli');
  assert.equal(
    /onTabChange\('identity'\)|onTabChange\('universes'\)/.test(header),
    false,
    'geçersiz sekme kimlikleri (identity/universes) geri gelmemeli'
  );
});

// ---------------------------------------------------------------------------
// 5. Tek kural kaynağı korunur
// ---------------------------------------------------------------------------
test('F7-5 useItemActions kendi kural/olay kopyasını taşımaz', () => {
  const hook = read('src/hooks/useItemActions.ts');
  const service = read('src/modules/library/client-service.ts');

  assert.ok(hook.includes('createClientLibraryService'), 'adaptör hattı kullanmalı');
  assert.equal(
    /export function resolveItemActionTimestamps/.test(hook),
    false,
    'adaptör zaman damgası kuralını yeniden tanımlamamalı'
  );
  assert.ok(
    service.includes("from './operations.ts'"),
    'hat, kütüphane kurallarını operations.ts’ten almalı'
  );
  assert.ok(service.includes('buildLibraryItem('));
  assert.equal(
    /createAppEventBus\s*\(|new\s+DatabaseSync\s*\(|from\s+'node:sqlite'/.test(service),
    false,
    'hat paralel EventBus/SQLite kurmamalı'
  );
});

test('F7-6 sinema kimliği panelleri ve korumalı runtime tanılama hattı bağlanır', () => {
  const dashboard = read('src/components/taste/TasteProfileDashboard.tsx');
  assert.match(dashboard, /fetchTasteOverview/);
  assert.match(dashboard, /<TasteComparePanel/);
  assert.match(dashboard, /<TasteEvolutionPanel/);
  assert.match(dashboard, /overviewStatus === "error"/);
  assert.match(dashboard, /Yeniden Dene/);
  const evolution = read('src/components/taste/TasteEvolutionPanel.tsx');
  assert.ok(evolution.includes('snapshots = []'));
  assert.ok(evolution.includes('drifts = []'));
  const e2eFixtures = read('e2e/fixtures.ts');
  assert.ok(e2eFixtures.includes("path === '/api/taste/overview'"));

  const server = read('src/server/app.ts');
  assert.ok(server.includes("app.get('/api/diagnostics/runtime', personalReadGuard"));
  const routeStart = server.indexOf("  // Teknik tanılama:");
  const routeEnd = server.indexOf("  app.get('/api/health'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, 'tanılama rotası health rotasından önce tanımlanmalı');
  const route = server.slice(routeStart, routeEnd);
  assert.ok(route.includes("Cache-Control', 'no-store'"));
  assert.ok(route.includes('contentIntelligence.healthCheck()'));
  assert.ok(route.includes('backgroundManager.healthCheck()'));
});
