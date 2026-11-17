# MIA Faz 5 — R2-A1 Teknik Hazırlık Raporu

**Durum:** Kodlama öncesi teknik hazırlık ve envanter raporu. Bu belge **analiz amaçlıdır**; uygulama izni değildir.  
**Kapsam notu:** Kod değişikliği, yeni uygulama dosyası, test ekleme/değişikliği, migration/veri taşıma, R1/master değişikliği ve R2-A1 kodlaması bu rapor kapsamında yapılmamıştır.

## 1. Git tabanı ve inceleme kapsamı

| Öğe | Değer / doğrulama | Not |
|---|---|---|
| Depo | `SiriusBrahim/Cinethos` (`origin https://github.com/SiriusBrahim/Cinethos.git`) | `git ls-remote` ile doğrulandı |
| `origin/master` (uzak) | `2ffe4bf82a5d512c1dafd7754498554e443c9098` (`refs/heads/master`) | Doğrulandı |
| İncelenen master commit | `2ffe4bf82a5d512c1dafd7754498554e443c9098` — `MIA Faz 4: BackgroundManager kalıcı regresyon testleri (22 test) (#28)` | Kaynak kod envanteri bu commit üzerinden incelendi |
| R1 dalı | `agent-2/phase-5-r1-eventbus-boundaries` | Uzak/yerel dal mevcut; R1 PR/icerigi bu raporda değiştirilmedi |
| R1 HEAD | `3f256a7f77c6e7e6d27ff4a11dfa225445ba3a67` (`docs(mia): Faz 5 R1 EventBus sınırlarını netleştir`) | R1 henüz master’a merge edilmemiştir |
| İnceleme yöntemi | `git show 2ffe4bf:<path>`, `git ls-tree -r --name-only 2ffe4bf`, `git grep -n ... 2ffe4bf` | `refs/remotes/origin/master` lokal izleme ref’i oluşmadığı için master içeriği commit nesnesinden okundu |

**R1 ayrımı:** R1 dokümantasyonu (`docs/mia/faz5-r1-eventbus-sinirlari.md`, R1 dalında) master kodunun parçası gibi değerlendirilmemiştir. Bu rapor, master (`2ffe4bf`) kaynak kod envanterine ve Faz 5 R2 tasarım sözleşmesi gereksinimlerine dayanır.

## 2. Mevcut mimari envanteri

