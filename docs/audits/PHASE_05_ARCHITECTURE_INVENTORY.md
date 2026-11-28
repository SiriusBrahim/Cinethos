# Aşama 5 — Mimari Envanter ve Analiz

**Tarih:** 24 Kasım 2026
**Dal:** `remediation/full-project-remediation`
**PR:** #65 → `master` (açık, merge edilmemiş)
**Başlangıç HEAD:** `9a00628581b5e9e519740e28cb046c0e785f2370` (`9a00628`)
**PR tabanı:** `master` @ `9be5011684c2d18daa8342c1803aa4c0f185173e`

> Bu belge yalnızca **envanter ve analiz** içerir. Bölüm A kuralı gereği hiçbir kaynak dosyası
> değiştirilmemiştir; refaktör uygulaması kullanıcı onayına bağlıdır (Bölüm B).
> Satır numaraları bu HEAD üzerinde ölçülmüştür.

---

## 1. Başlangıç durumu

### 1.1 Git ve PR

| Alan | Değer |
|---|---|
| Aktif dal | `remediation/full-project-remediation` |
| HEAD | `9a00628` — "Aşama 4 raporunda CI doğrulama HEAD'ini c439cf1 olarak düzelt" |
| Çalışma ağacı | Temiz; yalnızca `.audit/` untracked (commit edilmedi) |
| PR #65 | `state: open`, `merged: false`, `mergeable_state: clean` |
| PR tabanı | `master` |
| Önceki aşama HEAD'leri | `977b701` (başlangıç) → … → `9f3b639` → `c439cf1` → `9a00628` |

### 1.2 Doğrulanmış kalite kapıları (bu oturumda yeniden koşuldu)

| Komut | Sonuç | Çıktı özeti |
|---|---|---|
| `npm run lint` | ✅ 0 hata / 0 uyarı | ESLint + `tsc --noEmit` + `tsc --noEmit -p tsconfig.tests.json` |
| `npm run cycles` | ✅ 0 döngü | "Bağımlılık döngüsü bulunmadı." |
| `npm test` (unit) | ✅ **817/817**, 69 suite, 80 test dosyası | `[data-guard] OK: data/ değişmedi (15 dosya)` |
| `npm run test:taste` | ✅ **440/440**, 134 suite, 27 test dosyası | `[data-guard] OK` |
| CI `9a00628` | ✅ 4/4 kontrol `success` | Lint/Test/Build + Playwright E2E + bakım analizi + Vercel Preview Comments (0 çözülmemiş geri bildirim) |

Bu değerler Aşama 5 için **regresyon tabanıdır**: her refaktör grubundan sonra aynı komutlar
aynı sonucu vermelidir. Yerel sonuçlar ile CI sonuçları ayrı kaynaklardır ve karıştırılmamalıdır.

---

## 2. Mevcut mimari genel görünümü

`src/` altında 290 TypeScript dosyası, toplam **108.414 satır** (`.d.ts` hariç; `server.ts` ayrı).

| Katman | Dosya | Satır | Rol |
|---|---:|---:|---|
| `src/server` | 50 | 33.601 | Express uygulaması, kalıcı depo, GitHub senkronu, Excel/SQLite arşiv, taste servisi |
| `src/core` | 62 | 24.290 | Alan mantığı: normalizasyon, merge, öneri motoru, taste profili, ilişki grafiği |
| `src/components` | 55 | 18.385 | React bileşenleri |
| `src/services` | 30 | 13.014 | Tarayıcı servisleri: TMDB API, IDB, stok, taste API |
| `src/modules` | 33 | 8.078 | Modül servisleri (library, content, background, recommendations) |
| `src/app` | 16 | 3.053 | Uygulama kabuğu yardımcıları: storage, sync, navigation, catalog-loader |
| `src/hooks` | 15 | 2.474 | React hook'ları |
| `src/App.tsx` | 1 | 2.391 | Uygulama kökü (UI orkestrasyon) |
| `src/contracts` | 8 | 1.147 | Tip sözleşmeleri |
| diğer (`utils`, `design-system`, `presentation`, `workers`, `types`, `features`, `i18n`, `shared`) | 19 | 1.981 | Yardımcı ve sunum katmanları |

Katmanlar arası gerçek import kenarları (ölçüm, §4.1): `components → core` 41,
`modules → core` 41, `server → core` 47, `services → core` 20, `hooks → core` 12,
`app → core` 10. Çekirdek katmanı hem sunucu hem istemci tarafından yoğun kullanılıyor;
bu yüzden core'daki her kirlilik iki tarafa da yayılıyor.

**Genel değerlendirme:** Katman iskeleti (core / contracts / server / services / components)
gerçekten uygulanmış ve döngü yok. Sorun iskelette değil, üç noktada yoğunlaşıyor:

1. **Sorumluluk yoğunluğu** — dört dosya tüm kod tabanının %15'ini taşıyor (41.514 satır).
2. **Ölü/kopya modüller** — canlı kodla aynı işi yapan, hiçbir yerden import edilmeyen 7 modül.
3. **Sınır aşınması** — core içinde 4 dosyada 7 altyapı importu ve 679 `any`.

---

## 3. Büyük dosyalar ve sorumluluk analizi

Her dosya için satır sayısı, üstlendiği sorumluluklar, bağımlılık yönü ve bölünme değerlendirmesi.
Satır aralıkları HEAD `9a00628` üzerindendir.

### 3.1 `src/core/cinetrack-core.ts` — 6.445 satır

**Üstlendiği sorumluluklar (en az 8 ayrı iş):**

| Satır aralığı | Sorumluluk |
|---|---|
| 56–240 | Test mirror sıfırlama, tipler (`SavedItem`, `Preferences`, `Profile`, `DataDocument`), şema/sürüm sabitleri |
| 242–436 | Alan normalizasyonu: favori oyuncu, sezon haritaları, bölüm ilerlemesi |
| 436–728 | `normalizeSavedItem` (kayıt doğrulama), arama/filtre, `dedupeItems` |
| 728–966 | Yedek metni ayrıştırma (`parseBackupText`, sürüm 1–4) |
| 968–1220 | Tercih/silinmiş anahtar/profil/belge normalizasyonu, limit ihlalleri |
| 1239–1360 | İstek kapısı, matematiksel yardımcılar, sinyal ağırlıkları |
| 1400–1786 | Taste profili v3 (`buildTasteProfileV3`) ve kapsamlı profiller |
| 1869–2560 | Taste map: halkalar, imzalar, özet, budama, kalıcı harita |
| 2561–3566 | Taste map kalıcılığı + IDB hidrasyonu (`loadPersistentTasteMap`, `hydrateDiscoveryHistoryIdb`, `updateTasteMapWithBatch`) |
| 3567–4730 | `scoreCandidatesV3` skorlama, oyuncu önerileri, oyuncu kredisi getirme |
| 4731–6445 | Aday havuzu yönetimi, replenishment, IDB senkronu |

