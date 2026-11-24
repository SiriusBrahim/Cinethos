# Aşama 5 — Uygulama Sonuçları (Bölüm B)

**Tarih:** 24 Kasım 2026
**Dal:** `remediation/full-project-remediation` · **PR:** #65 (açık, merge edilmedi)
**Başlangıç HEAD:** `9b45895` · **Uygulama öncesi envanter:** [PHASE_05_ARCHITECTURE_INVENTORY.md](PHASE_05_ARCHITECTURE_INVENTORY.md)
**Yeni mimari:** [../../PHASE_05_ARCHITECTURE.md](../../PHASE_05_ARCHITECTURE.md)

Bu belge envanterdeki (§1–§15) bulguların uygulama sonrası **gerçek** durumunu kaydeder.
Envanter metni tarihsel kayıt olarak değiştirilmedi.

---

## 1. Başlangıç ölçümü (bu oturumda yeniden alındı)

| Kapı | Başlangıç (`9b45895`) |
|---|---|
| Unit | 817/817 |
| Taste | 440/440 |
| Lint + typecheck | 0/0 |
| Döngü | 0 |
| Mimari tarayıcı | 292 dosya / 898 import / **5** `core-purity` ihlali (gerçek: 7) |
| Data guard | 15 dosya değişmedi |