### 2.1 `src/server/taste-store.ts` (master@2ffe4bf, ~455 satır)
| Başlık | Mevcut durum (kanıt) |
|---|---|
| Sorumluluk | `data/taste/` ağacının IO sahibi: events/index/profile/manifest/objections okuma-yazma, süreç içi + cross-process yazma serileştirme. |
| Fonksiyonlar | `resolveTastePaths(dataDir="data")` (satır ~39-59), `TASTE_PATHS` export (satır ~61), `appendTasteEventIdempotent` (~219), `appendTasteEvent` (~239), `readTasteEvents` (~246), `writeTasteEvents` (~265), `writeTasteProfile` (~279, kilit içinde `writeManifestUnlocked`), `readTasteProfile` (~296), `writeTasteIndex` (~319), `readTasteIndex` (~336), `writeManifestUnlocked` (~360, iç), `readTasteManifest` (~394), `readTasteObjections` (~417), `writeTasteObjections` (~442). |
| Path üretimi | `dataDir === "data"` → `data/taste/cinetrack-taste-{taxonomy,index,events,profile,manifest,objections}.json`; değilse `path.join(dataDir,"taste",...)`. `TASTE_ARCHIVE_DIR = "data/taste/archive/taste-events"` (satır ~28). **`profileId` parametresi yok; partition yok.** |
| Global kullanım noktaları | Tüm taste artefaktları tek global küme. Repo genelinde `TASTE_PATHS/resolveTastePaths/cinetrack-taste-*` kullanımları: `src/server/taste-store.ts`, `src/server/taste-rebuild-coordinator.ts` (~206-219, ~331), `src/server/taste-metadata-hydrator.ts` (~46-47), `src/server/github-bidirectional-sync.ts` (~110,116), `src/server/sync-manifest.ts` (~65,71), `src/services/taste-api.ts`, `tests/taste/*`, `tests/mia-phase1-contracts.test.mjs`. |
| Kilit mekanizması | Süreç içi FIFO: `tasteWriteChains: Map<string, Promise>` anahtarı `path.resolve(dataDir||"data")` (`serializeTasteWrite`, ~174-196). Cross-process: `withCrossProcessTasteLock` (~112-168) `taste/.taste.lock` (`wx`, token `pid:Date.now():randomUUID`), timeout 10s, backoff; stale: `mtime` > 15s veya holder PID canlı değilse `unlink`+retry. Finally: token eşleşirse unlink (best-effort). |
| Atomik IO | Yazımlar `writeJsonFileAtomicAsync(..., { backupPath, validateParsed })`, okumalar `readJsonFileWithRecoveryAsync(..., { backupPaths, validate, label })` (`src/server/atomic-json.ts`). |
| Mevcut test kapsamı | `tests/taste/taste-store.test.mjs`: append/idempotency, profile/index read-write, `.tmp` temizliği, manifest güncelleme, atomik yazım/bozuk dosya senaryosu. `tests/taste/taste-store-integration.test.mjs`: migration→store→profile→manifest, `TASTE_PATHS` sabitleri, sync kapsamı ve ana veri koruması. `tests/mia-phase1-contracts.test.mjs` taste event/idempotency kısımları. **Gözlem:** testte bozuk events için boş dizi beklentisi var; master `readTasteEvents` kurtarılamaz bozuklukta `CorruptJsonFileError` fırlatır (davranış/expectation uyumsuzluğu — R2-A1 kapsamı dışında not edilmelidir). |
| R2-A1’de muhtemel imza/yüzey değişimi | `resolveTastePaths` profil-scope desteği; mapping manifest API (tek yazar), global mapping-manifest kilidi, giriş/kök doğrulama yardımcıları. `TASTE_PATHS` ve mevcut IO imzalarının geniş kırılımı A2’ye kaydırılmalı (uyumluluk yüzeyi tasarım kararı). |
| A2–A5’e bırakılacaklar | Tam profil partition IO, legacy salt-okunur uyum davranışı (A2/A5), shared metadata cache kilidi entegrasyonu (A2), adapter/rebuild/routes profil bağlamı (A3), background hedef profil (A4), uçtan uca doğrulama (A5). |

### 2.2 `src/server/taste-rebuild-coordinator.ts` (master@2ffe4bf, ~700+ satır)
| Başlık | Mevcut durum (kanıt) |
|---|---|
| Sorumluluk | Bootstrap, metadata upsert, worker/off-main-thread aggregation, rebuild zinciri, TMDB hydration tetikleme. `cinetrack-data.json` yalnız okunur. |
| Fonksiyonlar | `mergeTasteMetadata`, `migratedEventKey/collectNewEvents`, `collectEvidenceContentIds`, `configureTasteHydration` (~189), `scheduleTasteMetadataHydration` (~248), `computeBootstrapSignature` (~206-223 imza dosyaları), `coerceItemToTasteMetadata` (~231), `upsertTasteMetadataInputs` (~331), `executeAggregationOffMainThread` (~357), `performRebuildOnce` (~410), `triggerTasteProfileRebuild` (~471), `ensureInitialTasteBootstrap` (~490+). |
| Path/scope | Bootstrap imzasında hardcoded global taste yolları (`data/taste/cinetrack-taste-{events,index,profile,metadata-cache}.json` ve `dataDir` eşlenikleri). Tüm store/hydrator çağrıları `dataDir` bazlı, profil yok. Aktif profil `DataDocument.activeProfileId`/ilk profilden seçilir ama çıktı global taste deposuna yazılır. |
| Kilit/eşzamanlılık | Süreç içi map’ler `activeRebuildChains`, `bootstrapPromises`, `bootstrapSignatures`, `hydrationApiKeys`, `activeHydrations` **`dataDir` anahtarlı**. Dosya kilidi `taste-store`’a emanet; coordinator cross-process lock tutmaz. |
| Test kapsamı | Dolaylı (`tests/taste/taste-store-integration.test.mjs`, `tests/taste/stock-and-live-profile.test.mjs`, migration/aggregation testleri). İzole rebuild eşzamanlılık/profil-scope testi görünür değil. |
| R2-A1 etkisi | Doğrudan imza değişikliği hedeflenmez; ancak hardcoded imza yolları ve dataDir-anahtarlı map’ler A2/A3 için uyum gerektirir. |
| A2–A5’e bırakılacaklar | `(dataDir, profileId)` scope map/chain/imza/hydration, profil partition IO, legacy/entegrasyon. |

