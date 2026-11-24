# Aşama 5 — Mimari Yapı ve Katman Sınırları

**Durum:** Kısmen tamamlandı (bkz. `docs/audits/PHASE_05_ARCHITECTURE_INVENTORY.md` §16 ve
`docs/DEVELOPMENT_REMEDIATION_PLAN.md` §7).
**Dal:** `remediation/full-project-remediation` · **PR:** #65

Bu belge Aşama 5 uygulamasından **sonraki** mimariyi anlatır: yeni modüller, port/adaptör
sınırları, bağımlılık yönleri ve gerekçeli istisnalar. Envanterdeki (uygulama öncesi) durum
`docs/audits/PHASE_05_ARCHITECTURE_INVENTORY.md` içinde korunmuştur.

---

## 1. Katmanlar ve bağımlılık yönleri

```
                    ┌──────────────────────────────┐
   UI / app         │ components · hooks · app      │
                    │ features · design-system      │
                    └───────────────┬──────────────┘
                                    │ (izinli)
                    ┌───────────────▼──────────────┐
   modüller         │ modules/*  (sözleşme + port) │
                    └───────────────┬──────────────┘
                                    │ port (server uygular)
                    ┌───────────────▼──────────────┐
   sunucu           │ server/*  · server.ts         │
                    └───────────────┬──────────────┘
                                    │
                    ┌───────────────▼──────────────┐
   ortak + çekirdek │ shared/*  · contracts/*  ·    │
                    │ core/*  (+ core/ports/)       │
                    └──────────────────────────────┘
```

Ölçülen yönler (`scripts/maintenance/architecture-boundaries.mjs`, AST tabanlı):

| Kural | Kapsam | Yön | Durum |
|---|---|---|---|
| `core-purity` | `src/core/**` | core → server/services/app/modules/hooks/components/design-system **yasak**; `react`, `idb-keyval`, `exceljs` ve Node yerleşikleri yasak | **0 ihlal** |
| `server-isolation` | `server.ts`, `src/server/**` | server → app/components/hooks/features/design-system **yasak** | **0 ihlal** |
| `client-no-server` | components/hooks/app/features/design-system | → server **yasak**, Node yerleşikleri yasak | **0 ihlal** |
| `contracts-isolation` | `src/contracts/**` | sözleşmeler çalışma zamanı katmanlarına bağımlı olamaz | **0 ihlal** |
| `modules-no-server` | `src/modules/**` | modules → server **yasak** | **0 ihlal** |
| `shared-isolation` | `src/shared/**` | shared → server/app/services/modules/... **yasak** | **0 ihlal** |

Döngüsel import: **0** (`npm run cycles` ve tarayıcının kendi DFS kontrolü).

### 1.1 İzin verilen ve gerekçeli yönler

- **server → modules** (otomatik yasak değil): sunucu, modül servislerini **bir araya getiren**
  kompozisyon katmanıdır (`src/server/app.ts`). Modüller kendi portlarını tanımlar, sunucu
  adaptörleri bu portları uygular. Bağımlılık yönü daima `server → modules`.
- **modules → services (istemci)**: modül UI bileşenleri (`src/modules/*/*Section.tsx`) mevcut
  istemci servislerini kullanır; bunlar arayüz modülleridir, sunucu modülü değildir.
- **core → utils, core → shared**: `core/utils/release-window.ts` gibi saf yardımcılar ve
  `shared/brand.ts` ortak primitifler çekirdekten kullanılabilir.
- **services → core**: uygulama katmanı çekirdeği kullanır; ters yön yasaktır.

---

## 2. Çekirdek portları (Ports & Adapters)

Çekirdek katmanı ortam bağımlılıklarını **doğrudan** import etmez. Port tanımları
`src/core/ports/` altındadır; adaptörler uygulama katmanında kayıtlıdır.