**Bağımlılıklar:** `idb-keyval` (satır 4), `../services/api-client.ts` (satır 5), `./encoding.ts`,
`./limits.ts`, `./keys.ts`, `./profile-id.ts`.
**Kendisine bağımlı modüller:** `App.tsx`, `server/github-bidirectional-sync.ts`,
`server/taste-profile-scope.ts`, `modules/recommendations/*`, `hooks/*`, `core/user-data-merge.ts`,
`core/derived-profile-cache.ts` ve testlerin büyük bölümü (barrel görevi görüyor).

**Çok sorumluluk mu?** Evet ve bu dosya tek başına "core" katmanının tamamına yakınını temsil ediyor.
En az beş ayrı modül olacak kadar bağımsız alan var: tipler/normalizasyon, yedek ayrıştırma,
taste profili, skorlama, kalıcı harita + IDB.

**Bölünmenin gerçek faydası:** Yüksek. Öneri skorlama ve taste profili saf fonksiyonlar;
IDB hidrasyonu ise I/O. İkisini ayırmak hem core purity'yi (§6) doğrudan çözer hem de
`scoreCandidatesV3` gibi performans kritik kodun testini hızlandırır.

**Riskler:** 100'den fazla test ve modül bu dosyadan tek noktadan import ediyor. Bölme sırasında
import yolları değişirse hem testler hem `ARCHITECTURE.md` referansları kırılır. Bu yüzden
**barrel (`cinetrack-core.ts` yeniden dışa aktarır) korunmalı**; dosya taşıma değil, yeni modül
çıkarma yaklaşımı uygulanmalı.

### 3.2 `src/server/github-bidirectional-sync.ts` — 5.117 satır

| Satır aralığı | Sorumluluk |
|---|---|
| 137–600 | Hash'ler, kayıpsız katalog birleştirme, manifest, uçucu alan temizleme |
| 622–1545 | Beş ayrı "raw content" okuyucu: katalog, manifest, kullanıcı verisi, stok, künye, türetilmiş profil |
| 1545–1735 | `compareSyncSides` — iki tarafın karşılaştırması |
| 1736–1772 | Bağımlılık arayüzü |
| 1773–5117 | `GitHubBidirectionalSyncManager` sınıfı: inspect/pull/push/reconcile/verify, hata sınıflandırma |

**Bağımlılıklar:** `node:fs`, `node:async_hooks`, `node:path`, core (cinetrack-core, user-data-merge,
cinema-kunye, keys, limits, derived-profile-cache), `./github-request.ts`, `./persistent-store-utils.ts`.

**Çok sorumluluk mu?** Evet. Dosya hem **veri okuma/ayrıştırma** hem **GitHub protokolü** hem
**birleştirme politikası** hem **hata sınıflandırma** işini yapıyor.

**Bölünme faydası:** Yüksek. `inspect*` okuyucuları (~920 satır) saf ayrıştırma; manager sınıfı
(~3.340 satır) orkestrasyon. Ayrılınca senkron davranışı değişmeden test edilebilirlik artar.

**Riskler:** En yüksek riskli dosya. Aşama 2'de kabul edilen kuyruk/kilit/sayaç davranışı burada.
Bölme sırasında `runExclusiveSync` bağlamı (`AsyncLocalStorage`), journal ve lease etkileşimi
bozulmamalı. Bu dosya **en sona** bırakılmalı.

### 3.3 `src/server/persistent-store.ts` — 4.129 satır, 62 metot

Tek sınıf `PersistentDataStore` içinde şu sorumluluklar:

| Sorumluluk | Örnek metotlar (satır) |
|---|---|
| Yapılandırma / public repo politikası | `getEffectiveConfiguredIsPublicRepo` (407), `setPublicPersonalSyncConsent` (467) |
| Token yönetimi | `updateGitHubToken` (585), `recoverGitHubTokenOn401` (605) |
| Sync state kalıcılığı | `loadPersistedSyncState` (772), `recoverStaleSyncingFileStates` (829), `persistSyncState` (853) |
| Katalog deposu | `readCatalog` (921), `ensureCatalogFiles` (1008), `upsertCatalogItems` (1258) |
| Stok / künye / türetilmiş profil | `readStockSnapshot` (1474), `saveStockSnapshotUpload` (1589), `upsertDerivedProfile` (1731) |
| GitHub uzak işlemleri | `verifyRemoteRepoAccess` (2220), `commitFileToGitHub` (2619) |
| Senkron orkestrasyonu | `syncToGitHub` (3020), `runStagedFullSync` (3254) |
| Binary yedek yükleme | `uploadBinaryBackupToGitHub` (3770) |

**Bağımlılıklar:** `node:fs`, `node:crypto`, core, `./persistent-store-utils.ts`,
`./persistent-store-types.ts`, `./github-bidirectional-sync.ts`, Excel/SQLite arşiv modülleri.
**Kendisine bağımlı:** `server/app.ts` (ana tüketici), `modules/library/*`, `server/taste-*`,
`server/backup*`, testler.

**Bölünme faydası:** Orta-yüksek. Dosya zaten "depo" sınırı içinde; ancak katalog, profil,
sync-state ve GitHub commit'i ayrı depolara ayrılabilir. Tek sınıf olması testte `new PersistentDataStore`
kolaylığı sağlıyor; bu yüzden bölünürse **cephe (facade) sınıfı korunmalı**.

**Riskler:** Yüksek. Aşama 1/2'nin atomik yazma, lease, journal ve serialize davranışları burada.
Ayrıştırma sırasında kilit kapsamı değişirse veri bütünlüğü riski doğar.

### 3.4 `src/App.tsx` — 2.391 satır

Ayrıntı §9'da. Özet: 28 `useState`, 23 `useEffect`, 17 `useCallback`; altı yerel hook zaten
ayrılmış durumda (`useOfflineSync`, `useServerSyncCoordinator`, `useProfileBackupCoordinator`,
`useStockEngine`, `useCinemaKunye`, `useKeyboardShortcuts`) ama kalan üç sorumluluk kümesi
(profil kalıcılığı, belge uygulama/merge, katalog yükleme) hâlâ dosyanın içinde.

### 3.5 Diğer büyük dosyalar