### 2.3 `src/server/taste-metadata-hydrator.ts` (master@2ffe4bf, ~318 satır)
| Başlık | Mevcut durum (kanıt) |
|---|---|
| Sorumluluk | Ham TMDB metadata cache okuma/yazma ve TMDB fetch/normalize/batch hydration. |
| Fonksiyonlar | `resolveTasteMetadataCachePath` (~45), `readTasteMetadataCache` (~51), `writeTasteMetadataCache` (~71), `normalizeTmdbMetadata` (~143), `fetchTmdbMetadata` (~190), `hydrateTasteMetadataBatch` (~234). |
| Path/scope | Global tek cache: `data/taste/cinetrack-taste-metadata-cache.json` veya `path.join(dataDir,"taste","cinetrack-taste-metadata-cache.json")`. Profil yok. |
| Kilit | Kendi lock’u yok; `writeJsonFileAtomicAsync` kullanır. |
| Test kapsamı | Doğrudan izolasyon testi görünmüyor (bootstrap/rebuild akışlarıyla dolaylı). |
| R2-A1 etkisi | Path değişimi beklenmez (ham TMDB cache global/shared kararı korunur). |
| A2–A5’e bırakılacaklar | Shared metadata cache için ayrı kilit (A2), profil-bazlı hydration/rebuild uyumu (A3). |

### 2.4 `src/server/taste-routes.ts` (master@2ffe4bf, ~688 satır)
| Başlık | Mevcut durum (kanıt) |
|---|---|
| Sorumluluk | Taste HTTP API: `/profile`, `/overview`, `/metric/:id`, `/evidence/:metricId`, `/manifest`, `/events`, `/override`, `/objection`, `/event`, `/domain-event`, `/rebuild`. |
| İmza/bağlam | `createTasteRouter(dataDir="data", options)`; `eventBus/tasteAdapter` alır. `x-cinetrack-profile-id` veya ProfileContext okuması yok. Store/coordinator çağrıları `dataDir` bazlı global. |
| Path | Doğrudan taste dosya yolu üretmez; `cinetrack-data.json` ve `catalog/*.json` salt-okunur okur. |
| Kilit | Yok (store/coordinator’a dayanır). |
| Test kapsamı | Route-özel izolasyon testi belirgin değil; dolaylı sistem/API kapsamı. |
| R2-A1 etkisi | Beklenmez. |
| A2–A5’e bırakılacaklar | Hedef/aktif profil bağlamının aktarımı (A3), legacy/entegrasyon doğrulaması (A5). API sözleşmesi korunur. |

### 2.5 `src/server/taste-service-adapter.ts` (master@2ffe4bf, ~333 satır)
| Başlık | Mevcut durum (kanıt) |
|---|---|
| Sorumluluk | `TypedAppEvent` → `TasteEvent` çevirisi ve IMemoryService/ITasteService adaptörü. |
| Fonksiyonlar | `translateAppEventToTasteEvent`, `ServerTasteServiceAdapter` (`getProfile`, `refreshProfile`, `processEvent`), `createServerTasteServiceAdapter`, `subscribeTasteAdapterToEventBus`. |
| Davranış | `profileContext` ile `assertCurrent/assertWritable`; bellek içi `processedEventIds: Set`; kalıcı kontrol `readTasteEvents` + `appendTasteEventIdempotent`; `rebuildOnEvent` ile `triggerTasteProfileRebuild(dataDir)`. |
| Path/scope | `dataDir` bazlı global store/coordinator; profil partition yok. |
| Test kapsamı | Dolaylı (contracts/architecture/taste entegrasyon); profil-switch/dedupe-restart izole senaryoları görünür değil. |
| R2-A1 etkisi | Beklenmez. |
| A2–A5’e bırakılacaklar | Profil-bazlı dedupe ve kalıcı idempotency akışı, hedef profil iletimi (A3), background tüketici bağlamı (A4). |

