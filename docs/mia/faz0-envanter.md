# MIA Faz 0 — Mimari Envanter ve Bağımlılık Haritası

## 0. Doğrulanmış Yeniden Ölçüm (2026-11-15)

Bu bölüm, aşağıdaki envanterin **kod üzerinde yeniden üretilebilir ölçümle** doğrulanmış hâlidir. Veri: `node scripts/arch-inventory.mjs --write` → [`faz0-envanter-veri.md`](./faz0-envanter-veri.md) (202 kaynak dosya, 640 iç import kenarı, 82.134 satır).

| Ölçüm | Önceki ifade | Doğrulanan | Not |
| --- | --- | --- | --- |
| Kaynak dosya sayısı | 208 (madge) | **202** (`src/**/*.ts[x]` + `server.ts`) | madge farklı bir dosya kümesi sayıyor; bu tablo yalnızca derlenen TS kaynaklarını sayar |
| Döngü | 7 (madge) | **3 SCC**, bunlardan **1'i gerçek değer döngüsü** | madge basit döngüleri tek tek sayar; aynı 5'li core kümesi tek SCC'dir |
| Katman ihlali | core→services: 2 dosya | **4 değer importu**, 2 dosya | `relationship-explorer` 3 servise, `actor-recommendations` 1 servise bağlı |
| Paylaşılan sembol | `SavedItem` 7 dosya | **57 dosya (8 değer / 49 tip)** | Önceki sayım yalnızca değer importlarını görmüş; tip taşıma kararı daha da güçlü |
| IndexedDB deposu | 12 | **12** | `cinetrack-relationship-cache` `DB_NAME` sabitiyle açılıyor, inline değil |
| localStorage | "7+" | **36 anahtar/şablon** | `ct:*`, `cinetrack.*`, `cinetrack_*` aileleri; şablonlar `*` ile normalize |
| Test dosyası | 25 | **25 dosya / 204 statik `test()` bloğu** | Çalıştırıcı: `npm test` **422/422**, `npm run test:taste` **362/362** |
| En büyük dosya | — | `github-bidirectional-sync.ts` 4.754 · `cinetrack-core.ts` 4.691 · `App.tsx` 4.651 · `persistent-store.ts` 4.230 | `core` 20.390 satır, `server` 22.224 satır |

**Teyit edilen döngü ayrıntısı:**
1. Core 5'lisi (`cinetrack-core`, `actor-recommendations`, `candidate-pool-store-port`, `cinema-kunye`, `ring-lifecycle`): dört `import type` ile kırılıyor — `core/media/types.ts` taşıması bunu tamamen bitirir.
2. `relationship-explorer` ↔ `relationship-wordlists`: tek `import type` (`RelationshipType`) ile kırılıyor.
3. `persistent-store` → `github-bidirectional-sync` → `github-catalog-sync` → `persistent-store`: **tek gerçek değer döngüsü**; `SyncStorePort` çıkarılmadan Faz 2 taşıması yapılmamalı.

### 0.1 Faz 0 kapanış tablosu (13 madde)

