# MIA Faz 1 — Modüler Altyapı ve Sözleşmeler

> **Durum:** Faz 1 tamamlandı · 2026-11-16 · dal `freebuff/faz0-f47140`
> **Kod:** [`src/core/kernel/`](../../src/core/kernel/) · [`src/core/content-intelligence/`](../../src/core/content-intelligence/)
> **Testler:** `tests/mia-kernel.test.mjs`, `tests/mia-profile-events.test.mjs`, `tests/mia-content-intelligence.test.mjs` — **21/21**
> **İlkeler:** [mimari-ilkeler.md](./mimari-ilkeler.md) · **Faz 0 kanıtı:** [faz0-checklist.md](./faz0-checklist.md)

Çekirdek React'ten ve Node API'lerinden bağımsızdır (`src/core`); istemci, sunucu ve testler aynı sözleşmeyi kullanır. Faz 1 kapsamı **sözleşme + çalışan çekirdek**tir; üretim veri yolu bilinçli olarak Faz 2/3'e bırakıldı.

## 1. Modül yaşam döngüsü

```ts
interface AppModule {
  manifest: ModuleManifest;                 // id, version, schemaVersion, dependencies, provides
  api?: unknown;                            // dışa açılan TEK yüzey
  initialize?(ctx: ModuleContext): void | Promise<void>;
  start?(ctx: ModuleContext): void | Promise<void>;
  healthCheck?(ctx: ModuleContext): ModuleHealthReport | Promise<ModuleHealthReport>;
  stop?(ctx: ModuleContext): void | Promise<void>;
}
```

- Sıra: **initialize → start → (healthCheck)* → stop**. `stop` başlatmanın ters sırasındadır.
- `ModuleContext` yalnız `{ moduleId, events, profile, logger }` taşır; **registry referansı vermez**. Modüller birbirine `create(deps)` ile gelen `deps.getService(id)` üzerinden erişir, o da yalnız `api` döner.
- Adımlardan biri hata fırlatırsa modül `failed` olur; uygulama düşmez, bağımlıları `skipped` olur ve `module.failed` olayı yayınlanır.
- Manifesto doğrulaması: `id` `^[a-z][a-z0-9-]*$`, `version` semver, `schemaVersion` pozitif tamsayı, kendine bağımlılık yasak.

## 2. Module Registry

`src/core/kernel/module-registry.ts`

| Yetenek | Davranış |
| --- | --- |
| Kayıt | Tek kimlik; tekrar `duplicate_module`; bootstrap sonrası kayıt `already_started` |
| Sıralama | Kahn topolojik sıralama; eşit seviyede kimliğe göre deterministik |
| Eksik bağımlılık | Modül `failed`, mesaj `Eksik bağımlılık: …` |
| Döngü | Döngüdeki her modül `failed`, mesaj `Döngüsel bağımlılık` |
| Servis erişimi | `getService` yalnız `running` + `api` varsa; aksi `not_started` / `unknown_module` |
| Sağlık | `healthCheck()` tüm modülleri toplar; `ok = hepsi healthy` |
| Durdurma | Başlatma sırasının tersi; hata loglanır, diğerleri durmaya devam eder |

`tryGetService` hata fırlatmayan `Result` döner. Registry `snapshot()` durum + son hata verir (Sistem Yönetimi panelinin Faz 4 girdisi).

## 3. Profile Context

`src/core/kernel/profile-context.ts`

```ts
interface ProfileSnapshot { profileId: string; revision: number; epoch: number; updatedAt: string }
interface ProfileTaskToken { profileId: string; revision: number; epoch: number }
```

- `switchProfile(profileId, revision?)` epoch'u artırır, `profile.changed` yayınlar. **Aynı profile yeniden geçiş de epoch artırır** (yarışan işler iptal edilir).
- `setRevision(revision)` sunucudan gelen yeni veriyi işler; revizyon aynıysa epoch artmaz (gereksiz iptal yok).
- `beginTask()` → token; `isTaskCurrent(token)` / `assertCurrent(token)` (ihlalde `StaleProfileTaskError`).
- Kural: sonucu yazacak her asenkron iş `assertCurrent` çağırmadan yazmaz. Faz 2'de bu, veri yazma yollarına bağlanacak.