### 2.6 `src/server/app.ts` (master@2ffe4bf, taste wiring)
| Başlık | Mevcut durum (kanıt) |
|---|---|
| Sorumluluk | Uygulama kurulumu: storage/repository, background, event bus, profile context, taste adapter, hydration config, taste router mount, module lifecycle. |
| Taste wiring (satır referansları) | `configureTasteHydration` import (~52), `createTasteRouter` (~166), `createServerTasteServiceAdapter({ dataDir: resolvedDataDir, rebuildOnEvent: true })` (~498), taste module subscribe/health (~566-673), `app.use("/api/taste", createTasteRouter(..., { tmdbApiKey, eventBus, tasteAdapter, deferAdapterSubscription, onDomainEvent, onRawTasteEvent }))` (~2664+). |
| Path | `resolvedDataDir` üretilir ve alt bileşenlere aktarılır. |
| R2-A1 etkisi | İdeal olarak yok; yalnız zorunlu resolver başlatma uyumu gerekirse minimal/davranış koruyucu. |
| A2–A5’e bırakılacaklar | Profil-bilinçli adapter/router/wiring uyumu (A3/A4/A5). |

### 2.7 ProfileContext ve sözleşmeler
| Bileşen | Kanıt | Not |
|---|---|---|
| `src/app/ProfileContext.ts` | `normalizeProfileId` trim+boş kontrolü; `getCurrent/assertCurrent/assertWritable/getRevision/commitRevision/switchProfile/onProfileChange`; `ProfileSwitched` olayı. | Aktif profil/revision tek doğruluk kaynağı; sözleşme korunacak. |
| `src/contracts/profile.ts` | `IProfileContext`, `ProfileChangeEvent`, `ProfileConflictError` kullanımı. | Değişmeyecek. |
| `src/contracts/common.ts` | `ProfileRef`, `WriteProfileRef` (`revision` zorunlu), `ProfileConflictError`, `OperationOutcome` vb. | Değişmeyecek. |
| `src/server/primary-data-repository.ts` | `saveForProfileOrThrow(document, ref: WriteProfileRef, reason?)` profil/revision doğrulaması. | R2-A1 dışında; profil bağlamı referansı. |

### 2.8 Dosya kilidi ve atomik yazım yardımcıları
| Bileşen | Kanıt (dosya/fonksiyon) | R2-A1 ilgisi |
|---|---|---|
| Atomik JSON | `src/server/atomic-json.ts`: `writeJsonFileAtomic(Async)` (temp+validate+backup+fsync+rename), `readJsonFileWithRecovery(Async)` (ok/recovered/missing/corrupt_unrecoverable, quarantine), `tryParseValidJson(Async)`, `CorruptJsonFileError`, `FileWriteSerializer`, `cleanupStaleTempFiles`. | Manifest ve partition dosyaları için uygun altyapı; bozuk JSON/tutarsızlık tespiti yapılabilir. |
| Taste store lock | `src/server/taste-store.ts`: `serializeTasteWrite` (dataDir FIFO) + `withCrossProcessTasteLock` (`.taste.lock`, PID+mtime stale, timeout/backoff). | Ayrı global mapping-manifest kilidi ve `(dataDir, profileId)` scope’ları için yetersiz; stale politikası (PID reuse, lease/ownerToken, atomik sahiplenme) revize tasarıma göre güçlendirilmeli. |
| Diğer | `src/server/sqlite-primary-store.ts`, upload/restore kilitleri (`src/server/app.ts` çevresi) ayrı kapsam. | Taste kilit tasarımıyla çakışmamalı. |

## 3. Gerçek `profileId` sözleşmesi

