# MIA Faz 0 — Mevcut İş Akışları ve Veri Mimarisi

> **Yöntem:** Yalnızca okuma. Satır numaraları `freebuff/faz0-f47140` (MIA dalı `vibe/modular-shell-m1-b66b9a` + `ef031af`) üzerinden alınmıştır; taşımalardan sonra kayar.
> **İlgili belgeler:** [Bağımlılık grafiği](./faz0-bagimlilik-grafigi.md) · [Fonksiyon sahipliği](./faz0-fonksiyon-sahipligi.md) · [Veri sahipliği](./faz0-veri-sahipligi.md) · [Kapanış tablosu](./faz0-envanter.md#01-faz-0-kapanış-tablosu-13-madde)

## 1. Veri katmanları (özet)

| Katman | Nerede | Ne tutar | Bugünkü yazıcı |
| --- | --- | --- | --- |
| Ana kullanıcı belgesi | `data/cinethos-data.json` (+ `.bak`, `data/backups/*.json` 7 adet) | profiller, items, preferences, tombstones, `revision` | `server/storage.ts` |
| SQLite birincil kopya (opt-in) | `data/cinethos.db` → `documents(id, revision, updated_at, payload)`, `meta(key, value)` | aynı belge | `sqlite-primary-store` ↔ `storage.ts` |
| İzole kopyalar | `data/profile.json`, `data/user-lists.json` | aktif profil + listeler (istemci hidrasyonu) | `storage.ts` (best-effort) |
| Ortak katalog | `data/catalog/movies.json`, `tv.json`, `manifest.json` | TMDB metaverisi, kanonik `movie:id` anahtarı | `persistent-store.ts`, `github-catalog-sync.ts` |
| Türetilmiş profil | `data/profiles/<profileId>.json` | matchScore, ring, signals, reasons, pillars (`schemaVersion: 2`) | `storage.ts`, `/api/profiles/derived/upsert` |
| Stok | `data/stock.json` + IDB `cinethos-stock-db` | 500 film + 500 dizi aday havuzu | `persistent-store.ts`, `stock-engine.ts` |
| Sinema künyesi | `data/sinema-kunyesi.json` + `ct:cinema-kunye` | tür/yıl/kadro anahtarlı künye | `persistent-store.ts`, `/api/cinema-kunye` |
| Zevk verisi | `data/taste/*.json` (taxonomy, index, events, profile, manifest, objections) | kanıtlar, öğrenme durumu, türetilmiş profil | `taste-store.ts`, `taste-rebuild-coordinator.ts` |
| Tarayıcı | 14 IndexedDB deposu + 36 localStorage anahtarı | katalog önbelleği, aday havuzu, zevk haritası, UI tercihleri, offline kuyruk | `services/*` (bkz. veri sahipliği §3–4) |
| Arşiv | `data/archives/*.sqlite` + `data/cinethos.db` (arşiv) | tam yedek | `sqlite-archive.ts` |

### 1.1 SQLite arşiv şeması (`sqlite-archive.ts:145-192`)
`archive_meta(key,value)` · `profiles(id, name, created_at, is_demo, preferences_json, favorite_actors_json, deleted_keys_json, position)` · `profile_items(profile_id, media_key, media_type, media_id, status, personal_rating, payload_json, position)` · `taste_maps(profile_id, payload_json)` · `stock_items(kind, media_key, payload_json)` · `stock_state(key,value)` · `posters(url, media_key, content_type, byte_length, bytes)`. İki indeks: `idx_profile_items_profile(profile_id, position)`, `idx_stock_items_kind(kind)`.
**İlişki:** `profile_items.profile_id → profiles.id` (uygulama düzeyinde, FK kısıtı yok), `posters.media_key` → `profile_items.media_key` (gevşek referans). Arşiv **taşınabilir yedek**tir, canlı okuma kaynağı değildir.

## 2. Film/dizi ekleme akışı

```text
UI aksiyonu (kart "Listeme Ekle")
  → App.tsx handleSaveItem (2978) / handleQuickAdd (2987)
  → setProfiles(...) + M1 kabuk olayı (2918)
  → persist effect (703, 1249) → buildCurrentPayload (845)
  → api.ts pushServerDataDetailed (383)  [If-Match: revision]
  → server app.ts PUT /api/data (1290)
  → storage.saveDataSerialized → validateAndPrepareSave (401)
  → writeJsonFileAtomic (JSON + .bak + snapshot) → sqlitePrimaryStore.write
```

- **Doğrulama:** `normalizeSavedItem` (`core/cinethos-core.ts:372`) alanları temizler; geçersiz kayıt sessizce düşürülür.
- **Eşzamanlılık:** `revision > 0` iken `If-Match` zorunlu (`428`), uyuşmazlıkta `409 revision_conflict`.
- **Kanıt:** `tests/faz0-baseline.test.mjs` (profil izolasyonu + silme/geri yükleme), `tests/persistent-store.test.mjs` (7 snapshot, bozuk yedek reddi).

## 3. İzleme listeleri arasındaki geçişler

| Geçiş | Giriş noktası | Etki |
| --- | --- | --- |
| `watchlist → watching` | `handleSetStatus` (App.tsx:2997) | `status` alanı + `updatedAt`; öneri ağırlığı 0.3 → 0.6 |
| `watching → completed` | `handleMarkCompleted` (2992) | `status: completed`; sinyal ağırlığı 1.0 |
| Dizi bölümü artırma | `handleIncrementTvEpisode` (3034) | `season_progress[sezon]` sayacı, `episodes_watched` |
| "İlgilenmiyorum" | `handleToggleDislike` (3129) + `emitDislikeTasteEvent` (`hooks/useItemActions.ts:32`) | `preferences.disliked` + zevk olayı (−0.8 ceza) |
| Gizle | `handleToggleHide` (3196) + `emitHideTasteEvent` (58) | `preferences.hidden` (nötr bastırma) |
| Silme | `handleRemoveItem` (3092) | kayıt çıkar + `deleted_keys[mediaKey]` mezar taşı (30 gün) |

Ağırlıklar tek yerde: `RECOMMENDATION_WEIGHTS_V3` (`core/cinethos-core.ts:947`); durum ağırlıkları `SIGNAL_WEIGHTS` olarak Faz 5'te ayrılacak.

## 4. Zevk profili oluşturma ve güncelleme

**İstemci (anlık hesap):** App.tsx `selectTopSeeds` (2062) → `buildTasteProfileV3` (`core/cinethos-core.ts:1077`) → profil nesnesi `scoreCandidatesV3`'e verilir. Profil her katalog yenilemesinde yeniden hesaplanır; kalıcı değildir.

**Sunucu (olay tabanlı öğrenme):**
```text
kullanıcı aksiyonu → TasteEvent (core/taste/types.ts)
  → appendTasteEvent (server/taste-store.ts:63)   [cinethos-taste-events.json]
  → triggerTasteProfileRebuild (taste-rebuild-coordinator.ts:486)
  → worker: new URL("../workers/taste-profile-worker.ts") (373)
  → writeTasteProfile (taste-store.ts:104)        [cinethos-taste-profile.json]
  → istemci readTasteProfile / services/taste-api.ts
```
**Doğrulama:** `tests/taste/*` 362 test; `npm run test:taste` yeşil. **Risk:** istemci profili (buildTasteProfileV3) ile sunucu profili (taste-store) iki ayrı hesap yolu; hangisinin ekranda kazandığı `App.tsx` içinde dağınık.

## 5. Öneri üretme ve yenileme

```text
loadCategoryResults (App.tsx:1510)
  → aday havuzu: ct:stock → data/catalog → TMDB (2183, 2240)
  → scoreCandidatesV3 (core:2788)  [15 sinyal, ağırlıklar 947]
  → buildEnrichmentShortlist (2390) → zenginleştirme (TMDB detay)
  → ring seçimi (ring0 → ring2, ring1 dışlanır) + çeşitlendirme
  → recordDisplayedRecommendations (core:2376) + ct:surfaced/skip-log yazımı
Yenileme: handleRefreshForYou (2696) · handleRefreshTasteMap (2707) · handleManualStockReplenish (2759)
```

- **Baseline kilidi:** `tests/faz0-baseline.test.mjs` aynı girdi için 66/49 puanlarını ve bileşen kırılımını (`genre`, `keywords`, `story`, `lovedSim`, `quality`) doğrular. Öneri motoru Faz 6'da değiştirilirse bu testin bilinçli güncellenmesi gerekir.
- **Değişmez kural:** TMDB puanı kullanıcı puanının üzerine yazılmaz (`personal_rating` ayrı alan).

## 6. Zevk Haritası ve İlişki Keşif Motoru

| Akış | Giriş | Yazdığı yer |
| --- | --- | --- |
| Zevk Haritası tohumlama | `updateTasteMapWithBatch` (`core:1931`) | `cinethos_taste_map_<profileId>` (localStorage) |
| Gösterim kaydı | `recordDisplayedRecommendations` (2376) | aynı anahtar + `ct:surfaced` |
| Arşivle/geri al | `archiveTasteMapEntry` (2551), `restoreTasteMapEntry` (2583) | aynı anahtar |
| İlişki grafiği | `buildRelationshipGraph` (`core/relationship-explorer.ts:721`) — çağrı: `RelationshipExplorer.tsx:411,470` | `cinethos-relationship-cache` (IDB) |
| İlişki dökümü | `computeRelationshipBreakdown` (511), `pairRelationships` (185) | yalnız hesaplama |

**Risk:** Zevk Haritası anahtarı saf hesaplama modülünde (`core`) üretiliyor; depolama sahibi Faz 5'te ayrılacak (veri sahipliği §5).

## 7. İçerik indirme ve önbellekleme

```text
services/api.ts fetchTmdbCached (318)
  → bellek TTL önbelleği (268) + in-flight birleştirme (308)
  → /api/tmdb (server/app.ts:1271, tmdbRateLimiter)
  → tmdb-proxy.ts: 500 girdilik LRU + stale-cache fallback + demo katalog
Posterler: poster-cache-manager (IDB LRU, 200 MiB) · poster-hydration-service.ts:207 (günlük kota)
Stok: stock-engine.ts stockEngine (100) → ct:stock + data/stock.json
```

## 8. Profil değiştirme sırasında çalışan asenkron işler

**Sıra:** `handleSwitchProfile` (App.tsx:3906) → `activeProfileId` değişir → M1 olayı (3936) → sunucudan çekme/senkron (`pullMergeFromServerIfAdvanced` 1266, `handleVisibilitySync` 1302) → IDB hidrasyonu (1070).

**Aynı anda çalışabilenler:** katalog/öneri hesapları (1510–2695), poster hidrasyonu (566, 586), stok doldurma (1033+), zevk haritası yenileme (2707), sunucu push'u (1249 debounce).

| Senaryo | Bugünkü davranış | Kanıt |
| --- | --- | --- |
| Profil değişimi listeleri karıştırıyor mu? | Hayır: her profil `items`'ı ayrı; E2E yeşil | `e2e/profiles-and-conflict.spec.ts:12` geçti |
| Eski profilin öneri hesabı yeni profile yazar mı? | **Koruma görünmüyor**: öneri state'i `App` içinde tek; sonuç `profileId` damgası taşımıyor | Kod incelemesi; test yok |
| Aynı belgeye eşzamanlı yazma | `revision` + `If-Match` + `sudden_item_drop` koruması | `tests/faz0-baseline.test.mjs` (409) |
| Profil değişiminde bekleyen push | `dirty` bayrağı + debounce; hedef belge aktif profile göre yeniden kuruluyor | `App.tsx:791–845` |

**Faz 2 şartı:** uzun süren her hesap `{ profileId, baseRevision }` taşımalı; sonuç yalnız eşleşen profilde uygulanmalı. Bu, plan §2'deki `ProfileSwitched` olayıyla birlikte gelecek ve `tests/` altında bir yarış testiyle kilitlenecek.

## 9. GitHub yedekleme ve senkronizasyon

```text
POST /api/sync/staged (app.ts:1778) veya arka plan tetiklemesi
  → GitHubBidirectionalSyncManager (github-bidirectional-sync.ts:1502)
  → A. katalog birleştirme (4048)  → data/catalog/*.json
  → B. kullanıcı verisi (4233)     → data/cinethos-data.json
  → C. türetilmiş profiller (4295) → data/profiles/*.json
  → C2. stok (4448) · C3. künye (4487)
  → D. birleşik dosyaları yükle (4537)
  → E. uzak dosyaları yeniden oku ve doğrula (4668)
Durum: data/sync-state.json (persistent-store) · çevrimdışı yazma: offline-queue → /api/data
```

- Çakışma çözümü üç seçenekli: yereli koru / sunucuyu kullan / birleştir (`App.tsx:1202–1237`).
- Sırlar `redactSecrets` (`persistent-store.ts:324`) ile maskelenir.
- Gerçek değer döngüsü burada: `persistent-store ↔ github-bidirectional-sync` (Faz 2'de port ile kırılacak).

## 10. Silme, güncelleme, geri yükleme

| İşlem | Yol | Korumalar |
| --- | --- | --- |
| Tek kayıt silme | UI → `handleRemoveItem` → belge kaydı + mezar taşı | `deleted_keys` 30 gün, maks 2000; senkronda geri dirilmez |
| Toplu silme | `PUT /api/data` | `confirmBulkDelete` / `sudden_item_drop` → 409 |
| Anlık görüntü | her yazma öncesi `isWorthKeeping` ise `data/backups/` | en yeni 7 geçerli dosya |
| Geri yükleme | `POST /api/data/restore` → `restoreBackup` | bozuk/şemasız yedek reddedilir, mevcut veri korunur |
| Arşiv geri yükleme | `/api/archive/sqlite` + `archive-restore-consistency.test.mjs` | journal + boyut sınırı |
| SQLite/JSON ayrışması | `selectPrimaryDocument` (`storage.ts`) | JSON revizyonu büyükse JSON kazanır ve SQLite eşitlenir |

**Doğrulama:** `tests/faz0-baseline.test.mjs` (silme → mezar taşı → geri ekleme akışı), `tests/sqlite-primary-store.test.mjs`, `tests/archive-restore-consistency.test.mjs`.
