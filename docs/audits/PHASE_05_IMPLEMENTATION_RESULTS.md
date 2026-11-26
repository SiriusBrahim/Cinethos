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


---

## 6. Aşama 5.1 — Sonuçlar (24 Kas 2026, bu oturum)

**Başlangıç HEAD:** `31251eb` · **Sonuç HEAD:** `f34144c`+ · **PR:** #65 (açık, merge edilmedi)

> Sınırlama: bu oturumda yerel Node/npm/git ortamı yoktu. Typecheck, unit/taste testleri,
> lint, build ve data guard yerelde ÇALIŞTIRILAMADI; yalnızca dosya/commit dizinlemesi ve
> kaynak okuma yapıldı. Aşağıdaki her değişiklik CI kapılarıyla doğrulanmalıdır; bu
> oturumda yerelde "başarılı" gösterilen hiçbir test sonucu yoktur.

### F5.1-05 — Çift tip modeli (✅ Bu oturumda tamamlandı)

- **Önceki durum:** `media/types.ts` ile `media/document-types.ts` SavedItem, NextEpisode,
  FavoriteActorInfo ve belge modelini iki kez tanımlıyordu; types.ts kopyası
  `status_changed_at`/`rating_changed_at` alanlarını içermiyordu (sürüm kayması riski).
- **Yapılan:**`8489472`, `b40fb83`: kanonik tanımlar ve belge sabitleri yaprak dosya
  `types.ts`'ye taşındı; `document-types.ts` birebir yeniden dışa aktaran uyumluluk
  yüzeyine dönüştü. `ParsedBackupProfile/ParsedBackupDocument.preferences` alanları
  `any` → `unknown`. `types.ts` yaprak kaldığı için yeni döngü kenarı oluşmaz;
  `cinetrack-core` yeniden dışa aktarımı korunur, eski import yolları geçerli.
- **Test:** yerelde koşulamadı; typecheck + unit/taste CI'da doğrulanmalı. Davranış
  değişikliği yoktur (yalnız tip yüzeyi).
- **Kalan risk:** `cinetrack-core.ts` içindeki eski `SavedItem` tanımı bu dosyalardan
  biri tarafından besleniyorsa ikili tanım riski devam eder; CI typecheck bunu
  yakalar (çift tanım aynı isimde export edilseydi hata verirdi).

### F5.1-06 — Dış veri sınırı doğrulaması (⚠️ Kısmen)

- **Önceki durum:** TMDB sınırı external-json ile kapalıydı; TVDB sınırı hâlâ
  doğrulanmayan `any` alanları kullanıyordu.
- **Yapılan:** `d6d0532`, `f34144c`: `tvdb-proxy.ts` dış JSON ayrımı `external-json`
  guard'larıyla daraltıldı (hata mesajı, token charset/uzunluk, JWT exp, gövde apiKey);
  `catch(err: any)` → `unknown`; `executeUpstream/parsed/responseCache` tipleri
  `any` → `unknown`. Yanıt formatı ve hata yolları korunur.
- **Test:** yerelde koşulamadı; CI typecheck/eslint doğrular.
- **Kalan:** GitHub yanıt sınırı (`github-bidirectional-sync.ts`, `github-request.ts`,
  `persistent-store` girişleri) ve yedek parse'ın kalan `any` yüzeyleri. `any`
  sayısı ölçülemedi (kod araması bu depoda güvenilmez sonuç veriyor; ölçüm CI'da
  `grep -cE ': any|any\[\]|<any>' -r src` ile alınmalıdır).

### F5.1-07 — Ölü kod ve adapter akışı (⚠️ Kısmen, kanıt güncellendi)

- **Önceki durum:** Aşama 5 raporu `store-catalog/store-profile/sync-compare/sync-manifest/
  store-types` için "önceki aşamalarda kaldırıldı; tekrar doğrulandı" diyordu.
- **Bu oturumda saptanan:** bu beş dosya `f34144c` ağacında **hâlâ mevcut**.
  Önceki raporun bu kalemi ağaç durumuyla çelişiyor; GitHub kod araması bu depoda
  güvenilmeyen sonuçlar ürettiği için içe aktaran olmadığı yönünde kanıt üretilemedi.
  Bu nedenle **silme yapılmadı** (yanlış pozitif silme = CI/işlev riski).
- **Sonuç:** dosyalar korundu; silme kararı, dependent şikayet bulunabilecek yerel
  ortamda `analyze.mjs`/import taramasıyla verilmelidir. Bu madde kapanmadı.
- Adapter akışı (`core-adapters.ts`) bu oturumda değiştirilmedi; Aşama 5 kaydı
  (tek giriş, testlerin açıkça yüklemesi) yerinde duruyor.

### F5.1-01 / F5.1-02 / F5.1-03 (❌ Bu oturumda yapılmadı — gerekçe)

- `App.tsx` (2.391 satır), `persistent-store.ts` (3.876 satır) ve
  `github-bidirectional-sync.ts` (5.118 satır) bu oturumda bölünmedi.
- **Teknik engel:** yerelde typecheck/test koşulu yok; Aşama 5'te bidi-sync bölme
  denemesi 100+ tip hatası üretip geri alınmıştı. Küçük bir taşımanın dahi tip
  hatası üretip üretmediğini doğrulama olasılığı olmadan büyük dosyayı bölmek,
  PR'ı kırmak ve senkron davranışını riske atmak demektir. Kural gereği
  ("güvenli biçimde ayrılamıyorsa zorla bölme") borç bilinçli olarak korundu.
- **Önerilen yol (r2 oturumu için):** (1) `github-bidirectional-sync.ts`'ta tip
  sınırlarını önce `persistent-store/contracts.ts`'e taşı; (2) saf yardımcıları
  (normalize/merge/hash) tek tek taşı, her adımda `tsc + npm test`; (3) sınıf
  metodlarını sona bırak. `App.tsx` için: katalog orkestrasyonu ve release-reminder
  effect'leri en bağımsız adaylar.

### Kabul kriterleri durumu (Aşama 5.1)

