import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES } from '../src/app/module-registry.ts';
import {
  DOCK_NAV_ITEMS,
  HEADER_NAV_ITEMS,
  MOBILE_OVERFLOW_ITEMS,
  SETTINGS_SHORTCUT,
  SHORTCUT_TAB_MAP,
  SIDEBAR_NAV_ITEMS,
  tabFromHash,
} from '../src/app/navigation.ts';

test('masaüstü sekmeleri kayıt defterindeki tüm modülleri kapsar', () => {
  assert.equal(HEADER_NAV_ITEMS.length, MODULES.length);
  assert.deepEqual(
    HEADER_NAV_ITEMS.map((item) => item.id),
    MODULES.map((module) => module.id)
  );
});

test('her masaüstü sekmesi erişilebilir ad ve ikon taşır', () => {
  for (const item of HEADER_NAV_ITEMS) {
    assert.ok(item.label.trim().length > 0, `${item.id} etiketi boş olamaz`);
    assert.match(item.iconRef, /^#[a-z-]+$/, `${item.id} ikon referansı geçerli olmalı`);
  }
  for (const item of SIDEBAR_NAV_ITEMS) {
    assert.ok(item.label.trim().length > 0);
  }
});

test('dock + taşma menüsü tüm modülleri tam olarak bir kez kapsar', () => {
  const dockIds = DOCK_NAV_ITEMS.map((item) => item.id);
  const overflowIds = MOBILE_OVERFLOW_ITEMS.map((item) => item.id);
  const all = [...dockIds, ...overflowIds];

  assert.equal(new Set(all).size, all.length, 'aynı modül iki yerde listelenmemeli');
  assert.deepEqual(
    [...all].sort(),
    MODULES.map((module) => module.id).sort(),
    'mobilde her modüle erişim olmalı'
  );
});

test('kısayollar benzersiz ve ayarlar kısayolu modüllerle çakışmıyor', () => {
  const shortcuts = MODULES.map((module) => module.shortcut);
  assert.equal(new Set(shortcuts).size, shortcuts.length, 'kısayol çakışması olmamalı');
  assert.ok(!shortcuts.includes(SETTINGS_SHORTCUT), '0 ayarlara ayrılmış olmalı');
  for (const module of MODULES) {
    assert.equal(SHORTCUT_TAB_MAP[module.shortcut], module.id);
  }
});

test('hash yönlendirmesi her modülü çözer ve bilinmeyeni reddeder', () => {
  for (const module of MODULES) {
    assert.equal(tabFromHash(`#/${module.hash}`), module.id);
  }
  assert.equal(tabFromHash('#/bilinmeyen'), null);
  assert.equal(tabFromHash(''), null);
});