| Port | Dosya | Adaptör | Kayıt noktası |
|---|---|---|---|
| API (`coreApiFetch`) | `core/ports/api-port.ts` | `services/api-client.ts` (`apiFetch`) | modül yüklenirken kendini kaydeder |
| Anahtar-değer deposu | `core/ports/kv-store-port.ts` | `services/core-idb-store.ts` (`idb-keyval`) | fabrika kaydı |
| İçerik kodlaması | `core/ports/encoding-port.ts` | `services/encoding-service.ts` | modül yüklenirken |
| Seri kataloğu (senkron okuma) | `core/ports/series-catalog-port.ts` | `services/storage-idb.ts` | modül yüklenirken |

Tek giriş noktası: `src/services/core-adapters.ts` (uygulama girişi `src/main.tsx`).
Testler bu modülü açıkça import eder; test başarımı için gizli global kurulum yoktur.

**Kayıt yoksa davranış:** API ve kodlama portları açık hata fırlatır (sessiz yutma yok);
anahtar-değer ve seri kataloğu portları "depo yok" davranışına düşer (mevcut
`typeof indexedDB === 'undefined'` semantiği korunur).

### 2.1 Çekirdekten çıkarılan ortam bağımlılıkları

| Önce | Sonra |
|---|---|
| `core/actor-recommendations.ts` → `services/api-client.ts` | `core/ports/api-port.ts` |
| `core/cinetrack-core.ts` → `idb-keyval` | `core/ports/kv-store-port.ts` |
| `core/cinetrack-core.ts` → `services/api-client.ts` | `core/ports/api-port.ts` |
| `core/relationship-explorer.ts` → `services/encoding-service.ts` | `core/ports/encoding-port.ts` |
| `core/relationship-explorer.ts` → `services/storage-idb.ts` | `core/ports/series-catalog-port.ts` |
| `core/relationship-explorer.ts` → `services/series-tv-seeds.ts` | saf veri: `core/series-tv-seeds.ts` |
| `core/taste/migration.ts` → `require("crypto")` | `globalThis.crypto.randomUUID` + opak yedek |

---

## 3. Yeni ve taşınan modüller

### 3.1 Çekirdek

| Modül | Satır | Sorumluluk |
|---|---|---|
| `src/core/media/document-types.ts` | 171 | `SavedItem`/`Profile`/`DataDocument` modeli, sabitler, yedek tipleri |
| `src/core/media/document-normalize.ts` | ~812 | Doğrulama, bozuk veri kurtarma, tombstone, profil normalizasyonu |
| `src/core/media/backup-parse.ts` | ~242 | Yedek ayrıştırma (B-05/B-06/B-07 kuralları) |
| `src/core/series-types.ts` | 44 | Seri/koleksiyon veri sözleşmeleri (tek kaynak) |
| `src/core/series-tv-seeds.ts` | 171 | Saf TV franchise seed verisi |
| `src/core/relationship-ports.ts` | 45 | Explorer'ın port köprüleri |
| `src/core/ports/*.ts` | — | Port tanımları ve kayıt defterleri |

`src/core/cinetrack-core.ts` **6.445 → 5.335 satır** (public API korunuyor: kalan modüller
yeniden dışa aktarılır).

### 3.2 Sunucu

| Modül | Satır | Sorumluluk |
|---|---|---|
| `src/server/persistent-store/contracts.ts` | ~288 | Senkronizasyon sözleşmeleri, durum şablonları, HTTP/token sınıflandırıcıları |
| `src/server/external-json.ts` | 78 | Dış JSON sınırı type guard'ları (F5-09) |

`src/server/persistent-store.ts` **4.130 → 3.876 satır**.

### 3.3 Ortak çalışma zamanı (`src/shared/`)

Sunucu ile istemcinin birlikte kullandığı primitifler `src/app/` altından taşındı; eski yollar
tek satırlık shim olarak korunuyor:

- `shared/runtime/app-event-bus.ts` (tipli domain olay yolu)
- `shared/runtime/ProfileContext.ts` (aktif profil + revision)
- `shared/runtime/runtime-module-registry.ts` (modül yaşam döngüsü)
- `shared/runtime/shell-events.ts` (kabuk olay kanalı)
- `shared/library-event-diff.ts` (kütüphane olay türetimi)