| Dosya | Satır | Sorumluluk | Bölünmeli mi? |
|---|---:|---|---|
| `src/server/excel-profile-backup.ts` | 3.533 | Excel üretimi + ayrıştırma + önizleme | Orta; Aşama 9 (yedekleme) ile birlikte |
| `src/server/app.ts` | 3.011 | Tüm HTTP rotaları | Orta; rota grupları ayrılabilir (Aşama 5 kapsamı dışı sayılabilir) |
| `src/services/api.ts` | 1.828 | TMDB + sunucu API + arşiv + yedek indirme | Orta; `any` yoğun (47) |
| `src/app/catalog-loader.ts` | 1.391 | Katalog sayfalama/önbellek | Düşük |
| `src/server/storage.ts` | 1.381 | Depo soyutlaması | Düşük |
| `src/server/taste-profile-scope.ts` | 1.347 | Profil kapsamlı taste | Düşük |
| `src/modules/content/content-metadata-processor.ts` | 1.179 | Meta veri temizleme | Düşük |

**Not:** `tests/spec-v2-remaining.test.mjs:813-833` yeni/refaktör edilmiş modüller için
"< 1.000 satır" kuralını zaten dayatıyor. Bu kural mevcut dört büyük dosyayı kapsamıyor
(dosyalar "v7 modülü" listesinde değil), dolayısıyla bugün ihlal üretmiyor. Bölme çalışması
bu eşiği yeni modüller için doğal kabul edebilir.

---

## 4. Bağımlılık grafiği ve döngüler

### 4.1 Ölçüm

`scripts/maintenance/architecture-boundaries.mjs` çıktısı:

| Ölçüm | Değer |
|---|---|
| Taranan dosya | 292 |
| Toplam import | 898 |
| Yerel (relative) kenar | 692 |
| Döngüsel import (SCC) | **0** |
| `core-purity` ihlali | 5 (gerçekte **7**, bkz. §4.3) |
| `server-isolation` ihlali | 0 |
| `client-no-server` ihlali | 0 |
| `contracts-isolation` ihlali | 0 |

`scripts/check-cycles.mjs` bağımsız olarak 290 dosya / **924 yerel kenar** ve **0 döngü** buluyor.

### 4.2 Katman yönleri

| Kenar | Adet | Değerlendirme |
|---|---:|---|
| `server → core` | 47 | Beklenen |
| `server → modules` | 13 | **Katman ihlali eğilimi**: sunucu, modül servislerine bağlı (ör. `app.ts` → `modules/library/service.ts`) |
| `server → app` | 5 | **İhlal**: sunucu, istemci kabuğu yardımcılarını kullanıyor (`app/app-event-bus.ts`, `app/runtime-module-registry.ts`, `app/ProfileContext.ts`) |
| `modules → server` | 2 | **İhlal**: modüller sunucuya bakıyor |
| `server → components` / `→ hooks` | 0 / 0 | Temiz |
| `components → core` | 41 | Yoğun ama kural dışı değil |
| `components → app` | 5 | Sınır aşınması |
| `core → services` | 3 (gerçekte 5) | **İhlal** (§6) |

`server → modules`/`server → app` kenarları `architecture-rules.json`'daki mevcut dört kuralın
hiçbiriyle engellenmiyor; bunlar **ölçülen ama korunmayan** sınırlar. Bu, Aşama 5'in
"mimari sınırlar CI ile korunuyor" kabul kriteri açısından gerçek bir boşluk.

Gerçek ihlal örnekleri:

- `src/server/app.ts:45-65` → `../app/app-event-bus.ts`, `../app/ProfileContext.ts`,
  `../modules/library/service.ts`, `../modules/content/service.ts`, `../modules/background/*`.
- `src/server/library-event-diff.ts:16` → `../app/app-event-bus.ts`.
- `src/server/content-processing-queue.ts:16-21` → `../modules/content/*`.

### 4.3 Tarayıcının kapsama açığı (doğrulanmış)

`architecture-boundaries.mjs` çok satırlı import'ları kaçırıyor. Satır bazlı desenler yalnızca
`import … from '…'` biçimini ve satır başındaki `from '…'` biçimini tanıyor; kapanış satırı
`} from '../services/…'` hiçbir desene uymuyor:

```
LINE_SPECIFIER_PATTERNS = [
  /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/,
  /^\s*from\s*['"]([^'"]+)['"]/,
  /^\s*import\s+['"]([^'"]+)['"]/,
]
```

Sonuç: `src/core` içinde **28** çok satırlı import kapanışı var ve bunların en az ikisi
(`relationship-explorer.ts` → `storage-idb.ts`, `series-tv-seeds.ts`) gerçek ihlal olmasına
rağmen raporlanmıyor. Bu nedenle "5 ihlal" sayısı eksik; gerçek sayı **7**.

**Değerlendirme:** Tarayıcı CI'da bloklayıcı kapı yapılmadan önce bu açık kapatılmalı.
Aksi hâlde "yeni ihlal yok" güvencesi yanlış olur.

---

## 5. Tekrarlanan iş mantıkları

Aşağıdaki tablo yalnızca **doğrulanmış kopyaları** listeler. Davranış farkı olan yerler ayrıca
işaretlendi; birleştirme önerisi bu farklar incelenmeden uygulanmamalı.

| İşlem | Uygulama noktaları | Fark | Değerlendirme |
|---|---|---|---|
| `mergeCatalogItem` | `src/server/persistent-store-utils.ts:66` ve `src/server/store-catalog.ts:44` | Gövde birebir aynı görünüyor | **store-catalog.ts ölü** (hiç import edilmiyor) → kopya |
| `normalizeCatalogRecordStrict` / `mergeCatalogRecordsLossless` / `mergeCatalogMapsLossless` | `src/server/github-bidirectional-sync.ts:170/254/391` ve `src/server/github-catalog-sync.ts:11/95/232` | **Davranış farkı var**: eski kopyada `voteCount` satırı `Math.max(localVotes, remoteVotes) || undefined` biçiminde; canlı sürümde farklı. Eski dosya ölü | **Ölü + ıraksamış kopya** — canlı davranış korunmalı |
| `redactSecrets` | `src/server/persistent-store-utils.ts:8` (canlı) ve `src/server/store-types.ts:225` (ölü) | Gövde aynı | Kopya; `store-types.ts` ölü |
| `hashContent` | `persistent-store-utils.ts:47` ve `store-types.ts:264` | Aynı (`sha256` hex) | Kopya; `store-types.ts` ölü |
| `stringifyDeterministic` | `persistent-store-utils.ts` (canlı) ve `store-types.ts:244` (ölü) | Aynı | Kopya |
| `sanitizeProfileId` | `persistent-store-utils.ts:152` ve `store-profile.ts:34` (ölü) | Aynı | Kopya; `store-profile.ts` ölü |
| `toCanonicalKey` | `persistent-store-utils.ts` ve `store-catalog.ts:27` (ölü) | Aynı | Kopya |
| Deterministik hash/serileştirme | `persistent-store-utils.ts:hashContent`, `core/derived-profile-cache.ts:hashDeterministic` (89), `github-bidirectional-sync.ts:computeRawUtf8Hash` (141), `computeCatalogSemanticMapHash` (380), `computeUserDataSemanticHash` (518), `server/archive-integrity.ts:hashDocument` (43), `services/api.ts:computeSha256HexBrowser` (1201) | Farklı **girdi sözleşmeleri** (ham UTF-8, kanonik JSON, belge özeti, tarayıcı ArrayBuffer). Aynı primitifin farklı amaçlarla kullanımı | **Bilinçli çeşitlilik**: tek "hash" fonksiyonuna indirgemek yanlış olur. Tek kaynak **primitif** olmalı (UTF-8 → sha256), algoritma/çıktı biçimi korunmalı |
| Kullanıcı verisi birleştirme | `core/user-data-merge.ts` (tek kaynak), `core/cinema-kunye.ts:367/605` (alan bazlı), `core/duplicate-detector.ts:449` (çift birleştirme) | Farklı alanlar | **Bilinçli ayrım**; birleştirilmemeli |
| Normalizasyon | `core/cinetrack-core.ts` (`normalizeSavedItem`, `normalizeDataDocument`, `normalizePreferences`), `core/profile-id.ts`, `services/operations-api.ts`, `modules/content/content-metadata-processor.ts` | Farklı alan sözleşmeleri | Bilinçli; ancak `normalizeProfileId` (core) ile `sanitizeProfileId` (server) karıştırılmamalı |
| Dedupe | `core/cinetrack-core.ts:dedupeItems`, `services/stock-filter.ts:dedupeAndPurgeStockList` | Farklı veri kümeleri | Bilinçli |