## 4. Event System

`src/core/kernel/event-bus.ts`

```ts
interface KernelEvent<T> {
  id: string; type: T; profileId: string; entityId?: string;
  occurredAt: string; schemaVersion: number; payload: KernelEventMap[T];
}
```

- Adlandırma: `domain.action` (`^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`). İhlalde `InvalidEventNameError` — sessiz yayın yok.
- `profileId` zorunlu; `subscribe(type, handler, { profileId })` ile profil filtresi.
- Abone hatası yayını durdurmaz: `onError`/logger'a raporlanır, sonraki aboneler çalışır.
- `once` tek seferlik; `listenerCount`, `clear` (test/yeniden başlatma).
- Olay kataloğu: `content.added`, `content.updated`, `content.removed`, `watchlist.changed`, `profile.changed`, `taste.updated`, `recommendations.refreshRequested`, `content.processed`, `module.failed`.
- **İçerik olayları `system` profiliyle yayınlanır** (içerik profilsizdir). Profil bazlı türev iş Faz 4 işleyicisinde üretilir.
- UI katmanındaki `app/shell-events.ts` ayrı kalır (plan §0: iki katman).

## 5. Repository ve Service sözleşmeleri

`src/core/kernel/repository-contracts.ts`

```ts
ReadRepository.get(key)        → Result<Revisioned<T> | null>
ReadRepository.list()          → Result<Revisioned<T>[]>
WriteRepository.put(value, { expectedRevision? }) → Result<Revisioned<T>>
WriteRepository.delete(key)    → Result<boolean>
```

