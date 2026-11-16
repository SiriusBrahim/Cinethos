# MIA Faz 4 — Background Manager: Envanter ve Şema Onay Dosyası

**Durum:** Şema onaylandı ve uygulama tamamlandı (bkz. §10). Bağımsız test/CI doğrulaması Agent 1'in sorumluluğundadır.
**Onay:** §8 kararları A/A/A olarak onaylandı (iki yeni tablo aynı DB'de, salt-okunur pilot işleyici, tüm olaylar kaydedilir + yalnızca pilot ikisi için görev).
**Kaynak dal:** `agent-2/phase-3` (57905e2)
**Çalışma dalı:** `agent-2/phase-4-background-manager`
**Tarih:** 2026-11-16

Bu belge kod taşımaz; mevcut altyapının envanterini, Faz 4 için zorunlu görünen
ek şemayı ve alınması gereken onayı kaydeder.

---

## 1. Mevcut altyapı envanteri (doğrulanmış)

| Bileşen | Dosya | Mevcut durum | Faz 4 için yeterli mi? |
|---|---|---|---|
| AppEventBus | `src/app/app-event-bus.ts` | `IEventPublisher` + `IEventSubscriber`; `publish()` doğrulama yapar, `persistEvent` kancasını çağırır, sonra aboneleri `Promise.allSettled` ile çalıştırır; abone hatası `AggregateError` ile çağırana döner. | **Kısmen.** Kanca var ama uygulamada **hiç bağlanmamış**: `createCineTrackApp` `createAppEventBus()` çağırıyor (app.ts:467), `persistEvent` verilmiyor. Yani domain olayları kalıcı değil. |
| Event sözleşmeleri | `src/contracts/events.ts` | `AppEventMap` (8 olay), `TypedAppEvent`, `profileId` + `sourceRevision` zorunlu, `IEventPublisher`/`IEventSubscriber`. Dosya başlığında "Faz 4'te kalıcı Outbox'a bağlanır" notu var. | **Evet** — sözleşme değişikliği gerekmiyor. |
| Event outbox | `src/server/content-event-subscriber.ts` + `content-intelligence-repository.ts` | Yalnızca **içerik** kuyruğu için transactional outbox: `content_processed_events(event_id PK)` + `content_processing_queue` tek transaction'da (`acceptEventTransactionally`). `AppEventBus.persistEvent` ile bağlı değil. | **Hayır.** İçerik işine özgü; genel olay/görev defteri değil. |
| Kalıcı içerik kuyruğu | `src/server/content-processing-queue.ts`, `content-intelligence-repository.ts` | SQLite `content_processing_queue`; `media_key` **PRIMARY KEY** (içerik başına tek iş), durumlar `pending/processing/completed/failed`, `attempts/max_attempts/next_retry_at/last_error`, `claimNextJobs`, `recoverInterruptedJobs`, backoff `base * 2^(attempts-1)`. | **Hayır.** Profil, işleyici, event bazlı çoklu görev ve `retry_wait/cancelled` yok; semantiği içerik üretimine kilitli. |
| Kalıcı görev kaydı | — | Genel amaçlı görev tablosu **yok**. `data/cinetrack.db` yalnızca `content_intelligence`, `content_processing_queue`, `content_processed_events` tablolarını içeriyor. | **Yok.** |
| Repository / transaction | `src/server/content-intelligence-repository.ts` (`node:sqlite` `DatabaseSync`, WAL, `busy_timeout=5000`), `src/server/primary-data-repository.ts` (JSON/SQLite kullanıcı verisi, `saveForProfileOrThrow`, revizyon) | İki ayrı kalıcılık alanı: ortak içerik DB'si ve kullanıcı verisi. | **Kısmen.** SQLite bağlantı deseni yeniden kullanılabilir; görev tabloları için repository yok. |
| Retry / backoff | `content-processing-queue.ts` (`isRetryableError`, `baseRetryDelayMs`, `attempts < max_attempts`, `next_retry_at`) | Yalnızca içerik kuyruğu için; kalıcı hata sınıflandırması ve `retry_wait` durumu yok. | **Kısmen.** Desen kopyalanmaz, ortak politika modülüne çıkarılır. |
| ProfileContext | `src/app/ProfileContext.ts` | `getCurrent()`, `assertCurrent(ref)`, `assertWritable(ref)`, `commitRevision`, `switchProfile`; `ProfileConflictError('profile-switched' \| 'stale-revision')`. | **Evet** — profil izolasyonu için yeterli. |
| ModuleRegistry | `src/app/runtime-module-registry.ts` | `IApplicationModule` yaşam döngüsü, `startAll/stopAll/healthCheckAll`, hata geri alımı. | **Evet.** Yeni modül `background-manager` olarak kaydedilir; `content-intelligence` kaydı korunur. |
| Faz 3 LibraryService olayları | `src/modules/library/service.ts` | `addItem/updateItem/removeItem` sonrası `diffLibraryEvents(before, after)` → `eventPublisher.publish(...)`. Olaylar: `LibraryItemAdded`, `LibraryStatusChanged`, `LibraryRatingChanged`, `LibraryItemUpdated`. | **Evet.** Yayın hattı hazır; kalıcılık kancası olmadığı için olaylar kaybolabiliyor. |

### 1.1 Doğrulanan boşluklar

1. `AppEventBus` kalıcılık kancası bağlı değil → uygulama yeniden başlarsa olaylar kaybolur (4.1 ihlali).
2. Genel görev tablosu yok → `pending/processing/completed/retry_wait/failed/cancelled`, `attempts`, `last_error`, lease/kurtarma alanları saklanamaz (4.1, 4.3, 4.6).
3. `content_processing_queue` `media_key` PK olduğu için aynı olayın iki işleyicisi veya aynı içerik için farklı olaylar ayrı kayıt olamaz (4.2, 4.4).
4. `content_processed_events` yalnızca eventId bazlı; `(eventId, handlerId)` idempotency anahtarı yok.
5. Profil kimliği görev kaydında yok → profil izolasyonu kalıcı düzeyde uygulanamaz (4.5).

**Sonuç:** Faz 4'ün 4.1–4.6 maddeleri mevcut tablolarla karşılanamaz. Ek tablo(lar) zorunludur. Talimat §2 gereği onay alınmadan migration/DDL uygulanmayacaktır.

## 2. Önerilen şema (yalnızca EKLEME)

Aynı SQLite dosyası (`data/cinetrack.db`), mevcut tablolara **dokunmadan**, iki yeni tablo.
`data/cinetrack.db` GitHub senkronizasyon envanterinde **değildir** (yalnızca katalog, kullanıcı verisi, profil ve taste dosyaları senkronize edilir), bu nedenle profil kimliği içeren görev satırları depoya sızmaz.

```sql
PRAGMA foreign_keys = ON;  -- bağlantı düzeyinde

CREATE TABLE IF NOT EXISTS background_events (
  event_id        TEXT PRIMARY KEY,
  event_type      TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  entity_id       TEXT,
  schema_version  INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  occurred_at     TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  payload_json    TEXT NOT NULL          -- olay türü başına allowlist ile küçültülür
);
CREATE INDEX IF NOT EXISTS idx_bg_events_type_time
  ON background_events(event_type, received_at);

CREATE TABLE IF NOT EXISTS background_tasks (
  task_id       TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES background_events(event_id) ON DELETE CASCADE,
  handler_id    TEXT NOT NULL,
  profile_id    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN
                  ('pending','processing','completed','retry_wait','failed','cancelled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT,
  lease_until   TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  completed_at  TEXT,
  UNIQUE (event_id, handler_id)
);
CREATE INDEX IF NOT EXISTS idx_bg_tasks_ready
  ON background_tasks(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_bg_tasks_profile
  ON background_tasks(profile_id, status);
```

**Neden iki tablo?** Olay bir kez kalıcı olur, her işleyici kendi görev satırını alır (`UNIQUE(event_id, handler_id)` = idempotency). Aynı olayın iki işleyicisi birbirini bloke etmez; biri `failed` olurken diğeri `completed` olabilir.

**Mevcut tablolara etki:** yok. `ALTER TABLE`, veri taşıma veya geri doldurma yok. Migration = `CREATE TABLE/INDEX IF NOT EXISTS` (idempotent).

## 3. Önerilen akış

```
LibraryService.addItem/updateItem
  └─ diffLibraryEvents → eventBus.publish(event)
       ├─ persistEvent(event)  ← YENİ: BackgroundTaskRepository.acceptEvent(event)
       │    BEGIN IMMEDIATE
       │      INSERT OR IGNORE background_events(...)
       │      INSERT OR IGNORE background_tasks(event_id, handler_id, profile_id, 'pending')
       │    COMMIT
       │    (hata → throw; publish reddedilir, sessiz yutma yok)
       └─ bellek içi aboneler (mevcut davranış) → backgroundManager.notify() → pompa
```

İşçi döngüsü:
```
claimNextTask(now)
  UPDATE background_tasks SET status='processing', lease_until=now+60s, attempts=attempts+1
  WHERE task_id = (uygun ilk görev) AND status IN ('pending','retry_wait' koşullu)
  → handler(event, profileRef)
      ├─ başarı → completed + completed_at
      ├─ profile-switched/stale → retry_wait (next_retry_at = now + backoff)
      ├─ geçici hata → attempts < max ? retry_wait : failed
      └─ kalıcı hata → failed (tekrar denenmez)
```

`persistEvent` kancası, mevcut `IEventPublisher.publish` sözleşmesindeki "kuyruk yazımı başarısızsa reddet" kuralıyla birebir uyumludur; sözleşme değişmez.

## 4. Durumlar, retry ve kurtarma

| Durum | Anlam | Geçişler |
|---|---|---|
| `pending` | Kalıcı, işlenmeyi bekliyor | → processing |
| `processing` | Lease sahibi işçi çalışıyor | → completed / retry_wait / failed |
| `completed` | Etki tamamlandı (terminal) | — |
| `retry_wait` | `next_retry_at` zamanında yeniden denenecek | → processing / failed / cancelled |
| `failed` | Kalıcı hata veya deneme tükendi (terminal) | → cancelled (manuel) |
| `cancelled` | Kullanıcı/profil kapsamı dışında iptal (terminal) | — |

- **Retry politikası:** yalnızca sınıflandırılmış geçici hatalar (ağ, `SQLITE_BUSY`, `ECONNRESET`, `5xx`, `429`); `base=250ms`, `delay = base * 2^(attempts-1)`, jitter yok (deterministik test), üst sınır 30s, `max_attempts=3`. Kalıcı hatalar (doğrulama, geçersiz payload) tek denemede `failed`.
- **Çökme kurtarma:** açılışta `status='processing' AND lease_until < now` → `status='pending'`, `lease_until=NULL` (deneme sayısı korunur; `attempts >= max_attempts` ise `failed`). `retry_wait` ve `next_retry_at <= now` → `pending`.
- **Idempotency:** `UNIQUE(event_id, handler_id)` + terminal durum kontrolü; aynı `eventId` ikinci kez `acceptEvent`'e gelirse yeni görev üretilmez. Etki tamamlanmadan `completed` yazılmaz (durum geçişi etki sonrası, tek `UPDATE`).
- **Profil izolasyonu:** her görev `profile_id` taşır; işleyici çağrısı `profileContext.assertCurrent({profileId, revision: sourceRevision})` ile başlar. Profil değiştiyse hiçbir yazma yapılmaz; görev `retry_wait` + backoff'a alınır, deneme tükenirse `failed`. Başka profile yazma yolu yoktur.
- **Payload minimizasyonu:** `background_events.payload_json` olay türüne göre allowlist ile yazılır. `LibraryItemAdded` → `{mediaKey, mediaType, list}`; `LibraryRatingChanged` → `{mediaKey, mediaType, rating}`. Not, yorum, diğer profil alanları yazılmaz.

## 5. Pilot kapsam ve işleyiciler

Yalnızca `LibraryItemAdded` ve `LibraryRatingChanged` için görev üretilir. Diğer olaylar (istenirse) yalnızca `background_events`'e yazılır, görev üretmez — bu, ileride açılacak işleyiciler için kayıp olmadan zemin sağlar.

Pilot işleyicilerin **yan etkisi** için iki seçenek var (onay gerekiyor):

- **A (önerilen):** salt-okunur doğrulama işleyicisi — `assertCurrent` + medya anahtarı doğrulaması + görev tamamlandı kaydı. Mevcut içerik/öneri davranışı değişmez; Faz 4 altyapısı uçtan uca doğrulanır.
- **B:** işleyici mevcut `ContentProcessingCoordinator.enqueueRawItem`'a devreder. İçerik kuyruğuyla çakışma/çift iş riski ve kullanıcı verisi sızma riski yeniden incelenmelidir; `ContentEventSubscriber` bunu zaten yapıyor.

## 6. Entegrasyon noktaları

- `src/server/app.ts`: `createAppEventBus({ persistEvent: (event) => backgroundManager.acceptEvent(event) })`; `backgroundManager` modülü `moduleRegistry.register(...)` ile eklenir (mevcut 5 modül kimliği korunur, yeni kimlik: `background-manager`).
- `createCineTrackApp` dönüşüne `backgroundManager` eklenir (Faz 3'teki `libraryService`/`contentService` gibi).
- Yeni dosyalar (onay sonrası): `src/contracts/background.ts`, `src/server/background-task-repository.ts`, `src/server/background-manager.ts`, `src/modules/library/background-handlers.ts`; `src/server/app.ts` düzenlemesi.
- Değişmeyecekler: `IEventPublisher`/`AppEventMap`, `LibraryService`, `ContentService`, `ContentProcessingQueue`, `PrimaryDataRepository`, API uçları, yedekleme/senkronizasyon, UI.

## 7. Test yaklaşımı (bu fazda test dosyası eklenmeyecek)

Talimat §5 gereği test/CI dosyaları Agent 1'e aittir. Doğrulama, geçici bir dizinde çalıştırılan salt-okunur betiklerle yapılacak:
yeniden başlatma sonrası `pending` kurtarma, aynı `eventId` iki kez → tek görev, geçici hata → `retry_wait` → `completed`, kalıcı hata → `failed`, profil değişimi → yazma yok, `processing` lease süresi dolmuş görev → yeniden `pending`.

## 8. Onay gereken kararlar

1. **Şema:** §2'deki iki yeni tablonun aynı `data/cinetrack.db` içine eklenmesi onaylanıyor mu? (Alternatifler: mevcut `content_processing_queue`'yu `ALTER TABLE` ile genişletmek — içerik semantiğini bozar; ayrı DB dosyası — yedekleme envanteri dışında kalır; JSON dosyası — paralel kalıcılık.)
2. **Pilot işleyici davranışı:** A (salt-okunur doğrulama, önerilen) mi, B (içerik kuyruğuna devir) mi?
3. **Outbox kapsamı:** yalnızca iki pilot olay türü mü kalıcı yazılsın, yoksa tüm `AppEventMap` olayları `background_events`'e yazılıp yalnızca ikisi için görev mi üretilsin? (Önerilen: tümü kaydedilir, görev yalnızca pilot ikisi.)

## 9. Kapsam dışı (bu fazda yapılmayacak)

- R0/R1 otomatik onarım, bakım botu değişiklikleri.
- Öneri motoru, Zevk Haritası, Content Intelligence algoritmaları.
- UI'de görev paneli/ilerleme göstergesi.
- Yeni HTTP API ucu, yedekleme/senkronizasyon değişikliği.
- Test/CI dosyaları (Agent 1) ve PR merge.

---

## 10. Uygulama sonucu

### 10.1 Eklenen / değişen dosyalar

| Dosya | Tür | Sorumluluk |
|---|---|---|
| `src/contracts/background.ts` | yeni | `BackgroundTaskStatus` (6 durum), `BackgroundEventRecord`, `BackgroundTaskRecord`, `BackgroundTaskHandler`, `BackgroundTaskHandlerContext`, `BackgroundStats`. |
| `src/contracts/index.ts` | güncellendi | Faz 4 tiplerinin barrel dışa açımı. Mevcut sözleşmeler değişmedi. |
| `src/server/background-task-repository.ts` | yeni | SQLite `background_events` + `background_tasks`; onaylı additive DDL; transaction'lı olay kabulü; claim/lease, retry, fail, cancel, `recoverInterrupted`, istatistik. |
| `src/modules/background/event-payload.ts` | yeni | Olay türü başına payload allowlist'i (kullanıcı verisi minimizasyonu). |
| `src/modules/background/errors.ts` | yeni | `RetryableBackgroundError` / `PermanentBackgroundError`, retry sınıflandırması, deterministik backoff. |
| `src/modules/background/handlers.ts` | yeni | Pilot audit-only işleyiciler (`library.item-added.audit`, `library.rating-changed.audit`); profil izolasyonu + payload doğrulaması. |
| `src/modules/background/service.ts` | yeni | `BackgroundManager`: `persistEvent` kabulü, işleyici eşlemesi, pompa, retry, idempotency, kurtarma, sağlık/istatistik. |
| `src/server/app.ts` | güncellendi | Repository + manager oluşturma, `createAppEventBus({ persistEvent })` bağlantısı, yaşam döngüsü (`startRuntimeModules`/`stopRuntimeModules`), dönüş nesnesine `backgroundManager`. |
| `docs/mia/faz4-background-manager-tasarim.md` | bu belge | Envanter + onay + uygulama kaydı. |
| `ARCHITECTURE.md` | güncellendi | §6 Faz 4 katmanı ve veri sınırları. |

### 10.2 Yeniden kullanılan mevcut altyapı

- `AppEventBus` + `IEventPublisher` / `IEventSubscriber` + `AppEventMap` (yeni olay türü eklenmedi, sözleşme değişmedi).
- `ProfileContext` (`getCurrent`, `ProfileConflictError`) — görev profilinin aktifliği buradan doğrulanır.
- `ModuleContext` (`profile`, `logger`) — manager `initialize(context)` ile beslenir.
- Mevcut SQLite altyapısı: aynı `data/cinetrack.db`, `node:sqlite` `DatabaseSync`, WAL + `busy_timeout`, transaction deseni.
- `data/cinetrack.db` GitHub senkronizasyon envanterinde değildir; profil kimliği taşıyan görev satırları depoya sızmaz.

### 10.3 Bilinçli sapma: ModuleRegistry kaydı

`background-manager`, `ModuleRegistry`'ye **ayrı modül olarak kaydedilmedi**. Nedeni: `GET /api/health` modül listesi mevcut beş kimliği (`primary-storage`, `taste-engine`, `backup-sync`, `content-intelligence`, `initial-indexer`) tam olarak doğruluyor ve bu test Agent 1'in sahipliğinde; talimat §5 test/CI dosyalarının değiştirilmesini yasaklıyor. Bunun yerine manager, `startRuntimeModules`/`stopRuntimeModules` içinde `serverModuleContext` ile başlatılıp durduruluyor ve `createCineTrackApp` dönüşünden erişilebiliyor. Yaşam döngüsü sözleşmesi (`initialize → start → stop`) ve `healthCheck()` uygulanır; registry'ye taşıma, Agent 1 health listesini güncellediğinde tek satırlık değişikliktir.

### 10.4 Akış (uygulanan)

1. `LibraryService.addItem/updateItem` → `diffLibraryEvents` → `eventBus.publish(event)`.
2. `AppEventBus.publish` → `persistEvent` → `BackgroundManager.acceptEvent`.
3. `acceptEvent` payload'ı allowlist'ten geçirir → `BackgroundTaskRepository.acceptEvent` tek transaction:
   `background_events` INSERT OR IGNORE; yalnızca kayıtlı işleyicisi olan olaylar için `background_tasks` (`UNIQUE(event_id, handler_id)`).
4. `publish` bellek içi aboneleri çalıştırır (içerik abonesi, taste adapter, shell köprüsü) — mevcut davranış korunur.
5. Manager pompası `claimNextTask` ile görevi kiralar (`processing`, `attempts+1`, `lease_until`), olayı ve işleyiciyi yükler, `handler.handle(event, {profileContext, now, logger})` çağırır.
6. Başarı → `completed`. Hata → `ProfileConflictError` ise `retry_wait` (profil yeni profile yazılmaz), geçici hata ise `retry_wait`, kalıcı hata/deneme tükenmesi ise `failed`.
7. Açılışta `recoverInterrupted`: lease'i dolmuş `processing` → `pending` (deneme tükendiyse `failed`).

### 10.5 Doğrulama (yerel, geçici betiklerle — test dosyası eklenmedi)

| Senaryo | Sonuç |
|---|---|
| Olay + görev kalıcı yazımı, ikinci `eventId` → yeni görev yok | ✅ |
| Görev `pending → processing → completed`, `attempts=1` | ✅ |
| Geçici hata → `retry_wait` (last_error kayıtlı) → süre dolunca `completed` | ✅ |
| Kalıcı hata → `failed`, ikinci pompada yeniden çalışma yok | ✅ |
| Aktif profil farklı → yazma yok, `profile-not-active` | ✅ |
| Lease'i dolmuş `processing` → `pending` → `completed` | ✅ |
| `createCineTrackApp` entegrasyonu: 2 olay → 2 görev → `completed`; `/api/health` modül listesi değişmedi | ✅ |
| Allowlist dışı alan (`personalNote`) kalıcı deftere yazılmadı | ✅ |
| `npm test` 447/447, `npm run test:taste` 355/355, `npm run build` | ✅ |
| `npx eslint src server.ts tests --max-warnings 0`, `npx tsc --noEmit` | ✅ |

### 10.6 Migration notu

Uygulanan değişiklik **yalnızca eklemedir**: aynı `data/cinetrack.db` içinde `CREATE TABLE IF NOT EXISTS background_events`, `background_tasks` ve indeksleri. Mevcut `content_intelligence`, `content_processing_queue`, `content_processed_events` tablolarına ALTER, veri taşıma veya geri doldurma yoktur. Geri alma: iki tabloyu düşürmek yeterlidir; uygulama kodu bu tablolar yokken yeniden oluşturur.

### 10.7 Bilinen sınırlar

- Pilot işleyiciler **audit-only**'dir; gerçek yan etkiler (içerik zenginleştirme, türetilmiş önbellek) sonraki fazlarda mevcut servisler üzerinden eklenecektir. Bu, içerik/öneri davranışının değişmediğini garanti eder.
- Manager tek işçi (concurrency=1) ile çalışır; sıralı işleme yeterli ve hata izolasyonu korunur. Yatay ölçek için `claimNextTask` lease modeli hazırdır.
- `retry_wait` görevleri için pompa 500 ms'lik poll + bildirim ile ilerler; ayrı bir zamanlayıcı servisi yoktur.
- Aynı `eventId` farklı payload ile gelirse ilk kayıt korunur (olay defteri değişmez; idempotency gereği).
- Döngüsel importlar ve mimari baseline bu fazda değiştirilmedi.