**Ölü modüller (git grep ile doğrulandı, hiçbir import yok):**

| Dosya | Satır | Not |
|---|---:|---|
| `src/server/store-catalog.ts` | 125 | `persistent-store-types` + `persistent-store-utils` kopyası |
| `src/server/store-profile.ts` | 37 | `sanitizeProfileId` kopyası |
| `src/server/sync-compare.ts` | 214 | `compareSyncSides` canlı sürümü `github-bidirectional-sync.ts:1545`'te |
| `src/server/sync-manifest.ts` | 285 | Manifest mantığı canlı sürümde |
| `src/server/github-catalog-sync.ts` | 292 | Katalog birleştirme kopyası, **ıraksamış** |
| `src/hooks/useAppModals.ts` | 124 | Modal state'i `App.tsx` içinde yaşıyor |
| `src/services/poster-hydration-service.ts` | 736 | Poster hidrasyonu başka yoldan yürüyor |
| **Toplam** | **1.813** | (`store-types.ts` 266 satır ayrıca sayılırsa 2.079) |

Bunlara ek olarak `src/server/respan-telemetry.ts` yalnızca kendi testi tarafından import ediliyor (§10).

**Uyarı:** Ölü dosyalar `git log`'da son olarak `3945592` (Aşama 1) ve `44aabcd` ile dokunulmuş.
Bir kısmı Aşama 1 sırasında yeni canlı sürümler yazılırken geride kalmış görünüyor. Silme,
"hangi kopya canlı" sorusu netleştikten sonra yapılmalı; `github-catalog-sync.ts`'teki
`voteCount` farkı bu yüzden ayrıca incelenmeli.

---

## 6. Core katmanındaki ihlaller (B-17)

`src/core` içinde altyapıya bağımlılıklar — tarayıcının raporladığı 5 + çok satırlı import
açığı nedeniyle bulunan 2:

| # | Dosya:satır | Import | Tür | Etki |
|---|---|---|---|---|
| 1 | `core/actor-recommendations.ts:2` | `../services/api-client.ts` | Ağ istemcisi | Core, tarayıcı fetch sarmalayıcısına bağlı; Node test bağlamında da yükleniyor |
| 2 | `core/cinetrack-core.ts:4` | `idb-keyval` | IndexedDB | Core, tarayıcı deposuna bağlı; Node'da polyfill gerekiyor |
| 3 | `core/cinetrack-core.ts:5` | `../services/api-client.ts` | Ağ istemcisi | Oyuncu kredisi getirme core içinde |
| 4 | `core/relationship-explorer.ts:18` | `../services/encoding-service.ts` | Worker/encoding | Kodlama servisi core'a sızıyor |
| 5 | `core/relationship-explorer.ts:19-22` | `../services/storage-idb.ts` | IndexedDB | **Tarayıcı raporlamıyor** (çok satırlı import) |
| 6 | `core/relationship-explorer.ts:23-26` | `../services/series-tv-seeds.ts` | Veri/servis | **Tarayıcı raporlamıyor** |
| 7 | `core/taste/migration.ts:265` | `require("crypto")` | Node yerleşik | Tarayıcıda `require` yolu; `globalThis.crypto` varsa kullanılmıyor |

**Değerlendirme:** Dördü de "port/adaptör" ile çözülebilir; davranış değişikliği gerekmez:

- `api-client` → `CandidateFetchPort` / `ActorCreditsPort` (mevcut çağrı yerleri enjekte edilir).
- `idb-keyval` → `KeyValuePort` (zaten `persistent-store-types.ts` benzeri port deseni var).
- `encoding-service` → `EncodingPort`.
- `series-tv-seeds` → saf veri; `core` içine taşınabilir veya port olur.
- `crypto` → `IdGeneratorPort` (`globalThis.crypto.randomUUID` yolu zaten var).

**Önemli:** `core/taste/migration.ts` içindeki `require("crypto")` fallback'i tarayıcı paketine
giriyor. `vite build` bunu bugün kaldırıyor gibi görünüyor (build başarılı), ama bu bir
"şans eseri çalışıyor" durumu; bölme sırasında doğrulanmalı.

---

## 7. Type safety ve API sözleşmeleri

### 7.1 `any` envanteri

`src` genelinde **679** eşleşme (`: any`, `as any`, `any[]`, `<any>`). Dağılım:

| Dosya | Adet | Sınır mı? |
|---|---:|---|
| `core/cinetrack-core.ts` | 128 | Karışık: normalizasyon girdileri (savunulabilir) + tipler |
| `services/api.ts` | 47 | **Evet** — API yanıtları |
| `server/persistent-store.ts` | 37 | **Evet** — GitHub/catalog yanıtları |
| `server/app.ts` | 36 | **Evet** — rota gövdeleri |
| `app/catalog-loader.ts` | 36 | **Evet** — TMDB sayfaları |
| `server/github-bidirectional-sync.ts` | 24 | **Evet** — GitHub içerikleri |
| `modules/recommendations/pipeline.ts` | 22 | Hayır (iç boru hattı) |
| `core/actor-recommendations.ts` | 19 | Karışık |
| `components/DetailModal.tsx` | 19 | UI |
| `services/tvdb-service.ts` | 12 | **Evet** — TVDB yanıtları |

