# MIA Faz 7 — Uygulama + Arayüz: tek veri hattı ve yönetici bağlaması

> Durum: **TAMAMLANDI** · Kapsam: Yönetici 1 (`src/app/`) + Yönetici 2 (`src/presentation/`) +
> Kütüphane Yöneticisi istemci yüzü (`src/modules/library/client-service.ts`)

## 1. Amaç

MIA planı §7 Faz 7: "mobil kart sistemi ve masaüstü yöneticilere bağlanır; **tüm veri
işlemleri yönetici servisleri üzerinden** geçer."

Bu fazın ölçütü satır sayısı değil, **tek yol** kuralıdır:

1. Arayüzün hangi parçası (mobil kart, masaüstü modal, çekmece, dashboard) olursa olsun
   kullanıcı kütüphanesine yazan her işlem **tek** bir servis hattından geçer.
2. Mobil ve masaüstü **aynı iş mantığını** kullanır; fark yalnızca sunumdur.
3. Gezinme listeleri **modül kayıt defterinden** türetilir; hiçbir bileşen kendi sekme
   listesini tutmaz.

## 2. Yapılan işler

### 2.1 `ClientLibraryService` — istemci kütüphane hattı (yeni)

`src/modules/library/client-service.ts`

| Komut | Metot | Kural kaynağı |
|---|---|---|
| `save` | `saveItem` | `modules/library/operations.ts` → `buildLibraryItem` |
| `rate` | `rateItem` | aynı (`forceRatedAt`, izlenecekler → izlendi geçişi) |
| `set-status` | `setItemStatus` / `markCompleted` / `addToWatchlist` | aynı (mevcut puan korunur) |
| `remove` | `removeItem` | tombstone + liste filtresi (içerik metadata'sına dokunmaz) |
| `advance-episode` | `advanceEpisode` | `core/tv-progress.ts` (saf çekirdek) |
| `merge-duplicates` | `mergeDuplicates` | `core/duplicate-detector.ts` (saf çekirdek) |
| `dislike` / `hide` | `dislikeItem` / `hideItem` | TP-018 zevk olayları (çekirdek değişmedi) |

Tasarım kuralları:

- **Kalıcılık enjekte edilir:** servis React, IndexedDB, sunucu ya da dosya bilmez.
  `applySavedItem`, `applySavedItems`, `applyTombstone`, `onItemRemoved` çağıran tarafından
  verilir. Böylece sunucu/istemci sınırı ve mevcut kalıcılık davranışı korunur.
- **Olay katmanı tekildir:** mevcut `AppEventBus` sözleşmesi (`createAppEvent`) kullanılır;
  ikinci bir EventBus/kuyruk/persistent katman kurulmaz.
- **Profil izolasyonu:** `profileContext.assertWritable` hattın içinde uygulanır; ref yoksa
  mevcut uyumluluk davranışı (`{ profileId: 'default', revision: 0 }`) korunur.
- **Davranış korunumu:** `handleRemoveItem`, `handleIncrementTvEpisode`, `handleMergeDuplicates`
  daha önce `App.tsx` içinde satır satır uygulanıyordu; kurallar birebir hatta taşındı,
  kullanıcı verisi biçimi (`deleted_keys`, `ratedAt`, `completedAt`, `episodes_watched`)
  değişmedi.

### 2.2 `useItemActions` — uyumluluk adaptörü

`src/hooks/useItemActions.ts` artık kural üretmez:

- `service` verilirse aynı hattı paylaşır (App tek örnek kurar).
- Verilmezse kendi örneğini kurar (mevcut çağıranlar ve testler bozulmaz).
- `emitDislikeTasteEvent`, `emitHideTasteEvent`, `mapWatchStatusToLibraryList`,
  `resolveItemActionTimestamps` eski import yolları için yeniden dışa açılır.

### 2.3 `App.tsx` — tek hat bağlaması

- `createClientLibraryService({ getSavedItems, applySavedItem, applySavedItems, applyTombstone })`
  tek kez kurulur; `useItemActions`'a **aynı örnek** verilir.
- Kaldırma, bölüm ilerletme ve çift kayıt birleştirme artık `libraryService` üzerinden yürür;
  `App.tsx` içinde `buildLibraryItem` / `resolveItemActionTimestamps` çağrısı yoktur.
- Mesaj/gösterim yan etkileri (toast, zevk haritası işareti, otomatik yedek) sunum
  katmanında kaldı; veri yazımı hatta kaldı.

### 2.4 Mobil yerleşim — `src/presentation/layouts/MobileLayout.tsx` (yeni)

- `MOBILE_NAV_ITEMS`, `MODULES` kayıt defterinden türetilir (`MOBILE_LABEL_OVERRIDES`
  yalnızca görünen metni korur: `relationships → "İlişkiler"`).
- `MobileBottomNav` 56px yapışkan alt gezinmeyi render eder; `App.tsx`'teki elle yazılmış
  dört düğümlük kopya **silindi**.

### 2.5 Masaüstü gezinme — `Header.tsx`

- Üst sekmeler `HEADER_NAV_ITEMS` (kayıt defteri) üzerinden üretilir; masaüstü etiketi
  `taste-map → "Kimliğim"` olarak korunur.
- **Hata giderildi:** Header daha önce `onTabChange('identity')` / `onTabChange('universes')`
  çağırıyordu; bu kimlikler `ModuleId` değildi ve App'in sekme durumuna yazılamıyordu
  (tıklama yanlış bölümü gösteriyordu). Artık `taste-map` ve `relationships` kimlikleri
  kullanılıyor.

## 3. Kanıt

`tests/phase7-ui-service-pipeline.test.mjs` (5 test):

| Test | Kanıt |
|---|---|
| F7-1 | Mobil ve masaüstü çağıranı aynı komut dizisinde **birebir aynı** kaydı üretir; her komut tek sink çağrısı yapar (çift yazım yok) |
| F7-2 | Sekiz komutun tamamı (`CLIENT_LIBRARY_COMMANDS`) hattan geçer; tombstone/yan etki kancaları enjekte edilir |
| F7-3 | `useItemActions` paylaşılan hattı kullanır; kendi sink'ini çağırmaz |
| F7-4 | `App.tsx` tek hat kurar, mobil/masaüstü gezinme kayıttan türer, `identity`/`universes` geri gelmez, App kendi kuralını uygulamaz |
| F7-5 | Tek kural kaynağı: hat `operations.ts`'i kullanır, adaptör kural kopyası taşımaz, paralel EventBus/SQLite kurulmaz |

`tests/phase3-ui-write-paths.test.mjs` F3-E1, tek-kaynak garantisini yeni hatta göre
güncellendi (kural hâlâ `modules/library/operations.ts`'te; hook artık adaptör).

## 4. Doğrulama (bu dalda)

| Komut | Sonuç |
|---|---|
| `npm run lint` (eslint + tsc + tsconfig.tests) | **0** |
| `npm test` | **524/524** (Faz 7 öncesi 519 + 5 yeni) |
| `npm run test:taste` | **436/436** |
| `npm run build` | başarılı |
| `tests/architecture-boundaries.test.mjs` (npm test içinde) | döngü **0**, yeni ihlal **yok** |

## 5. Kapsam dışı bırakılanlar (açık iş)

- **`forYou*` / `catalog*` durum kancalarının** `modules/discover/state.ts`'e taşınması
  (Faz 6 raporundaki açık madde). Bu fazda okuma tarafı yeniden düzenlenmedi; yazma tarafı
  tek hatta alındı.
- **`src/app/mobile/` eski kullanılmayan kabuk bileşenleri** (`MobileDashboard`,
  `MobileDock`, `MobileTopBar`) `presentation/` altına taşınmadı; uygulamada render
  edilmiyorlar. Taşıma/silme Faz 8 temizlik kapsamına bırakıldı.
- **`ILibraryService`/`IContentService` sunucu servislerinin** istemciye açılması
  (çevrimdışı öncelikli mimari korunuyor; istemci yazımı yerel hattan, sunucu eşitlemesi
  mevcut API üzerinden yürür).
- **Zevk/hafıza/ilişki yöneticileri** (Faz 5 açık işi) hâlâ ayrı ele alınmalı.
