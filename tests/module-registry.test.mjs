import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MODULES,
  getModule,
  getModuleByShortcut,
  getModuleByHash,
  moduleHash,
} from "../src/app/module-registry.ts";
import {
  SIDEBAR_NAV_ITEMS,
  HEADER_NAV_ITEMS,
  DOCK_NAV_ITEMS,
  SHORTCUT_TAB_MAP,
  tabFromHash,
  hashForTab,
} from "../src/app/navigation.ts";

describe("M1: modül kayıt defteri", () => {
  it("her modülün benzersiz kimliği, kısayolu ve hash'i vardır", () => {
    const ids = new Set(MODULES.map((m) => m.id));
    assert.equal(ids.size, MODULES.length);
    const shortcuts = new Set(MODULES.map((m) => m.shortcut));
    assert.equal(shortcuts.size, MODULES.length);
    const hashes = new Set(MODULES.map((m) => m.hash));
    assert.equal(hashes.size, MODULES.length);
    for (const m of MODULES) {
      assert.match(m.shortcut, /^[1-4]$/u, `${m.id} kısayolu 1-4 arasında olmalı`);
      assert.ok(m.label.length > 0);
      assert.ok(m.iconRef.startsWith("#icon-"));
    }
  });

  it("getModule / getModuleByShortcut / getModuleByHash tutarlı çözümler", () => {
    for (const m of MODULES) {
      assert.equal(getModule(m.id)?.id, m.id);
      assert.equal(getModuleByShortcut(m.shortcut)?.id, m.id);
      assert.equal(getModuleByHash(m.hash)?.id, m.id);
      assert.equal(getModuleByHash(`/${m.hash}`)?.id, m.id);
      assert.equal(getModuleByHash(`/${m.hash.toUpperCase()}`)?.id, m.id);
    }
    assert.equal(getModule("yok"), undefined);
    assert.equal(getModuleByShortcut("9"), undefined);
    assert.equal(getModuleByHash("bilinmeyen"), undefined);
  });

  it("moduleHash doğru adres üretir", () => {
    assert.equal(moduleHash("discover"), "#/discover");
    assert.equal(moduleHash("relationships"), "#/relationships");
  });
});

describe("M1: navigasyon türetimi", () => {
  it("kenar çubuğu, üst sekme ve dock listeleri kayıttan türetilir", () => {
    assert.equal(SIDEBAR_NAV_ITEMS.length, MODULES.length);
    assert.equal(HEADER_NAV_ITEMS.length, MODULES.length);
    for (let i = 0; i < MODULES.length; i += 1) {
      assert.equal(SIDEBAR_NAV_ITEMS[i].id, MODULES[i].id);
      assert.equal(SIDEBAR_NAV_ITEMS[i].label, MODULES[i].label);
      assert.equal(HEADER_NAV_ITEMS[i].id, MODULES[i].id);
    }
  });

  it("mobil dock mevcut UX'i korur: list→discover→taste-map sırası ve 'Kütüphane' etiketi", () => {
    assert.deepEqual(
      DOCK_NAV_ITEMS.map((item) => item.id),
      ["list", "discover", "taste-map"]
    );
    assert.equal(DOCK_NAV_ITEMS[0].label, "Kütüphane");
    assert.equal(DOCK_NAV_ITEMS[1].label, "Keşfet");
    assert.equal(DOCK_NAV_ITEMS[2].label, "Zevkim");
    assert.equal(DOCK_NAV_ITEMS.find((item) => item.id === "list")?.counter, "myList");
  });

  it("kısayol haritası 1-4 → modül eşlemesi içerir", () => {
    assert.deepEqual(SHORTCUT_TAB_MAP, {
      "1": "discover",
      "2": "list",
      "3": "taste-map",
      "4": "relationships",
    });
  });
});

describe("M1: hash yönlendirme", () => {
  it("hash ↔ sekme çift yönlü dönüşümü kayıpsızdır", () => {
    for (const m of MODULES) {
      const hash = hashForTab(m.id);
      assert.ok(hash.startsWith("#/"));
      assert.equal(tabFromHash(hash), m.id);
    }
  });

  it("tanınmayan hash'ler null döner ve sekme durumunu bozmaz", () => {
    assert.equal(tabFromHash(""), null);
    assert.equal(tabFromHash("#"), null);
    assert.equal(tabFromHash("#/bilinmeyen"), null);
    assert.equal(tabFromHash("#/DISCOVER"), "discover");
  });
});