| Soru | Bulgular (master kanıtı) |
|---|---|
| Nerede oluşturuluyor? | Sunucu `profileId` üretmez; belgeyi okur/yazar. İstemci varsayılan/akış: `src/features/profile/profile-storage.ts` (`profile-default`, profil listesi yükleme), `src/App.tsx` fallback’leri. `crypto.randomUUID()` kullanımları eventId/iş kimliği içindir (örn. `src/app/ProfileContext.ts`, `src/app/app-event-bus.ts`, `src/hooks/useItemActions.ts`), profileId değildir. |
| Biçim/karakterler | `src/core/cinetrack-core.ts`: `PROFILE_ID_PATTERN = /^(?:profile-[A-Za-z0-9_-]{1,60}|p\d{1,10})$/` (~717). `src/features/profile/profile-storage.ts` yüklemede `^profile-[A-Za-z0-9_-]{1,60}$` kabul eder (satır ~95-120 civarı). `src/app/ProfileContext.ts` `normalizeProfileId` yalnız trim + boş olmama kontrolü yapar (format kısıtlamaz). |
| UUID zorunlu mu? | Hayır. Kanıtlanan pratik biçimler: `profile-default`, `profile-*`, `p\d{1,10}`. |
| Boşluk/Unicode | Core/client regex’leri boşluk/Unicode’a izin vermez; ancak genel string taşıma yolları nedeniyle **güvenli path/manifest katmanı tüm geçersiz ve traversal riski taşıyan girdileri fail-fast reddetmelidir** (mevcut pratikte yok varsayımı yapılmaz). |
| Maksimum uzunluk | Pattern bazlı: `profile-*` gövdesi 60 karakter, `p\d` 10 hane. Genel ProfileContext/storage string limiti görünmüyor. |
| Saklama yerleri | Birincil: `DataDocument.profiles[].id`, `activeProfileId` (`data/cinetrack-data.json` / SQLite). İstemci localStorage (`PROFILES_STORAGE`, `ACTIVE_PROFILE_STORAGE`, profil anahtarları). Türetilmiş: taste-map/pool/derived cache anahtarları (`cinetrack_taste_map_<profileId>`, `cinetrack_pool_<media>_<profileId>` vb., `src/core/cinetrack-core.ts`). Master sunucu taste dosyaları profileId içermez. |

## 4. Base64URL ve manifest değerlendirmesi

### 4.1 Reversible token uygunluğu
| Konu | Değerlendirme |
|---|---|
| Yöntem | Kanonik `profileId`’nin **kayıpsız reversible** temsili (öneri: UTF-8 → Base64URL, padding’siz, sabit `scheme`, ör. `p1-b64url`). Basit sanitize/replace/whitelist temizleme tek başına **kullanılmamalı** (çakışma riski). |
| Mevcut sözleşme uyumu | `profile-default`, `profile-*`, `p\d+` ve gelecekteki kanonik string kimlikler kodlanabilir; token dizin adı temsili içindir, kanonik `profileId` iş mantığında korunur (`x-cinetrack-profile-id`, ProfileContext, primary data değişmez). |
| FS sınırları | Segment uzunluğu ve karakter güvenliği kontrol edilmeli; uzun kanonik kimlikler için kabul sınırı ve `scheme` kesinleştirilmeli. |
| Zorunlu kontrol | Reversible token tek başına yeterli değildir; **mapping manifest doğrulaması** ile birlikte kullanılmalıdır. |

### 4.2 Manifest tasarım gereksinimleri (R2-A1 hazırlık)
| Konu | Gereksinim |
|---|---|
| Format (öneri) | `data/taste/profiles/_profile-id-map.json`, sürümlü: `version`, `scheme`, `entries{ "<canonicalProfileId>": { "dir", "createdAt" } }`, `byDir{ "<dir>": "<canonicalProfileId>" }` — **birebir tutarlı**. |
| Sahiplik | Taste partition erişim katmanı (store/profile-scope resolver) tek yazardır; rebuild/adapter/routes doğrudan yazmaz. |
| Doğrulama | Girdi geçerliliği, reversible encode/decode tutarlılığı, `entries↔byDir` birebirliği, hedef yolun taste kökü içinde kalması, mevcut kayıtla uyum. |
| Fail-fast | Çakışma, tutarsızlık, şema/sürüm uyumsuzluğu, geçersiz kimlik/traversal, kök dışı yol → hata; otomatik onarım/yeniden eşleme/sessiz fallback yok. |
| Atomik güncelleme | Kilit altında doğrula → güncelle → atomik yazım; kısmi/tutarsız kayıt bırakılmamalı. |
| Bozuk JSON/uyumsuz şema | `corrupt_unrecoverable`/parse-doğrulama hatasında Taste işlemleri güvenli biçimde durur, teşhis edilebilir hata üretir; Taste dışı özellikler etkilenmemeli. Onarım ayrı ve açık onaylı operasyon. |

