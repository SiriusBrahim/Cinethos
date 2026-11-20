# Cinethos Mimari Belgesi (`ARCHITECTURE.md`)

Bu belge Cinethos uygulamasının modül sınırlarını, veri akışını, kalıcı depolama şemasını, önbellek ayrımını, migrasyon kurallarını ve veri bütünlüğü güvencelerini açıklar.

---

## 1. Modül Yapısı ve Sorumluluk Sınırları

### Çekirdek Katman (`src/core/`)
Tarayıcı DOM'undan ve Express sunucusundan bağımsız, saf ve deterministik iş mantığı modülleridir; hem istemci (Vite/React) hem de sunucu (Node.js) tarafından doğrudan kullanılır:

- `src/core/limits.ts`: Tek kaynaklı veri ve koleksiyon sınırları (`DEFAULT_MAX_DATA_BYTES = 25 * 1024 * 1024` = 25 MiB, `DEFAULT_MAX_PROFILES = 20`, `DEFAULT_MAX_ITEMS_PER_PROFILE = 25_000`, `DEFAULT_MAX_SNAPSHOTS = 7`) ve UTF-8 bayt ölçümü (`measureUtf8Bytes`).
- `src/core/keys.ts`: Medya anahtarlarının (`movie:123`, `tv:456`) kanonikleştirilmesi, eski anahtarların (`movie-123`) dönüştürülmesi ve çakışan `TasteMapEntry` kayıtlarının (`shownCount`, `skippedCount`, `ringDemotions`, `lastShownAt`, `lastRecommendedAt`, `impressionHistory`) kayıpsız ve idempotent biçimde birleştirilmesi (`migratePersistentTasteMapData`).
- `src/core/derived-profile-cache.ts`: Türetilmiş profil önbelleği şeması (`DERIVED_PROFILE_SCHEMA_VERSION = 2`), nesne anahtarı sırasından ve yazma zaman damgalarından (`generatedAt`, `calculatedAt`) bağımsız deterministik içerik özeti (`computeDerivedProfileContentHash`), kaynak katalog imzası (`computeSourceCatalogSignature`) ve önbellek geçerlilik denetimi (`validateDerivedProfileCache`).
- `src/core/cinetrack-core.ts` öneri puanlama çekirdeği (`scoreCandidatesV3`, `RECOMMENDATION_WEIGHTS_V3`, halka yönetimi) saf hâlde kalır; orkestrasyon/açıklama katmanı Faz 6'da `src/modules/recommendations/` yöneticisine taşınmıştır (bkz. §7).
- `src/core/cinetrack-core.ts`: Veri şeması doğrulama (`normalizeDataDocument`, `parseBackupText`), 15 sinyalli `TasteProfileV3` ve `scoreCandidatesV3` öneri motoru, `ring0` / `ring1` / `ring2` yaşam döngüsü yönetimi, `500 + 500` bağımsız film/dizi aday havuzu (`replenishCandidatePool`) ve oyuncu filmografisi kuyruk yöneticisi (`fetchActorCreditsBatch`).
- `src/core/relationship-explorer.ts`: `relationship-v3` deterministik ilişki keşif grafiği (`universe`, `person`, `semantic`, `atmosphere`, `contrast`), profil ve havuz imzaları (`computeRelationshipProfileSignature`, `computeRelationshipPoolSignature`).
- `src/core/evaluation.ts`: Öneri motorunun ardışık yenilemelerde `ring1RepeatRate`, `ring0Utilization`, `genreEntropy` ve `typeBalanceAccuracy` metriklerini ölçen çevrimdışı değerlendirme çatısı (`evaluateRecommendationEngine`).
- `src/core/exporters.ts`: Zevk DNA analizi (`buildTasteDnaProfile`), Letterboxd/IMDb uyumlu CSV içe/dışa aktarma (`importItemsFromCsv`, `exportItemsToCsv`), RFC 5545 `.ics` yayın takvimi (`generateIcsCalendar`), iki profil arası izleme listesi kesişimi (`computeProfileWatchlistIntersection`) ve kronolojik izleme yolculuğu (`buildMediaJourneyTimeline`).

### Sunucu Katmanı (`server.ts` & `src/server/`)
- `server.ts`: Sıfır zorunlu ortam değişkenli sunucu giriş noktası; sınırları `src/core/limits.ts` üzerinden alır (`DEFAULT_MAX_DATA_BYTES = 25 MiB`). Geliştirme (`--dev` ile dinamik `await import('vite')`) ve üretim (`dist/` statik sunumu) modlarını çalıştırır.
- `src/server/atomic-json.ts`: Tüm kalıcı JSON dosyaları için ortak atomik yazma (`writeJsonFileAtomic`: aynı dizinde benzersiz `.tmp` dosyasına yazma, bayt boyutu doğrulaması, `fsyncSync`, hata anında `.tmp` temizliği ve `renameSync`), başlangıçta yarım kalmış `.tmp` temizliği (`cleanupStaleTempFiles`), bozuk JSON karantinası + yedekten kurtarma (`readJsonFileWithRecovery`, `CorruptJsonFileError`) ve dosya bazlı yazma serileştiricisi (`FileWriteSerializer`).
- `src/server/storage.ts`: Ana kullanıcı verisi (`data/cinetrack-data.json`), `.bak` yedeği (`data/cinetrack-data.bak.json`) ve `data/backups/` altında en son 7 geçerli döner anlık görüntü (snapshot) yönetimi; UTF-8 bayt sınırı kontrolü, monotonik `revision` sayacı ve ani veri kaybı koruması (`sudden_item_drop` -> `409`). Bozuk ana dosya hiçbir zaman sağlam `.bak` yedeğinin üzerine kopyalanmaz.
- `src/server/persistent-store.ts`: Ortak içerik kataloğu (`data/catalog/movies.json`, `data/catalog/tv.json`, `data/catalog/manifest.json`), profil bazlı türetilmiş önbellek (`data/profiles/<profileId>.json`) ve dosya bazlı durum takipli (`data/sync-state.json`) GitHub Contents API senkronizasyonu (`PersistentDataStore`).
- `src/server/app.ts`: Express uygulama fabrikası (`createCineTrackApp`), UTF-8 bayt doğrulamalı `413 Payload Too Large`, `400 Invalid JSON` ve `500 corrupt_json_file / corrupt_storage` hata yakalayıcıları, `ETag` / `If-Match` revizyon uçları, katalog/türetilmiş profil ve GitHub eşitleme rotaları.
- `src/server/security.ts`: Çapraz kaynak (`Origin` -> `403`) koruması ve isteğe bağlı token/hız sınırı katmanları.
- `src/server/tmdb-proxy.ts`: Katı `ALLOWED_TMDB_PATH` (`/tv/{id}/season/{n}` dahil) ve parametre doğrulaması, 500 girdili sunucu LRU önbelleği, ağ kesintilerinde bayat önbellek (`stale-cache`) geri dönüşü ve yerleşik demo kataloğu.

