/**
 * Aşama 5.2 — F5.2-01 kabul testleri.
 *
 * `spec-v7-regressions` ve `phases-all` içindeki JSX kaynak metni kontrolleri
 * kaldırıldı; yerine bileşenlerin gerçek render çıktısı ve etkileşim
 * işleyicileri doğrulanır.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import { UI_COPY } from '../src/app/ui-copy.ts';
import { shouldHideSecondaryToolbar } from '../src/app/controls-state.ts';
import {
  ActorsSubtabsBar,
  DerivedCacheResetControl,
  EmptyLibraryGuide,
  ErrorRecoveryActions,
  MapPreparingNotice,
  StockPullButton,
} from '../src/components/ui-states.tsx';
import { findButtonByText, renderMarkup, renderText } from './helpers/render-tree.mjs';

test('F5.2-01 ErrorRecoveryActions: kullanıcıya gösterilen kurtarma etiketleri render edilir', () => {
  const idle = renderText(
    React.createElement(ErrorRecoveryActions, {
      isResettingCaches: false,
      copied: false,
      onRetry: () => {},
      onResetCachesAndRetry: () => {},
      onCopy: () => {},
    })
  );
  assert.ok(idle.includes(UI_COPY.errorBoundary.retry));
  assert.ok(idle.includes(UI_COPY.errorBoundary.resetCachesAndRetry));
  assert.ok(idle.includes(UI_COPY.errorBoundary.copyError));

  const busy = renderText(
    React.createElement(ErrorRecoveryActions, {
      isResettingCaches: true,
      copied: true,
      onRetry: () => {},
      onResetCachesAndRetry: () => {},
      onCopy: () => {},
    })
  );
  assert.ok(busy.includes(UI_COPY.errorBoundary.resettingCaches));
  assert.ok(busy.includes(UI_COPY.errorBoundary.copied));
  assert.equal(busy.includes(UI_COPY.errorBoundary.resetCachesAndRetry), false);

  const handlers = { retry: 0, reset: 0, copy: 0 };
  const tree = ErrorRecoveryActions({
    isResettingCaches: false,
    copied: false,
    onRetry: () => (handlers.retry += 1),
    onResetCachesAndRetry: () => (handlers.reset += 1),
    onCopy: () => (handlers.copy += 1),
  });
  findButtonByText(tree, UI_COPY.errorBoundary.retry).props.onClick();
  findButtonByText(tree, UI_COPY.errorBoundary.resetCachesAndRetry).props.onClick();
  findButtonByText(tree, UI_COPY.errorBoundary.copyError).props.onClick();
  assert.deepEqual(handlers, { retry: 1, reset: 1, copy: 1 });
});

test('F5.2-01 StockPullButton: yoğun ve boş durum etiketleri ile devre dışı bırakma', () => {
  const idle = renderMarkup(
    React.createElement(StockPullButton, { replenishing: false, onClick: () => {} })
  );
  assert.ok(idle.includes(UI_COPY.stock.pull));
  assert.equal(idle.includes('disabled'), false);

  const busy = renderMarkup(
    React.createElement(StockPullButton, { replenishing: true, onClick: () => {} })
  );
  assert.ok(busy.includes(UI_COPY.stock.pullBusy));
  assert.ok(busy.includes('disabled'));

  const longIdle = renderText(
    React.createElement(StockPullButton, { replenishing: false, variant: 'long', onClick: () => {} })
  );
  assert.equal(longIdle, UI_COPY.stock.download);

  const longBusy = renderText(
    React.createElement(StockPullButton, { replenishing: true, variant: 'long', onClick: () => {} })
  );
  assert.equal(longBusy, UI_COPY.stock.downloadBusy);

  let clicked = 0;
  const tree = StockPullButton({ replenishing: false, onClick: () => (clicked += 1) });
  findButtonByText(tree, UI_COPY.stock.pull).props.onClick();
  assert.equal(clicked, 1);
});

test('F5.2-01 MapPreparingNotice ve EmptyLibraryGuide: boş durum rehberi gerçekten render edilir', () => {
  const mapText = renderText(MapPreparingNotice());
  assert.ok(mapText.includes(UI_COPY.maps.preparing));

  const withAdd = renderText(
    EmptyLibraryGuide({ onGoDiscover: () => {}, onOpenAddCustom: () => {} })
  );
  assert.ok(withAdd.includes(UI_COPY.library.emptyTitle));
  assert.ok(withAdd.includes(UI_COPY.library.goDiscover));
  assert.ok(withAdd.includes('Özel içerik ekle'));

  const withoutAdd = renderText(EmptyLibraryGuide({ onGoDiscover: () => {} }));
  assert.ok(withoutAdd.includes(UI_COPY.library.emptyTitle));
  assert.equal(withoutAdd.includes('Özel içerik ekle'), false);

  let discovered = 0;
  const tree = EmptyLibraryGuide({ onGoDiscover: () => (discovered += 1) });
  findButtonByText(tree, UI_COPY.library.goDiscover).props.onClick();
  assert.equal(discovered, 1);
});

test('F5.2-01 DerivedCacheResetControl: sıfırlama düğmesi durum ve bildirim metnini yansıtır', () => {
  const idle = renderText(
    DerivedCacheResetControl({ resetting: false, onReset: () => {}, message: 'Önbellek temiz.' })
  );
  assert.ok(idle.includes(UI_COPY.profile.resetDerivedCaches));
  assert.ok(idle.includes('Önbellek temiz.'));

  const busy = renderText(DerivedCacheResetControl({ resetting: true, onReset: () => {} }));
  assert.ok(busy.includes(UI_COPY.profile.resettingDerivedCaches));

  let resets = 0;
  const tree = DerivedCacheResetControl({ resetting: false, onReset: () => (resets += 1) });
  findButtonByText(tree, UI_COPY.profile.resetDerivedCaches).props.onClick();
  assert.equal(resets, 1);
});

test('F5.2-01 ActorsSubtabsBar: Oyuncular/Öneriler sekmeleri ve geçiş işleyicisi', () => {
  const changes = [];
  const tree = ActorsSubtabsBar({
    activeSubTab: 'actors',
    favoriteCount: 7,
    onSubTabChange: (subTab) => changes.push(subTab),
  });

  const markup = renderMarkup(tree);
  assert.ok(markup.includes('role="tablist"'));
  assert.ok(markup.includes(UI_COPY.actors.actorsTab));
  assert.ok(markup.includes(UI_COPY.actors.recommendationsTab));
  assert.ok(markup.includes('aria-label="Favori oyuncular görünümü"'));
  assert.ok(markup.includes('>7<'), 'oyuncu sayısı render edilmeli');

  const actorsTab = findButtonByText(tree, UI_COPY.actors.actorsTab);
  const recommendationsTab = findButtonByText(tree, UI_COPY.actors.recommendationsTab);
  assert.equal(actorsTab.props['aria-selected'], true);
  assert.equal(recommendationsTab.props['aria-selected'], false);
  assert.ok(
    String(actorsTab.props.className).includes('is-active'),
    'aktif sekme sınıfı uygulanmalı'
  );

  recommendationsTab.props.onClick();
  actorsTab.props.onClick();
  assert.deepEqual(changes, ['recommendations', 'actors']);
});

test('F5.2-01 shouldHideSecondaryToolbar: yalnızca Listem + Favori Oyuncular ikincil çubuğu gizler', () => {
  assert.equal(shouldHideSecondaryToolbar('list', 'actors'), true);
  assert.equal(shouldHideSecondaryToolbar('list', 'all'), false);
  assert.equal(shouldHideSecondaryToolbar('list', 'watching'), false);
  assert.equal(shouldHideSecondaryToolbar('discover', 'actors'), false);
  assert.equal(shouldHideSecondaryToolbar('home', ''), false);
});