`tsconfig.json`: `strict: true`, ancak `noUnusedLocals: false`, `noUnusedParameters: false`.
ESLint'te `@typescript-eslint/no-explicit-any` **kapalı** (satır 27, 70) ve yalnızca tek bir
kapsamda `warn` (satır 117). Yani `any` bugün ne derleyici ne lint tarafından engellenmiyor.

### 7.2 Runtime doğrulama durumu

| Kaynak | Mevcut doğrulama | Değerlendirme |
|---|---|---|
| TMDB yanıtları | `validateTmdbResponseShape` (`services/api.ts:134-193`) | ✅ Yol bazlı şekil kontrolü var; alan tipleri `any` |
| GitHub içerikleri | `normalizeCatalogRecordStrict`, `inspect*RawContent` (bidi sync) | ✅ Kısmi: katalog/kullanıcı verisi alan alan doğrulanıyor |
| GitHub API meta yanıtları | `classifyGitHubHttpStatus`, `grade*` | ⚠️ Şekil doğrulaması zayıf, çoğu `any` |
| TVDB yanıtları | `services/tvdb-service.ts` | ⚠️ `any` (12) + tip dönüşümü; şema doğrulaması görünmüyor |
| Sunucu `/api/*` yanıtları | `normalizeOperations*` (`services/operations-api.ts`) | ✅ Sınırlı ama gerçek doğrulama |
| Yedek/Excel içe aktarma | `parseBackupText`, `sanitizeSpreadsheetText` | ✅ Güçlü (Aşama 1) |

**Sonuç:** Projede zaten el yazımı "normalize/sanitize" geleneği var ve bu, yeni bir şema
kütüphanesi eklemeye göre daha tutarlı. `zod` `package.json`'da yalnızca `overrides` içinde
(satır 35), doğrudan bağımlılık değil ve kodda hiç kullanılmıyor. Aşama 5 için öneri:
**mevcut `normalize*` desenini sürdürüp sınır dosyalarında tipleri daraltmak**, yeni bağımlılık
eklememek. `noUnusedLocals`/`noUnusedParameters` kademeli açılabilir; ancak bu, 679 `any` ile
birleşince büyük bir temizlik dalgasına dönüşebilir — kapsam dışına çıkmamak için yalnızca
dokunulan modüllerde açılmalı.

---

## 8. Test kalitesi — B-15

### 8.1 Ölçüm

Unit suite: 80 dosya / 817 test. Taste suite: 27 dosya / 440 test.

**Kaynak metnini okuyup içerik eşleştiren dosyalar (9):**

| Dosya | Test | `readFileSync` | Ne doğruluyor |
|---|---:|---:|---|
| `tests/spec-v7-regressions.test.mjs` | 5 | 11 | Bileşenlerde Türkçe metin, `style={{` yokluğu, `vite.config.ts` sırası, dosya satır sayısı |
| `tests/spec-v2-remaining.test.mjs` | — | 4+ | `copyFileSync` yokluğu, `.env.example` içeriği, sabit 20xx yılı yokluğu |
| `tests/phases-all.test.mjs` | 15 | 9 | `server.ts` sabitleri, `Controls.tsx` etiketi, `.env.example` |
| `tests/phase3-ui-write-paths.test.mjs` | 7 | 4 | Export edilen fonksiyon adları, import yolları, `class LibraryService` yokluğu |
| `tests/persistent-store.test.mjs` | 11 | 14 | `App.tsx` kod parçaları, README/ARCHITECTURE metni |
| `tests/phase7-ui-service-pipeline.test.mjs` | 6 | 1 | `App.tsx` servis bağlama satırı |
| `tests/phase6-recommendation-manager.test.mjs` | 6 | 2 | Dosya içeriği |
| `tests/api-auth-coverage.test.mjs` | 3 | 4 | `fetch('/api` deseni yokluğu, `apiFetch` export'u |
| `tests/discover-state-boundary.test.mjs` | 1 | 2 | `state.ts` alan adları, `useState` yokluğu |

Temsili örnekler (satır numaralarıyla):

- `tests/spec-v7-regressions.test.mjs:499-517`: `MediaGrid.tsx` içinde `'Stok havuzunu indir'`
  metnini arıyor. Metin değişse davranış aynı olsa da test kırılır.
- `tests/phases-all.test.mjs:880-883`: `server.ts` içinde
  `"const CINETRACK_HOST = '127.0.0.1'"` **karakter dizisini** arıyor.
- `tests/phase3-ui-write-paths.test.mjs:105-135`: `export interface ILibraryService` tanımının
  yalnızca `contracts/services.ts`'te olduğunu **regex ile** doğruluyor.
- `tests/discover-state-boundary.test.mjs:8-28`: `useState` çağrısının **metin olarak**
  bulunmadığını iddia ediyor.

### 8.2 Değerlendirme

Üç ayrı kategori var ve ayrı ele alınmalı:

1. **Gerçekten kırılgan olanlar (dönüştürülmeli):** UI metni/JSX içeriği arayan testler
   (`spec-v7:499-517`, `phases-all:1285-1303`, `discover-state-boundary` tamamı). Bunlar
   davranışı değil dosya düzenini koruyor.
2. **Mimari sözleşmeyi koruyanlar (bilinçli istisna):** `phase3-ui-write-paths:105-135`
   (tek kaynak tanımı), `api-auth-coverage` (`/api` fetch yasağı), `architecture-boundaries.test.mjs`.
   Bunlar kaynak metnine baksa da **amaçları mimari sınırı korumak**; davranışsal karşılığı yok.
   Bunlar "kırılgan test" değil, statik mimari kapıdır ve AST tabanlı hâle getirilebilir.
3. **Yanlış pozitif riski yüksek olanlar:** `spec-v2:246-252` — kaynakta herhangi bir `20\d\d`
   yılı aramak; bir yorum veya örnek veri eklendiğinde kırılır.

**Kritik sıralama sonucu:** Refaktör (özellikle `cinetrack-core`/`App.tsx` bölme), kategori 1
testleri kıracaktır. Bu yüzden B-15 dönüşümü **ilk iş** olmalı; aksi hâlde refaktör sırasında
"test kırıldı" sinyali gerçek regresyonla ayırt edilemez.

---

## 9. `App.tsx` sorumluluk analizi

**Boyut:** 2.391 satır · 28 `useState` · 23 `useEffect` · 17 `useCallback`.

Zaten ayrılmış olanlar (iyi durum): `useOfflineSync`, `useServerSyncCoordinator`,
`useProfileBackupCoordinator`, `useStockEngine`, `useCinemaKunye`, `useKeyboardShortcuts`,
`useDiscoverState`, `useLibraryController`, `useToasts`, `useHashNavigation`,
`createCatalogLoader`, `buildUserDataDocument`, `app/profile-storage.ts`.