- Tüm dönüşler `Result`; hata kodları `not_found | conflict | validation | unavailable`. Fırlatma yok.
- `expectedRevision` uyuşmazlığı `conflict` — yarışan yazma sessizce kazanmaz (Faz 0'daki `409` davranışının çekirdek karşılığı).
- `createInMemoryRepository` referans uygulamadır; üretim adaptörleri (JSON, SQLite, IndexedDB) Faz 2'de bu arayüzün arkasına geçer.
- Servis sözleşmesi kuralı: her modül **tek** `api` nesnesi dışa açar; repository'ler modül içinde kalır, dışarıya verilmez.

## 6. Content Intelligence Manager — mimari sınırlar

`src/core/content-intelligence/`

| Alt modül | Dosya (Faz 1) | Sorumluluk |
| --- | --- | --- |
| Content Ingestion | `manager.ts` `ingest` | Doğrulama → kimlik → tekilleştirme → yazma |
| Metadata Normalizer | `identity.ts` | Kanonik anahtar `movie:157336` / `tv:1396`, medya türü normalizasyonu |
| Content Repository | enjekte `ContentRecordRepository` | Katalog erişimi (Faz 2 adaptörü) |
| Feature Extractor | `features.ts` | `DerivedFeatures` üretimi (`featureVersion`) |
| Content Relationship Processor | Faz 5 | `DerivedFeatures` + ayrı ilişki deposu |
| Processing Coordinator | `manager.ts` `processing` + `reprocess` | `pending → features_ready | failed`, deneme sayısı, son hata |

Sınırlar:
1. **İçerik kimliği** = medya türü + TMDB kimliği. Başlık/yıl değişse anahtar değişmez; film ve dizi aynı sayıyı taşısa ayrı kayıttır.
2. **Tekilleştirme:** `fetchedAt` daha yeni değilse kayıt yeniden yazılmaz (`skipped`) — tekrarlı indirme/analiz yok (ilke 5).
3. **Kaynak ≠ türetim:** `source` (TMDB verisi, TMDB puanı dahil) ve `derived` (Cinethos özellikleri) ayrı alanlar. Türetilmiş özellik sağlayıcı alanı taşımaz; kullanıcı puanı burada hiç yoktur.
4. **İşlem durumu** kayıtla birlikte saklanır; hata `processing.failed` + `lastError` olarak yazılır, sağlık raporu `healthy: false` döner.
5. **Profil bağımsızlığı:** kayıtlarda `profileId` alanı yoktur (test bunu JSON üzerinde doğrular); dört izleme listesi de aynı katalog kaydını kullanır.
6. **Öneri motoru okuma yolu:** yalnız `getFeatures(key)` / `getFeaturesBatch(keys)`; yalnız `features_ready` kayıtlar döner. Profil, puan veya durum parametresi yoktur.
7. **Olaylar:** yazma sonrası `content.added` / `content.updated` (`system` profili, `entityId = contentKey`); `content.removed` aboneliği kaydı düşürür.

## 7. Kullanım

```ts
import { createKernel } from './src/core/kernel/index.ts';
import { createContentIntelligenceModule, CONTENT_INTELLIGENCE_SERVICE } from './src/core/content-intelligence/index.ts';

const kernel = createKernel({ profileId: 'profile-default', revision: 60 });
kernel.register(createContentIntelligenceModule());
await kernel.bootstrap();

const content = kernel.registry.getService(CONTENT_INTELLIGENCE_SERVICE);
const task = kernel.profile.beginTask();
const result = await content.ingest(source);
kernel.profile.assertCurrent(task); // profil değiştiyse yazma yapılmaz
```

## 8. Faz 1 kabul kriteri karşılığı

| Kriter | Durum | Kanıt |
| --- | --- | --- |
| Modül yaşam döngüsü çalışmalı | ✅ | sıra testi + ters durdurma + hata izolasyonu |
| Module Registry modülleri yönetebilmeli | ✅ | topolojik sıra, eksik bağımlılık, döngü, tekrar, geç kayıt, sağlık |
| Profile Context güvenilir olmalı | ✅ | geçiş/revizyon epoch iptali, `StaleProfileTaskError`, `profile.changed` |
| Event System temel olayları iletebilmeli | ✅ | zarf alanları, profil filtresi, hata izolasyonu, `once`, ad doğrulama |
| Repository ve Service sözleşmeleri tanımlı | ✅ | `Result` + revizyon/çakışma + referans uygulama |
| CIM mimari sınırları belirlenmiş | ✅ | kimlik, tekilleştirme, kaynak/türetim ayrımı, durum, profil bağımsızlığı, okuma yolu |

## 9. Bilinçli olarak Faz 2+'a bırakılanlar

| Konu | Faz | Neden |
| --- | --- | --- |
| JSON/SQLite/IndexedDB adaptörleri, migration | 2 | Veri Yöneticisi; tek yazma yolu `revision` ile |
| Kuyruk (Outbox), retry/dead-letter, idempotans | 4 | Kalıcı olay işleme; Faz 1 yalnız yayın/abonelik |
| `LibraryManager`, `TasteManager`, `MemoryManager`, `RecommendationManager` sözleşmeleri | 3–6 | Gerçek tipler taşıma sırasında çıkarılacak |
| CIM'in katalog dosyalarına bağlanması | 3 | `ContentRecordRepository` adaptörü; bugün referans in-memory depo |
| İlişki işleyicisi | 5 | `DerivedFeatures` hazır, grafik deposu yok |
| Uygulama/sunucu kablolaması, Sistem Yönetimi paneli | 4/7 | Çekirdek önce; sonra tek giriş noktası |

> **Doğruluk notu:** Bu fazda üretim veri yolu değişmedi; mevcut uygulama aynı `storage.ts` yolunu kullanmaya devam ediyor. Bu yüzden "kullanıcı verisi artık çekirdekten geçiyor" denemez — o Faz 2/3 işidir.