| # | Madde | Durum | Kanıt |
| --- | --- | --- | --- |
| 1 | Kaynak dosya envanteri | ✅ | §0, `faz0-envanter-veri.md` §2–3 (202 dosya, 82.134 satır) |
| 2 | Büyük modüllerin belirlenmesi | ✅ | `faz0-envanter-veri.md` §3 (en büyük 25) |
| 3 | Ana modül sınıflandırması | ✅ | `faz0-fonksiyon-sahipligi.md` §1–10 |
| 4 | `ARCHITECTURE.md` incelemesi | ✅ | 75 satır; veri katmanı/önbellek ayrımı ve migrasyon kuralları okundu, bu tablolarla çelişki yok |
| 5 | Import bağımlılık grafiği | ✅ | [`faz0-bagimlilik-grafigi.md`](./faz0-bagimlilik-grafigi.md) — 640 dosya kenarı, 407 modül kenarı, tam liste §13 |
| 6 | Döngüsel bağımlılık analizi | ✅ | `faz0-bagimlilik-grafigi.md` §2 — 3 SCC, 1 gerçek değer döngüsü |
| 7 | Fonksiyon bazında sorumluluk haritası | ✅ | [`faz0-fonksiyon-sahipligi.md`](./faz0-fonksiyon-sahipligi.md) — 15 büyük dosya, blok + satır aralığı |
| 8 | Veri sahipliği haritası | ✅ | [`faz0-veri-sahipligi.md`](./faz0-veri-sahipligi.md) §2–4 — sunucu dosyaları, 14 IDB deposu, localStorage anahtarları |
| 9 | Modüller arası veri akışı | ⚠️ Kısmi | Sahiplik ve R/W yönleri var; uçtan uca akış diyagramı Faz 1 sözleşmeleriyle kesinleşecek |
| 10 | Profil değiştirme yarışları | ⚠️ Analiz var, çalıştırma yok | `faz0-veri-sahipligi.md` §6 — `profileId` damgası eksikliği tespit edildi |
| 11 | SQLite/JSON veri bütünlüğü | ✅ | `sqlite-primary-store.test.mjs` 4/4 (migration, bozuk JSON kurtarma, revizyon seçimi) + canlı `CINETRACK_STORAGE=sqlite` açılışında migration doğrulandı |
| 12 | Canlı yerel veri denetimi | ✅ | `data/cinetrack-data.json`: `version 3`, `schemaVersion 3`, `engineVersion v3.2.0`, 1 profil |
| 13 | Testlerin modüllerle eşleştirilmesi | ✅ | `faz0-envanter-veri.md` §9 (25 test dosyası, hedef kaynaklar) |
| 14 | Lint/TypeScript | ✅ | `npm run lint` temiz (eslint + 2× tsc) |
| 15 | E2E testleri | ⚠️ Çalıştırıldı: **4/11 geçti**, 7 başarısızlık testlerin eski düzene yazılmış olmasından | §0.2 — ayrıntılı senaryo/temel neden tablosu |

**Sonuç:** 12/15 madde tamam, 3 madde kısmi (veri akışı diyagramı, profil yarışı, E2E). E2E artık **çalıştırıldı**; 7 başarısızlığın tamamı testlerin sidebar + `MobileDock` öncesi düzene yazılmış seçicilerinden kaynaklanıyor, ürün hatası kanıtlanmadı (§0.2). Faz 1 **sözleşme tasarımı** için engel yok; Faz 2 veri taşıması `SyncStorePort` + profil damgası çözülmeden başlamamalı.

### 0.2 E2E sonuçları — 2026-11-16

**Komut:** `./node_modules/.bin/playwright test --workers=1 --retries=0 --reporter=list` (Chromium headless, `npm run build` + `vite preview` webServer ile)
**Sonuç:** **11 test · 4 geçti · 7 başarısız · 50,7 sn**
**Ortam notu:** Bu VM'de Chromium sistem kütüphaneleri ve font paketi yoktu; `libnspr4/libnss3/libatk*/libxkbcommon` + `fonts-liberation`/`dejavu` paketleri `/tmp` altına açılıp `LD_LIBRARY_PATH` ve `FONTCONFIG_FILE` ile verildi. Bu, depoya giren bir değişiklik değildir; ortamın kendi eksiğidir (root/sudo yok).

| # | Senaryo | Sonuç | Temel neden |
| --- | --- | --- | --- |
| 1 | `app-smoke` › marka, gezinme ve yerel liste | ❌ | `page.locator('.brand-title')` **strict mode ihlali**: sidebar ve `MobileTopBar` aynı sınıfı taşıyor (2 eşleşme). Test tek görünür öğeye kapsanmalı |
| 2 | `app-smoke` › ana sekmeler + profil girişi | ✅ | — |
| 3 | `offline` › API yokken yeniden yükleme listeyi korur | ✅ | — |
| 4 | `profiles-and-conflict` › hızlı profil değişimi listeleri karıştırmaz | ✅ | — |
| 5 | `profiles-and-conflict` › revizyon çakışması + kayıpsız birleştirme | ✅ | — |
| 6–8 | `responsive` › mobil-360x640, mobil-390x844, tablet-768x1024 | ❌ | `.app-header` mobilde artık render edilmiyor (`MobileTopBar` kullanılıyor); test eski header'ı bekliyor |
| 9–11 | `responsive` › laptop-1024, masaustu-1440, genis-1920 | ❌ | `.app-header` geçiyor, ardından `.header-nav-tabs` / `.mobile-tab-bar` bekleniyor; gezinme artık `AppSidebar` (`role="tablist"`) + `MobileDock` |

