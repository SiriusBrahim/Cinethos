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
  SIDEBAR_NAV_GROUPS,
  SIDEBAR_NAV_ITEMS,
  HEADER_NAV_ITEMS,
  DOCK_NAV_ITEMS,
  MOBILE_OVERFLOW_ITEMS,
  SHORTCUT_TAB_MAP,
  SETTINGS_SHORTCUT,
  tabFromHash,
  hashForTab,
} from "../src/app/navigation.ts";

describe("M1: modül kayıt defteri", () => {
  it("bilgi mimarisindeki yedi modülü sırayla tanımlar", () => {
    assert.deepEqual(
      MODULES.map((m) => m.id),
      ["home", "discover", "list", "taste-map", "relationships", "series", "operations"]
    );
  });

  it("her modülün benzersiz kimliği, kısayolu ve hash'i vardır", () => {
    const ids = new Set(MODULES.map((m) => m.id));
    assert.equal(ids.size, MODULES.length);
    const shortcuts = new Set(MODULES.map((m) => m.shortcut));
    assert.equal(shortcuts.size, MODULES.length);
    const hashes = new Set(MODULES.map((m) => m.hash));
    assert.equal(hashes.size, MODULES.length);
    for (const m of MODULES) {
      assert.match(m.shortcut, /^[1-9]$/u, `${m.id} kısayolu 1-9 arasında olmalı`);
      assert.ok(m.label.length > 0);
      assert.ok(m.iconRef.startsWith("#icon-"));
      assert.ok(m.keywords.length > 0);
    }
    assert.equal(SETTINGS_SHORTCUT, "0");
    assert.equal(SHORTCUT_TAB_MAP[SETTINGS_SHORTCUT], undefined, "ayarlar kısayolu modül değildir");
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
    assert.equal(moduleHash("home"), "#/home");
    assert.equal(moduleHash("discover"), "#/discover");
    assert.equal(moduleHash("series"), "#/series");
    assert.equal(moduleHash("operations"), "#/operations");
  });
});

describe("M1: navigasyon türetimi", () => {
  it("kenar çubuğu grupları tüm modülleri tam olarak bir kez kapsar", () => {
    assert.deepEqual(
      SIDEBAR_NAV_GROUPS.map((group) => group.id),
      ["overview", "library", "analysis", "system"]
    );
    const groupedIds = SIDEBAR_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    // Gruplandırma sırayı değiştirir (Seriler arşivde, Zevkim analizde);
    // kapsam tam ve tekrarsız olmalıdır.
    assert.deepEqual([...groupedIds].sort(), [...MODULES.map((m) => m.id)].sort());
    assert.equal(new Set(groupedIds).size, MODULES.length);
    assert.equal(SIDEBAR_NAV_ITEMS.length, MODULES.length);
    for (const group of SIDEBAR_NAV_GROUPS) {
      assert.ok(group.items.length > 0, `${group.id} grubu boş olmamalı`);
    }
  });

  it("üst sekmeler kayıt defterinin tamamını sırayla taşır", () => {
    assert.deepEqual(
      HEADER_NAV_ITEMS.map((item) => item.id),
      MODULES.map((m) => m.id)
    );
  });

  it("mobil dock dört birincil sekmeyi, taşma sayfası kalanları taşır", () => {
    assert.deepEqual(
      DOCK_NAV_ITEMS.map((item) => item.id),
      ["home", "discover", "list", "taste-map"]
    );
    assert.equal(DOCK_NAV_ITEMS[2].label, "Kütüphane");
    assert.equal(DOCK_NAV_ITEMS.find((item) => item.id === "list")?.counter, "myList");

    const combined = [...DOCK_NAV_ITEMS.map((item) => item.id), ...MOBILE_OVERFLOW_ITEMS.map((item) => item.id)];
    assert.deepEqual(combined, MODULES.map((m) => m.id), "dock + taşma tüm modülleri kapsamalı");
    assert.deepEqual(
      MOBILE_OVERFLOW_ITEMS.map((item) => item.id),
      ["relationships", "series", "operations"]
    );
  });

  it("kısayol haritası kayıt defteriyle birebir aynıdır", () => {
    assert.deepEqual(SHORTCUT_TAB_MAP, {
      "1": "home",
      "2": "discover",
      "3": "list",
      "4": "taste-map",
      "5": "relationships",
      "6": "series",
      "7": "operations",
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
