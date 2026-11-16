# MIA Faz 0 — Mimari Envanter ve Bağımlılık Haritası

> **Kapsam:** `src/` + `server.ts` — 208 dosya (madge), 25 test dosyası, 12 idb deposu, 7+ localStorage anahtarı.
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
