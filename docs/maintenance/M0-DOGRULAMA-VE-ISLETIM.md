# Cinethos — M0 Bakım Analizi: Doğrulama ve İşletim

**Durum:** M0 (salt okunur gözlem) tamamlandı — `agent-2/maintenance-bot`
**Kapsam:** Analiz altyapısının güvenilirliği. Otomatik onarım, bot commit'i, PR üretimi ve merge **etkin değildir**.
**Plan:** [`OTOMATIK-KOD-BAKIM-ONARIM-PLANI.md`](./OTOMATIK-KOD-BAKIM-ONARIM-PLANI.md)

---

## 1. Bileşenler

| Dosya | Görev |
|---|---|
| `.github/workflows/maintenance.yml` | Salt okunur M0 workflow'u (PR, gece zamanlaması, manuel). Aksiyonlar tam commit SHA'sına sabit. |
| `scripts/maintenance/analyze.mjs` | Lint/tsc/test/build/audit + mimari ölçümünü tek raporda birleştirir; `report.md`, `report.json`, `logs/`. |
| `scripts/maintenance/architecture-boundaries.mjs` | Import sınırı tarayıcısı. `.ts .tsx .mts .cts .js .jsx .mjs .cjs`, çok satırlı import, side-effect import, `import()` ve `require()`. |
| `scripts/maintenance/architecture-guard.mjs` | Baseline farkı ve kural bütünlüğü yardımcıları. |
| `scripts/maintenance/architecture-baseline.json` | Yalnızca **önceden var olan** ihlallerin gerekçeli istisna listesi. |
| `scripts/maintenance/architecture-rules.json` / `.lock.json` | Kurallar + SHA-256 ve zorunlu yasak kümeleri kilidi. |
| `scripts/maintenance/check-architecture.mjs` | CI mimari kapısı (`npm run check:architecture`). |
| `scripts/maintenance/risk-classifier.mjs` + `risk-policy.json` | Bulguları R0/R1/R2 olarak etiketler; otomatik düzeltme yetkisi vermez. |
| `scripts/maintenance/report-diff.mjs` | Faz 3 öncesi/sonrası rapor karşılaştırması. |
| `docs/maintenance/baselines/m0-pre-faz3.json` | Faz 3 öncesi (master `148c95d`) M0 baseline anlık görüntüsü. |
| `tests/maintenance/maintenance-bot.test.mjs` | Tarayıcı, baseline, kural kilidi, verdict, risk ve CLI regresyon testleri. |

## 2. Doğrulanan eski sorunlar ve düzeltmeler

| # | Eski sorun | Doğrulama | Düzeltme |
|---|---|---|---|
| 1 | Tarayıcı yalnızca `.ts/.tsx/.mts/.cts` tarıyordu | `listSourceFiles` uzantı filtresi .js/.mjs/.cjs içermiyordu | Uzantı kümesi genişletildi; `extensionCounts` raporda |
| 2 | Mimari tarama hatası genel sonucu PASS'tan alıkoymuyordu | `verdict` yalnızca kontrol çıkış kodlarına bakıyordu | `computeVerdict`: tarama yok → `INCOMPLETE`, tarama hatası → `ERROR`; çıkış kodu 0 değil |
| 3 | Çok satırlı importlar atlanıyordu | Satır bazlı regex `} from '...'` satırını kaçırıyordu | Deterministik ifade tarayıcısı; 754 yerel kenar (önce 534) ve **2 ek önceden var olan ihlal** bulundu |
| 4 | Test çıktısı ayrıştırılamadığında başarılı sonuç | `parseNodeTest` özet yoksa da PASS üretiyordu | Özet yoksa hata → zorunlu kontrolde `INCOMPLETE`, çıkış kodu 1 |
| 5 | Rapor eksik/hatalı analizi başarı gösterebiliyordu | `SKIP`/ayrıştırma hatası verdict'e girmiyordu | `SKIP` (isteğe bağlı olmayan) ve `INCOMPLETE` → `INCOMPLETE`; PASS yalnızca tam analizde |
| 6 | Actions sürümleri mutable tag'e bağlıydı | `@v4` etiketleri | `checkout@11bd719…` (v4.2.2), `setup-node@49933ea…` (v4.4.0), `upload-artifact@ea165f8…` (v4.6.2) |
| 7 | Mevcut ve yeni ihlal ayrılmıyordu | Tüm ihlaller aynı listede raporlanıyordu | `architecture-baseline.json` + `check-architecture` (yeni ihlal FAIL, düzeltilen istisna "stale") |
| 8 | Kuralların sessizce gevşetilmesi mümkündü | Kural dosyası serbestçe düzenlenebiliyordu | `architecture-rules.lock.json` (SHA-256 + zorunlu katman/paket/builtin kümeleri) |

### Tarama sırasında ortaya çıkan ek bulgular

- **2 ek önceden var olan core-purity ihlali** (çok satırlı importlar): `src/core/relationship-explorer.ts` → `../services/storage-idb.ts` ve `../services/series-tv-seeds.ts`. İlk raporda görünmüyorlardı; baseline'a gerekçeleriyle eklendi, **düzeltilmedi** (R2).
- **2 döngüsel import** (önceden de vardı, çok satırlı importlar nedeniyle görünmüyordu): `persistent-store.ts ↔ github-bidirectional-sync.ts` ve `relationship-wordlists.ts ↔ relationship-explorer.ts`. M0 yalnızca raporlar; zorunlu kapı değildir (M3 kapsamı).

## 3. Çalışma biçimleri

