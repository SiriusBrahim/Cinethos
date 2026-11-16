# MIA Faz 0 — Fonksiyon Bazında Sahiplik ve Taşıma Tablosu

> **Kapsam:** 900 satır üzeri 15 dosya; üst düzey bildirimlerin tam listesi [`faz0-envanter-veri.md` §12](./faz0-envanter-veri.md#12-büyük-dosya-bildirimleri-900-satır) içinde satır numaralarıyla üretilir (`npm run inventory:arch`).
> **Yöntem:** Satır aralıkları dosyalardaki gerçek bölüm başlıklarından ve bildirim satırlarından okundu. Yönetici ataması MIA planı §1'deki 8 yöneticiye göre yapıldı; **taşıma sırası** Faz 2–7'dir, bu tablo taşımayı başlatmaz.
> **İşaretler:** ● sahip (yazan/karar veren) · ○ okuyucu · — ilgisiz. "≈" satır sınırının bölüm başlığına göre yaklaşık olduğunu gösterir.

## 1. Özet — 5 dev dosyanın sorumluluk dağılımı

| Dosya | Satır | Baskın sorumluluk | Taşınacağı yöneticiler |
| --- | --- | --- | --- |
| `src/App.tsx` | 4.651 | Kabuk state'i, sunucu senkron akışı, katalog/öneri hattı, işlem işleyicileri | Uygulama (kabuk), Veri (senkron), Öneri (katalog hattı), Kütüphane (işlemler), Deneyim (render) |
| `src/core/cinethos-core.ts` | 4.691 | Veri modeli, normalizasyon, puanlama, Zevk Haritası, aday havuzu | Veri (model), İçerik (normalizasyon), Kütüphane (kayıt yardımcıları), Öneri (puanlama/havuz), Zevk (harita) |
| `src/server/persistent-store.ts` | 4.230 | Katalog / türetilmiş profil / stok / künye / GitHub durum dosyaları | İçerik (katalog, stok, künye), Veri (dosya, senkron durumu) |
| `src/server/github-bidirectional-sync.ts` | 4.754 | Uzak dosya denetimi + kayıpsız iki yönlü birleştirme | Veri/Senkron (Faz 2'de `SyncStorePort` arkasına) |
| `src/server/excel-profile-backup.ts` | 3.447 | Excel/JSON profil yedeği, poster yerleşimi, XLSX paketleme | Veri (yedek), İçerik (poster) |

## 2. `src/App.tsx` — blok bazında

| ≈ Satır | Blok | ● Sahip | ○ Okuyan | Faz |
| --- | --- | --- | --- | --- |
| 1–221 | Import, M1 modül kayıt defteri, tipler | Uygulama | — | 7 |
| 222–342 | `loadInitialProfiles`, `loadProfileItems`, `*StorageKey` — localStorage okuma yardımcıları | **Veri** | Uygulama | 2 |
| 343–484 | Profil/liste/keşif state'leri, toast | Uygulama | — | 7 |
| 485–702 | Açılış efektleri: stok arındırma, IDB migration, poster yamaları, `ct:ui-prefs` | Uygulama | İçerik, Deneyim | 7 |
| 703–790 | `PROFILES_STORAGE` kotaya dayanıklı yazım, `persistProfilesBestEffort` | **Veri** | — | 2 |
| 791–1002 | `buildCurrentLivePayloadFromRefs`, `buildCurrentPayload`, `handleMergedServerDocument`, çakışma çözümü | **Veri** | Uygulama | 2 |
| 1003–1361 | Sunucuya gönderme/çekme, revizyon ilerlemesi, görünürlük senkronu, IDB kurtarma | **Veri** | — | 2 |
| 1383–1461 | Tür listesi, çıkış hatırlatıcıları (`checkReleaseReminders`) | İçerik | Uygulama | 3 |
| 1462–2695 | `loadCategoryResults`, `fetchDiscoverPageByCategory`, aday havuzu, zenginleştirme, `scoreCandidatesV3` çağrıları | **Öneri** | İçerik, Zevk | 6 |
| 2696–2844 | `handleRefreshForYou`, `handleRefreshTasteMap`, tür/tür-filtresi seçimi | Öneri | Zevk | 6 |
| 2845–2977 | Arama, sayfalama, stok tamamlama | İçerik | — | 3 |
| 2978–3227 | `handleSaveItem`, `handleSetStatus`, `handleRemoveItem`, `handleToggleDislike`, `handleToggleHide`, TV bölüm artırma | **Kütüphane** | Zevk, Öneri | 3 |
| 3228–3390 | SQLite arşivi oluşturma/geri yükleme | Veri | — | 2 |
| 3898–4150 | Profil adı/geçiş/oluşturma, `handleSavePreferences`, hatırlatıcı, demo modu, yedek dışa/içe aktarma | **Uygulama** | Veri | 7 |
| 4151–4325 | `useShell()` kabuk eylemleri, modül ortak parçaları | Uygulama | Tüm modüller | 7 |
| 4326–4651 | `return (...)`: `AppSidebar`, `MobileDock`, modallar, bölüm yuvaları | **Deneyim** | — | 7 |

**Faz 7 kararı:** App.tsx'te yeni iş mantığı yazılmaz. 2978–3227 bloğu Faz 3'te `library/operations/*` altına, 791–1361 Faz 2'de `data/synchronization/` altına, 1462–2844 Faz 6'da `modules/discover/state.ts` altına taşınır. Kalan state kabuğu `AppShell.tsx` + `useProfiles` olur.

## 3. `src/core/cinethos-core.ts` — blok bazında

| ≈ Satır | Blok | ● Sahip | ○ Okuyan | Faz |
| --- | --- | --- | --- | --- |
| 1–214 | Sabitler ve tipler: `DataDocument`, `Profile`, `Preferences`, `SavedItem`, `NextEpisode`, limitler | **Veri** | Tüm katmanlar (57 dosya `SavedItem`) | 1 |
| 215–371 | `normalizeFavoriteActor`, `normalizeSavedItem`, `sanitizeSeasonProgress`, `safeHttpsUrl` — içerik metaverisi doğrulama | **İçerik** | Kütüphane | 3 |
| 372–632 | `findSavedItem`, `buildSavedItemsIndex`, `filterHistoryByType`, `dedupeItems` | **Kütüphane** | Öneri, Zevk | 3 |
| 633–942 | `parseBackupText`, `normalizeProfile`, `normalizeDataDocument`, `createRequestGate` — belge kurtarma/normalizasyon | **Veri** | Sunucu, istemci | 2 |
| 943–1422 | `RECOMMENDATION_WEIGHTS_V3`, `actorFrequency`, `pairMatchScore`, `castHarmonyScore`, `extractOverviewTokens` | **Öneri** | Zevk | 6 |
| 1423–2787 | `calculateTastePillars`, `buildTasteProfileSummary`, `updateTasteMapWithBatch`, `recordDisplayedRecommendations`, `archiveTasteMapEntry` | **Zevk** | Öneri, İlişki | 5 |
| 2788–3158 | `scoreCandidatesV3`, `syncPoolCandidatesWithTasteMap`, `isTasteMapCacheValid` | **Öneri** | Zevk | 6 |
| 3159–4691 | Aday havuzu: `createDefaultPoolData`, `determineItemEra`, tür/popülerlik kovaları, havuz normalizasyonu | **Öneri** | İçerik | 6 |

**Faz 1 kararı:** 1–214 aralığındaki tipler `core/media/types.ts`, medya anahtarı yardımcıları (`core/keys.ts`) `core/media/keys.ts` altına taşınır; `cinethos-core.ts` yeniden export eder. Bu, 4 tip döngüsünü keser (§0 döngü tablosu).

## 4. `src/server/persistent-store.ts` — bölüm bazında

| ≈ Satır | Blok | ● Sahip | Not |
| --- | --- | --- | --- |
| 1–505 | Tipler, `redactSecrets`, `hashContent`, `mergeCatalogItem`, `sanitizeProfileId` | Veri | Sır maskeleme ve katalog birleştirme saf yardımcıları |
| 506–1031 | `PersistentDataStore` kurulumu, yol çözümleme, atomik yazma, kuyruk | Veri | `createDataStorage` ile aynı yazma disiplini |
| 1032–1573 | `CATALOG OPERATIONS` — `data/catalog/*.json` | **İçerik** | Katalog sahipliği buraya |
| 1574–1580 | `DERIVED PROFILE OPERATIONS` — `data/profiles/*.json` | Zevk (üretir) / Veri (yazar) | Türetilmiş profil önbelleği |
| 1581–1612 | `STOCK DEPOT SNAPSHOT OPERATIONS` — `data/stock.json` | **İçerik** | |
| 1613–2148 | `SİNEMA KÜNYESİ OPERATIONS` — `data/sinema-kunyesi.json` | **İçerik** | |
| 2149–4230 | `SYNC & GITHUB OPERATIONS` — staged yazma, durum kaydı, uzak doğrulama | **Veri/Senkron** | Faz 2'de `github-bidirectional-sync` ile birlikte port arkasına alınır |

## 5. `src/server/github-bidirectional-sync.ts` — bölüm bazında

| ≈ Satır | Blok | ● Sahip |
| --- | --- | --- |
| 78–136 | `SYNC_STATIC_INVENTORY` — senkronlanan dosya listesi | Veri |
| 137–1263 | `inspect*RawContent` denetçileri: katalog, manifest, kullanıcı verisi, stok, künye, türetilmiş profil | Veri (şema) + İçerik (yorum) |
| 1264–1486 | `compareSyncSides`, `SyncStorePort` adayı bağımlılık arayüzü | Veri |
| 1487–4047 | `GitHubBidirectionalSyncManager`: staged yazma, kilit, hata sınıflandırma | Veri/Senkron |
| 4048–4754 | Aşama A–E: katalog → kullanıcı verisi → türetilmiş profil → stok/künye → yükleme → uzak doğrulama | Veri/Senkron |

## 6. `src/server/excel-profile-backup.ts` — bölüm bazında

| ≈ Satır | Blok | ● Sahip |
| --- | --- | --- |
| 43–276 | Sayfa adları, satır tipleri, rapor tipleri | Veri |
| 277–559 | XML/CSV metin temizliği, dosya adı, görsel boyutu, EMU dönüşümleri | Veri |
| 560–958 | Poster yerleşimi, CRC32/PNG, izinli host listesi, poster indirme | İçerik |
| 960–1464 | Poster LRU istatistikleri ve önbellek seçenekleri | İçerik |
| 1465–1775 | `buildProfileBackupDataset` — dışa aktarım veri kümesi | Veri |
| 1776–2208 | `inspectXlsxPackageBuffer` — yüklenen XLSX doğrulama | Veri |
| 2209–3171 | `generateProfileExcelBuffer` — çalışma kitabı üretimi | Veri |
| 3172–3447 | `executeProfileBackupExport` — dosya + GitHub yükleme akışı | Veri |

## 7. `src/server/app.ts` — rota grupları

| ≈ Satır | Blok | ● Sahip |
| --- | --- | --- |
| 41–389 | Yardımcılar: stream, yazma önkoşulu (`If-Match`), SPA fallback, SHA-256 | Uygulama (sunucu kabuğu) |
| 390–509 | `createCinethosApp` kurulumu, `storage`/`persistentStore` bağlama, `/api/health` | Uygulama |
| 510–568 | SQLite arşiv durumu ve yükleme | Veri |
| 569–1269 | P0-01 yazma hattı: journal, optimistic concurrency, çift yönlü birleştirme | **Veri** |
| 1270–1273 | TMDB vekili ve görsel vekili | İçerik |
| 1274–1400 | `/api/data` okuma-yazma, izole profil/listeler, yedek listeleme/geri yükleme | Veri |
| 1401–1445 | `/api/stock` ve `/api/stock/upload` | İçerik |
| 1446–1513 | `/api/cinema-kunye` okuma/yazma | İçerik |
| 1514–1817 | `/api/sync/*` — durum, inspect, pull, push, reconcile, token, onay, staged | Veri/Senkron |
| 1818–1926 | `/api/catalog`, `/api/catalog/upsert`, `/api/profiles/derived/*` | İçerik + Zevk |
| 1927–2010 | `/api/backup/hybrid-merge` (CSV + GitHub birleştirme) | Veri |
| 2011–2205+ | `/api/backup/profile-export*`, `/api/backup/excel/*`, dışa aktarım indirme | Veri |

## 8. `src/services/api.ts` — istemci API katmanı

| ≈ Satır | Blok | ● Sahip |
| --- | --- | --- |
| 9–185 | TMDB kaynak durumu, yanıt şekli doğrulama, `fetchTmdb` | İçerik |
| 186–354 | TTL önbelleği, in-flight istek birleştirme, `fetchTmdbCached` | İçerik |
| 355–625 | Sunucu verisi, yedekler, geri yükleme, stok yükleme | Veri |
| 626–732 | CSV hibrit birleştirme, istemci ağ hatası raporu | Veri |
| 733–896 | GitHub inspect/pull/push/reconcile/token/staged | Veri/Senkron |
| 897–970 | Katalog ve türetilmiş profil okuma/yazma | İçerik + Zevk |
| 971–1100 | Profil yedeği dışa aktarma ve XLSX doğrulama | Veri |

## 9. Diğer büyük dosyalar

| Dosya | Satır | Blok özeti | ● Sahip | Faz |
| --- | --- | --- | --- | --- |
| `src/core/exporters.ts` | 1.054 | 26–203 Zevk DNA profili · 204–813 CSV dışa/içe aktarma · 814–907 ICS takvim · 908–1054 izleme kesişimi + yolculuk zaman çizelgesi | Zevk / Veri / Deneyim | 3–5 |
| `src/core/relationship-explorer.ts` | 926 | 86–184 içerik ön hesabı · 185–640 çift ilişkileri ve dökümü · 641–721 grafik düğümleri ve puanlama | **İlişki** | 5 |
| `src/services/stock-engine.ts` | 992 | Stok doldurma, poster kuyruğu, kalıcı katalog yazımı | **İçerik** | 3 |
| `src/services/series-service.ts` | 947 | Dizi indeksi, sezon/bölüm metaverisi | **İçerik** | 3 |
| `src/components/DetailModal.tsx` | 1.041 | Tek bileşen: detay paneli, sezon seçimi, puanlama girişi | **Deneyim** | 7 |
| `src/services/discovery-storage.ts` | 536 | Aday havuzu + keşif geçmişi (IDB) | **Öneri** | 6 |
| `src/hooks/useItemActions.ts` | — | Ekleme/güncelleme/silme eylemleri | **Kütüphane** | 3 |
| `src/server/storage.ts` | 780 | JSON belge deposu, yedekler, SQLite aynası, izole kopyalar | **Veri** | 2 |

## 10. Taşıma sırası (bu tablodan çıkan)

1. **Faz 1:** `core/media/types.ts` + `core/media/keys.ts` — App.tsx ve cinethos-core'daki tip bağımlılıklarını azaltır.
2. **Faz 2:** `data/` adaptörleri — `storage.ts` + `sqlite-primary-store.ts` + `persistent-store.ts` yazma yolları; `SyncStorePort` çıkarımı.
3. **Faz 3:** `library/operations/*` (App.tsx 2978–3227) + `content/` (stock/series/poster).
4. **Faz 6:** App.tsx 1462–2844 → `modules/discover/state.ts`; `cinethos-core` puanlama blokları `recommendations/` altına sarmalanır.
5. **Faz 7:** App.tsx kabuğu `AppShell.tsx` + `presentation/layouts/*`; `AppModals` → `app/modals/`.

> Bu tablo **taşıma kararı** değil, taşımanın sınırlarını gösteren envanterdir. Her blok taşınmadan önce ilgili test dosyası yeşil kalmalı (§9 test eşlemesi).