**Değerlendirme:** Başarısızlıkların 7'si de **seçici/düzen beklentisi** kaynaklı; hiçbiri DOM'da hata, API regresyonu veya konsol hatası göstermedi (diğer 4 senaryo, aynı uygulamada geçti). Ancak bu nedenle şu ürün davranışları E2E ile **doğrulanmış sayılmaz**: yatay taşma kontrolü (nav assert'ından sonra geliyor), sekmeye tıklayıp listeyi görme (aynı testte), mobil gezinme davranışı.

**Düzeltme için gereken (Faz 8 kapsamı, bu turda yapılmadı):**
1. `e2e/responsive.spec.ts` — `.app-header` yerine `AppSidebar` + `MobileTopBar` koşulları; `≤768px` için `MobileDock` (`nav.mobile-dock`), `>768px` için sidebar tablist görünürlüğü.
2. `e2e/app-smoke.spec.ts` — `.brand-title` seçicisini görünür öğeye kapsamak (ör. `page.locator('.app-sidebar .brand-title')`).
3. Testleri güncelledikten sonra `--workers=1 --retries=0` ile tekrar koşup 11/11 hedeflenmeli.

**Baseline:** `npm run lint` temiz · `npm test` 422/422 · `npm run test:taste` 362/362 · `npm run build` başarılı (ana JS 427,76 kB).


> **Kapsam:** `src/` + `server.ts` — madge 208 dosya; doğrulanmış TS kaynak sayısı **202** (§0), 25 test dosyası, 12 idb deposu, 36 localStorage anahtarı (§0).
> **Araçlar:** `madge --circular` (döngü taraması), hedefli grep taramaları (katman ihlalleri, depolama envanteri).
> **Karar etkisi:** Bu envanter Faz 1 (sözleşmeler) ve taşımaların (Faz 2–7) tek referansıdır.

---

## 1. Katman İhlal Taraması (hedef kurallara göre)

| Kural | Sonuç | İhlal |
| --- | --- | --- |
| `core/` saf kalmalı (React yok) | ✅ | — |
| `core/` → `services/`/`server/` olmamalı | ❌ **2 dosya** | `core/relationship-explorer.ts` → `services/encoding-service`, `services/storage-idb`, `services/series-tv-seeds` · `core/actor-recommendations.ts` → `services/api-client` (`apiFetch`) |
| `components/`/`modules/`/`app/` → `server/` olmamalı | ✅ | — |
| `modules/*` → `modules/*` olmamalı | ✅ | — (M1 bölümleri henüz temiz) |
| `core/` içinde localStorage yok | ✅ | — |

**Faz 5 aksiyonu:** `relationship-explorer`'ın idb/encoding erişimi **port arayüzüne** çevrilecek (`candidate-pool-store-port.ts` deseni zaten mevcut — aynı desen kopyalanır). `actor-recommendations`'ın `apiFetch`'i parametre enjeksiyonuna dönürülür (saf fonksiyon → çağıran veriyi verir).

## 2. Döngüsel Bağımlılıklar (madge: 7 adet)

| Döngü | Nitelik | Faz 0 kararı |
| --- | --- | --- |
| `cinetrack-core.ts` ↔ `actor-recommendations.ts` | **Yalnızca `import type`** (`FavoriteActorInfo`) | Zararsız; Faz 1'de tip `core/media/types.ts`'e taşınır |
| `cinetrack-core.ts` ↔ `candidate-pool-store-port.ts` | `import type` (`PersistentCandidatePoolData`) | Aynı |
| `cinetrack-core.ts` ↔ `cinema-kunye.ts` | `import type` (`SavedItem`) | Aynı |
| `cinetrack-core.ts` ↔ `ring-lifecycle.ts` | `import type` (`PersistentTasteMapData`, `TasteMapEntry`) | Aynı |
| `persistent-store.ts` ↔ `github-bidirectional-sync.ts` | **GERÇEK değer döngüsü**: persistent-store `GitHubBidirectionalSyncManager` sınıfını import ediyor; sync 9 sembolü persistent-store'dan alıyor | **Faz 2'de kırılır:** sync manager'ın ihtiyaçları `SyncStorePort` arayüzüne çıkarılır; persistent-store somut portu verir, sınıfı import etmez |
| `persistent-store.ts` ↔ `github-bidirectional-sync.ts` ↔ `github-catalog-sync.ts` | Aynı zincirin devamı | Aynı port ile çözülür |
| `relationship-explorer.ts` → `relationship-semantics.ts` → `relationship-wordlists.ts` | Yönsel zincir (madge döngü işaretli) | Faz 5'te doğrulanır; wordlist saf veri modülü olduğundan riske düşük |

## 3. Paylaşılan Semboller (tip modülü adayları)

`cinetrack-core.ts`'ten en çok import edilenler: **`SavedItem` (7 dosya)**, **`makeMediaKey` (4)**, **`DataDocument` (3)**, `findSavedItem` (2), `normalizeSavedItem` (1).

→ **Faz 1'in ilk işi:** `src/core/media/types.ts` (`SavedItem`, `DataDocument`, `FavoriteActorInfo`, `PersistentCandidatePoolData`, `PersistentTasteMapData`, `TasteMapEntry`) + `src/core/media/keys.ts` (`makeMediaKey`, `parseMediaKey`, `canonicalizeMediaKey` — mevcut `core/keys.ts` buraya taşınır). `cinetrack-core.ts` bu modüllerden yeniden export eder → 4 tip döngüsü anında kopar, export katmanı uyumluluğu korunur.

## 4. Depolama Envanteri (mülkiyet tablosu — Faz 2 repository'lerinin temeli)

### IndexedDB (12 depo)
| Depo | İçerik | MIA sahibi | Bugün erişen |
| --- | --- | --- | --- |
| `cinetrack-profile-db` | Profil dokümanı | Veri | profile service'leri |
| `cinetrack-user-lists-db` | Kullanıcı listeleri | Veri | storage-idb |
| `cinetrack-stock-db` | İçerik stoku | İçerik | stock-engine |
| `cinetrack-encodings-db` | Zevk kodlamaları | Zevk/Hafıza | encoding-service, relationship-explorer |
| `cinetrack-relationship-cache` | İlişki önbelleği | İlişkiler | relationship-cache |
| `cinetrack-series-index-db` | Dizi indeksi | İçerik | series-service |
| `cinetrack-actor-credits-db` | Oyuncu filmografisi | İçerik | actor servisi |
| `cinetrack-poster-lru-db` | Poster LRU | İçerik | poster-cache-manager |
| `cinetrack-offline-queue-db` | Sunucuya yazma kuyruğu | Senkron | offline-queue |
| `cinetrack-skip-log-db` / `cinetrack-surfaced-db` | Öneri geri bildirimi | Öneri | öneri akışı |
| `cinetrack-ui-prefs-db` | UI tercihleri | Deneyim | UI bileşenleri |

### localStorage (sahiplik karışık — Faz 2'de `keys.ts`'e kaydedilir)
`cinetrack.profile.${profileId}.preferences.v1`, `.watchlist.v1`, `cinetrack_disliked_cache`, `cinetrack_evidence_objections`, `ct:library-view`, `ct:mobile-dashboard:${key}` (DashboardRepository'ye taşınacak — P2 bulgusu), `cinetrack_offline_sync_queue_v1`, DIRTY_KEY vb.

**Kural (Faz 2'den itibaren):** her anahtar `keys.ts`'te sahibiyle kayıtlı; kayıtsız anahtar ESLint kuralıyla engellenir.

## 5. Dosya → Yönetici Envanteri (taşınacak / kalır / dokunulmaz)

**DOKUNULMAZ (saf katman — 767 testin konusu):** `core/`'un hesaplama modülleri (scoring, rating-math, genre-matching, loved-similarity, mood-affinity, taste/taxonomy, evaluation, limits, encoding, saved-index, wrapped-summary, duplicate-detector, person-insights, tv-progress, cinema-kunye) · `server/` katman kuralları · `shared/`.

**KALIR (yerinde):** `app/module-registry.ts`, `navigation.ts`, `useHashNavigation.ts`, `shell-context.tsx`, `shell-events.ts`, `lazy-with-retry.ts` (M1 çıktısı) · `modules/{discover,list,taste-map,relationships}/` bölümleri · `services/api-client.ts`, `offline-queue.ts` (Faz 2'de `data/synchronization/` altına taşınır ama davranış değişmez).

**TAŞINACAK (faz başına):**

| Hedef yönetici | Taşınacak dosyalar | Faz |
| --- | --- | --- |
| Kütüphane | `hooks/useItemActions.ts` → `library/operations/`; App.tsx `listStatus` bloğu → `library/state.ts` | 3 |
| İçerik | `stock-engine.ts` + 6 stock-* → `content/stock/`; `series-service.ts` + `series-*` → `content/catalog/`; poster servisleri → `content/posters/` | 3 |
| Arka Plan | `src/modules/background/` (yeni: EventBus, EventQueue, EventRegistry, EventProcessor, RetryManager, 5 job) | 4 |
| Zevk/Hafıza | `core/memory/` (yeni) + `memory-service.ts`; `relationship-*` port sarmalayıcıları | 5 |
| Öneri/Keşif | App.tsx `forYou*`/`catalog*` state'leri → `useForYou`/`useCatalog`; `evaluation.ts` sarmalayıcısı | 6 |
| Uygulama | App.tsx profil mantığı → `ProfileContext` + `useProfiles`; `AppModals` → `app/modals/` | 7 |
| Deneyim | `app/mobile/` → `presentation/layouts/`; design-system → `presentation/design-system/`; `DashboardRepository` | 7 |
| Veri | `services/{storage-idb,discovery-storage,relationship-cache,client-depots,idb-schema-version}.ts` → `data/`; backup/archive kümesi → `data/backup/`; GitHub kümesi → `data/synchronization/` | 2 |

## 6. Test → Kaynak Eşlemesi (regresyon güvenliği)

| Test dosyası | Korumadığı alan | Taşımada risk |
| --- | --- | --- |
| `core.test.mjs` | cinetrack-core hesaplamaları | Yüksek — export katmanı korunmalı |
| `persistent-store.test.mjs`, `sqlite-*.test.mjs`, `archive-restore-consistency.test.mjs` | Veri katmanı | Yüksek (Faz 2) |
| `github-bidirectional-sync.test.mjs`, `offline-queue-durability.test.mjs` | Senkron | Yüksek (Faz 2) |
| `relationship-explorer.test.mjs`, `loved-similarity.test.mjs`, `feat-03-encoding-relationships.test.mjs` | Zevk/İlişki | Yüksek (Faz 5) |
| `api-auth-coverage`, `api-error-policy`, `image-proxy-hardening`, `respan-telemetry` | Sunucu/API | Düşük (dokunulmaz) |
| `module-registry.test.mjs`, `shell-events.test.mjs` | M1 kabuğu | Düşük |
| `spec-v*`, `phases-*`, `audit-spec-fixes` | Çapraz regresyon | Orta |

**Kural:** Her fazda test dosyaları **taşınan kaynağa göre değil, davranışa göre** yeşil kalmalı; import yolu değişen testte yalnızca import satırı güncellenir.

## 7. Faz 0 Sonuç Kararları

1. **Faz 1'in kapsamı netleşti:** (a) `core/media/types.ts` + `core/media/keys.ts` tip modülleri (4 döngüyü koparır), (b) 4 yönetici sözleşmesi (`LibraryManager`, `TasteManager`, `MemoryManager`, `RecommendationManager`), (c) `SyncStorePort` (gerçek döngüyü kırar).
2. **Faz 2 öncesi zorunlu:** `SyncStorePort` çıkarımı — `persistent-store ↔ github-sync` değer döngüsü port olmadan taşıma yapılmaz.
3. **Faz 5 öncesi zorunlu:** `relationship-explorer`'ın 3 services bağımlılığının port'a çevrilmesi (core saflığı geri kazanılır).
4. **Riskli bölge:** `persistent-store.ts` (4.229) — envanter, dosyanın 4 sorumluluğunu (katalog, türetilmiş profil, GitHub durumu, senkron) doğruladı; Faz 2'de sınırlar önce çizilir.
5. **Temiz bulgular:** components→server sıfır, modules→modules sıfır, core'da localStorage sıfır — hedef mimarinin üç kuralı bugün zaten sağlanıyor.

**Doğrulama:** madge 208 dosya taradı; `npm run lint && npm test && npm run test:taste && npm run build` — bu turda kod değişikliği yok, yalnızca envanter (testler yeşil kaldı).