### 3.4 Modül portları

| Modül | Port | Uygulayan |
|---|---|---|
| `modules/library` | `modules/library/ports.ts` (`LibraryWriteRepository`) | `server/primary-data-repository.ts` |
| `modules/content` | `modules/content/ports.ts` (`ContentMetadataPort`) | `server/content-metadata-source.ts` |

`modules/content/metadata-detail.ts` — `hasSufficientDetail` tek kaynağı.

---

## 4. Uyumluluk (shim) yolları

Taşınan her modülün eski import yolu çalışmaya devam eder. Shims yalnızca yeniden dışa aktarır,
iş mantığı içermez:

```
src/app/app-event-bus.ts            → shared/runtime/app-event-bus.ts
src/app/runtime-module-registry.ts  → shared/runtime/runtime-module-registry.ts
src/app/ProfileContext.ts           → shared/runtime/ProfileContext.ts
src/app/shell-events.ts             → shared/runtime/shell-events.ts
src/server/library-event-diff.ts    → shared/library-event-diff.ts
src/services/series-tv-seeds.ts     → core/series-tv-seeds.ts
```

Kaldırılan shim'ler Aşama 6/7'de (tüketici sayısı sıfırlandığında) temizlenebilir.

---

## 5. Mimari tarayıcı (F5-02)

`scripts/maintenance/architecture-boundaries.mjs` import tespiti artık **TypeScript Compiler
API** ile yapılır:

- statik `import` / `export ... from` / `import x = require(...)`,
- dinamik `import('...')` ve `require('...')`,
- çok satırlı ve alias'lı biçimler,
- yorum/metin içindeki sahte importlar **sayılmaz**,
- her ihlal `dosya:satır → hedef (gerekçe)` olarak raporlanır.

Kural dosyası `scripts/maintenance/architecture-rules.json` **sürüm 2**'dir; `tests/
architecture-boundaries.test.mjs` kural gevşetmeyi, yeni ihlali, bayat allowlist girdisini ve
çok satırlı import kaçırma regresyonunu denetler. **Allowlist boştur.**

---

## 6. Gerekçeli istisnalar ve bilinen borç

1. **`src/core/media/types.ts` ile `document-types.ts` çift veri modeli.** `media/types.ts`
   alt modüllerin (actor-recommendations, cinema-kunye, ring-lifecycle) kullandığı modeldir;
   `document-types.ts` ise `cinetrack-core` modelidir. İkisini birleştirmek alan farkları nedeniyle
   veri sözleşmesi riski taşıdığı için Aşama 5'te yapılmadı (bkz. §16 "kalan işler").
2. **`server → modules`** bilinçli olarak serbesttir: sunucu kompozisyon köküdür.
3. **Büyük dosyalar:** `github-bidirectional-sync.ts` (5.118) ve `App.tsx` (2.391) bu aşamada
   bölünmedi; `persistent-store.ts` yalnızca sözleşmeler düzeyinde ayrıldı. Gerekçe: kilit/
   lease/atomic-write ve UI akışlarının davranışsal eşdeğerliği kanıtlanmadan bölünme riski.
4. **`< 1.000 satır` hedefi** yeni modüllerde korundu (en büyüğü ~812 satır); mevcut büyük
   dosyalar bu kuralın kapsamı dışındadır.

---

## 7. Doğrulama

| Kapı | Komut | Sonuç |
|---|---|---|
| Unit | `npm test` | 818/818 |
| Taste | `npm run test:taste` | 440/440 |
| Lint + typecheck | `npm run lint` | 0 hata / 0 uyarı |
| Döngü | `npm run cycles` | 0 |
| Mimari | `node scripts/maintenance/architecture-boundaries.mjs` | 0 ihlal / 310 dosya |
| Build | `npm run build` | başarılı |
| Data guard | test çalıştırıcısı | 15 dosya değişmedi |
