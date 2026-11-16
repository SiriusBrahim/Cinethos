# Cinethos — Denetim Planı (6. Tur: Modüler Mimari Dönüşümü)

> Baz: `master` @ `ef031af` · Önceki raporlar: `CODE_REVIEW_REPORT.md`, `DEEP_DIVE_REVIEW.md`
> Karar: Önceki planın Y2–Y7 kalemleri **bekletiliyor** (§C'de saklandı). Aktif iş: **M1 — modüler mimari + navigasyon dönüşümü.**
>
> **6. tur güncellemesi:** `ef031af` ile `src/app/` kabuğu (AppSidebar, AppFooter, AppModals, MobileDock/TopBar/Dashboard), `src/design-system/` kartları ve SQLite birincil depolama geldi. M1 artık sıfırdan kurmak değil, **mevcut kabuğu tamamlamaktır**; navigasyon kopyası 4'ten 5'e çıkmıştı (yeni MobileDock kendi listesini tutuyordu) — kayıt defteri hepsini birleştirir.

---

## M1 Öncesi Mimari Görüş: "Ajan Sistemi" Verimli mi?

**Kısa cevap: Evet ama doğru varyantıyla.** Yönetici + altında iş başına modül şekli bu kod tabanına tam oturuyor; buna karşılık *gerçek* ajan sistemi (çalışma zamanında modül keşfi, otonom mesajlaşma, genel amaçlı event bus) bu ürün için **aşırı mühendislik** olur — akışlar deterministik, kullanıcı tek, gereksinim yok.

**Önerilen desen: Modüler Monolit + Orkestratör Kabuk (registry tabanlı).**

Neden verimli olduğu (ölçülmüş kanıtlar):
1. **`App.tsx` 4.570 satır, 39 `useState`, `createContext` = 0** — her yeni özellik App'e dokunuyor; modül sınırı çizmek merge/regresyon riskini kökten azaltır.
2. **Navigasyon 4 yerde kopya:** `FloatingGlassDock.tsx` (`DOCK_ITEMS` + `ShellTabId`), `Header.tsx` (hardcoded 4 tab), `useKeyboardShortcuts.ts` (1-4 tuşları), `CommandPalette`. Tek kayıt defteri bu dört kopyayı öldürür; yeni modül eklemek = tek manifest dosyası.
3. Mevcut altyapı zaten yarı yolda: `lazyWithRetry` (`App.tsx:5-8`), `cmdk` paleti, `candidate-pool-store-port.ts` port deseni, `core/taste/` modülerliği — kabuk bunların üzerine **tek yönetim katmanı** ekler.

Kaçınılacaklar: dinamik plugin yükleme, DI framework'ü, string tabanlı yayın-abone bus'u. Bunun yerine **statik, tipli, tree-shakeable** manifest kaydı + küçük tipli olay arayüzü.

---

## M1 — Tek Seferde Uygulanacak Dönüşüm (tek dal, tek teslim)

### Hedef yapı

```
src/
  app/
    AppShell.tsx            # YÖNETİCİ: registry, aktif modül çözümleme, provider'lar (~400 satır)
    module-registry.ts      # Modül manifest'lerinin kaydı + sıralama
    navigation.ts           # Registry'den sidebar/dock/tabs/shortcut/palette türetimi
    shell-context.tsx       # Paylaşılan servisler: profileStore, toast, auth, tmdb, sync
    shell-events.ts         # Tipli çapraz-modül olayları (~40 satır)
  modules/
    discover/               # manifest.ts + DiscoverView.tsx + state.ts (filtre/sayfalama)
    list/                   # manifest.ts + ListView.tsx + state.ts (durumlar, aktörler)
    taste-map/              # mevcut TasteMapView etrafına manifest
    relationships/          # mevcut RelationshipExplorer etrafına manifest
    settings/               # ProfilModal + senkron + yedek + arşiv (bugün modal olanlar)
    detail/                 # DetailModal + PersonDrawer → shell servisi (her modül çağırır)
  shared/                   # mevcut components/, services/, utils/ (dokunulmaz)
  core/                     # DOKUNULMAZ (zaten temiz, 767 test korunuyor)
```

### Modül manifest sözleşmesi

```ts
// src/app/module-registry.ts
export interface AppModuleManifest {
  id: ModuleId;                          // 'discover' | 'list' | 'taste-map' | 'relationships' | 'settings'
  nav: {
    label: string;
    Icon: React.ComponentType<{ className?: string }>;
    section: 'main' | 'settings';        // dock/üst çubuk vs. ayarlar menüsü
    order: number;
    shortcut?: string;                   // '1'..'5'
    badge?: (ctx: ShellContext) => number | undefined;   // örn. Listem sayısı
  };
  Component: React.LazyExoticComponent<React.ComponentType<ModuleProps>>;
  paletteCommands?: (ctx: ShellContext) => PaletteCommand[];   // cmdk girdileri
  onActivate?: (ctx: ShellContext) => void | (() => void);     // cleanup dönebilir
}
```

### Navigasyon güncellemesi (tek kaynak)

1. **`navigation.ts`**: `registry` → `headerTabs`, `dockItems`, `shortcutMap`, `paletteEntries` türetimi. `ShellTabId` tek yerde tanımlanır; `FloatingGlassDock`, `Header`, `useKeyboardShortcuts`, `CommandPalette` **props olarak türetilmiş listeyi alır**, kendi kopyasını siler.
2. **Deep-link (hash tabanlı):** `#/discover`, `#/list`, `#/taste-map`, `#/relationships`, `#/settings` + alt durum (`#/discover/stock`, `#/list/watching`). `hashchange` dinleyicisi AppShell'de; sunucu tarafı gerektirmez → PWA/çevrimdışı ve `createSpaFallbackMiddleware` ile uyumlu. Açılışta hash'ten ilk modül çözümlenir; modül değişince `history.replaceState`.
3. **Mobil dock:** `DOCK_ITEMS` silinir; `section: 'main'` modüllerinden otomatik üretilir (mevcut görsel sınıflar manifest'e taşınır).
4. **Ayarlar:** `settings` modülü `section: 'settings'` ile dock dışında kalır; mevcut `onOpenSettings` akışı registry üzerinden çözümlenir.

### AppShell (yönetici) sorumlulukları — tek dosya, tek doğruluk

- Registry'den aktif modülü çözümleme (hash + shortcut + palette komutu)
- `ShellContext` sağlama: aktif profil + items (`profile-context`), toast kuyruğu, auth (`api-client` + `AuthTokenModal`), tmdb kaynak durumu, senkron durumu
- Modül yaşam döngüsü: `onActivate` cleanup, `lazyWithRetry` + ErrorBoundary sarmalama (mevcut desen korunur)
- Tipli olaylar (`shell-events.ts`): `item:saved`, `profile:changed`, `sync:completed` — modüller yalnızca kabukla konuşur, birbirleriyle değil

### Yürütme durumu (tek dalda commit serisi — faz değil, teslim içindeki doğal sıra)

1. ✅ `app/module-registry.ts` — `ModuleId`/`MainTab` tipleri + `MODULES` kaydı + çözümleyiciler (id/shortcut/hash)
2. ✅ `app/navigation.ts` — `SIDEBAR_NAV_ITEMS`, `HEADER_NAV_ITEMS`, `DOCK_NAV_ITEMS` (mevcut mobil UX sırası/etiketleri korunarak), `SHORTCUT_TAB_MAP`, hash yardımcıları
3. ✅ `app/useHashNavigation.ts` — `#/discover…#/relationships` çift yönlü eşitleme (açılışta hash'ten çözümleme, `hashchange` geri/ileri desteği, `replaceState` ile geçmiş kirlenmeden sekme→hash)
4. ✅ Navigasyon kopyalarının silinmesi: `AppSidebar`, `Header`, `MobileDock`, `useKeyboardShortcuts` artık kayıttan türetilmiş listeleri kullanıyor; `MobileTabBar.tsx`'in `MainTab`'i kayıt defterine devredildi (`@deprecated` re-export)
5. ✅ Sözleşme testleri: `tests/module-registry.test.mjs` (8 test: benzersizlik, çözümleyiciler, dock UX korunumu, hash kayıpsızlığı)
6. ✅ `app/shell-context.tsx` — `ShellProvider`/`useShell`/`useOptionalShell`; 8 kabuk aksiyonu (openDetails, openQuickSave, setStatus, toggleDislike, refreshTasteMap, openCommandPalette, openAddCustom, openProfile)
7. ✅ `app/shell-events.ts` — tipli `ShellEventMap` (`item:saved`, `item:disliked`, `profile:changed`, `sync:completed`) + emit/subscribe/reset; App'te dört yayın noktası bağlandı (commitSavedItem, handleToggleDislike, handleSwitchProfile, mergeRemoteDocumentIntoState); `tests/shell-events.test.mjs` (5 sözleşme testi)
8. ✅ `modules/taste-map/TasteMapSection.tsx` + `modules/relationships/RelationshipsSection.tsx` — registry `Section` alanından tembel yüklü; chunk'lar korundu (TasteMapSection 14 kB, RelationshipsSection 28.6 kB, TasteProfileDashboard/Minimal ayrı)
9. ✅ `modules/discover/DiscoverSection.tsx` + `modules/list/ListSection.tsx` — Hero/Stats + ortak MediaGrid modüllere taşındı; Controls slot olarak paylaşılıyor (`controlsNode`), MediaGrid propları tek yerde (`catalogGrid`); registry'de statik Section (varsayılan sekme Suspense flaşı olmasın)
10. ✅ `CommandPalette` sekme komutları `MODULES`'ten türetildi; `ModuleDefinition.keywords` alanı eklendi; `PaletteTab` → `ModuleId` takma adı
11. ⏳ Sırada: katalog/öneri/senkron mantığının kancalara çıkarılması (`useCatalog`, `useForYou`, `useProfiles`, `useSync`) → `App.tsx` < 1.000 satır; `settings` modül manifesti (ProfilModal içeriği) + `detail` kabuk servisi (DetailModal/PersonDrawer); `useShell` tüketicilerinin artırılması (şu an 2 bölüm)

**Doğrulama (7. tur itibarıyla):** 422/422 birim + 362 taste testi yeşil · lint (`--max-warnings 0`) yeşil · build başarılı, code-splitting korundu.

### Güvence (big-bang riskine karşı — değişmeden korunanlar)

- **767 test** (405 birim + 362 taste) değişmeden yeşil kalmalı; `core/` ve `server/` katmanına **sıfır dokunuş**
- 5 Playwright E2E spec'i + üretim smoke testi (CI) yeşil kalmalı
- Her commit sonrası: `npm run lint && npm test && npm run test:taste && npm run build`
- Kabul kriterleri: `App.tsx` < 1.000 satır · `createContext` > 0 · navigasyon kopyası = 1 · yeni modül eklemek = tek `manifest.ts` + view dosyası · hash deep-link çalışır

---

## C. Bekletilen Kalemler (önceki plandan — aklımızda, M1 sonrası)

| Kalem | Özet |
| --- | --- |
| Y2 | Delta yazma yolu: `PUT /api/profiles/:profileId` + `pushProfileDelta` (tam belge PUT kaldırılır) |
| Y3 | Depo hijyeni: `phase-0-findings.md` → `docs/`; README "eski ad: Cinethos" notu + CI badge |
| Y4 | E2E'ye `firefox` + `webkit` projeleri |
| Y5 | Çok dillilik: `tr.ts`/`en.ts` bölmesi, `navigator.language` tespiti |
| Y6 | Yenilikler: Zevk Anlatıcısı (LLM özet) · Ortak izleme listesi (`watch-party.json`) · Semantik arama (worker içi indeks) · Prediktif detay ısınması · Zevk İkizi |
| Y7 | Gerçek `runtime` ile izleme süresi; `DetailModal`'a fragman embed'i |

> **Not:** M1'in modül yapısı Y6'yı kolaylaştırır — her yenilik artık tek manifest + view dosyası olacak. Y2 (delta yazma) M1'den hemen sonra gelmeli; `modules/list/state.ts` yazma çağrılarını tek yerden topladığı için geçiş maliyeti düşer. `ef031af`'teki SQLite birincil depolama (`sqlite-primary-store.ts`) Y2'nin tasarımını etkilemez: delta API yine `app.ts` katmanında açılır, sürücü farkı `storage.ts` içinde kalır.