Hâlâ `App.tsx` içinde kalan sorumluluk kümeleri:

| Küme | Kanıt (satır) | Ayrılabilir mi? |
|---|---|---|
| Profil kalıcılığı | `persistProfilesBestEffort` (541), `profiles/activeProfileId/preferences/savedItems/favoriteActors/deletedKeys` state'leri (168-183), `profile-storage.ts` yükleyicileri | ✅ `useProfilePersistence` |
| Uzak belge uygulama/merge | `mergeRemoteDocumentIntoState` (601), `handleMergedServerDocument` (668), `applyDataDocumentToState` (747), `pullMergeFromServerIfAdvanced` (822) | ✅ `useRemoteDocumentSync` (test edilebilir saf dönüşüm + hook) |
| Yayın hatırlatmaları | `checkReleaseReminders` (951) ve ilgili effect (997) | ✅ `useReleaseReminders` |
| Katalog yükleme orkestrasyonu | `loadCategoryResults` (1012), `handleSelectType/Genre` (1091/1096) | ✅ Kısmen `catalog-loader` içinde; kalan seçim mantığı ayrılabilir |
| Sekme/modül yönlendirme | `tab`, `useHashNavigation`, `getModule` | ⚠️ Zaten modül kayıt defterinde; dokunma |
| Modal state | 8 ayrı `useState` (247-255) | ⚠️ `useAppModals.ts` **ölü** olarak duruyor; canlı kod App içinde. Ya hook kullanılmalı ya ölü dosya silinmeli |

**Değerlendirme:** `App.tsx` "her şeyi yapan" bir dosya değil; çoğu sorumluluk zaten hook'lara
taşınmış. Kalan yük ağırlıklı olarak **veri belgesi senkronizasyonu** ve **profil kalıcılığı**.
Bu ikisi ayrıldığında dosya ~1.200-1.400 satıra iner ve `mergeRemoteDocumentIntoState` gibi
kritik mantık davranışsal olarak test edilebilir hâle gelir.

---

## 10. `@respan/respan` değerlendirmesi (B-18)

**Kurulum:** `package.json:20` → `"@respan/respan": "2.5.0"` (çalışma zamanı bağımlılığı).

**Kullanım haritası:**

| Yer | Ne yapıyor |
|---|---|
| `src/server/respan-telemetry.ts` | `createRespanTracing()` — SDK'yı yalnızca `RESPAN_API_KEY` varsa dinamik import eder, `initialize()` çağırır, adaptör durumlarını sayar |
| `src/server/config.ts:144-145, 277-279, 390-391` | `RESPAN_API_KEY` / `RESPAN_BASE_URL` okunur ve config nesnesine konur |
| `tests/respan-telemetry.test.mjs` | Modülü **tek** tüketici; sahte istemciyle davranış testi |

**Kritik bulgu:** `git grep respan-telemetry` yalnızca test dosyasını döndürüyor. `server.ts`,
`src/server/app.ts` veya başka hiçbir üretim yolu `createRespanTracing`'i çağırmıyor.
Yani **SDK kurulu, config alanları okunuyor, modül test ediliyor; ama hiçbir zaman başlatılmıyor.**

**Ek bulgu:** `config.respanApiKey`/`respanBaseUrl` hiçbir yerde tüketilmiyor (yalnızca config
nesnesinde taşınıyor). Uygulamada model çağrısı yok (OpenAI/Anthropic/Bedrock kullanımı yok),
bu yüzden SDK'nın izleyeceği bir trafik de yok.

**Seçenekler:**

| Seçenek | Sonuç | Risk |
|---|---|---|
| **A. Kaldır** (öneri) | `@respan/respan` bağımlılığı, `respan-telemetry.ts`, config alanları ve testi kaldırılır | Düşük. Ürün gereksinimi yoksa doğru karar; tedarik zinciri yüzeyi ve lockfile küçülür |
| B. Gerçekten bağla | `server.ts` başlangıcında `createRespanTracing({apiKey, baseUrl}).start()` çağrılır | Orta. Bugün izlenecek model çağrısı yok; boş telemetri ve dış ağ bağımlılığı doğar |
| C. Olduğu gibi bırak | Ölü kod + ölü bağımlılık kalır | Düşük ama teknik borç sürer |

**Karar kullanıcıya ait.** Ürün tarafında LLM izleme planı yoksa A; ileride model çağrısı
eklenecekse B. Bu belge yalnızca durumu tespit eder; **paket kaldırılmamıştır**.

---

## 11. Tespit edilen riskler

| # | Risk | Kanıt | Etki |
|---|---|---|---|
| R1 | Refaktör, kaynak metni eşleştiren testleri kırar ve gerçek regresyonu maskeler | §8.1, 9 dosya | Yüksek — bu yüzden test dönüşümü önce gelmeli |
| R2 | Mimari tarayıcı çok satırlı import'ları kaçırıyor; "yeni ihlal yok" güvencesi yanlış olabilir | §4.3, `src/core` içinde 28 çok satırlı import | Yüksek — CI kapısı olmadan önce düzeltilmeli |
| R3 | Hash/serileştirme birleştirmesi veri kimliğini değiştirebilir (senkron karşılaştırması, arşiv bütünlüğü) | §5, 7 farklı hash kullanımı | Yüksek — çıktı vektörleri korunmalı |
| R4 | `persistent-store`/`github-bidirectional-sync` bölünürken kilit/lease kapsamı değişebilir | §3.2–3.3, Aşama 1/2 davranışları | Yüksek — veri bütünlüğü |
| R5 | Ölü dosya silme, ıraksamış bir davranışın tek kopyasını yok edebilir | `github-catalog-sync.ts` `voteCount` farkı | Orta — silmeden önce canlı kopyayla karşılaştırma |
| R6 | Core purity port enjeksiyonu IDB/ağ çağrılarının zamanlamasını değiştirebilir | §6, `loadPersistentTasteMap`, `fetchActorCreditsBatch` | Orta — davranışsal test şart |
| R7 | `any` temizliği `strict` ile birleşince büyük bir dalga yaratabilir | §7, 679 `any` | Orta — yalnızca dokunulan sınırlarda ilerlemeli |
| R8 | `require("crypto")` fallback'i tarayıcı paketinde çalışma zamanı hatası üretebilir | `core/taste/migration.ts:265` | Düşük ama gerçek |
| R9 | `noUnusedLocals`/`noUnusedParameters` açılırsa CI yeni hatalarla kırılabilir | `tsconfig.json:16-17` | Düşük — kademeli açılmalı |

---

## 12. Önceliklendirilmiş refaktör önerileri

