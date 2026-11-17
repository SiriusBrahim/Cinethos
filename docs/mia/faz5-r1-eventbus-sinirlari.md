# MIA Faz 5 — R1: EventBus Sınırları ve Sorumluluk Ayrımı

**Durum:** Belgelendirme (R1). Kod davranışı değiştirilmemiştir.  
**Kapsam tabanı:** `origin/master` FETCH_HEAD / yerel çalışma dalı `agent-2/phase-5-r1-eventbus-boundaries`, HEAD `2ffe4bf82a5d512c1dafd7754498554e443c9098` (MIA Faz 4 merge, #28).  
**Amaç:** Domain olay altyapısında tek otoriteyi, katman sınırlarını ve yasaklı örüntüleri kod kanıtıyla netleştirmek. Bu belge Faz 5 R2+ için ön koşul sınır sözleşmesidir; uygulama onayı değildir.

## 1. Temel kararlar (değişmez)

- **`AppEventBus`** uygulama/domain olaylarının **tek yayın ve abonelik otoritesidir**.
- **BackgroundManager** yalnızca `AppEventBus` üzerinden (kalıcılık kancası ile) kabul edilen olayları kalıcı işler ve görev yaşam döngüsünü yönetir.
- **Kernel EventBus** (ayrı bir kernel yaşam döngüsü bus’ı) bu checkout’ta üretim domain akışının parçası olarak kullanılmaz; varsa sorumluluğu kernel/iç altyapı yaşam döngüsü ile sınırlıdır ve domain olayı otoritesi olamaz.
- **Shell/UI event mekanizması** (`shell-events.ts`) yalnızca arayüz bildirimi/sunum amaçlıdır; domain olayı üretmez, domain olayının yerine geçmez.
- Bu sistemlerin görevleri birbirine karıştırılmaz.
- **Üçüncü bir EventBus oluşturulmaz.**
- **Aynı domain olayı iki farklı bus/kanal üzerinden bağımsız olarak yayımlanmaz.**

## 2. Kanıtlı mevcut mimari

### 2.1 Domain olay otoritesi: `AppEventBus`
- **Sözleşme ve tipler:** `src/contracts/events.ts`
  - `AppEventMap` domain olay kataloğu: `LibraryItemAdded`, `LibraryItemUpdated`, `LibraryStatusChanged`, `LibraryRatingChanged`, `LibraryItemRemoved`, `FavoriteActorChanged`, `ProfileSwitched`, `CatalogItemEnriched`.
  - `TypedAppEvent` alanları: `eventId`, `eventType`, `profileId`, `entityId?`, `occurredAt`, `schemaVersion`, `payload`, `sourceRevision`, `ref?`.
  - `IEventPublisher.publish` / `IEventSubscriber.subscribe` sözleşmesi; aboneler idempotent olmalıdır.
- **Uygulama:** `src/app/app-event-bus.ts`
  - `createAppEvent(...)`: `profileId` ve geçerli `sourceRevision` zorunlu; `eventId`/`occurredAt`/`schemaVersion` üretir veya doğrular.
  - `AppEventBus.publish(...)`: `eventId/profileId/sourceRevision` doğrular; **önce** `persistEvent` kancasını `await` eder, başarısızsa hatayı çağırana iletir; **sonra** geçmişe ekler ve aboneleri `Promise.allSettled` ile çalıştırır; abone hatalarında `AggregateError` fırlatır.
  - `persistEvent` başarısız olduğunda geçmişe yazım ve abone çalıştırma gerçekleşmez (kanca `publish` akışının başında).
  - `bridgeAppEventsToShellEvents(...)`: seçili domain olaylarından (`LibraryItemAdded` → `item:saved`, `ProfileSwitched` → `profile:changed`) **UI özet bildirimi** üretir; yeni domain olayı yayımlamaz (bkz. 2.4).

### 2.2 Kalıcı kabul ve görev yaşam döngüsü: `BackgroundManager`
- **Kablolama:** `src/server/app.ts` (satır ~473–492)
  - `createBackgroundTaskRepository({ dataDir })` ve `createBackgroundManager(...)` oluşturulur.
  - `createAppEventBus({ persistEvent: async (event) => backgroundManager.acceptEvent(event) })` ile domain olayı kalıcılık kabulüne bağlanır.
  - `profileContext` aynı `eventBus` ile ilişkilendirilir (`eventPublisher: eventBus`).
- **Sözleşme:** `src/contracts/background.ts` (`BackgroundTaskStore`, görev durumları, handler/istatistik tipleri).
- **Kabul/persist:** `src/modules/background/service.ts`
  - `acceptEvent`: işleyici eşlemesi + payload allowlist (`sanitizeEventPayload`) ile repository kabulü; dedupe bilgisini loglar, görev üretildiyse pompayı tetikler.
  - Çalıştırma: claim/lease, `ProfileConflictError` ve retry sınıflandırması, terminal durumlar, kurtarma (`recoverInterrupted`), sağlık/istatistik.
- **Kalıcılık:** `src/server/background-task-repository.ts`
  - Aynı SQLite (`data/cinetrack.db`), additive `background_events` + `background_tasks`, tek transaction’da olay+görev kabulü (`UNIQUE(event_id, handler_id)`), lease/retry alanları.
- **Not:** Faz 4 kararı gereği BackgroundManager `ModuleRegistry`’ye ayrı modül olarak kayıtlı değildir; yaşam döngüsü `server/app.ts` üzerinden yönetilir ve `healthCheck()` uygulanır (mevcut `/api/health` modül listesi sözleşmesi korunur).

### 2.3 Domain olay üretimi ve tüketimi (örnek kanıtlar)
- **Üretim:**
  - İstemci mutasyonları: `src/hooks/useItemActions.ts` (`createAppEvent(...)`).
  - Sunucu diff/yazma akışı: `src/server/library-event-diff.ts` (`diffLibraryEvents*`, `createAppEvent`).
- **Tüketim (AppEventBus aboneleri):**
  - İçerik işleme: `src/server/content-event-subscriber.ts` (`subscriber.subscribe(...)` tüm `AppEventMap` olay türleri için kayıtlı).
  - Taste servis adaptörü: `src/server/taste-service-adapter.ts` (ilgili olay türlerine abonelik).
- Bu tüketiciler **AppEventBus subscriber**’larıdır; ayrı domain event bus oluşturmaz.

### 2.4 Shell/UI olay kanalı
- **Uygulama:** `src/app/shell-events.ts` — tipli `ShellEventMap` (`item:saved`, `item:disliked`, `profile:changed`, `sync:completed`), `emit/subscribe`, dinleyici hatası yayını bozmaz, test reset desteği.
- **Sınır:** Shell olayları UI kabuğu içi bildirimdir; `AppEventMap` domain sözleşmesinin, kalıcı outbox/background kabulünün veya domain abonelerinin yerine geçmez.
- **Köprü:** `src/app/app-event-bus.ts` içindeki `bridgeAppEventsToShellEvents` yalnızca **AppEvent → ShellEvent** yönünde özet üretir. Bu checkout’ta `src` içinde üretim kullanımı tespit edilmemiştir (fonksiyon mevcut, opsiyonel entegrasyon noktasıdır); kullanıldığında dahi domain olayını yeniden yayımlamaz.

### 2.5 Kernel EventBus
- Bu checkout (`2ffe4bf`) içinde `src` altında `KernelEventBus`/`createKernelEventBus` üretim kullanımı tespit edilmemiştir.
- Faz 1 kernel tasarımında ayrı kernel event/lifecycle katmanı öngörülse bile, **domain iş olayı otoritesi `AppEventBus`’tır**; kernel katmanı domain olayını kopyalamaz veya ikinci otorite olarak kullanmaz.

## 3. Yasaklı örüntüler ve uyum kuralları

1. **Üçüncü EventBus yok:** Yeni bir genel/domain publish-subscribe altyapısı eklenmez.
2. **Çift yayın yok:** Aynı domain olayı hem `AppEventBus` hem başka bir bus/kanalda “domain olayı” olarak bağımsız yayımlanmaz. Shell köprüsü yalnızca UI bildirimi üretir.
3. **Kalıcılık sırası korunur:** `persistEvent` başarılı olmadan domain olay “kabul edilmiş” sayılmaz; `publish` başarısız olmalıdır (sessiz yutma yok).
4. **Sözleşme alanları korunur:** `eventId`, `profileId`, `sourceRevision`, `schemaVersion`, payload ve olay tipleri `AppEventMap` ile uyumlu kalır.
5. **Profil bağlamı:** Domain olayları profil etiketlidir; background işleyicileri/etkileri profil izolasyonu kurallarına tabidir (yanlış profile yazım yok).
6. **Faz 4 davranışı korunur:** `persistEvent` → `BackgroundManager.acceptEvent` bağlantısı, additive şema, audit-only pilot handler kapsamı ve mevcut `/api/health` modül listesi bu fazda değiştirilmez.

## 4. Kernel ↔ AppEventBus köprüsü ne zaman gerekebilir?

R1 kararı: **şu an minimal adaptör zorunlu değil** (mevcut üretim akışında kanıtlı ihtiyaç yok). İleride yalnızca aşağıdaki koşulların tümü sağlanırsa, **ayrı kullanıcı onayı ve ayrı adımla** tek yönlü minimal adaptör değerlendirilebilir:
- Kernel yaşam döngüsü bilgisinin domain/outbox tarafında işlenmesi için **kanıtlanmış** bir gereksinim vardır.
- Eşleme tek noktadan, tek yönlü ve idempotenttir.
- `AppEventMap` ve `AppEventBus` domain otoritesi değişmez; üçüncü bus oluşturulmaz.
- Aynı olayın çift işlenmesi/double-publish riski testlerle engellenir.

## 5. R1 kapsam dışı (bilinçli olarak yapılmadı)

- R2 profil-bazlı Taste partition/migration, backup/sync/restore değişiklikleri.
- Taste/Memory/Relationship Manager kodlaması, AppEventMap veya `/api/taste` sözleşmesi değişiklikleri.
- BackgroundManager davranış değişiklikleri, DB şeması değişiklikleri, ModuleRegistry/health sözleşmesi değişiklikleri.
- Öneri motoru değişiklikleri, Faz 4’e dönük kod refaktörü.

## 6. Faz 4 regresyon güvence notu

Bu R1 teslimi yalnızca dokümantasyon ekler; `src/`, `server.ts`, testler ve çalışma zamanı yapılandırmaları değiştirilmemiştir. Bu nedenle Faz 4’ün `persistEvent` sıralaması, publish hata semantiği, background kabul/idempotency, payload allowlist ve pilot handler kapsamı üzerinde doğrudan kod kaynaklı regresyon beklenmez. Nihai doğrulama, çalıştırılan test/lint/build sonuçları ve Agent 1 bağımsız incelemesi ile tamamlanır.
