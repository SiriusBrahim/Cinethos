# Aşama 6 — İstemci performansı, depolama ve bellek: Uygulama Sonuçları

**Tarih:** 26 Kasım 2026
**Dal:** `remediation/full-project-remediation` · **PR:** #65 (açık, merge edilmedi)
**Başlangıç HEAD:** `cac6c24` · **Base:** `master@c58ec49`
**Kapsam:** B-20 (bundle/lazy loading), B-21 (localStorage), B-23 (Excel önizleme/bellek), B-37 (export retention) + ölçüm. B-22 doğrulandı, değiştirilmedi.

Bu belge yalnızca bu oturumda **ölçülen** ve **test edilen** davranışı kaydeder. Ölçüm betikleri tekrar üretilebilir:

```bash
npm run build
node scripts/perf/phase6-bundle-report.mjs --out docs/audits/phase6-bundle-after.json
./node_modules/.bin/tsx scripts/perf/phase6-bench.ts --label after --out docs/audits/phase6-perf-after.json
```

Ham veriler: [phase6-bundle-before.json](phase6-bundle-before.json), [phase6-bundle-after.json](phase6-bundle-after.json),
[phase6-perf-before.json](phase6-perf-before.json), [phase6-perf-after.json](phase6-perf-after.json).
"Önce" değerleri `cac6c24` üzerinde geçici bir git worktree'de **aynı betikle** alındı (tahmin yok).

---

## 1. Başlangıç durumu

| Alan | Değer |
|---|---|
| PR #65 | açık, `merged:false`, base `master` |
| Dal ucu / HEAD | `cac6c24` (yerel = uzak, `0 0`) |
| Ana chunk | `index` 773,40 kB (gzip 230,02 kB) |
| İlk yükte indirilen JS | 1.360.643 B (gzip 416.005 B) — 6 dosya, `d3-graph` (209,68 kB) + `series-tv-seeds` (149,46 kB) ön yükleniyordu |
| Build uyarıları | 2 × `INEFFECTIVE_DYNAMIC_IMPORT` (`TasteProfileDashboard`, `RelationshipExplorer`) |

## 2. Başlangıç ölçümleri (kod değişmeden)

50 hızlı ardışık güncelleme (her birinde tam liste serileştirme + yazım):

| Kayıt | Önce: toplam | Önce: güncelleme başına |
|---|---|---|
| 1.000 | 469,6 ms | 9,39 ms |
| 5.000 | 1.940,2 ms | 38,80 ms |
| 10.000 | 3.180,2 ms | 63,60 ms |

Tam liste serileştirme (tek plan üretimi): 8,85 / 41,11 / 62,19 ms.
Kota hatası davranışı: `overview` **120 karaktere kırpılıp** "başarılı" sayılıyordu (`compactSavedItems`).
Excel önizleme: tüm veri seti tek JSON'da — 10.000 kayıtta 4.672.532 B yanıt, 262,3 ms.
`data/exports` bu makinede **yok** (yalnızca `data/backups` var); retention hiç uygulanmıyordu.

## 3. B-20 — Bundle ve lazy loading

**Kök neden:** Üç ayrı statik import, gerçek lazy sınırlarını bozuyordu:
1. `src/components/ProfileStatsTab.tsx` → `TasteProfileDashboard` (statik) — panel `index` chunk'ına giriyordu.
2. `src/components/UniversesView.tsx` → `RelationshipExplorer` (statik) — `SeriesSection` üzerinden App'e, oradan `index`'e bağlanıyordu.
3. `vite.config.ts` graf kitaplarını (`react-force-graph-2d|force-graph|react-kapsule|d3-*`) zorla `d3-graph` chunk'ına alıyordu; bu chunk `modulepreload` ile **ilk yükte** indiriliyordu.