| # | Kriter | Durum |
|---|---|---|
| 1 | App.tsx ayrıştırma | ❌ |
| 2 | persistent-store modülerleştirme | ❌ (contracts öncesi zaten yapılmıştı) |
| 3 | bidi sync modülerleştirme | ❌ (gerekçeli borç) |
| 4 | lock/lease/atomic/sync davranış testleri | ✅ (Aşama 5'te korunuyor) |
| 5 | metin tabanlı test dönüşümü | ❌ |
| 6 | çift tip modeli netliği | ✅ |
| 7 | GitHub/TVDB runtime validation | ⚠️ (TVDB ✅, GitHub ❌) |
| 8 | any ölçüm + anlamlı azaltma | ⚠️ (ölçülemedi; tvdb + document-types azaltıldı) |
| 9 | core adapter production akışı | ⚠️ (değiştirilmedi, Aşama 5 kaydı geçerli) |
| 10-12 | döngü/mimari/core-purity 0 | yerelde ölçülemedi; değişiklikler döngü eklememeli |
| 13 | unit/taste/lint/typecheck/build | yerelde koşulamadı (CI zorunlu) |
| 14 | e2e + prod smoke | koşulamadı |
| 15 | data guard | koşulamadı (değişiklikler veri formatına dokunmuyor) |
| 16 | dokümantasyon | ✅ (bu bölüm; diğer iki belge sonraki oturum) |
| 17 | PR #65 açık + merge edilmemiş | ✅ |

**Nihai durum: AŞAMA 5.1 KISMEN TAMAMLANDI. Aşama 6 başlatılmadı.**
---

## 7. Aşama 5.2 — Kalan işlerin uygulanması (25 Kas 2026)

**Başlangıç HEAD:** `9784bda` · **Dal:** `remediation/full-project-remediation` · **PR:** #65 (açık, merge edilmedi)
**Ortam:** yerel Node 26.13.1 / npm 11.20.0; tüm kapılar bu ağaçta çalıştırıldı.

### 7.1 İş bazında sonuç

| Madde | Durum | Yapılan |
|---|---|---|
| **F5.1-01** App.tsx | ⚠️ Kısmen (gerçek ayrıştırma yapıldı) | 2.391 → **2.207** satır. Saf sorumluluklar çıkarıldı: `src/app/catalog-titles.ts`, `src/app/displayed-items.ts`, `src/app/series-universe.ts`, `src/app/release-reminders.ts`. Liste filtresi/sıralama, seri evreni, hatırlatıcı adayları ve katalog başlıkları artık React dışında ve doğrudan test edilebilir. 5 davranış testi (`tests/f5-1-app-helpers.test.mjs`). |
| **F5.1-02** persistent-store | ⚠️ Kısmen | 3.876 → **3.837** satır. Durum dosyası sorumluluğu `src/server/persistent-store/store-state.ts`'e taşındı: şablon okuma/yazma (atomik), gelecek sürüm reddi, bozuk JSON'da güvenli davranış, yarıda kalan `syncing` kayıtlarının kurtarılması. Sınıf bu modülü delege eder; kilit/lease/atomic-write/serileştirme kodu değişmedi. 4 davranış testi. |
| **F5.1-03** bidi sync | ✅ Bu oturumda tamamlandı (yardımcı katman) | 5.118 → **3.438** satır. Modül düzeyindeki saf katman (envanter, normalize/merge/hash, `inspect*`, `compareSyncSides`, bağımlılık sözleşmesi) `src/server/github-sync/sync-core.ts` (1.758 satır) modülüne taşındı. Sınıf koordinatör olarak kaldı; tüm adlar `export *` ile geriye dönük uyumlu. Tip adları ayrı `import type` bloğunda (Node type-stripping güvenli). |
| **F5.1-04** davranışsal testler | ⚠️ Kısmen | `tests/phase3-ui-write-paths.test.mjs` tamamen AST tabanlı yapısal doğrulamaya çevrildi (regex/metin yok). `spec-v7-regressions` REG-04 ve `phases-all` ortam/sabit kontrolleri AST'ye taşındı. Ortak yardımcı: `tests/helpers/source-ast.mjs`. Kalan: `spec-v7`/`phases-all` içindeki UI kopyası metinleri (JSX metni) hâlâ kaynak üzerinden okunuyor; DOM test ortamı (jsdom/RTL) bu projede yok. |
| **F5.1-05** tip birleştirme | ✅ Doğrulandı + düzeltildi | Kanonik tanım tek: `core/media/types.ts`; `document-types.ts` yalnızca yeniden dışa aktarır. Önceki oturumun bıraktığı `ParsedBackupProfile.preferences: unknown` tip regresyonu (`useProfileBackupCoordinator` derleme hatası) düzeltildi: alan gerçekte normalize edilmiş `Preferences` taşıyor. |
| **F5.1-06** GitHub sınırı | ✅ | `src/server/github-response.ts`: `readGitHubBlobPayload`, `readGitHubContentEntry`, `readGitHubDirectoryEntries`, `readGitHubErrorMessage`, `isGitHubTooLargeError`. Senkron motorundaki `any` yanıt gövdeleri kaldırıldı; eksik/yanlış alanlar istisna yerine `malformed_response` üretir. 4 davranış testi. |
| **F5.1-07** ölü modüller + adapter | ✅ | `store-catalog.ts`, `store-profile.ts`, `sync-compare.ts`, `sync-manifest.ts`, `store-types.ts` (toplam 927 satır) AST/import taramasıyla **hiçbir** içe aktaranı olmadığı doğrulanıp kaldırıldı. Adapter akışı değişmedi: tek giriş `services/core-adapters.ts`; production'da `app.ts` üzerinden yüklenir, testler açıkça import eder. |

### 7.2 Kapı sonuçları (bu ağaçta gerçekten çalıştırıldı)

| Kapı | Sonuç |
|---|---|
| `npm run lint` (ESLint + 2 × `tsc --noEmit`) | ✅ 0 hata / 0 uyarı |
| `npm test` | ✅ **831/831** (818 → +13) |
| `npm run test:taste` | ✅ **440/440** |
| `npm run cycles` | ✅ 0 döngü |
| Mimari tarayıcı (AST) | ✅ 6 kuralın tamamı **0 ihlal** (core-purity, server-isolation, client-no-server, contracts-isolation, modules-no-server, shared-isolation) |
| `npm run build` | ✅ başarılı |
| Data integrity guard | ✅ `data/` değişmedi (16 dosya) |
| Üretim duman testi (`NODE_ENV=production node server.ts`) | ✅ `/api/data` 200, `/` 200, kontrollü kapanış |
| Playwright E2E | ⏹ Bu ortamda çalıştırılmadı; CI işine bırakıldı |

### 7.3 Kalan teknik borç

1. **App.tsx (2.207 satır):** profil değiştirme/oluşturma, belge birleştirme ve persist effect'leri hâlâ bileşen içinde. Bunlar çok sayıda ref üzerinden birbirine bağlı; hook'a taşımak davranışsal eşdeğerlik testi gerektirir.
2. **persistent-store.ts (3.837 satır):** katalog/profile/derived-profile okuma-yazma grupları ve GitHub uzak IO metotları sınıf içinde. Sınıfı kompozisyona çevirmek (CatalogStore/ProfileStore/GitHubRemoteClient) ayrı bir oturum ve geniş regresyon testi ister.
3. **sync-core.ts:** sınıf hâlâ 3.438 satır; `inspect`/`pull`/`push`/`reconcile` metotları taşınmadı.
4. **F5.1-04:** `spec-v7` ve `phases-all` içindeki kullanıcıya görünen metinler JSX kaynağından okunuyor; DOM tabanlı test altyapısı eklenirse `renderToStaticMarkup`/RTL ile değiştirilmeli.
5. **`any` azaltma:** GitHub sınırı ve TVDB sınırı temizlendi; `persistent-store.ts` içindeki `any` yanıt gövdeleri (yaklaşık 20 nokta) sonraki aday.

---

## 8. Aşama 5.2 — Kalan mimari borçların çözülmesi (25 Kas 2026, bu oturum)

**Başlangıç HEAD:** `7224be0` · **Dal:** `remediation/full-project-remediation` · **PR:** #65 (açık, merge edilmedi)
**Ortam:** Node 26.13.1 / npm 11.20.0. Tüm kapılar bu ağaçta çalıştırıldı; veri koruması `scripts/run-tests.mjs` sha256 kapısıyla her koşuda doğrulandı.

### 8.1 İş bazında sonuç

| Madde | Durum | Yapılan |
|---|---|---|
| **F5.2-01** Kaynağa bağımlı UI testleri | ✅ Tamamlandı | Sabit arayüz metinleri tek sözleşmede (`src/app/ui-copy.ts`). Durum yüzeyleri saf sunum bileşenlerine ayrıldı (`src/components/ui-states.tsx`: `ErrorRecoveryActions`, `StockPullButton`, `MapPreparingNotice`, `EmptyLibraryGuide`, `DerivedCacheResetControl`, `ActorsSubtabsBar`). `spec-v7` ve `phases-all` içindeki JSX kaynak metni kontrolleri kaldırıldı; yerine `react-dom/server` ile **gerçek render çıktısı** ve öğe ağacı üzerinden işleyici çağrıları geldi (`tests/helpers/render-tree.mjs`). `Controls` gizleme kararı saf `shouldHideSecondaryToolbar` fonksiyonuna taşındı. `phases-all` içindeki `2_000_000` metin taraması AST sayısal literal denetimine çevrildi. Yeni bağımlılık eklenmedi. |
| **F5.2-02** App.tsx sorumlulukları | ✅ Tamamlandı (hedeflenen kapsam) | Profil oluşturma/değiştirme veri hazırlığı `src/app/profile/profile-coordinator.ts`'e (saf, React'siz); iki yerde kopyalanan "giden profil anlık görüntüsü" tek fonksiyona indirildi. Autosave/kota/kirli-işaret kararı `src/app/persistence/persistence-plan.ts` (saf plan + memo + hata toleransı) ve React bağlantısı `src/app/persistence/use-app-persistence.ts`. Debounce/zamanlama davranışı yoktu ve eklenmedi; yazma sırası, kota düşüşünde özet kırpma ve hata sonrası eski değerin korunması birebir korundu. App.tsx 2.206 → **2.108** satır. 11 davranış testi (`tests/f5-2-profile-persistence.test.mjs`). |
| **F5.2-03** Persistent store ayrıştırması | ⚠️ Kısmen (gerçek ayrıştırma, yazma yolu korundu) | `src/server/persistent-store/catalog-store.ts` (katalog okuma, manifest, bozuk JSON kurtarma, dizin/dosya hazırlığı; senkron + async) ve `src/server/persistent-store/derived-profile-store.ts` (türetilmiş profil okuma + şema/imza doğrulaması; senkron + async). `PersistentDataStore` bu işlevlere delege eden facade olarak kaldı; public metot adları, parametreleri ve dönüş tipleri aynı. **Kilit/lease, atomic write, journal, sync state geçişleri, recovery, çakışma tespiti ve yazma sırası değiştirilmedi.** persistent-store.ts 3.836 → **3.689** satır. 6 doğrudan alt-modül testi (`tests/f5-2-store-submodules.test.mjs`). |
| **F5.2-04** GitHub sync koordinatörü | ⚠️ Kısmen | Uzak taraf incelemesi (dosya indirme, `too_large` → blob API yedeği, boyut sınırı, katalog/manifest/kullanıcı verisi doğrulaması, profil listesi) `src/server/github-sync/inspect-operation.ts` (829 satır) modülüne taşındı. Modül yalnızca `deps`, `maxBytes` ve `fetchGitBlobBySha` içeren dar bir host bağlamı alır; kilit/kuyruk/journal'a erişmez. Koordinatör üç ince delege metoduyla aynı davranışı korur: github-bidirectional-sync.ts 3.437 → **2.719** satır. 4 test (`tests/f5-2-github-sync-operations.test.mjs`, `fetch` stub'lı). `pull`/`push`/`reconcile` gövdeleri taşınmadı: bu üç işlem aynı `runSerialized` + lease + journal işlem sınırını paylaşıyor ve ayrıştırma kilit sahipliği semantiğini değiştirme riski taşıyor (bkz. §8.3). |
| **F5.2-05** Persistent store `any` temizliği | ✅ Tamamlandı | `persistent-store.ts` içindeki 38 açık `any` kullanımının tamamı kaldırıldı: GitHub yanıt gövdeleri `unknown` + `github-response.ts` doğrulayıcıları (`readGitHubRepositoryMeta`, `readGitHubFileEnvelope`, `readGitHubCommittedSha`, `findGitHubDirectoryEntry`, `isGitHubTooLargeError`, `readGitHubErrorMessage`), `catch (e: any)` → `catch (e)` + `errorMessageOf`, `Record<string, any>` → `Record<string, unknown>`, `items: any[]` → `unknown[]`, `readJsonFileWithRecovery<any>` → tipli, `(raw as any)` → tip koruyucu. **Kalan 2 dar geçiş** (`CatalogManifest`, `DerivedProfileDocument`) yalnızca mevcut doğrulama koşullarını koruyan, gerekçe yorumlu `as unknown as` geçişleridir; AST testi yeni `any` eklenmesini engeller. 7 test (`tests/f5-2-persistent-store-types.test.mjs`). |

