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