## 5. Kilit mekanizması ve kilit sırası

### 5.1 Mevcut durum
- **Taste store:** `serializeTasteWrite` (in-memory FIFO, `path.resolve(dataDir)` anahtarı) + `withCrossProcessTasteLock` (`taste/.taste.lock`, `wx`, PID+mtime stale, 10s timeout). Ayrı profil scope veya ayrı manifest scope yok.
- **Atomic JSON:** Dosya bazlı atomik yazım sağlar; cross-process lock sağlamaz. `FileWriteSerializer` process-içi ve dosya yolu bazlıdır.

### 5.2 R2-A1 için hedef kilit mimarisi (tasarım)
| Kilit | Kapsam | Amaç |
|---|---|---|
| Global mapping-manifest kilidi | `(dataDir, "__profile-id-map__")` | Manifest ilk oluşturma/güncelleme ve eşleme çözümleme yarışını önlemek |
| Profil veri kilidi | `(dataDir, profileIdSafe)` | Aynı profil taste IO/rebuild-kritik tutarlılık (A2’de tam uygulanır; A1 sıralamaya uyumlu altyapı) |
| Shared metadata cache kilidi | `(dataDir, "shared-metadata-cache")` | Ham TMDB cache eşzamanlı erişim (A2) |

**Edinim sırası (deadlock önleme):** 1) global mapping-manifest kilidi → 2) hedef profil kilidi → 3) shared metadata cache kilidi. Ters sıra yok; aynı anda birden fazla farklı profil kilidi yok; kritik bölüm minimum.

### 5.3 Stale lock / kurtarma gereksinimleri (uygulama aşaması için)
- Lock meta verisi: `lockId`, `pid`, `hostname`, `createdAt`, `expiresAt` (lease), `ownerToken`, `scope` (PID tek başına yeterli değil).
- Sahip canlıysa bekle + sınırlı timeout/backoff; timeout’ta teşhis edilebilir hata (zorla çalma/silme yok).
- Stale tespiti: lease dolumu + sahiplik doğrulanamaması (host/ownerToken/PID sinyalleri birlikte); **PID reuse** dikkate alınmalı.
- Güvenli kurtarma: yalnız kanıtlanabilir stale kilitte atomik yeniden sahiplenme; bozuk lock dosyası stale sayılmaz.
- Yanlışlıkla silme engeli: genel temizlik hedefi olmamalı; yalnız doğrulanmış stale kurtarma akışı.

### 5.4 Uygulanabilirlik ve risk özeti
| Konu | Değerlendirme |
|---|---|
| Manifest kilidi mevcut altyapıyla | Mevcut tek `.taste.lock` yeterli değil; scope’lu lock tasarımı ve yarış testleri gerekir. |
| Deadlock riski | Manifest↔profil↔cache kilitleri sabit sıra ile yönetilmezse risk var. |
| Bozuk manifest izolasyonu | Taste scope’unda fail-fast, otomatik onarım yok; Taste dışı akışlar etkilenmemeli. |
| Manifest yokken ilk oluşturma | Eşzamanlı erişimde atomik, kilitli ve doğrulamalı oluşturma zorunlu. |

## 6. R2-A1 dosya ve test planı

### 6.1 Değişmesi muhtemel dosyalar (uygulama aşaması)
| Dosya | Olası rol | Öncelik |
|---|---|---|
| `src/server/taste-store.ts` | Reversible token + manifest (format/doğrulama/tek yazar), global mapping-manifest kilidi, güvenli profil-scope path çözümleme, giriş/kök sınırı kontrolleri | Ana |
| (tek sorumluluklu yardımcı, aynı katman) | `validate/encode/decode profileId`, manifest okuma-yazma-doğrulama, lock helper — tek üretim noktası | Ana (katman eklemeden) |
| `src/server/app.ts` | Zorunluysa minimal, davranış koruyucu resolver uyumu | Düşük |
| `src/server/taste-rebuild-coordinator.ts`, `src/server/taste-routes.ts`, `src/server/taste-service-adapter.ts`, `src/server/taste-metadata-hydrator.ts` | A1’de ideal olarak imza kırılımı yok; uyumluluk gereksinimi Ajan 1 denetimiyle netleşir | Dokunmama hedefi |