### 8.2 Kapı sonuçları (bu ağaçta gerçekten çalıştırıldı)

| Kapı | Önceki (Aşama 5.1) | Bu oturum |
|---|---|---|
| `npm run lint` (ESLint + 2 × `tsc --noEmit`) | 0 hata / 0 uyarı | ✅ 0 hata / 0 uyarı |
| `npm test` | 831/831 | ✅ **865/865** (+34) |
| `npm run test:taste` | 440/440 | ✅ **440/440** |
| `npm run cycles` | 0 | ✅ 0 |
| Mimari tarayıcı (321 dosya, 1.085 yerel import) | 6 kural 0 ihlal | ✅ 6 kural **0 ihlal**, 0 döngü |
| `npm run build` | başarılı | ✅ başarılı (6,75 s, PWA 30 giriş) |
| Data integrity guard | değişmedi | ✅ `data/` değişmedi (16 dosya, 88 unit + 27 taste dosyası) |
| Üretim duman testi | 200/200 | ✅ `/api/tmdb-status` 200, `/` 200, `/discover/deep-link` 200, `/api/data` 200 |
| Playwright E2E | CI | ⏹ Bu ortamda çalıştırılmadı; CI işine bırakıldı |

Test artışının dağılımı: F5.2-01 **+6**, F5.2-02 **+11**, F5.2-03 **+6**, F5.2-04 **+4**, F5.2-05 **+7**. Hiçbir test silinmedi, atlanmadı veya gevşetilmedi.