Sıra, **bağımlılık ilişkisine** göre belirlendi (Bölüm B'nin önerdiği sıradan iki sapma var;
gerekçeleri tabloda).

| ID | Öneri | Bulgu | Öncelik | Neden bu sırada |
|---|---|---|---|---|
| **F5-01** | Kaynak metni eşleştiren testleri davranışsal testlere dönüştür (kategori 1); mimari testleri AST/import-tabanlı hâle getir (kategori 2) | B-15 | **P0** | Diğer tüm refaktörlerin güvenlik ağı; önce yapılmazsa R1 gerçekleşir |
| **F5-02** | `architecture-boundaries.mjs` çok satırlı import açığını kapat; `core → services` ve `server → app/modules` kurallarını ekle; mevcut 7 ihlal için **azalan** izin listesi | B-17, §4.3 | **P0** | Sonraki adımların "yeni ihlal yok" kanıtı buna dayanır |
| **F5-03** | Tek kaynak temizliği: ölü kopyaları sil (`store-catalog`, `store-profile`, `store-types`, `sync-compare`, `sync-manifest`, `github-catalog-sync`), canlı kopyaları yetkili ilan et | B-16, §5 | P1 | Düşük risk, yüksek net kazanç; bölmeden önce gürültüyü azaltır |
| **F5-04** | Core purity: `api-client`, `idb-keyval`, `encoding-service`, `series-tv-seeds`, `crypto` için port/adaptör | B-17 | P1 | `cinetrack-core` bölünmesinin ön koşulu; I/O ayrılınca bölme temiz olur |
| **F5-05** | `cinetrack-core` bölünmesi: `core/types.ts`, `core/normalize.ts`, `core/backup.ts`, `core/taste/profile.ts`, `core/recommendation/scoring.ts`, `core/taste/map-store.ts`; **barrel korunur** | B-16 | P1 | En büyük dosya; port ayrımından sonra en düşük riskli bölme |
| **F5-06** | `App.tsx` sadeleştirmesi: `useProfilePersistence`, `useRemoteDocumentSync`, `useReleaseReminders` | B-16 | P2 | Core bölünmesinden sonra tipler oturmuş olur |
| **F5-07** | `persistent-store` ayrıştırması: katalog / profil+derived / sync-state / GitHub commit; **facade korunur** | B-16 | P2 | Yüksek risk; kilit davranışı testleri genişletildikten sonra |
| **F5-08** | `github-bidirectional-sync` ayrıştırması: `inspect/` okuyucuları, `merge/` politikası, manager | B-16 | P2 | En yüksek risk; en son |
| **F5-09** | Type safety: sınır dosyalarında (`services/api.ts`, `catalog-loader`, `server/app.ts`, `tvdb-service`, bidi) `any` daraltma + mevcut `normalize*` deseniyle runtime doğrulama; `noUnused*` kademeli | B-16 | P2 | Bölmelerden sonra dosya sınırları netleşince |
| **F5-10** | `@respan/respan` kararı: kaldır **veya** başlat (ürün onayı gerekir) | B-18 | P3 | Bağımsız; veri/senkron riski yok |
| **F5-11** | Ölü `useAppModals.ts` / `poster-hydration-service.ts` kararı: canlı kodla birleştir veya sil | B-16 | P3 | Bağımsız, küçük |

**Bölüm B sırasından sapmalar:**

- B-15 gerçekten ilk sırada (aynı).
- "Tekrarlanan iş mantıkları" ikinci sırada **değil**, çünkü önce ölü kopyaların hangisi olduğu
  netleşmeli (F5-03) ve port ayrımı (F5-04) core kopyalarını etkiliyor. Bu yüzden F5-02 (kapı)
  ve F5-03 (ölü kopya) öne alındı.
- Büyük dosya bölme, core purity'den **sonra**: aksi hâlde aynı dosyaya iki kez dokunulur.

---

## 13. Her öneri için tahmini etki ve risk

> Aşağıdaki süre/etki değerleri **tahmindir**, ölçülmüş sonuç değildir. Risk düzeyi, mevcut
> test kapsamı ve Aşama 1–4 davranışlarına etkisi dikkate alınarak verilmiştir.

| ID | Etki | Risk | Geri alınabilirlik |
|---|---|---|---|
| F5-01 | Testler refaktörü engellemeyi bırakır; ~9 dosya / ~54 test dönüşür | Orta — yanlış dönüşüm kapsam kaybı yaratır; her dönüşüm önce/sonra aynı davranışı kanıtlamalı | Yüksek (commit bazlı) |
| F5-02 | Mimari kapı gerçekten bloklayıcı olur; kaçırılan 2 ihlal görünür | Düşük — yalnızca betik/CI | Yüksek |
| F5-03 | 1.813 ölü satır (store-types ile 2.079) ve 6 kopya fonksiyon kalkar | Düşük-orta — `github-catalog-sync` farkı doğrulanmalı | Yüksek |
| F5-04 | Core 7 ihlal → 0; Node testlerinde IDB/ağ bağımlılığı kalkar | Orta — enjeksiyon noktaları davranışı kaydırabilir | Orta |
| F5-05 | 6.445 → ~6 modül (en büyüğü ~1.500 satır); skorlama saf ve hızlı test edilir | Orta — import yolları; barrel ile azaltılır | Orta |
| F5-06 | 2.391 → ~1.300 satır; merge/senkron mantığı davranışsal test edilebilir | Orta — effect sırası ve ref'ler hassas | Orta |
| F5-07 | 62 metotluk sınıf 4 depoya ayrılır; katalog testleri izole olur | **Yüksek** — atomiklik/kilitleme | Düşük-orta |
| F5-08 | 5.117 → 3 modül; inspect testleri saf hâle gelir | **Yüksek** — senkron davranışı | Düşük-orta |
| F5-09 | Sınır `any` sayısı düşer; yeni alanlar derleyici tarafından yakalanır | Orta — yanlış tip gerçek hatayı gizleyebilir | Yüksek |
| F5-10 | Bağımlılık yüzeyi küçülür veya telemetri gerçekten çalışır | Düşük (kaldırma) / Orta (bağlama) | Yüksek |
| F5-11 | Ölü dosya kalmaz | Düşük | Yüksek |