> Not: envanterdeki 292/898 sayıları regex tarayıcıya aittir; AST tarayıcı aynı kodda 7 ihlal
> ve daha fazla import kenarı görür (§4.3'teki kapsama açığı doğrulanmıştır).

---

## 2. F5-01–F5-11 durum tablosu

| Madde | Durum | Yapılan | Kalan |
|---|---|---|---|
| **F5-01** Test kalitesi | ⚠️ Kısmen | `api-auth-coverage`: regex kaynak taraması → AST `fetch('/api…')` tespiti; token başlığı ve 401 kimlik olayı artık **davranışsal** testle (stub `fetch`/`sessionStorage`/`window`) doğrulanıyor; servis bağımlılığı AST import kontrolü. `discover-state-boundary`: `includes()` → AST tanımlayıcı + `useState` analizi. Yeni: `tests/external-json.test.mjs`. Kapsam daraltılmadı, test silinmedi. | `tests/spec-v7-regressions`, `tests/phases-all`, `tests/phase3-ui-write-paths` hâlâ kısmen metin tabanlı; davranışsal karşılıkları henüz yazılmadı. |
| **F5-02** AST tarayıcı | ✅ Tamamlandı | Tarayıcı TypeScript Compiler API kullanıyor: statik/dinamik import, `export … from`, `import = require`, çok satırlı ve alias'lı biçimler; yorum/metin içindeki sahte importlar sayılmıyor; ihlaller `dosya:satır` ile raporlanıyor. Kurallar sürüm 2: `server-isolation`'a `app` eklendi, `modules-no-server` ve `shared-isolation` eklendi. Test: kural gevşetme, bayat allowlist, çok satırlı import regresyonu. **Allowlist boş.** | — |
| **F5-03** Ölü kod | ✅ Tamamlandı | Doğrulanarak kaldırıldı: `src/server/github-catalog-sync.ts`, `src/hooks/useAppModals.ts`, `src/services/poster-hydration-service.ts`. Envanterdeki diğer 5 dosya (`store-catalog`, `store-profile`, `sync-compare`, `sync-manifest`, `store-types`) önceki aşamalarda zaten kaldırılmıştı; tekrar doğrulandı. `voteCount` farkı **doğrulanmadı**: canlı `github-bidirectional-sync.ts` aynı `Math.max(localVotes, remoteVotes) \|\| undefined` kuralını kullanıyor; kopya davranış farkı içermiyor. | — |
| **F5-04** Core purity / ports | ✅ Tamamlandı | `src/core/ports/` (api, kv-store, encoding, series-catalog) + adaptörler (`services/core-idb-store.ts`, kendini kaydeden `api-client`/`encoding-service`/`storage-idb`, tek giriş `services/core-adapters.ts`). Saf seed verisi `core/series-tv-seeds.ts`, seri sözleşmeleri `core/series-types.ts`. Node `crypto` bağımlılığı kaldırıldı (hash/veri formatı değişmedi). **core-purity: 7 → 0.** | — |
| **F5-05** cinetrack-core bölme | ⚠️ Kısmen | 6.445 → 5.335 satır. Yeni: `core/media/document-types.ts` (171), `core/media/document-normalize.ts` (812), `core/media/backup-parse.ts` (242). Public API shim'siz korunuyor (yeniden dışa aktarım). 0 döngü, 818/818 test. | Skorlama/öneri (`buildTasteProfileV3`, `scoreCandidatesV3`), aday havuzu ve kalıcılık blokları henüz ayrı modüllerde değil. |
| **F5-06** App.tsx sadeleştirme | ❌ Yapılmadı | — | `src/App.tsx` 2.391 satır / 23 effect olarak duruyor. Davranışsal eşdeğerlik kanıtlanmadan UI orkestrasyonunu taşımak bu oturumda üstlenilmedi. |
| **F5-07** persistent-store bölme | ⚠️ Kısmen | 4.130 → 3.876 satır. `src/server/persistent-store/contracts.ts` (~288 satır): senkronizasyon sözleşmeleri, durum şablonları, HTTP/token sınıflandırıcıları. Kilit/lease/atomic-write/serialization kodu **değiştirilmedi**. | 3.800 satırlık sınıfın metot grupları ayrı modüllere bölünmedi (davranış riski). |
| **F5-08** bidi sync bölme | ❌ Yapılmadı | Denendi ve **geri alındı**: saf yardımcılar (normalize/merge/hash/inspection ~1.700 satır) ayrı modüllere taşındığında 100'ün üzerinde tip hatası oluştu (taşınan yardımcıların özel tipleri ve sınıf içi kullanım bağları). Risk kabul edilmedi; dosya değişmedi (5.118 satır). | Sınıf ve yardımcılar aynı dosyada. Ayrı bir oturumda tip sınırları sözleşmeye taşınarak yapılmalı. |
| **F5-09** Tip güvenliği | ⚠️ Kısmen | `src/server/external-json.ts`: dış JSON için bağımlılıksız guard'lar (`isPlainRecord`, `asExternalRecord`, `readString`, `readPositiveInteger`, `readFiniteNumber`, `readPositiveIntegerArray`); TMDB yanıtındaki `as Record<string, unknown>` cast'i kaldırıldı (nesne değilse "veri yok"). 4 yeni davranış testi. | ~679 `any` kullanımının büyük kısmı duruyor. `noUnusedLocals`/`noUnusedParameters` **açılmadı**: kod tabanında geniş ve ilgisiz bir değişiklik gerektiriyor (ölçüm: tsc bu bayraklarla yüzlerce hata verir). |
| **F5-10** Respan kaldırma | ✅ Tamamlandı | Kullanılmadığı doğrulandı (üretimde `createRespanTracing` çağrısı yok). `@respan/respan` bağımlılığı, `src/server/respan-telemetry.ts`, testi ve `RESPAN_API_KEY`/`RESPAN_BASE_URL` konfigürasyonu kaldırıldı; `package-lock.json` temizlendi. Diğer telemetry/loglama davranışları korundu. | — |
| **F5-11** Kalan borç taraması | ⚠️ Kısmen | AST tarayıcı ile ölü/yanlış yönlü bağımlılıklar yeniden tarandı; shim yolları belgelendi; dokümantasyon güncellendi (`PHASE_05_ARCHITECTURE.md`, bu belge, plan §7). | Çift veri modeli (`core/media/types.ts` ↔ `core/media/document-types.ts`) birleştirilmedi; `App.tsx`/bidi/persistent-store sınıfı borcu duruyor. |

---

## 3. Mimari önce/sonra

| Ölçüm | Önce | Sonra |
|---|---|---|
| `core-purity` ihlali | 7 | **0** |
| `server → app` importu | 5 | **0** |
| `modules → server` importu | 3 | **0** |
| Döngüsel import | 0 | 0 |
| Taranan dosya (AST) | 292 (regex) | **310** |
| Import kenarı | 692 yerel / 898 toplam (regex) | **1.017 yerel / 1.228 toplam** |
| `src/core/cinetrack-core.ts` | 6.445 | 5.335 |
| `src/server/persistent-store.ts` | 4.129 | 3.876 |
| `src/server/github-bidirectional-sync.ts` | 5.117 | 5.118 (değişmedi) |
| `src/App.tsx` | 2.391 | 2.391 (değişmedi) |

Kaldırılan dosyalar: `src/server/github-catalog-sync.ts`, `src/hooks/useAppModals.ts`,
`src/services/poster-hydration-service.ts`, `src/server/respan-telemetry.ts`,
`tests/respan-telemetry.test.mjs`.

Yeni dosyalar: `src/core/ports/*` (4 port), `src/core/media/{document-types,document-normalize,
backup-parse}.ts`, `src/core/series-types.ts`, `src/core/relationship-ports.ts`,
`src/services/core-adapters.ts`, `src/services/core-idb-store.ts`,
`src/server/persistent-store/contracts.ts`, `src/server/external-json.ts`,
`src/shared/runtime/*` (4), `src/shared/library-event-diff.ts`, modül portları.

---

## 4. Test ve kapı sonuçları (uygulama sonrası)

| Kapı | Sonuç |
|---|---|
| Unit (`npm test`) | **818/818** (817 − 4 Respan testi + 1 mimari + 4 dış-JSON + 1 net yeni) |
| Taste (`npm run test:taste`) | **440/440** |
| Lint + typecheck (`npm run lint`) | **0 hata / 0 uyarı** |
| Döngü (`npm run cycles`) | **0** |
| Mimari (`architecture-boundaries.mjs`) | **0 ihlal**, 0 döngü |
| Build (`npm run build`) | **başarılı** |
| Data guard | **OK — 15 dosya değişmedi** |
| E2E | **Bu oturumda koşulmadı** (CI'da Playwright işi çalışır; önceki referans 31/31) |

---

## 5. Kalan işler ve riskler

1. **F5-06 / F5-08 tamamlanmadı.** En büyük iki dosya (App.tsx, github-bidirectional-sync.ts)
   davranışsal eşdeğerlik kanıtlanmadan bölünmedi; kısmi ve riskli bir bölünme yerine
   dokümante edilmiş borç tercih edildi.
2. **F5-05 / F5-07 kısmi.** Skorlama/havuz/kalıcılık ve sınıf metot grupları hâlâ monolit.
3. **F5-01 kısmi.** Üç test dosyası hâlâ kaynak metni eşliyor; davranışsal karşılıkları
   yazılmalı (özellikle `phase3-ui-write-paths`, `phases-all`).
4. **F5-09 kısmi.** `any` temizliği ve `noUnusedLocals`/`noUnusedParameters` sonraki aşamaya
   bırakıldı; açılması geniş ve ilgisiz bir diff üretir.
5. **Çift tip modeli** (`media/types.ts` ↔ `document-types.ts`) tek kaynağa indirilmeli.
6. **Shim'ler** geçici; tüketici sıfırlandığında kaldırılmalı.