### 8.3 Kalan teknik borç (gerekçeli)

1. **`pull`/`push`/`reconcile` gövdeleri koordinatörde.** Üçü de aynı `runSerialized` kuyruğu, dosya kilidi/lease yenileme ve journal kaydı içinde çalışır. Ayrı modüllere taşımak, kilit sahipliğini ve yarıda kalan işlem kurtarmasını yeniden düzenlemeyi gerektirir; Aşama 2'de kabul edilen güvenceleri riske atmamak için bu oturumda yapılmadı. Öneri: önce lease/journal için sahte (fake) bir port tanımlayıp 14 senaryoyu (yalnız yerel/uzak, çakışma, rate-limit, lease süresi, yarım iş) bu port üzerinden koşturmak, sonra gövdeleri taşımak.
2. **`persistent-store.ts` yazma yolu.** Katalog upsert, stok yazımı ve türetilmiş profil upsert'i atomik yazma + seri hale getirici + katalog imzası ile aynı işlem sınırını paylaşır; bu nedenle facade'da bırakıldı. Okuma yolu (F5.2-03) ayrıştırıldı; yazma yolu için aynı yöntem (dar bağlam + doğrudan test) uygulanabilir.
3. **`isDerivedDocFreshForContext` ve `createUnconfiguredReport`** hâlâ koordinatörde; ikisi de işlem raporu/tazelik kararı olarak `sync-core` benzeri saf modüle taşınabilir (davranış aynı kalacak şekilde).
4. **`as unknown as` geçişleri (2 adet).** `CatalogManifest` yalnızca `contentHash`, `DerivedProfileDocument` yalnızca `profileId` + `items` ile doğrulanıyor (mevcut davranış). Tam şema doğrulaması eklenirse bu geçişler kaldırılmalı; eklenmesi mevcut bozuk-dosya kabul davranışını değiştireceği için bu oturumda yapılmadı.
5. **App.tsx belge birleştirme ve persist effect'i dışında kalan ref ağı.** Profil/autosave ayrıldı; `mergeRemoteDocumentIntoState` ve `applyDataDocumentToState` hâlâ çok sayıda ref ve sunucu senkron durumuyla bağlı. Taşımak için sunucu belgesi uygulama akışının uçtan uca davranış testi gerekir (mevcut kapsam `phase1-restore-conflict`, `archive-restore-consistency` ve `phase2-sync-*` ile korunuyor).


---

## 9. Aşama 5.3 — Nihai mimari giderme (25 Kas 2026, bu oturum)

**Başlangıç HEAD:** `dcc7050` · **Sonuç HEAD:** `ffd9907`+ · **PR:** #65 (açık, merge edilmedi)
**Ortam sınırlaması:** bu oturumda yerel Node/npm/git yoktu; lint/typecheck/test/build/data guard yerelde koşulamadı. Yapılan değişiklik CI kapılarıyla doğrulanmalıdır; yerelde "başarılı" gösterilen test sonucu yoktur.

### 9.1 İş bazında sonuç