| Tetikleyici | Davranış |
|---|---|
| `pull_request` (main/master) | Tam analiz + baseline karşılaştırması; mimari kapı ve bot öz-testleri önce çalışır. |
| `schedule` (03:00 UTC) | Aynı tam analiz; bağımlılık/güvenlik taraması dahil. |
| `workflow_dispatch` → `analysis: full` | Manuel tam analiz (Faz 3 sonrası da kullanılabilir). |
| `workflow_dispatch` → `analysis: post-faz3` | Baseline dosyası yoksa iş başarısız olur; varsa yeni/düzelen ihlaller ve risk sınıfları raporlanır. |
| Yerel | `node scripts/maintenance/analyze.mjs --compare docs/maintenance/baselines/m0-pre-faz3.json` |

Raporlar: `maintenance-report/report.md` (Actions özetiyle aynı), `report.json`, `logs/*.log`, ayrıca `maintenance-report` artifact'ı (30 gün).

## 4. Faz 3 sonrası karşılaştırma

Faz 3 master'a alındıktan sonra:

```bash
npm ci
npm run check:architecture
npm run test:maintenance
node scripts/maintenance/analyze.mjs \
  --report-dir maintenance-report \
  --compare docs/maintenance/baselines/m0-pre-faz3.json
```

Raporun **5. bölümü** şunları verir: yeni mimari ihlalleri (dosya:satır, kural, hedef, risk, otomatik düzeltmeye uygunluk), düzelen ihlaller (istisnadan çıkarılması gerekenler), kötüleşen/düzelen kontroller. Baseline Faz 3 öncesi commit `148c95d` üzerinde üretilmiştir.

## 5. Baseline ve kural değişikliği politikası

1. Baseline'a **yalnızca önceden var olan** ihlal, gerekçesi ve R2 etiketiyle eklenir; yeni ihlal eklemek insan onayı gerektirir.
2. Bir ihlal düzeltildiğinde ilgili baseline kaydı **aynı PR'da çıkarılır**; aksi halde kapı "stale exception" ile başarısız olur.
3. `architecture-rules.json` değişikliği `architecture-rules.lock.json` özetini de değiştirir; bu, kod incelemesinde görünür bir eylemdir. Kilit güncellenmeden kural değişikliği CI'ı düşürür.
4. Baseline ve kilidi bot kendiliğinden güncellemez (`check-architecture` yalnızca okur).

## 6. Risk sınıfları (özet)

| Sınıf | Örnek | Otomatik düzeltme |
|---|---|---|
| R0 | Kullanılmayan import, deterministik lint düzeltmesi (R2 dışı dosyalarda) | M1'de etkinleştirilecek; **şu an kapalı** |
| R1 | Tip hatası, test/build bulgusu, uyumlu güvenlik güncellemesi | Ayrı branch/PR + insan incelemesi |
| R2 | `src/core`, `src/contracts`, `src/app`, `src/modules`, şema/migration, kullanıcı verisi, yedekleme/senkronizasyon, öneri algoritmaları, EventBus/kuyruk, güvenlik sınırları | **Yasak**; yalnızca bulgu + manuel görev taslağı |

## 7. Güvenlik ve sınırlar

- Workflow izni yalnızca `contents: read`; yazma token'ı, secret veya `pull_request_target` yoktur.
- `persist-credentials: false`; checkout kimlik bilgisi bırakmaz.
- Fork PR'larında secret kullanılmaz (hiçbir secret tanımlı değil).
- M0 hiçbir kaynak dosyayı değiştirmez, commit/branch/PR üretmez, otomatik merge yapmaz.
- Test/CI sahipliği Agent 1'dedir; bu çalışma mevcut doğrulamaları değiştirmedi. `ci.yml`'a yalnızca **tek yeni adım** (`npm run check:architecture`) eklendi.

## 8. Bilinen sınırlamalar

- **Gerçek GitHub Actions çalıştırması bu ortamda yapılamadı:** GitHub CLI kimliği yok ve `workflow_dispatch` yalnızca workflow varsayılan dala girdikten sonra kullanılabilir. Workflow YAML'i statik olarak doğrulandı; ilk gerçek koşu PR/merge sonrası izlenmelidir.
- `workflow_dispatch` girdileri (`analysis`, `compare_baseline`) GitHub tarafından yalnızca manuel tetiklemede doldurulur; PR/zamanlanmış koşularda varsayılanlar kullanılır.
- Zamanlanmış ve PR koşuları aynı tam analizi çalıştırır; "hızlı" mod bilinçli olarak yoktur (eksik analiz PASS sayılmadığı için yanıltıcı olurdu).
- `npm test` içindeki `mia-maintainer-regressions` "opak eventId" testi rastgele UUID içinde `777|888` araması nedeniyle **flaky** olabilir; bu çalışmada bir kez başarısız olup tekrarında geçti. Test Agent 1 sahipliğindedir, değiştirilmedi.
- Döngüsel importlar M0'da yalnızca raporlanır; zorunlu kapı değildir.
- Otomatik düzeltme, R0 allowlist uygulaması, bot branch/PR üretimi ve idempotent PR kontrolü M1 kapsamındadır ve bu PR'da **etkinleştirilmedi**.

## 9. Komutlar

```bash
npm run check:architecture   # mimari kapı (yeni ihlal/stale/kural gevşetme → FAIL)
npm run test:maintenance     # bakım botu regresyon testleri (13 test)
node scripts/maintenance/analyze.mjs --help
node scripts/maintenance/architecture-boundaries.mjs --json
```