### 6.2 Yeni yardımcı sorumlulukları (tasarım)
- Kanonik `profileId` doğrulama (boş/`./..`, ayraç, null/control, traversal reddi).
- Reversible encode/decode (`scheme` sabit, kayıpsız).
- `(dataDir, canonicalProfileId)` → doğrulanmış profil kökü/yolları (taste kökü içinde).
- Manifest doğrulama/güncelleme (`entries/byDir` birebir, atomik yazım).
- Ayrı global mapping-manifest kilidi (lock sırasına uyumlu).

### 6.3 Fonksiyon imzası adayları
| Mevcut | A1 hedefi | Not |
|---|---|---|
| `resolveTastePaths(dataDir)` | Profil-scope resolver desteği | Çağıran kırılımını önlemek için uyumluluk yüzeyi gerekebilir |
| `TASTE_PATHS` | Legacy/uyumluluk rolü; profil-bazlı tek otorite olmamalı | Yaygın kullanım nedeniyle geçiş stratejisi şart |
| `serializeTasteWrite` / `withCrossProcessTasteLock` | Manifest lock + profil-scope kilit altyapısı ile uyum | Sıra: manifest → profil → shared cache |
| `append/read/writeTaste*` IO imzaları | Tam profil parametresi yayılımı ağırlıklı A2 | A1’de gereksiz imza patlamasından kaçınılmalı |

### 6.4 Kalıcı test planı (uygulama aşamasında eklenecek)
| Adım | Test senaryoları |
|---|---|
| R2-A1 | Deterministik/reversible token; traversal/geçersiz kimlik reddi; `entries/byDir` birebirlik; çakışma/tutarsızlık/şema uyumsuzluğu fail-fast; eşzamanlı ilk oluşturma (yarışsız); kök sınırı; bozuk manifest hatası ve otomatik onarım yok; uyumluluk/regresyon (legacy yazımı tetiklenmez). |
| R2-A2 | Profil-bazlı IO ve `(dataDir, profileId)` kilitleri, shared cache ayrı kilidi, legacy salt-okunur/değişmezlik, deadlock yok. |
| R2-A3 | Profil-bazlı `processedEventIds` + store idempotency, restart tekrar teslim, rebuild/bootstrap izolasyonu, API/context korunumu. |
| R2-A4 | Hedef profil korunumu, A→B switch, yanlış yazım yok, Faz 4 retry/lease/idempotency/terminal regresyonu. |
| R2-A5 | Uçtan uca izolasyon, S3 yanlış atfetme negatif testleri, legacy değişmezlik, kapsam denetimi. |

### 6.5 Dokunulmaması gereken dosyalar (R2-A1)
`src/core/taste/*`, `src/app/app-event-bus.ts`, `src/app/shell-events.ts`, `src/modules/background/*`, `src/server/github-bidirectional-sync.ts`, `src/server/excel-profile-backup.ts`, `src/server/restore-journal.ts`, `src/contracts/*`, R1 dalı/PR artefaktları, `origin/master`.

### 6.6 R2-A1 tek başına bağımsız PR uygulanabilirliği
**Koşullu uygulanabilir.** Mapping manifest + güvenli resolver + global manifest kilidi, mevcut davranışı koruyan uyumluluk yüzeyiyle altyapı PR’ı olarak tasarlanabilir. Ancak `resolveTastePaths/TASTE_PATHS` ve taste IO imzalarına yaygın bağımlılık nedeniyle kırıcı imza yayılımı PR’ı kırılganlaştırabilir; imza geçişi ve test uyumu A2’ye bölünmeli, kesin kesim Ajan 1 denetimiyle netleştirilmelidir.

## 7. A2–A5 bağımlılıkları ve kapsam sınırları