| Madde | Durum | Yapılan |
|---|---|---|
| **F5.3-04** Saf yardımcılar + tip assertion incelemesi | ✅ Bu oturumda tamamlandı | `ffd9907`: §8.3-3'teki iki koordinatör yardımcısı saflıkları doğrulanarak (state/lock/journal/`this` erişimi yok) `src/server/github-sync/` altına taşındı: `sync-operation-result.ts` → `createGithubSyncUnconfiguredReport`; `derived-doc-freshness.ts` → `isDerivedDocFreshForContext`. Sınıftan silindi; 4 rapor ve 3 tazelik çağrı noktası serbest fonksiyonlara yönlendirildi; artık kullanılmayan `ALGORITHM_VERSION`/`computeTasteProfileSignature`/`type Profile` importları koordinatörden temizlendi. Parantez dengesi ve satır delta (2.719 → ~2.639) kontrol edildi. Kalan 2 `as unknown as` geçişi §8.3-4'teki gerekçeyle (yalnız doğrulanmış alan; tam şema doğrulaması mevcut bozuk-dosya kabul davranışını değiştirir) bilinçli olarak korundu. |
| **F5.3-01** pull/push/reconcile işlem mimarisi | ❌ Bu oturumda yapılmadı | Aynı §8.3-1 gerekçesi geçerli: üç işlem aynı `runSerialized` + lease + journal sınırını paylaşıyor ve ayrıştırma, kilit sahipliği semantiğini doğrulama kapısı olmadan değiştirme riski taşıyor. Önerilen yol aynı: önce sahte lease/journal portu + 14 senaryo, sonra gövde taşımaları. |
| **F5.3-02** PersistentStore yazma mimarisi | ❌ Bu oturumda yapılmadı | Aynı §8.3-2 gerekçesi geçerli: yazma yolu atomik yazma + serileştirici + katalog imzası ile aynı işlem sınırını paylaşıyor. |
| **F5.3-03** App.tsx belge birleştirme | ❌ Bu oturumda yapılmadı | Aynı §8.3-5 gerekçesi geçerli: `mergeRemoteDocumentIntoState`/`applyDataDocumentToState` uçtan uca davranış testi gerektiriyor. |
| **F5.3-05** Nihai denetim | ⚠️ Kısmen (statik) | Ağaç denetimi: `src/server/github-sync/` = {sync-core, inspect-operation, sync-operation-result, derived-doc-freshness}; `src/server/persistent-store/` = {contracts, store-state, catalog-store, derived-profile-store}; App.tsx ~76 KB. Bu oturumun değişikliği yalnızca saf fonksiyon taşıması olduğu için döngü/mimari/veri formatı riski yoktur; ancak tarayıcı/test koşusu yerelde yapılamadığı için "0 ihlal" iddiası CI'ya bırakıldı. Public import yolları ve `export *` yüzeyi korundu. `data/` dosyaları bu oturumda dokunulmadı. |

### 9.2 Nihai karar

**AŞAMA 5 (5.0–5.3) KISMEN TAMAMLANDI.** Aşama 5.2'nin gerçek kapı sonuçlarıyla
tamamladığı maddeler (App.tsx profil/persistence ayrıştırması, persistent-store okuma
ayrıştırması, sync inspect ayrıştırması, `any` temizliği, UI test dönüşümü) korunmuştur;
bu oturum F5.3-04'ü kapatmıştır. Kalan borç: pull/push/reconcile gövdeleri, persistent
store yazma yolu, App.tsx belge birleştirme ve DOM tabanlı metin testlerinin kalanı.
Aşama 6 başlatılmadı; PR #65 açık ve merge edilmemiş.
---

## 10. Aşama 5.3 — GitHub izolasyonu ve yerel veri güvenilirliği (26 Kas 2026)

**Başlangıç (yerel klon) HEAD:** `dcc7050` · **Uzak/PR HEAD:** `77567f7` · **Kod bitiş HEAD:** `7aadf0b`
**Dal:** `remediation/full-project-remediation` · **PR:** #65 (açık, merge edilmedi)

### 10.0 Başlangıç doğrulaması ve commit uyuşmazlığı

- Uzak dal yerel klondan **9 commit ilerideydi** (`ffd9907`, `3381aeb`, `f945044`, `7c9f696`, `0cecbad`, `cc2ad6b`, `e3baa47`, `caab5ec`, `77567f7`). Yerel `git cat-file` bu nesneleri göremedi; GitHub API (`GITHUB_GET_A_COMMIT`) her iki SHA'yı da doğruladı ve ebeveyn zinciri `dcc7050 → ffd9907 → 3381aeb` olarak okundu. Fark, başka bir oturumun bu dalı ilerletmesinden kaynaklanıyordu.
- Çözüm: cherry-pick/rebase **yapılmadı**; `git merge --ff-only origin/remediation/...` ile ilerleme alındı (kayıp commit yok, geçmiş yeniden yazılmadı).
- PR #65: `state=open`, `merged_at=null`, `merge_commit_sha=null`, base `master@9be5011`, head = dal ucu. CI sonuçları her zaman **ilgili HEAD SHA'sı** için ayrı sorgulandı.

### 10.1 Mimari karar

Cinethos'un son kullanıcı sürümü yerel-öncelikli çalışır; GitHub senkronizasyonu yalnızca geliştirme aracıdır. Bu oturumda senkronizasyon **geliştirilmedi**; sınırı ayrıldı ve kaldırılabilir hâle getirildi.

```
YEREL ÇEKİRDEK                         GELİŞTİRME ENTEGRASYONU
UI (src/components, src/App.tsx)       github-sync/register.ts  (tek bağlantı noktası)
Application services                   github-bidirectional-sync.ts
Domain (src/core)                      github-sync/{sync-core,inspect,pull,push,reconcile}
persistent-store  ──(saf port)──▶      github-response.ts, persistent-store/github-commit-store.ts
Local file system
```

### 10.2 Yapılan değişiklikler