**Yapılanlar:**
- `TasteProfileDashboard` ve `RelationshipExplorer` statik importları `React.lazy` + `React.Suspense` sınırına alındı (fallback metinleri eklendi).
- `d3-graph` zorunlu chunk'ı kaldırıldı; graf motoru tek tüketicisi olan tembel `RelationshipExplorer` chunk'ında kalıyor (çift React kopyası da ortadan kalktı: `react-vendor` 210,9 → 218,7 kB, ayrı `d3-graph` chunk'ı yok).
- `SeriesSection` (≈150 kB dizi tohumu çekiyordu) ve `OperationsSection` App'te tembel yüklemeye alındı; `ErrorBoundary` ve `Suspense` sarmalayıcıları korundu.
- App içindeki kopya `lazyWithRetry` kaldırıldı; mevcut `src/app/lazy-with-retry.ts` tek kaynak oldu ve yeniden deneme davranışı `loadWithRetry` olarak test edilebilir hâle getirildi (bir kez retry, ikinci hatada özgün hata → ErrorBoundary).

**Sonuç (aynı build komutu):**

| Ölçüm | Önce | Sonra | Fark |
|---|---|---|---|
| Ana chunk (`index`) | 773,40 kB (gzip 230,02) | 527,16 kB (gzip 153,50) | **−246,24 kB / −33,15 kB gzip** |
| İlk yükte indirilen JS | 1.360.643 B (gzip 416.005) | 912.432 B (gzip 271.708) | **−448.211 B / −144.297 B gzip (−32,9% / −34,7%)** |
| `d3-graph` ön yüklemesi | 209.686 B | yok (lazy chunk) | −209.686 B |
| Build `INEFFECTIVE_DYNAMIC_IMPORT` | 2 | 0 | giderildi |

**Kalan (dürüst sınır):** `series-tv-seeds` (149.464 B / 46.013 B gzip) hâlâ ilk yükte. Bu veri `series-service` içinden **senkron** API'lerle (`computeUserSeriesUniverses`, `indexItemsForSeriesBatch`) kullanılıyor; ertelemek bu API'leri async yapmayı gerektirir ve davranış sözleşmesini değiştirir. Aşama 6 kapsamında kabul edilen borç olarak bırakıldı (bkz. §11).

## 4. B-21 — LocalStorage ve yerel kalıcılık

**Kök nedenler:**
1. `useAppPersistence` effect'i her `savedItems/preferences/...` değişiminde **tam listeyi** yeniden serileştirip senkron `setItem` yapıyordu (10.000 kayıtta tek yazım ≈62 ms ana iş parçacığı).
2. Kota hatasında `compactSavedItems` ile `overview` 120 karaktere **kırpılıp** başarı sayılıyordu — sessiz veri kaybı.
3. Liste IndexedDB'ye iki ayrı effect'te yazılıyordu (`preferences` değişiminde bile tam liste yeniden yazılıyordu).
4. Sekme gizlenirken/kapanırken bekleyen yazım için flush yoktu.

**Yapılanlar:**
- Yeni `src/app/persistence/local-write-scheduler.ts`: trailing debounce (250 ms), en son anlık görüntü kazanır, yazım sırası korunur; ilk (hidrasyon) yazımı beklemeden uygulanır; `flush()` bekleyen yazımı hemen yazar. Yazım sırasında gelen güncelleme kaybolmaz (yazımdan önce `pending` temizlenir).
- `useAppPersistence`: yazımlar scheduler'a bağlandı; `visibilitychange(hidden)` ve `pagehide` olaylarında **zorunlu flush**; unmount'ta da flush. Başarısız yazım `onWriteFailure`, yeniden başarılı yazım `onWriteSuccess` ile bildirilir.
- **Kırpma tamamen kaldırıldı:** `compactSavedItems` ve `compactFallback` silindi. Kota dolduğunda `setItem` hata verir, **eski sağlıklı değer korunur**, hiçbir alan kısaltılmaz, veri silinmez; tam liste React state'i + IndexedDB + sunucu belgesinde kalır.
- Kullanıcı bildirimi: kalıcı `OfflineIndicator` uyarı şeridi (`unpersistedWarning`) + 30 saniyede bir toast; başarılı yazımda uyarı temizlenir.
- Mükerrer `saveUserListsIdb` çağrısı kaldırıldı (tek yazım noktası).

**Sonuç:**

| Kayıt | 50 güncelleme önce | 50 güncelleme sonra | Kazanç |
|---|---|---|---|
| 1.000 | 469,6 ms | 8,2 ms | ~57× |
| 5.000 | 1.940,2 ms | 72,3 ms | ~27× |
| 10.000 | 3.180,2 ms | 134,9 ms | ~24× |

10.000 kayıtta 50 ardışık güncelleme 3,18 s → 0,135 s; yazım sayısı 50 → 1 (debounce) + sekme kapanışında 1 flush. Veri bütünlüğü testlerle güvence altında (§10).

## 5. B-23 — Excel önizlemesi ve bellek

**Kök neden:** `POST /api/backup/excel/preview` `buildProfileBackupDataset` ile **tüm** satırları eşleyip `dataset` olarak tek JSON yanıtında döndürüyordu (10.000 kayıt → 4,67 MB yanıt).

**Yapılanlar:**
- Yeni `buildProfileBackupPreviewPage({profile, page, pageSize, ...})`: sayfa dilimi için yalnızca gereken satırları eşler; toplam sayılar/sayfa bilgisi tam arşivden hesaplanır; sıra tam dışa aktarmayla **birebir** aynıdır (İzlenen → İzlenecek → İzleniyor → İlgilenmiyorum; ilk üçü eklenme zamanına göre yeniden→eskiye).
- Uç nokta: `page` (varsayılan 1), `pageSize` (varsayılan 50, üst sınır 200). Geçersiz değer → **400**. Yanıt: `completeness`, `sheetCounts`, `pageInfo {page, pageSize, totalPages, totalItemsCount, hasMore}`, `rows[{sheet,row}]`.
- Tam dışa aktarma (`/api/backup/profile-export`) **değişmedi**; tüm arşivi eksiksiz üretir.
- İstemcide bu ucu kullanan bir çağrı yoktu (doğrulandı); API sözleşmesi değişikliği yalnızca sunucu tarafında ve belgelendi.

**Sonuç:**

| Kayıt | Önizleme önce (tek JSON) | Önizleme sonra (50 satır) |
|---|---|---|
| 1.000 | 466.511 B / 41,3 ms | 25.594 B / 11,2 ms |
| 5.000 | 2.335.855 B / 157,3 ms | 25.703 B / 57,0 ms |
| 10.000 | 4.672.532 B / 262,3 ms | 25.706 B / 39,3 ms |

**Streaming:** ExcelJS'in mevcut 6 sayfalı, poster gömülü, formüllü çalışma kitabı mimarisi streaming writer'a taşınmadı; bunun yerine önizleme sınırlandı. Tam dışa aktarma süresi 1.000 kayıtta 389 ms (önce) / 518 ms (sonra) — kod yolu değişmedi, fark ölçüm gürültüsü (±%30, tek süreç/JIT); bu belgede kazanç olarak sunulmuyor. Bellek zirvesi 1.000 kayıtta 395 MB → 455 MB (aynı gürültü aralığı; retention modülü ek yükleme getirmedi, çalışma zamanı verisi aynı).

## 6. B-37 — Dışa aktarma dosyaları için retention

**Mevcut durum:** `data/exports` yoktu; her dışa aktarma `data/exports/Cinethos_Profile_YYYY-MM-DD_HHmm.{json,xlsx}` üretiyor, hiçbir temizlik yapılmıyordu. `data/backups` ayrı bir yedek dizini.

**Yeni:** `src/server/export-retention.ts`
- `isManagedExportFileName` / `selectExportsForRetention` (saf, test edilebilir) / `applyExportRetention` (dosya sistemi).
- Yalnızca `EXPORT_FILE_NAME_PATTERN` ile eşleşen, dizin bileşeni içermeyen dosyalar adaydır (desen tek kaynak: `src/server/export-file-names.ts`).
- **En yeni dışa aktarma her koşulda korunur**; `keepFileName` (az önce yazılan dosya) da korunur.
- Sıra: yaş → adet → toplam boyut (en eskiden başlayarak). Her silme yolu mutlaklaştırılıp `exports/` altında olduğu doğrulanır; `..`/`/`/`\` reddedilir.
- `data/backups`, ana veri dosyaları ve kullanıcı dosyaları **kapsam dışı** (listelenir, dokunulmaz).
- Hata durumunda dosya listesi ve veri bütünlüğü korunur; silme hataları `errors` içinde raporlanır. `dryRun` yalnızca karar üretir.

**Varsayılan politika ve gerekçesi (`DEFAULT_EXPORT_RETENTION_POLICY`):**

| Sınır | Değer | Gerekçe |
|---|---|---|
| `maxAgeDays` | 180 | Elle alınan tam yedeklerde "geçen yılın aynı dönemi" karşılaştırması korunur; 1.000 kayıtta XLSX ≈98 kB, JSON ≈1 MB olduğundan disk baskısı düşük. |
| `maxFiles` | 12 | Ayda bir yedek alan kullanıcı için ≈1 yıllık geçmiş; sınırsız birikmeyi engeller. |
| `maxTotalBytes` | 256 MiB | Posterli büyük çalışma kitaplarında bile disk şişmesini sınırlar; en yeni dosya her durumda korunur. |

Retention, başarılı dışa aktarmadan sonra `executeProfileBackupExport` içinde otomatik uygulanır ve sonuç `report.retention` olarak istemciye döner; `ProfileBackupTab` saklanan dosyaları ve temizlenenleri gösterir.

## 7. B-22 doğrulaması

Öneri cache sınırı Aşama 3'te tamamlandı ve **bu aşamada değiştirilmedi**. Doğrulama:
`modules/recommendations/RecommendationService.ts` LRU + TTL + revizyon/katalog/kapsam anahtarı + nesil (geç yazma koruması) davranışı yerinde; `tests/phase3-recommendation-cache*.test.mjs`, `tests/phase3-architecture.test.mjs` ve tüm suite yeşil. Gerçek bir regresyon bulunmadığı için kod değişikliği yapılmadı.

## 8. Değiştirilen / oluşturulan dosyalar

**Yeni**
- `src/app/persistence/local-write-scheduler.ts` — debounce + flush yazım zamanlayıcısı.
- `src/server/export-retention.ts` — retention politikası.
- `src/server/export-file-names.ts` — yönetilen dosya adı deseni (döngüsel import'u önler).
- `scripts/perf/phase6-bundle-report.mjs`, `scripts/perf/phase6-bench.ts` — tekrar üretilebilir ölçüm.
- `tests/f6-bundle-lazy-loading.test.mjs` (7), `tests/f6-local-persistence-scheduler.test.mjs` (7), `tests/f6-excel-preview-pagination.test.mjs` (6), `tests/f6-export-retention.test.mjs` (10).
- `docs/audits/phase6-{bundle,perf}-{before,after}.json`, bu belge.

**Değişen**
- `vite.config.ts` (zorunlu d3 chunk kaldırıldı), `src/App.tsx` (lazy ekranlar, yazma hatası bildirimi, mükerrer IDB yazımı kaldırıldı), `src/app/lazy-with-retry.ts` (`loadWithRetry`), `src/app/persistence/persistence-plan.ts` (kırpma kaldırıldı), `src/app/persistence/use-app-persistence.ts` (scheduler + flush + bildirim), `src/components/{ProfileStatsTab,UniversesView,ProfileBackupTab}.tsx`, `src/server/{app,excel-profile-backup}.ts`, `src/services/api.ts`, `tests/{f5-2-profile-persistence,spec-v7-regressions}.test.mjs`.

## 9. Veri güvenliği, migration ve geri alma

- **Veri formatı değişmedi.** localStorage anahtarları, JSON şeması (v3), IndexedDB depoları ve `data/*.json` yapısı aynı. Migration gerekmedi.
- **Kırpma yok:** kota hatasında hiçbir alan kısaltılmaz, dosya silinmez; eski değer korunur ve hata kullanıcıya gösterilir.
- **Retention yalnızca** `data/exports` altındaki, deseni eşleşen dosyalarda çalışır; `data/`, `data/backups`, kullanıcı dosyaları kapsam dışıdır. Testler geçici dizinlerde koşar; `data/` testlerce değiştirilmedi (data-guard %100 eşleşti).
- **Geri alma:** her değişiklik ayrı commit; `git revert <sha>` ile geri alınabilir. Retention'ı kapatmak için `skipRetention: true` (sunucu) veya politikayı gevşetmek yeterli; localStorage davranışı saf modüllerde olduğundan tek dosya geri alımı yeterlidir.

## 10. Testler

Yeni davranış testleri (30 test, tamamı gerçek üretim modüllerini kullanır):

| Dosya | Test | Kapsam |
|---|---|---|
| `f6-bundle-lazy-loading` | 7 | Statik grafikte ağır ekranların yokluğu, `react-force-graph-2d`'nin ilk pakette olmaması, dinamik import hedefleri, retry bir kez + kalıcı hatada hata iletimi |
| `f6-local-persistence-scheduler` | 7 | 50 hızlı güncelleme → tek yazım, son güncelleme kazanır, kota hatasında kırpma/silme yok + hata bildirimi, yeniden başarılı yazım, gizlenme/kapanma flush, yazım sırasında gelen güncelleme, aynı veri tekrar yazılmaz, yeniden açılışta tam veri |
| `f6-excel-preview-pagination` | 6 | Sayfa sınırları/son sayfa/sayfa dışı, tam dışa aktarma sırasıyla birebir tutarlılık, boş arşiv, 10.000 kayıtta yanıt sınırı, tam export eksiksizliği, ilgilenmiyorum sayfalaması |
| `f6-export-retention` | 10 | Ad deseni, yaş/adet/boyut, son başarılı dosyanın korunması, `backups`/kullanıcı dosyaları kapsam dışı, dizin dışı adlar, dryRun, silme hatası, olmayan dizin |

Değişen davranışa uygun güncellenen mevcut testler: kota kırpma testi → "kırpma yok, hata bildirilir, eski veri korunur"; `manualChunks` testi → "d3-graph zorlanmaz". Silinen/skip edilen/gevşetilen test **yok**.

## 11. Kalite kapıları (bu oturumda yerelde)

| Kapı | Sonuç |
|---|---|
| `npm run lint` (ESLint + 2× tsc) | 0 hata / 0 uyarı |
| `npm test` (unit) | tüm testler geçti (Aşama 5: 924 → bu aşamada +29 davranış testi) |
| `npm run test:taste` | geçti (fail 0) |
| `npm run cycles` | 0 döngü |
| `npm run build` | başarılı; `INEFFECTIVE_DYNAMIC_IMPORT` uyarısı yok |
| Üretim duman testi | `/` 200, `/discover/deep-link` 200, `/api/data` 200, `/api/tmdb-status` 200, `/api/sync/status` 200, `POST /api/sync/push` 404 |
| Önizleme ucu (canlı) | `{"page":0}` → **400** "Geçersiz sayfa numarası." |
| `npm run test:e2e` | **Yerelde koşulmadı** (bu ortamda tarayıcı yok); CI'da doğrulanır |
| Data guard | `data/` değişmedi |

## 12. CI

Son HEAD için zorunlu kontrollerin (`Lint, Test, Build & Production Smoke Test`, `Playwright E2E`, `Salt okunur bakım analizi`, `Vercel Preview Comments`) sonucu PR #65 üzerinde doğrulanacak ve bu bölüm son commit SHA'sıyla güncellenecek.

## 13. Kabul edilen teknik borç

1. **`series-tv-seeds` (149 kB) ilk yükte kalıyor** — senkron seri API'leri bu veriyi modül yüklemesinde kullanıyor; ertelemek API'leri async yapmayı gerektirir. B-20 hedefinin %33'lük kısmı tamamlandı, bu kalem ayrı bir iş olarak bırakıldı.
2. **ExcelJS streaming yok** — tam dışa aktarma hâlâ tüm çalışma kitabını bellekte üretir; önizleme sayfalandırıldı, tam export mimarisi korundu.
3. **`maxTotalBytes`/`maxFiles` varsayılanları ürün kullanımına göre seçildi, saha verisi yok** — politika yapılandırılabilir; ilk gerçek kullanım sonrası gözden geçirilmeli.
4. **Debounce 250 ms** — sekme kapanışında `pagehide` flush'ına güveniyor; tarayıcı `pagehide` çalıştırmazsa son 250 ms'lik değişiklik yalnızca IndexedDB/sunucu kopyasında kalır (localStorage'da değil).
5. **E2E yerelde koşulamadı** — yalnızca CI'da doğrulanır.

## 14. Aşama 6 kapanış matrisi

| Madde | Durum | Kanıt |
|---|---|---|
| **B-20** Bundle/lazy | ✅ Tamamlandı | İlk yük −448 kB (−%33), ana chunk −246 kB, 0 etkisiz dinamik import, 7 test |
| **B-21** Local persistence | ✅ Tamamlandı | Kırpma kaldırıldı, debounce+flush, hata bildirimi, 50 güncelleme 3,18 s → 0,135 s, 7 test + güncellenen mevcut test |
| **B-23** Excel önizleme/bellek | ✅ Tamamlandı | Sayfalı önizleme (4,67 MB → 25,7 kB), 400 doğrulaması, tam export eksiksiz, 6 test |
| **B-37** Export retention | ✅ Tamamlandı | Yaş/adet/boyut, en yeni korunur, `backups`/kullanıcı dosyaları hariç, rapor + UI, 10 test |
| **B-22** Öneri cache | ✅ Doğrulandı (değişmedi) | Aşama 3 testleri yeşil, regresyon yok |
| Ölçüm | ✅ Tamamlandı | 4 JSON + 2 betik, aynı fixture ve ortam |
| Veri güvenliği | ✅ | Kırpma/silme yok, migration yok, data-guard eşleşti |

**Aşama 6 tamamlandı.** Engelleyici eksiklik yok; borçlar §13'te açıkça listelendi.

## 15. Son HEAD ve PR durumu

- Son HEAD: bu belgenin commit'i (PR #65 dal ucu; CI bölümü ayrı commit ile güncellenir).
- PR #65 **açık ve birleştirilmemiş** kalır; merge/kapatma kararı kullanıcıya aittir.
- Aşama 7 başlatılmadı.