**Önerilen commit grupları (uygulama onaylanırsa):** her ID ayrı commit (F5-05 ve F5-07/F5-08
kendi içinde 2–3 küçük commit'e bölünür). Her gruptan önce ve sonra §1.2'deki beş komut.

---

## 14. Aşama 5 kabul kriterleriyle mevcut durum

| # | Kabul kriteri | Bugünkü durum | Kanıt |
|---|---|---|---|
| 1 | Testlerde implementasyon metni aramak yerine davranışsal doğrulama | ❌ Karşılanmıyor | 9 dosya kaynak metni okuyor (§8.1) |
| 2 | Büyük dosyalar sorumluluklarına göre ayrıştırılmış | ❌ Karşılanmıyor | 4 dosya = 41.514 satır (§3) |
| 3 | Tekrarlanan kritik veri/güvenlik işlemleri tek yetkili uygulamada | ❌ Karşılanmıyor | 6 kopya fonksiyon + 7 ölü modül (§5) |
| 4 | Core katmanındaki altyapı bağımlılıkları azaltılmış | ❌ Karşılanmıyor | 7 ihlal / 4 dosya (§6) |
| 5 | Yeni mimari ihlal veya döngüsel bağımlılık oluşturulmamış | ✅ Karşılanıyor (henüz değişiklik yok) | 0 döngü; 7 mevcut ihlal değişmedi |
| 6 | API ve harici servis verilerinin tip güvenliği artırılmış | ❌ Karşılanmıyor | 679 `any`; sınır dosyalarında 200+ (§7) |
| 7 | Gerekli runtime validation mekanizmaları eklenmiş | ⚠️ Kısmen | TMDB + yedek doğrulaması var; GitHub meta/TVDB zayıf (§7.2) |
| 8 | `App.tsx` sorumlulukları sadeleştirilmiş | ❌ Karşılanmıyor | 2.391 satır, 23 effect (§9) |
| 9 | `@respan/respan` değerlendirilmiş ve gerekçeli karar verilmiş | ⚠️ Değerlendirildi, karar bekliyor | §10 — paket başlatılmıyor, kullanıcı kararı gerekli |
| 10 | Mimari sınırlar CI kontrolleriyle korunuyor | ⚠️ Kısmen | Döngü + 4 kural var; tarayıcı çok satırlı import'u kaçırıyor ve `server → app/modules` kuralı yok (§4.2–4.3) |
| 11 | Önceki aşamaların davranışları ve testleri korunmuş | ✅ Karşılanıyor | 817/817, 440/440, data-guard OK |
| 12 | Build, lint, test ve E2E başarılı | ✅ (başlangıç referansı) | §1.2; E2E bu oturumda yeniden koşulmadı, CI `9a00628` 4/4 |
| 13 | Dokümantasyon güncel ve gerçek durumu yansıtıyor | ⚠️ Bu belge eklendi; plan dosyası Aşama 5 uygulamasından sonra güncellenecek | §1 |
| 14 | PR #65 açık ve merge edilmemiş | ✅ Karşılanıyor | `open`, `merged: false`, base `master` |

**Sonuç:** Aşama 5 **başlamamıştır**; yalnızca Bölüm A (envanter) tamamlanmıştır. 14 kriterin
3'ü bugün karşılanıyor, 3'ü kısmen, 8'i karşılanmıyor. Hiçbir kaynak dosya değiştirilmedi.

---

## 15. Onay bekleyen kararlar

1. **F5-01 → F5-11 uygulama sırası** onaylanıyor mu? (Bölüm B sırasından iki sapma §12'de gerekçeli.)
2. **`@respan/respan`:** kaldırılsın mı, başlatılsın mı, yoksa ertelensin mi? (§10)
3. **Core purity portları** için mevcut `contracts/` katmanı mı kullanılsın, yoksa `core/ports/`
   altında ayrı arayüzler mi tanımlansın?
4. **Büyük dosya bölünmelerinde barrel (yeniden dışa aktarma) korunacak mı?** Öneri: evet
   (import yolu kırılmasını önler, ancak "tek modül" görüntüsü bir süre devam eder).
5. **`tests/spec-v2-remaining.test.mjs:813-833`** "< 1.000 satır" kuralı yeni modüller için
   korunacak mı? (Mevcut büyük dosyalar bu kuralın dışında.)

Bu kararlar verilmeden Bölüm B'ye (uygulama) başlanmayacaktır.

---

## 16. Uygulama sonuçları (Bölüm B — 24 Kasım 2026)

Bu envanter **uygulama öncesi** durumu kaydeder ve tarihsel referans olarak değiştirilmedi.
Uygulama sonrası gerçek durum ayrı belgede tutulur:

- **Ayrıntılı sonuç:** [PHASE_05_IMPLEMENTATION_RESULTS.md](PHASE_05_IMPLEMENTATION_RESULTS.md)
- **Yeni mimari:** [../../PHASE_05_ARCHITECTURE.md](../../PHASE_05_ARCHITECTURE.md)

### 16.1 Özet

| Madde | Envanterdeki durum | Uygulama sonrası |
|---|---|---|
| F5-01 test kalitesi | Kaynak metni eşleyen testler | 2 dosya AST/davranışsal; 3 dosyada iş sürüyor (kısmi) |
| F5-02 AST tarayıcı | Regex, 5/7 ihlal görüyor | **AST; 310 dosya, 6 kural, 0 ihlal, boş allowlist** |
| F5-03 ölü kod | 7 dosya listelendi | 3 dosya kaldırıldı, 5'i zaten yoktu; `voteCount` farkı yok |
| F5-04 core purity | 7 ihlal | **0 ihlal; `src/core/ports/` + adaptörler** |
| F5-05 cinetrack-core | 6.445 satır | 5.335 satır + 3 saf modül (kısmi) |
| F5-06 App.tsx | 2.391 satır | 2.391 satır (yapılmadı) |
| F5-07 persistent-store | 4.129 satır | 3.876 satır + sözleşme modülü (kısmi) |
| F5-08 bidi sync | 5.117 satır | 5.118 satır (denendi, geri alındı) |
| F5-09 tip güvenliği | 679 `any` | Dış JSON guard'ları + TMDB sınırı (kısmi) |
| F5-10 Respan | Değerlendirildi | **Tamamen kaldırıldı** |
| F5-11 kalan borç | — | Yeniden tarandı, dokümante edildi (kısmi) |

### 16.2 Kapılar

818/818 unit · 440/440 taste · lint 0/0 · 0 döngü · 0 mimari ihlal · build başarılı ·
data guard 15 dosya değişmedi. E2E bu oturumda koşulmadı (CI'da çalışır).

### 16.3 §15'teki onay bekleyen kararların sonucu

1. Uygulama sırası: kullanıcı talimatı F5-02 → F5-01 → … olarak verildi; uygulandı.
2. `@respan/respan`: **kaldırıldı** (kullanıcı kararı).
3. Core portları: **`src/core/ports/`** kullanıldı; `contracts/` uygulama katmanı sözleşmeleri
   için korundu.
4. Bölünmelerde barrel/uyumluluk: **korundu** (yeniden dışa aktarım + tek satırlık shim).
5. `< 1.000 satır` hedefi yeni modüllerde **sürdürüldü**; mevcut büyük dosyalar kapsam dışı.