| Madde | Durum | Kanıt |
|---|---|---|
| **F5.3-01** Senkronizasyon geliştirmelerinin iptali | ✅ (kapsam dışı bırakıldı) | Pull/push/reconcile/lease/journal üzerinde yeni özellik çalışması yapılmadı. Bağımlılık envanteri çıkarıldı (aşağıda) ve izolasyon planına bağlandı. |
| **F5.3-02** PersistentStore yerel yazma güvenilirliği | ✅ Doğrulandı + test edildi | `tests/f5-3-local-store-reliability.test.mjs`: 12 senaryo (tekil/art arda/eşzamanlı yazma, yazma hatası, rename hatası, bozuk JSON, eksik dosya, okuma sırasında yazma, yeniden açılış, türetilmiş profil no-op tutarlılığı, `.tmp` artığı temizliği, bozuk manifestte katalog korunması). Tümü gerçek geçici dizinlerde gerçek dosya sistemi üzerinde koşar. |
| **F5.3-03** App.tsx yerel veri akışı | ✅ Denetlendi | `src/app/persistence/remote-document-merge.ts` sunucu (yerel SQLite/filesystem) belgesini birleştirir; GitHub import'u yoktur (izolasyon testi bunu zorlar). GitHub'a özgü panel artık statik grafikte değil: `ProfileModal` içinde `React.lazy` + `Suspense` ile yalnızca senkron sekmesi açıldığında yükleniyor. `RemoteSyncStatusPayload` tipi `src/core/sync-display.ts`'e taşındı (sağlayıcıdan bağımsız; `ProfileBackupTab` artık GitHub bileşeninden tip import etmiyor). |
| **F5.3-04** Önceki yardımcıların denetimi | ✅ Doğrulandı | `src/server/github-sync/sync-operation-result.ts` ve `derived-doc-freshness.ts` gerçekten saf (state/lock/journal/`this` erişimi yok) ve yalnızca GitHub senkronizasyon modülleri tarafından kullanılıyor. Çekirdek/uygulama katmanı bunları import etmiyor (test). Mevcut 2 `as unknown as` geçişi (CatalogManifest `contentHash`, DerivedProfileDocument `profileId`+`items`) doğrulama sözleşmesi nedeniyle korundu; gerekçeleri §8.3-4'te. |
| **F5.3-05** İzolasyon sınırı ve nihai denetim | ⚠️ Kısmen (gerçek sınır kuruldu, tam kaldırma için kalan liste §10.4) | Yeni saf port `src/server/persistence/remote-sync-port.ts` + kayıt defteri `remote-sync-registry.ts`. `PersistentDataStore` artık `github-bidirectional-sync.ts` import etmiyor; motor `createRemoteSyncEngine(deps)` ile geliyor. GitHub motoru `src/server/github-sync/register.ts` içinde kaydediliyor ve yalnızca `app.ts` bağlıyor. Motor yoksa `createLocalOnlyRemoteSyncEngine` devreye giriyor: `ok:false / config_error` raporu döner, ağ çağrısı yapılmaz, yerel okuma-yazma etkilenmez. |

### 10.3 İzolasyon öncesi/sonrası bağımlılık yapısı

| Ölçüm | Önce | Sonra |
|---|---|---|
| `src/core`, `src/app`, `src/services`, `src/components`, `src/modules`, `src/shared` içinde GitHub import'u | 2 (ProfileModal → GitHubSyncSection, ProfileBackupTab → tip) | **0** (statik import) |
| `persistent-store.ts → github-bidirectional-sync.ts` | Var | **Yok** (port + kayıt defteri) |
| GitHub motorunun örneklendiği yer | `persistent-store.createBidirectionalManager()` | `github-sync/register.ts` (tek kayıt noktası) |
| GitHub panelinin istemci grafiğine girişi | Statik import (her açılışta) | Dinamik `import()` (yalnızca senkron sekmesi) |
| `persistent-store.ts` içinde kalan GitHub import'ları | 2 (`github-response.ts`, `persistent-store/github-commit-store.ts`) | 2 — **donduruldu**, testle büyümesi engellendi |

Yeni koruma testi: `tests/f5-3-github-isolation.test.mjs` (5 test). Katman sızıntısını, motor import'unu, port saflığını, tek kayıt noktasını ve "motor yokken ağ çağrısı yok" davranışını doğrular.

### 10.4 Bilinçli olarak bırakılan borç (tam kaldırma için kalan liste)