### İstemci Servis, Hook ve Arayüz Katmanı (`src/services/`, `src/hooks/`, `src/components/`)
- `src/services/api.ts`: İstemci TMDB önbelleği, uçuş hâlindeki (in-flight) istek tekilleştirme, TMDB yanıt şeması doğrulaması (`validateTmdbResponseShape`), `If-Match` revizyon takipli sunucu senkronizasyonu ve katalog / türetilmiş profil (`fetchDerivedProfileData`, `pushDerivedProfileData`) istemci çağrıları.
- `src/services/relationship-cache.ts`: İlişki grafiği anlık görüntülerini `IndexedDB` (`cinetrack-relationship-cache`) üzerinde saklar.
- `src/services/offline-queue.ts` & `src/hooks/useOfflineSync.ts`: Çevrimdışı yapılan yerel değişiklikleri kuyruğa alır; bağlantı geri geldiğinde taban revizyonla (`baseRevision`) sunucuya iletir ve olası `409 Conflict` durumunda kullanıcıya seçim sunar (`ConflictBanner`).

---

## 2. Kalıcı Veri Katmanları ve Önbellek İzolasyonu

Cinethos'te kalıcı veri ve önbellek katmanları görevlerine göre kesin sınırlarla ayrılmıştır:

1. **Kullanıcıya Özel Ana Durum (`data/cinetrack-data.json`, `schemaVersion: 3`)**:
   - Kullanıcının doğruluk kaynağıdır (source of truth): izleme listeleri (`watching`, `watchlist`, `completed`), kişisel puanlar, tercihler (`disliked`, `hidden`, `providers`, `mood`) ve favori oyuncular burada tutulur.