| Adım | Bağımlılık / kapsam |
|---|---|
| **R2-A1** | Profil kimliği doğrulama, reversible token, mapping manifest, güvenli path çözümleme, global mapping-manifest kilidi ve lock sırası temeli. |
| **R2-A2** | A1 kabulü. Profil partition IO, `(dataDir, profileId)` bellek içi/cross-process kilitler, shared metadata cache ayrı kilidi, legacy salt-okunur yazım hedefi ayrımı. |
| **R2-A3** | A1-A2 kabulü. Adapter/rebuild/routes profil bağlamı, profil-bazlı `processedEventIds` ve store-seviyesi kalıcı idempotency, scope’lu rebuild/bootstrap/hydration. |
| **R2-A4** | A1-A3 kabulü. BackgroundManager görev hedef `profileId` korunumu, A→B senaryosu, yanlış yazım engeli (Faz 4 sözleşmesi korunur). |
| **R2-A5** | A1-A4 kabulü. Legacy koruması, S3 yanlış atfetme engeli, uçtan uca entegrasyon doğrulaması ve kapsam denetimi. |

**Kapsam dışı (R2 boyunca, ayrı karar/onay):** `LibraryItemRemoved` nötralizasyonu (ayrı teknik borç), GitHub sync/backup/restore değişiklikleri, Memory Manager, Taste algoritması değişikliği, Faz 6, legacy migration/veri taşıma/otomatik profil ataması.

## 8. Riskler ve açık kararlar

### 8.1 Riskler
| Risk | Etki | Hazırlık notu |
|---|---|---|
| Manifest kilidi vs mevcut tek lock | Yarış/tutarsız eşleme | Scope’lu cross-process lock ve eşzamanlılık testleri gerekli |
| Manifest↔profil↔cache deadlock | Blokaj | Sabit edinim sırası zorunlu |
| Base64URL/FS uzunluk sınırı | Geçersiz yol/taşma | `scheme` ve maksimum uzunluk politikası netleştirilmeli |
| Stale lock yanlış kurtarma (PID reuse) | Veri tutarsızlığı/çifte sahiplik | Lease + ownerToken/hostname + atomik sahiplenme gerekli |
| Bozuk manifest | Taste işlemleri durur | Fail-fast, teşhis edilebilir hata, otomatik onarım yok, Taste dışı izolasyon |
| A1 imza kırılımı (`resolveTastePaths/TASTE_PATHS`) | Geniş çağıran/test kırılması | Uyumluluk yüzeyi, kırıcı geçiş A2+ |
| Mevcut bozuk-events test beklentisi uyumsuzluğu | Yanlış regresyon sinyali | R2-A1 dışında ayrıca ele alınmalı; davranış kazara değiştirilmemeli |

### 8.2 Açık kararlar (uygulama varsayımına dönüştürülmeyecek)
1. Nihai `profileIdSafe` şeması/kodlama parametreleri ve kabul edilen maksimum kanonik uzunluk.
2. Manifest kesin konumu, alan adları ve sürüm/şema geçiş politikası.
3. Lock timeout/backoff/lease ve stale meta veri alanları.
4. S1/S2/S3 canlı veri kanıtı ve S1 onaylı kopya kararı (şu an kanıt yok).
5. S3/belirsiz legacy verinin kullanıcıya sunum politikası (yanlış atfetme yok).
6. R2-A1 PR kesimi ve `TASTE_PATHS/resolveTastePaths` uyumluluk stratejisi.
7. Ajan 1 denetimi bulguları doğrultusunda revizyon gerektiren maddeler.

### 8.3 Kapsam dışı işler ve teknik borçlar
- **Teknik borç (ayrı kayıt):** `LibraryItemRemoved` nötralizasyonu — R2 dışında, ayrı karar/onay/uygulama.
- **Kapsam dışı:** GitHub sync/backup/restore değişiklikleri, Memory Manager, Taste algoritması, Faz 6, legacy migration/veri taşıma, otomatik profil ataması.
- **Gözlem/teknik borç adayı:** `tests/taste/taste-store.test.mjs` bozuk events beklentisi ile master `readTasteEvents` hata davranışı arasındaki uyumsuzluk (ayrı değerlendirme).

---
*Bu rapor, master commit `2ffe4bf82a5d512c1dafd7754498554e443c9098` kaynak kod envanterine dayalı hazırlanmıştır. Doğrulanamayan bilgiler varsayım olarak ele alınmalı ve Ajan 1 denetimi/kullanıcı kararı ile netleştirilmelidir.*