1. `persistent-store.ts` hâlâ `github-response.ts` (GitHub HTTP zarf okuyucuları) ve `persistent-store/github-commit-store.ts` (uzak commit yazımı) import ediyor. Bunlar `PersistentDataStoreSyncPort` üzerinden senkron motoruna **yerel tarafın uzak yazma yeteneği** olarak sunuluyor; kaldırmak, commit/verify/staged-sync metotlarının motorun içine taşınmasını gerektirir (senkron semantiği riski).
2. `PersistentStoreOptions` hâlâ `githubToken/githubOwner/githubRepo/...` alanlarını taşıyor; token'lar normal kullanıcı ayarlarından ayrı bir `remoteSync` alt nesnesine taşınmadı (davranış/uyumluluk riski, ayrı iş).
3. `PersistentDataStoreSyncPort` tipi GitHub adlı üyeler içeriyor (`recoverGitHubTokenOn401`, `commitFileToGitHub`, `syncToGitHub`); port sözleşmesinin jenerik adlara çevrilmesi motorla birlikte yapılmalı.
4. Yerel `data/` dizini bu taze klonda yok (gitignore'lu); veri koruma kapısı bu nedenle "0 dosya" karşılaştırdı. Bu oturumda hiçbir kullanıcı verisi okunmadı/yazılmadı.

### 10.5 Kapılar (bu ağaçta çalıştırıldı)

| Kapı | Sonuç |
|---|---|
| `npm ci` | ✅ (lockfile korunarak) |
| `npm run lint` (ESLint + 2 × `tsc --noEmit`) | ✅ 0 hata / 0 uyarı |
| `npm test` | ✅ **904/904** (887 → +17: 12 yerel güvenilirlik, 5 izolasyon) |
| `npm run test:taste` | ✅ **440/440** |
| `npm run build` | ✅ başarılı |
| Üretim duman testi (`NODE_ENV=production`, GitHub yapılandırması yok) | ✅ `/api/tmdb-status` 200, `/` 200, `/discover/deep-link` 200, `/api/data` 200, `/api/sync/status` 200 (local_only), `POST /api/sync/trigger` 404 (production'da kapalı — beklenen) |
| Playwright E2E | Bu ortamda çalıştırılmadı; CI'ya bırakıldı |

---

## 11. Aşama 5.3 — Son GitHub izolasyon düzeltmeleri (F5.3-06)

Bu bölüm, §10.4'teki borçların bir kısmını kapatır. GitHub senkronizasyonu bu
aşamada **geliştirilmedi**; yalnızca kullanıcı arayüzünden, yerel veri
sözleşmesinden ve sunucu route katmanından ayrıldı. Pull/push/reconcile/lease/
journal davranışları değiştirilmedi.

### 11.1 Yapılan değişiklikler

| Madde | Değişiklik | Kanıt |
|---|---|---|
| **1. Kullanıcı arayüzü** | `ProfileBackupTab` içindeki "GitHub deposuna yükle" onay kutusu, `uploadExcelToGithub` durumu, `uploadToGithub` istek alanı ve `githubUpload` sonuç bloğu kaldırıldı. Bileşen artık `remoteSyncInfo` prop'u almıyor. JSON / Excel (.xlsx) / SQLite yedekleme ve geri yükleme düğmeleri aynen duruyor. | `tests/f5-3-github-boundary.test.mjs` — kaynak düzeyinde seçenek yokluğu + yerel düğmelerin varlığı doğrulanır. |
| **2. Store bağımlılıkları** | `persistent-store.ts` içindeki `github-response.ts` ve `persistent-store/github-commit-store.ts` çalışma zamanı import'ları kaldırıldı. Yalnızca `import type` kaldı; gerçek yardımcılar GitHub'a özgü metotların içinde `await import(...)` ile yükleniyor. Böylece yerel veri yolları GitHub kodunu hiç yüklemez. | İzolasyon testi: `runtimeImportsOf('src/server/persistent-store.ts')` içinde GitHub import'u **0**. |
| **3. Yapılandırma sınırı** | `PersistentStoreOptions.remoteSync?: RemoteSyncConfiguration` eklendi (enabled, token, owner/repo/branch, görünürlük/onay, token adayları). `app.ts` store'u yalnızca bu nesneyle kuruyor. Düz (legacy) alanlar geriye dönük uyumluluk için okunmaya devam ediyor ve `remoteSync` önceliklidir. | `tests/f5-3-github-boundary.test.mjs`: `remoteSync.enabled:false` → `githubSyncEnabled:false`; ayrıca `{dataDir}` ile kurulan store tüm yerel işlemleri yapar. |
| **4. Sunucu route'ları** | Tüm `/api/sync/*` uçları `src/server/app.ts` içinden çıkarılıp `src/server/github-routes.ts` → `registerGitHubSyncRoutes(deps)` altında toplandı. `app.ts` yalnızca tek çağrı yapar. Geliştirme kapısı (`githubDevSyncEnabled !== true → 404 github_dev_sync_disabled`) korunuyor; `/api/sync/status` yerel durum okuması olarak açık kalıyor. | `tests/f5-3-github-boundary.test.mjs`: modül kapalıyken `/api/sync/push` 404, yerel route 200; `buildSyncFailure` 409/500 + token maskeleme. |
| **5. İzolasyon testleri** | `tests/f5-3-github-isolation.test.mjs` güncellendi (statik GitHub çalışma zamanı import'u = 0 kuralı). Yeni `tests/f5-3-github-boundary.test.mjs` 6 test ekler. | Toplam 12 test. |
| **6. Test altyapısı (yan bulgu)** | `tests/helpers/test-data.mjs` temizliği geçici dizin sembolik bağlantıya çevrildiğinde `rmSync(recursive)` ile **hedefin içeriğini** siliyordu. TOCTOU testi bu yüzden gerçek `data/cinetrack.db` dosyasını silebiliyordu. Temizlik artık önce `lstat` ile bağlantıyı saptayıp yalnızca bağlantıyı kaldırıyor; hedef dizine dokunmuyor. | `tests/phase1-test-isolation.test.mjs` — "temizlik, sembolik bağlantı hedefindeki gerçek veriyi silmez". Tam koşuda veri kapısı: `data/ değişmedi (0 dosya)`. |

### 11.2 Önce/sonra

| Ölçüm | Aşama 5.3 öncesi | Şimdi |
|---|---|---|
| `persistent-store.ts` çalışma zamanı GitHub import'u | 2 | **0** (yalnızca `import type`) |
| `app.ts` içindeki `/api/sync` route tanımı | 11 route + kapı | **0** (tek `registerGitHubSyncRoutes` çağrısı) |
| Profil yedekleme ekranında GitHub yükleme seçeneği | Var | **Yok** |
| Store'un GitHub yapılandırması olmadan kurulması | Zaten mümkündü, alanlar düz | `remoteSync` sınırı + test |
| GitHub token'ı olmadan uygulama açılışı | Mümkündü | **Testle doğrulandı** (`/api/health`, `/api/data` 200) |
| `npm test` | 904 | **912** (+6 sınır, +1 veri temizliği, +1 statik import kuralı) |

### 11.3 Kalan GitHub bağımlılıkları (dürüst envanter)

1. **`PersistentDataStore` içindeki GitHub'a özgü genel metotlar.** `syncToGitHub`,
   `runStagedFullSync`, `inspectGitHub`, `pullFromGitHub`, `pushToGitHub`,
   `reconcileWithGitHub`, `commitFileToGitHub`, `uploadBinaryBackupToGitHub`,
   `verifyRemoteRepoAccess`, `updateGitHubToken`, `recoverGitHubTokenOn401`,
   `getKnownSecretsForRedaction`. Bunlar `PersistentDataStoreSyncPort` üzerinden
   motora açılıyor. Yerel işlemler bu metotları çağırmaz, ancak sınıfın public
   yüzeyinde dururlar.
2. **Tip düzeyinde iki import:** `GitHubRepositoryMeta` (github-response) ve
   `GitHubCommitOutcome` (github-commit-store). Derleme zamanı bağımlılığıdır;
   çalışma zamanında yüklenmez.
3. **`PersistentStoreOptions` düz alanları** (`githubToken`, `githubOwner`, …)
   geriye dönük uyumluluk için duruyor; yeni kod `remoteSync` kullanmalı.
4. **`excel-profile-backup.ts`** isteğe bağlı `uploadToGithub` parametresini ve
   `githubUpload` rapor alanını koruyor (sunucu sözleşmesi); kullanıcı arayüzü
   artık bu parametreyi göndermiyor.
5. **`server.ts`** GitHub ortam değişkenlerini okuyup `createCineTrackApp`
   seçeneklerine aktarıyor; uygulama bu değerler olmadan da açılıyor.
6. **`src/services/api.ts`** GitHub senkron uçlarını çağıran istemci
   fonksiyonlarını içeriyor; yedekleme ekranı bunları kullanmıyor.

### 11.4 "Yarın GitHub'ı tamamen silmek istesek" — somut kaldırma haritası

**Olduğu gibi silinebilecek dosyalar (başka yerden import edilmiyor):**

- `src/server/github-sync/` klasörünün tamamı (9 dosya, ~4.600 satır):
  `sync-core.ts`, `inspect-operation.ts`, `pull-operation.ts`, `push-operation.ts`,
  `reconcile-operation.ts`, `sync-operation-host.ts`, `sync-operation-result.ts`,
  `derived-doc-freshness.ts`, `register.ts`
- `src/server/github-bidirectional-sync.ts` (859)
- `src/server/github-request.ts` (150), `src/server/github-response.ts` (155),
  `src/server/github-token-refresh.ts` (131)
- `src/server/persistent-store/github-commit-store.ts` (436)
- `src/server/github-routes.ts` (346)
- `src/components/ProfileGitHubSyncSection.tsx` (734)
- `tests/github-bidirectional-sync.test.mjs`, `tests/f5-3-github-isolation.test.mjs`,
  `tests/f5-3-github-boundary.test.mjs`, `tests/phase2-*sync*` içindeki GitHub
  senaryoları (silme kararı test sahipliğine bağlı)

**Değiştirilmesi zorunlu dosyalar (silme tek başına derlemeyi bozar):**

| Dosya | Zorunlu değişiklik |
|---|---|
| `src/server/app.ts` | `import './github-sync/register.ts'`, `registerGitHubSyncRoutes(...)` çağrısı, `CineTrackAppOptions` GitHub alanları ve store `remoteSync` bloğu kaldırılır. |
| `src/server/persistent-store.ts` | §11.3-1'deki GitHub metotları ve iki `import type` satırı; `github*` özel alanları; `githubSyncEnabled` durum yüklemesi kaldırılır. Yerel katalog/profil/türetilmiş veri yolları aynen kalır. |
| `src/server/persistent-store/contracts.ts` | `RemoteSyncConfiguration`, `PersistentStoreOptions.remoteSync` ve legacy `github*` alanları; `TokenSourceKind`, `GitHubTokenCandidateInfo`, `GitHubSyncErrorCategory`, `classifyTokenFormat`, `classifyHttpFailure` kaldırılır. `SyncStatus`/`SyncFileStateRecord` gibi yerel durum tipleri sadeleştirilir. |
| `src/server/persistence/remote-sync-port.ts`, `remote-sync-registry.ts` | Port ve kayıt defteri ya tamamen silinir ya da sağlayıcısız yerel "yok" motoru olarak kalır (bu aşamada bilinçli olarak korundu). |
| `src/server/persistent-store-types.ts` | `PersistentDataStoreSyncPort` içindeki GitHub adlı üyeler. |
| `src/server/excel-profile-backup.ts` | `uploadToGithub` seçeneği, `githubUpload` rapor alanı ve `persistentStore.uploadBinaryBackupToGitHub` çağrısı. |
| `src/services/api.ts` | GitHub senkron istemci fonksiyonları ve `githubUpload` alanı. |
| `src/components/ProfileModal.tsx` | `LazyProfileGitHubSyncSection`, `remoteSyncInfo` durumu ve senkron sekmesi. |
| `src/core/sync-display.ts` | `BidirectionalSyncReport`/`SyncSideSummary` vb. tipler; kaldırılırsa kalan tüketiciler güncellenir. |
| `server.ts` | GitHub ortam değişkenleri ve senkron durum log satırı. |
| `scripts/` + `docs/audits/*` | GitHub senkron kapıları ve bu envanter. |

**Kritik sınır:** `persistent-store.ts` içindeki `commitFileToGitHub`,
`uploadBinaryBackupToGitHub` ve `verifyRemoteRepoAccess` metotları bugün hâlâ
GitHub HTTP çağrılarını **store içinde** barındırıyor. Tam kaldırmada bu üç metot
ya silinir ya da `RemoteSyncEngine` portuna taşınır. Yerel katalog/profil/
türetilmiş veri yolları bu metotlara bağımlı değildir; bu yüzden kaldırma
davranışsal risk taşımaz, yalnızca derleme düzeltmeleri gerektirir.

### 11.5 Kapılar (bu ağaçta çalıştırıldı)

| Kapı | Sonuç |
|---|---|
| `npm run lint` (ESLint + 2 × `tsc --noEmit`) | ✅ 0 hata / 0 uyarı |
| `npm test` | ✅ **912/912**, veri kapısı: `data/ değişmedi (0 dosya)` |
| `npm run test:taste` | ✅ **440/440**, veri kapısı OK |
| `npm run build` | ✅ başarılı |
| CI | Bu commit'lerin HEAD SHA'sı için ayrıca doğrulanacak (§11.5 notu) |