2. **Ortak İçerik Kataloğu (`data/catalog/movies.json`, `data/catalog/tv.json`, `data/catalog/manifest.json`)**:
   - Medya türü dahil kanonik kimlikle (`movie:123` ile `tv:123` ayrı kayıtlardır) tekilleştirilmiş TMDB metaverilerini tutar. Aynı içerik tekrar geldiğinde kopya üretilmez; zaman damgaları hariç anlamlı kaynak alanları değişmemişse disk yazımı (ve GitHub commit'i) yapılmaz.
3. **Profil Bazlı Türetilmiş Veri Önbelleği (`data/profiles/<profileId>.json`, `schemaVersion: 2`)**:
   - Her profil için hesaplanan `matchScore`, `tasteScore`, `priorityScore`, `lifecycleRing`, `signals`, `reasons`, `shownCount`, `skippedCount`, `demotionPenalty`, `status`, `scoreCoverage` ve `pillars` alanlarını tutar.
   - **Geçersizleştirme (Invalidation) ve Geri Dönüş**: Önbellek anahtarı ve doğrulaması `schemaVersion` (`2`), `algorithmVersion`, `profileFingerprint` ve `sourceCatalogHash` alanlarının tamamını denetler; ayrıca tüm anlamlı alanlar üzerinden deterministik `contentHash` (`computeDerivedProfileContentHash`) hesaplanır. Eski `schemaVersion: 1` dosyaları veya imzası/özeti uyuşmayan kayıtlar sessizce geçerli sayılmaz (`cache miss`); kaynak katalog ve kullanıcı profilinden yeniden hesaplanarak şema-2 biçiminde güncellenir. Türetilmiş önbellek hiçbir zaman kullanıcı listelerinin doğruluk kaynağı yerine geçmez.
4. **Tarayıcı Zevk Haritası, Aday Havuzu ve İlişki Önbelleği (`localStorage` & `IndexedDB`)**:
   - `cinetrack_taste_map_<profileId>` ve `cinetrack_pool_<type>_<profileId>` öneri motorunun yerel çalışma havuzunu tutar; `cinetrack-relationship-cache` (`IndexedDB`) ise ilişki grafiğini Zevk Haritası sayaçlarını etkilemeden saklar.

---

## 3. Anahtar Migrasyonu (`movie-123` -> `movie:123`) ve Yaşam Döngüsü Halkaları

- Eski `movie-123` / `tv-456` anahtarları `entries`, `archivedEntries`, kayıt içi `mediaKey` ve `lastRecommendedKeys` alanlarının tamamında `migratePersistentTasteMapData` ile kanonik `movie:123` / `tv:456` biçimine dönüştürülür.
- Hem eski hem yeni anahtar aynı anda varsa `mergeTasteMapEntriesOnCollision` kayıtları silmeden birleştirir: `impressionHistory` yinelenen olayları çoğaltmadan kronolojik birleştirilir (`MAX_IMPRESSION_HISTORY_PER_ENTRY = 30`, taşanlar `archivedImpressionCount` içinde korunur), `shownCount` tekilleştirilmiş geçmişle uyumlu hesaplanır, `skippedCount` toplanır, `ringDemotions` / `demotionPenalty` maksimum değeri korur, `lastShownAt` / `lastRecommendedAt` / `lastScoredAt` en yeni geçerli tarihi ve `firstShownAt` en eski tarihi korur; kullanıcı durum önceliği (`disliked > hidden > saved > active`) ezilmez. İkinci çalıştırma **idempotent**tir (`changed: false`).
- Öneri seçim sırası: önce `ring0` (hiç gösterilmemiş adaylar), `ring0` hedef sayıyı dolduramazsa `ring2` (daha önce gösterilip atlanmış yedek adaylar) seçilir; son gruptaki `ring1` öğeleri bir sonraki yenilemede kesinlikle dışlanır.

---

## 4. Atomik Yazma, Yedekleme, GitHub Eşitleme ve TMDB Sınırları

1. **Atomik Yazma ve Bozuk Dosya Koruması**:
   - Tüm kalıcı JSON yazımları hedef dizinde benzersiz `.tmp` dosyasına yazılıp `fsyncSync` ve boyut/JSON doğrulamasından geçtikten sonra `renameSync` ile hedefe taşınır; hata anında `.tmp` silinir ve önceki sağlam dosya korunur.
   - Açılışta veya okuma sırasında bozuk JSON saptanırsa dosya `*.corrupt.<timestamp>` olarak karantinaya kopyalanır ve önce `.bak`, ardından `data/backups/` içindeki en yeni sağlam snapshot üzerinden kurtarma denenir. Kurtarma mümkün değilse bozuk dosya boş veriyle ezilmez (`CorruptJsonFileError` / HTTP `500`).
2. **Tek Kaynaklı Boyut Sınırı (`25 MiB`)**:
   - `DEFAULT_MAX_DATA_BYTES = 26_214_400` bayt sınırı UTF-8 bayt uzunluğu üzerinden ölçülür; sınırı aşan istekler `413 Payload Too Large` ile reddedilir ve diskteki mevcut dosyalar değiştirilmez.
3. **Çift Yönlü GitHub Senkronizasyonu (`src/server/github-bidirectional-sync.ts`, `src/core/sync-display.ts` & `PersistentDataStore`)**:
   - **Ayrı Sunucu Uçları ve Eylemler**: `GET /api/sync/status`, `POST /api/sync/inspect` (salt okunur denetim), `POST /api/sync/pull` (çakışma korumalı güvenli indirme), `POST /api/sync/push` (doğrulamalı yükleme) ve `POST /api/sync/reconcile` (iki yönlü kayıpsız birleştirme ve eşitleme). Aynı depoya paralel senkronizasyon başlatılması serileştirilir ve `rejectIfBusy` ile korunur.
   - **Açık Kalıcı Veri Envanteri**: Ortak katalog (`data/catalog/movies.json`, `data/catalog/tv.json`, `data/catalog/manifest.json`) ve yalnızca özel (`private`) depolarda kişisel veriler (`data/cinetrack-data.json`, `data/profiles/*.json`). Geçici `.tmp`, `.bak`, `data/backups/*`, `data/sync-state.json`, `.corrupt.*`, `.env` ve derleme çıktıları envantere dahil edilmez.
   - **Varsayılan Silmesiz (No-Deletion) ve Kayıpsız Birleştirme**: `movie:<id>` ve `tv:<id>` kayıtları ayrı tutulur; dolu açıklamalar (`overview`), afiş yolları (`poster_path`, `backdrop_path`), tür kümeleri (`genre_ids`) ve yüksek oy sayıları korunur. Kullanıcı profilleri ve kayıtları kanonik kimlikle birleştirilir; yerel farklı kayıtlar varken `pull` sessizce ezmez, onay/birleştirme sunar ve işlem öncesi döner snapshot yedeği alır. Türetilmiş profiller yalnızca `generatedAt` tarihine bakılarak değil `schemaVersion`, `algorithmVersion`, `profileFingerprint` ve `sourceCatalogHash` doğrulamasıyla değerlendirilir; uyumsuz önbellekler kaynak veriden yeniden üretilir.
   - **Sayım, Ham/Semantik Hash ve İşlem Sonrası Uzak Doğrulama**: Yazma zaman damgalarından (`updatedAt`, `generatedAt`) bağımsız semantik içerik özeti ile ham UTF-8 dosya özeti ayrı raporlanır; `manifest.json` içindeki `movieCount`, `tvCount` ve `contentHash` gerçek katalogla çapraz doğrulanır. `push` ve `reconcile` sonrasında uzak dosyalar GitHub'dan yeniden okunur (`>1 MB` dosyalarda Git Blob API kullanılarak); tüm dosyalar doğrulanmadan `verifiedEqual: true` veya arayüzde *"Eşitlendi (Doğrulandı)"* durumu gösterilmez.
   - **Hata Sınıflandırması ve Gizlilik**: `404` yalnızca dosya yokluğu olarak değerlendirilir; `401/403` (`auth_error`), `429` (`rate_limit`), `409` (`conflict` — en fazla 3 yeniden deneme), ağ kesintisi (`network_error`), bozuk JSON ve boyut aşımı ayrı sınıflandırılır, tüm hata metinlerinde gizli anahtarlar `redactSecrets` ile temizlenir.
4. **TMDB Saklama Politikası Notu**:
   - Yerel katalog yalnızca uygulamanın kişisel öneri puanlaması ve çevrimdışı önbelleği için gerekli temel metaveri alanlarını saklar. TMDB API kullanım koşulları uyarınca TMDB verileri herkese açık bir katalog veya üçüncü taraf veri servisi olarak paylaşılmamalıdır.

---

## 5. MIA Faz 3 — Library Manager ve Content Manager

Faz 3, kullanıcı kütüphanesi işlemleri ile ortak içerik verisi yönetimini iki merkezi servise ayırır. Her iki servis de Faz 1/2 altyapısını (Repository, EventBus, ModuleRegistry, ProfileContext, `ContentMetadataSource`, `ContentProcessingCoordinator`) **yeniden kullanır**; yeni bir repository, event bus veya TMDB istemcisi oluşturulmaz.

### 5.1 Katmanlar ve dosyalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Ortak kurallar (saf) | `src/modules/library/operations.ts` | Liste ↔ izleme durumu eşlemesi, `ratedAt`/`completedAt`/`addedAt`/`updatedAt` geçişleri, normalize `SavedItem` üretimi (`buildLibraryItem`), içerik alanı allowlist'i (`pickContentFields`). Ağ/repository erişimi yoktur. |
| Sunucu kütüphane servisi | `src/modules/library/service.ts` | `ILibraryService` uygulaması (`addItem`, `updateItem`, `removeItem`, `getItem`). `ServerPrimaryDataRepository` + `ProfileContext` + `AppEventBus` + `diffLibraryEvents` kullanır. |
| Sunucu içerik servisi | `src/modules/content/service.ts` | `IContentService` uygulaması (`getMetadata`, `enrichMissing`, `searchCatalog`, `canonicalizeKey`). Mevcut `ContentMetadataSource` ve içerik kaydı/kuyruk portlarını kullanır. |
| Katalog okuma genişletmesi | `src/server/content-metadata-source.ts` | `listCatalogEntries()` — Content Manager'ın katalog aramasını ikinci bir dosya okuyucusu olmadan yapması için mevcut okuyucunun üzerine eklenmiş tek metot. |
| İstemci eylem katmanı | `src/hooks/useItemActions.ts` | Kayıt üretimini `buildLibraryItem` üzerinden yapar; kurallar artık tek kaynakta. Dışa açılan API ve EventBus davranışı değişmedi. |
| Uygulama bağlama | `src/server/app.ts` | `createCineTrackApp` dönüşünde `libraryService` ve `contentService`; koordinatörün mevcut `metadataSource`/`getByMediaKey`/`enqueueRawItem` portları enjekte edilir. |

### 5.2 Veri sınırları (değiştirilemez)

1. **Kullanıcı verisi ortak içeriğe yazılamaz.** `LibraryService` yalnızca `data/cinetrack-data.json` içindeki profil kayıtlarını yazar; katalog, `content_records`, vektör/atmosfer alanları ve poster deposu bu servisin yazma kapsamı dışındadır.
2. **Ortak içerik kullanıcıdan bağımsızdır.** `removeItem` yalnızca profil kaydını siler ve `deleted_keys` içine tombstone yazar; `ContentService` hiçbir kullanıcı kaydını silmez veya değiştirmez.
3. **Film/dizi kimliği ayrıdır.** Tüm girişler `parseMediaKey` ile doğrulanır, `makeMediaKey` ile `movie:<id>` / `tv:<id>` kanonik biçimine getirilir. `ContentService.canonicalizeKey` yalnızca pozitif tamsayı kimliği kabul eder.
4. **Kişisel puan ile TMDB puanı karışmaz.** `SavedItem.personal_rating` yalnızca kullanıcı girdisinden (`rating`) yazılır; `ContentMetadata.externalRating` TMDB `vote_average` değeridir ve kullanıcı kaydına aktarılmaz.
5. **Metaveri kanalı allowlist ile sınırlıdır.** `AddLibraryItemInput.metadata` / `UpdateLibraryItemInput.metadata` içinden yalnızca `pickContentFields` allowlist'indeki içerik alanları kopyalanır; `status`, `personal_rating`, not, ilerleme ve profil alanları bu kanaldan yazılamaz.
6. **Mevcut akışlar korunur.** `PUT /api/data` + `diffLibraryEvents` + `If-Match` revizyon davranışı, yedekleme, GitHub eşitleme, profil yönetimi ve tüm mevcut HTTP sözleşmeleri değişmedi; Faz 3 yalnızca yazma/okuma kurallarını merkezileştirir.

### 5.3 Olay yayımı

`LibraryService` her başarılı yazımdan sonra `diffLibraryEvents(before, after)` üretir ve olayları mevcut `AppEventBus` üzerinden yayınlar. Yeni olay türü eklenmemiştir. Kalıcı yazma başarılı olup olay yayımı başarısız olursa sonuç `ok: false` + `retryable: true` ve açıklayıcı mesajla döner (sessiz yutma yoktur).

### 5.4 Kademeli entegrasyon ve kalan işler

- Tek öğelik UI eylemleri `useItemActions` → `onCommitSavedItem` → `PUT /api/data` yolunu korur; kayıt üretimi artık Library Manager ile ortak `operations.ts` üzerindendir.
- `libraryService` / `contentService`, `createCineTrackApp` üzerinden programatik istemcilere ve sonraki fazlardaki HTTP uçlarına hazırdır. UI'nin doğrudan `PUT /api/data` yazımının tamamen HTTP uçlarına taşınması kademeli olarak yapılacaktır (Faz 3 kapsamı dışında bırakılan test/CI işleriyle birlikte değerlendirilmelidir).
- Eksik metadata zenginleştirme mevcut içerik kuyruğuna devredilir; kuyruk işleyicisi ve vektör üretimi Content Intelligence'ın sorumluluğunda kalır.

---

## 6. MIA Faz 4 — Background Manager (kalıcı görev kuyruğu)

Faz 4, domain olaylarını kalıcı hale getirir ve yalnızca kayıtlı işleyicisi olan olaylar için görev üretir. Mevcut `AppEventBus`, `ProfileContext` ve SQLite altyapısı yeniden kullanılır; ikinci bir event bus, outbox veya kuyruk yoktur.

### 6.1 Katmanlar ve dosyalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Sözleşmeler | `src/contracts/background.ts` | `BackgroundTaskStatus` (pending, processing, completed, retry_wait, failed, cancelled), `BackgroundTaskHandler`, `BackgroundTaskStore` portu, kayıt tipleri. |
| Kalıcı depo | `src/server/background-task-repository.ts` | Aynı `data/cinetrack.db` içinde `background_events` + `background_tasks`; transaction'lı kabul, lease'li claim, retry/fail/cancel, açılış kurtarması. |
| Yönetici | `src/modules/background/service.ts` | `BackgroundManager`: `persistEvent` kabulü, merkezi işleyici eşlemesi, pompa, retry sınıflandırması, durum yazımı, sağlık/istatistik. |
| İşleyiciler | `src/modules/background/handlers.ts` | Pilot audit-only işleyiciler (`LibraryItemAdded`, `LibraryRatingChanged`); profil izolasyonu ve payload doğrulaması. |
| Payload allowlist | `src/modules/background/event-payload.ts` | Olay türü başına izinli alanlar; not/serbest metin kalıcı deftere yazılmaz. |
| Hata politikası | `src/modules/background/errors.ts` | Geçici/kalıcı hata sınıfları, `base * 2^(attempt-1)` deterministik backoff (üst sınır 30 sn). |
| Uygulama bağlama | `src/server/app.ts` | `createAppEventBus({ persistEvent })`; repository + manager; `startRuntimeModules`/`stopRuntimeModules`; dönüşte `backgroundManager`. |

### 6.2 Akış ve garantiler

1. `LibraryService` → `diffLibraryEvents` → `eventBus.publish(event)`.
2. `publish`, `persistEvent` kancasıyla olayı ve görevleri **tek SQLite transaction** içinde yazar; yazım başarısızsa çağırana hata döner (sessiz yutma yok).
3. `background_events.event_id` PK'dır; `background_tasks` üzerinde `UNIQUE(event_id, handler_id)` vardır → aynı olay/işleyici ikinci kez işlenmez.
4. Görev `claimNextTask` ile kiralanır (`processing`, `attempts+1`, `lease_until`); hata diğer görevleri durdurmaz.
5. Geçici hata → `retry_wait` + `next_retry_at` + `last_error`; kalıcı hata veya deneme tükenmesi → `failed`; manuel iptal → `cancelled`.
6. Profil izolasyonu: görev `profile_id` taşır; pompa yalnızca **aktif profile** ait görevleri kiralar, diğerleri `pending` bekler (deneme tüketilmez) ve profil değişiminde uyanır. İşleyici yine aktif profili doğrular; yazma hiçbir zaman başka profile yapılmaz. Aktif olmayan profile ait taste olayları `intelligence.taste-event-sync` ile hedef profil aktif olduğunda telafi edilir.
7. Çökme kurtarması: açılışta lease'i dolmuş `processing` görevleri `pending` (deneme tükendiyse `failed`) durumuna alınır; `pending`/zamanı gelmiş `retry_wait` görevleri devam eder.

### 6.3 Veri sınırları

- Görev tabloları kullanıcıya ait **profil kimliği** taşır; yalnızca yerel `data/cinetrack.db` içinde tutulur. Bu dosya GitHub senkronizasyon envanterinde **değildir**.
- Ortak içerik tablolarına (`content_intelligence`, `content_processing_queue`, `content_processed_events`) ALTER veya veri yazımı yapılmaz; Faz 4 depoları yalnızca `background_*` tablolarıdır.
- Olay payload'ı allowlist ile küçültülür; kişisel not, serbest metin veya izleme geçmişi deftere taşınmaz.
- Pilot işleyiciler audit-only'dir; içerik, öneri ve zevk algoritmaları değişmez.

### 6.4 ModuleRegistry notu

`background-manager`, `/api/health` modül listesi sözleşmesini (ve mevcut doğrulama testlerini) bozmamak için registry'ye ayrı kimlik olarak eklenmemiştir; `ModuleContext` ile beslenip `startRuntimeModules`/`stopRuntimeModules` içinde başlatılır/durdurulur. Registry'ye taşıma, health listesi güncellendiğinde tek satırlık değişikliktir.

---

## 7. MIA Faz 6 — Öneri ve Keşif Yöneticisi

Faz 6, öneri orkestrasyonunu çekirdekten ayırıp bağımsız bir yöneticiye taşır. **Algoritma ve puanlama değişmedi**: aynı girdi aynı `tasteScore` / `matchScore` / `priorityScore`, halka ve gerekçe çıktısını üretir. Kanıt, `tests/phase6-recommendation-manager.test.mjs` içindeki önce/sonra karşılaştırmasıdır (altın anlık görüntü: `tests/fixtures/faz6-recommendation-before-scores.json`).

### 7.1 Katmanlar ve dosyalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Motor | `src/modules/recommendations/RecommendationEngine.ts` | `enrichCatalogItemsWithTaste`, `hydrateTasteMapWithDerivedCache`, `buildDerivedProfilePayloadFromTasteMap`; isteğe bağlı `now` ile deterministik puanlama. |
| Aday havuzu | `src/modules/recommendations/CandidatePoolManager.ts` | Katı film/dizi havuz ayrımı (`enforceStrictMediaTypePool`); puanlama yapmaz. |
| Açıklama | `src/modules/recommendations/ExplanationManager.ts` | `ring0`/`ring1`/`ring2` çözümlemesi (`ring1` ezilmez) ve kart/gerekçe eşlemesi. |
| Değerlendirme | `src/modules/recommendations/EvaluationManager.ts` | `core/evaluation.ts` çevrimdışı koşumunun yönetici yüzü; metrik formülleri çekirdekte kalır. |
| Sıralama | `src/modules/recommendations/RankingManager.ts` | Oyuncu kaynaklı önerilerin puanlama/çeşitlendirme yüzü; algoritma `core/actor-recommendations.ts` içinde korunur. |
| Dış yüz | `src/modules/recommendations/index.ts` | `createRecommendationManager()` — `id: 'recommendations'`, alt yöneticiler ve saf işlevler. UI yalnızca bu yüzü import eder. |

### 7.2 Sınırlar

1. **Hafızaya yazmaz.** Yönetici kanıt defterine, kütüphane kayıtlarına veya profil verisine yazmaz; türetilmiş paketi çağıran katman kalıcılaştırır.
2. **Çekirdek saf kalır.** `src/core/cinetrack-core.ts` puanlama matematiğinin tek sahibidir; yönetici onu yeniden uygulamaz.
3. **Tek yol.** `src/core/recommendation-orchestrator.ts` kaldırıldı; `App.tsx` ve testler işlevleri `src/modules/recommendations/index.ts` üzerinden alır.
4. **Eski sonuçlar korunur.** Taşınma öncesi alınan puan anlık görüntüsü, taşınma sonrası çıktıyla birebir eşleşir; sıralama, halka ve gerekçeler dahil.

---

## 8. MIA Faz 7 — Tek Veri Hattı ve Yönetici Bağlaması

Faz 7, arayüzü yöneticilere bağlar: mobil ve masaüstü **aynı iş mantığını** kullanır ve
kullanıcı kütüphanesine yazan bütün yollar **tek** hattan geçer.

### 8.1 Katmanlar ve dosyalar

| Katman | Dosya | Sorumluluk |
|---|---|---|
| İstemci kütüphane hattı | `src/modules/library/client-service.ts` | `ClientLibraryService`: `save`, `rate`, `set-status`, `remove`, `advance-episode`, `merge-duplicates`, `dislike`, `hide`. Kurallar `modules/library/operations.ts`'ten; olaylar mevcut `createAppEvent` sözleşmesinden; kalıcılık enjekte edilir. |
| Uyumluluk adaptörü | `src/hooks/useItemActions.ts` | Mevcut `saveItem/rateItem/...` API'sini korur; `service` verilirse aynı hattı paylaşır, kural kopyası taşımaz. |
| Mobil yerleşim | `src/presentation/layouts/MobileLayout.tsx` | `MOBILE_NAV_ITEMS` + `MobileBottomNav`; liste modül kayıt defterinden türetilir. |
| Masaüstü gezinme | `src/components/Header.tsx` + `src/app/navigation.ts` | Üst sekmeler `HEADER_NAV_ITEMS` üzerinden; geçersiz `identity`/`universes` kimlikleri kaldırıldı. |
| Yönetici (App) | `src/App.tsx` | Tek servis örneği kurar, `useItemActions`'a verir; kaldırma/ilerleme/birleştirme hattan çağrılır. Yan etkiler (toast, zevk haritası işareti, yedek) sunumda kalır. |

### 8.2 Sınırlar

1. **Tek yazma yolu.** Arayüz hiçbir yerde `buildLibraryItem`/`resolveItemActionTimestamps`
   çağırmaz; komutlar servise düşer. Kaldırma ve birleştirme tombstone'u da hattan yazılır.
2. **Sunum/veri ayrımı.** Servis React, IndexedDB veya sunucu bilmez; kalıcılık
   `applySavedItem`/`applySavedItems`/`applyTombstone` kancalarıyla enjekte edilir.
3. **Tek olay katmanı.** Yeni EventBus/kuyruk kurulmaz; `AppEventBus` sözleşmesi kullanılır.
4. **Tek gezinme kaynağı.** Mobil alt gezinme ve masaüstü üst sekmeler `MODULES`
   kayıt defterinden türetilir; yalnızca görünen etiket farkları yerel override'dır.
5. **Davranış korunumu.** Kayıt biçimi (`ratedAt`, `completedAt`, `deleted_keys`,
   `episodes_watched`) ve kullanıcı verisi değişmedi; kanıt
   `tests/phase7-ui-service-pipeline.test.mjs`.

Ayrıntılı uygulama kaydı: [Faz 7 — Arayüz ve tek veri hattı](docs/mia/faz7-ui-servis-hatti.md).

---

## 9. Çalışma Alanı Mimarisi — Yedi Modül ve İşlem Merkezi

Bu bölüm, arayüzün modül kayıt defteri üzerinden yönetilen yedi birincil çalışma
alanına ayrılmasını ve kalıcı arka plan kuyruğunun kullanıcı arayüzüne açılan
güvenli yüzünü açıklar.

### 9.1 Tek kaynak: modül kayıt defteri ve navigasyon

| Katman | Dosya | Sorumluluk |
|---|---|---|
| Kimlik tipi | `src/app/module-ids.ts` | `ModuleId` birleşimi; çalışma zamanı importu yok. Görünüm katmanı yalnızca bu tipi kullanır, bu yüzden registry ↔ MediaCard döngüsü oluşmaz. |
| Kayıt defteri | `src/app/module-registry.ts` | Sıra, etiket, ikon, kısayol (`1-7`), hash rotası, komut paleti anahtar kelimeleri. |
| Türetim | `src/app/navigation.ts` | `SIDEBAR_NAV_GROUPS`, `HEADER_NAV_ITEMS`, `DOCK_NAV_ITEMS` (4 birincil), `MOBILE_OVERFLOW_ITEMS` (kalanlar), `SHORTCUT_TAB_MAP`, `SETTINGS_SHORTCUT = '0'`. |
| Derin bağlantı | `src/app/useHashNavigation.ts` | `#/home`, `#/discover`, `#/series`, `#/operations` ↔ sekme çift yönlü eşleme. |
| Mobil kabuk | `src/presentation/layouts/MobileLayout.tsx` | Dört dock sekmesi + erişilebilir "Daha fazla" dialogu (Escape, odak, arka plan kaydırma kilidi). |

Bilgi mimarisi: **Ana Sayfa → Keşfet → Kütüphanem → Zevkim → İlişki Keşfi →
Seriler ve Evrenler → İşlem Merkezi**. Profil ve Ayarlar bir modül değildir; mevcut
profil/ayarlar penceresini açan sistem eylemidir (kenar çubuğu ve mobil taşma
sayfasında `0` kısayoluyla).

### 9.2 Çalışma alanı modülleri

| Modül | Dosya | Veri kaynağı |
|---|---|---|
| Ana Sayfa | `src/modules/home/dashboard.ts` (saf) + `HomeSection.tsx` | Kütüphane kayıtları ve `forYouItems`; devam edenler, son aktivite, tür eğilimi, seçkiler. |
| Seriler ve Evrenler | `src/modules/series/SeriesSection.tsx` | `computeUserSeriesUniverses` + mevcut `UniversesView` (ikinci kopya yok). |
| İşlem Merkezi | `src/modules/operations/OperationsSection.tsx` | `/api/background/tasks` + `/api/health`; görünür sekmede 12 sn yoklama, arka planda durur. |

`dashboard.ts` DOM'suz ve deterministiktir; aynı kurallar mobil/masaüstünde
tekrar yazılmaz ve birim testleriyle doğrulanır.

### 9.3 İşlem Merkezi API sözleşmesi

| Uç | Koruma | Davranış |
|---|---|---|
| `GET /api/background/tasks?status=&limit=` | `personalReadGuard` | Yalnızca **aktif profile** ait görevler (`profileId` istemciden alınmaz). `status` `BACKGROUND_TASK_STATUSES` ile doğrulanır (aksi `400`), `limit` 1-200 aralığına kısılır. |
| `POST /api/background/tasks/:taskId/retry` | `originGuard` + `tokenGuard` | Görev yoksa `404`; aktif profile ait değilse `403 profile_mismatch`; durum uygun değilse `409 task_not_retryable`. Başarıda `requeueTask` deneme sayacını sıfırlar ve pompa uyanır. |
| `POST /api/background/tasks/:taskId/cancel` | `originGuard` + `tokenGuard` | `404` / `403` / `409 task_not_cancellable`; başarıda `cancelled`. |

**Gizlilik:** Yanıtlar `taskId, eventId, handlerId, profileId, status, attempts,
maxAttempts, nextRetryAt, createdAt, updatedAt, completedAt, lastError` ile
sınırlıdır. Dosya yolları, olay payload'ı ve ham hata metni taşınmaz;
`lastError` `redactSecrets` ile temizlenip 400 karaktere kısaltılır.
`GET /api/health` yanıtı istemcide `normalizePipelineHealth` ile yalnızca modül
kimliği + durum ve kuyruk sayaçlarına indirgenir.

### 9.4 Veri bütünlüğü

Yeni uçlar kullanıcı verisine yazmaz; yalnızca `background_tasks` tablosundaki
yaşam döngüsü alanlarını değiştirir. Profil izolasyonu iki katmanda korunur:
okuma aktif profil filtresiyle, yazma ise görev sahibi ile aktif profil
karşılaştırmasıyla. Kuyruk dosyası (`data/cinetrack.db`) GitHub senkronizasyon
envanterinde değildir; bu nedenle yeni API senkronizasyon kapsamını genişletmez.

### 9.5 Kaldırılan tekrarlar

`src/app/AppSidebar.tsx`, `AppFooter.tsx`, `AppModals.tsx`, `MobileTabBar.tsx`,
`src/app/mobile/MobileDashboard.tsx` ve `src/components/FloatingGlassDock.tsx`
render edilmiyordu ve kendi gezinme/sekme listelerini tutuyordu. Tek doğruluk
kaynağı ilkesi gereği kaldırıldı; geriye kalan `Header` (masaüstü) ve
`MobileBottomNav` (mobil) listelerini kayıt defterinden türetir.

## 10. Tek öneri hattı, sunucu zevk sinyali ve içerik zekâsı geri işleme

### 10.1 Uygulama kabuğu ve sorumluluk ayrımı

`src/App.tsx` artık profil kalıcılığını, bildirim yaşam döngüsünü ve öneri
kararlarını kendi içinde tutmaz:

| Modül | Sorumluluk |
|---|---|
| `src/app/profile-storage.ts` | localStorage anahtarları, legacy ham profil kimliklerinin kanonik kimliğe taşınması, izole liste/tercih/favori/tombstone okuması. React bağımlılığı yok. |
| `src/app/useToasts.ts` | Bildirim yığını, otomatik sönme zamanlayıcıları ve unmount temizliği. |
| `src/modules/recommendations/pipeline.ts` | Havuz puanlama, zenginleştirme kısa listesi, dengeli seçim ve gerekçe üretimi. Ağ erişimi çağıranda kalır; karar mantığı React'ten ayrıdır. |
| `src/modules/recommendations/taste-signal.ts` | Sunucu `TasteProfile` metriklerini dar, tipli bir sıralama sinyaline indirger. |
| `src/services/taste-signal-service.ts` | Profil başına sinyal önbelleği; hata durumunda `null` (sıralama yerel profille sürer). |
| `src/services/content-intelligence-api.ts` | Anlamsal komşuluk ipuçları ve işleme durumu; 4 sn zaman aşımı ve sessiz geri dönüş. |
| `src/app/catalog-loader.ts` | Keşfet/Sana Özel veri toplama akışı (~1.140 satır): katalog sayfaları, aday havuzu, kadro zenginleştirme, tek hattan puanlama/seçim ve gerekçe. React bağımlılığı yok; durum/setter'lar bağlamla verilir. |
| `src/hooks/useLibraryController.ts` | Kütüphane yazımları: ekleme, durum/puan, bölüm ilerletme, silme, beğenmeme/gizleme. Tek `createClientLibraryService` örneği burada kurulur. |
| `src/app/user-data-payload.ts` | Sunucuya gönderilecek kullanıcı veri belgesini tek üreticide birleştirir; aktif profil canlı state'ten, diğerleri izole depodan okunur. |
| `src/core/relationship-server-links.ts` + `src/hooks/useServerRelatedLinks.ts` | Sunucu anlamsal/atmosferik komşuluklarını ilişki grafiğine yalnızca görünen düğümler arasında katar; yerel bağları silmez. |

`scoreCandidatesV3` sözleşmesi `serverTaste?: ServerTasteInput` ile genişletildi.
Sinyal yoksa veya `confidence < 0.35` ise puanlar birebir eski davranışla aynıdır
(`tests/recommendation-pipeline.test.mjs` geriye dönük uyum testi). Manuel
`exclude` override'ları `resolveEffectiveMetricView` üzerinden elenir; tür ve ruh
hâli afiniteleri sırasıyla %25 ve %15 ağırlıkla puanlanır ve gerekçe etiketi üretir.

### 10.2 İçerik zekâsı → keşif

`content_intelligence` kayıtlarındaki anlamsal komşuluklar
(`GET /api/content-intelligence/items/:mediaKey/related`) öneri hattına
`semanticHints` olarak girer; her komşu için azami 4 puanlık bir bonus uygulanır
ve "Sunucu anlamsal analiziyle ilişkili" gerekçesi eklenir. Sunucu kapalıysa
ipucu haritası boş döner ve akış değişmez.

Katalog yazımı (`POST /api/catalog/upsert`) zaten içerik kuyruğuna iş üretir.
Eksik, başarısız veya eski `processing_version` ile üretilmiş kayıtlar için:

| Uç | Davranış |
|---|---|
| `GET /api/content-intelligence/status` | `stale` sayısını da döner. |
| `GET /api/content-intelligence/stale?limit=` | Yeniden işlenecek kayıtları listeler. |
| `POST /api/content-intelligence/reprocess` | `failed`/`pending`/sürüm uyuşmayan kayıtları kuyruğa verir (202). Aynı `media_key` için kuyruk koalesansı geçerlidir. |

### 10.3 Kaldırılan paralel öneri yolu

`src/core/taste/recommendation-adapter.ts` üretimde hiçbir yerden çağrılmıyordu
(yalnızca kendi testi kullanıyordu) ve ikinci bir "taste fit" sıralaması
tanımlıyordu. Tek motor ilkesi gereği kaldırıldı; sunucu profilinin sıralamaya
etkisi artık `taste-signal.ts` üzerinden tek hatta uygulanıyor.

### 10.4 App kabuğunun daraltılması

`App.tsx` 4.095 → 2.535 satıra indi. Katalog yükleme, kütüphane yazımları ve
sunucu veri belgesi üretimi ayrı modüllere taşındı; App yalnızca profil
durumunu, efekt sırasını ve bu modüller arasındaki koordinasyonu tutuyor.
Katalog yükleyici yeni bir sıralama yolu açmaz: aynı
`scoreRecommendationPool → rescoreShortlist → selectRecommendationBatch`
zincirini kullanır. Profil kimlikleri (`normalizeProfileId`, `p2-hex`) ve
kullanıcı verisi yerleşimi değişmedi; `buildUserDataDocument` iki eski kopyayı
tek üreticide birleştirir.

### 10.5 İşlem Merkezi ve İlişki Keşfi entegrasyonu

İşlem Merkezi artık `/api/content-intelligence/status` özetini okur: indekslenen,
bekleyen, çalışan, başarısız ve eski sürümlü kayıt sayıları görünür; "Eskileri
yeniden işle" düğmesi `POST /api/content-intelligence/reprocess` çağırır ve
sonucu (kabul/yinelenen) gösterir. Görev tablosu gerçek kuyruk durumunu,
deneme sayısını ve son hatayı göstermeye devam eder.

İlişki Keşfi'nde kaynak içerik seçildiğinde sunucudaki anlamsal/atmosferik
komşular grafiğe eklenir; bağlantı kanıtı "İçerik zekâsı: %N anlamsal benzerlik"
ve varsa ortak kavramlarla açıklanır. Sunucu erişilemezse yerel grafik bozulmaz.

### 10.6 Veri bütünlüğü ve senkronizasyon katmanları (Faz 3)

| Sorumluluk | Modül | Not |
|---|---|---|
| Etkileşim tarihleri | `src/core/item-dates.ts` | `addedAt`/`firstAddedAt`, `watchedAt`, `ratedAt`, `completedAt` ayrı; `updatedAt` yalnızca son düzenleme. Sinyal yaşı, yıllık özet ve dışa aktarma gerçek etkileşim tarihini kullanır. |
| Sezon ilerlemesi | `src/core/season-progress.ts` | `watched_episodes` (sırasız bölüm izleme) + `progress_updated_at` (sezon damgası). Sezon bazında deterministik birleştirme; geri alma korunur, silinen bölüm dirilmez. |
| Etkin içerik durumu | `src/core/item-effective-state.ts` | `disliked > hidden > saved > available`; `inLibrary` ayrı bayrak. Keşfet/arama `filterCatalogItemsByPreferences` üzerinden tek filtre kullanır. |
| Semantik keşif sıralaması | `src/core/semantic-ranking.ts` | İçerik Zekâsı benzerliği sınırlı (azami +8 uyum puanı) ikincil anahtar; Sana Özel hattına dokunmaz. |
| Öneri karşılaştırması | `src/core/recommendation-comparison.ts` | Aynı veri kümesinde taban/güncel yapılandırma raporu; puanlama formülü değişmez. |
| GitHub dayanıklılığı | `src/server/github-request.ts` | Exponential backoff + jitter, `Retry-After`, `X-RateLimit-Reset`; PUT gövdesi idempotent. |
| App koordinasyonu | `src/app/server-sync.ts`, `src/app/profile-backup.ts` | Uzak belge birleştirme ve yedek payload'ı saf fonksiyonlar; App state/efekt koordinatörü. |
| Mimari denetim | `scripts/check-cycles.mjs` | Yerel import grafiğinde döngü raporu; `tests/phase3-architecture.test.mjs` sıfır döngü şartı koyar. |


Faz 3 takip düzeltmesi: `github-bidirectional-sync.ts` artık `persistent-store.ts` çalışma zamanı modülünden yardımcı fonksiyon veya sınıf tipi çekmez. Paylaşılan veri sözleşmeleri `persistent-store-types.ts`, saf yardımcılar `persistent-store-utils.ts` içindedir; sync manager yalnızca `PersistentDataStoreSyncPort` adaptörünü bilir. Excel yedeği, çift durumlu kayıtları `Durum Çakışmaları` adlı ayrı sayfada raporlar ve kaynak veriyi değiştirmez.


### 10.7 App senkron koordinatörü

`src/hooks/useServerSyncCoordinator.ts`, gönderimlerin tek uçuşta serileştirilmesini, debounce tabanlı otomatik gönderimi ve yerel/uzak/birleştir kararlarını kapsar. `src/hooks/useProfileBackupCoordinator.ts` yerel JSON yedek üretme, içe aktarma ve birleştirme eylemlerini App'ten ayırır. XLSX üretim/upload sunucu tarafındaki `excel-profile-backup.ts` ve `PersistentDataStore` katmanında kalır. App kabuğu React state/ref adaptörlerini, ilk açılış veri hidrasyonunu ve görünürlük/interval tabanlı uzak revizyon kontrolünü tutar. Bu ayrım veri sahipliğini hook'a taşımaz; yalnızca senkron komutlarını tek yerde toplar.
