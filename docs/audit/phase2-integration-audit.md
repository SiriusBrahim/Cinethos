# Faz 2 — Gerçek Mimari ve Entegrasyon Denetimi (master deposit: b9722b172)

> Salt-okunur kod düzeyi denetim. Bu belge, uygulamaların (Faz 2 commit setleri)
> kanıt tabanını oluşturur ve PR ilerledikçe güncellenir.

## 1. Doğrulanmış bulgular (kanıt: kod aramaları, satır referansları)

| # | Bulgu | Kanıt | Etki |
|---|-------|-------|------|
| B1 | `src/App.tsx` ~4.267 satırlık monolit; `loadCategoryResults` tek başına ~1.180 satır (L1408-2588) | Dosya envanteri | Sorumluluk ayrımı yok; öneri hattı, katalog yükleme ve olay yönetimi tek callback içine gömülü |
| B2 | Sunucu Taste profili sıralamayı **etkilemiyor**: `src/core/taste/recommendation-adapter.ts` "gölge modda" yazıldı (TP-037): `suggestFor` tasteFit hesaplar, loglar, sıralamayı DEĞİŞTİRMEZ | adapter içi yorumlar + `enrichCatalogItemsWithTaste` içindeki `tasteAdapter?.logFit` yalnızca log | Kullanıcı şikayeti doğrulandı |
| B3 | (a) App'in kendi `enrichItemsWithPersonalizedTaste` + `scoreCandidatesV3` hattı (L1360, L2249-2440), (b) modül motoru `enrichCatalogItemsWithTaste` (L1915 civarı), (c) `RecommendationService` (yalnızca testlerde içe aktarılıyor) — 3 paralel hat | search_code içe aktarma haritası | Tek motor yok |
| B4 | `createRecommendationAdapter` yalnızca test dosyalarında kullanılıyor; çalışma zamanı bağlantısı yok | search_code | Canlı taste etkisi yalnızca `PersistentTasteMapData.tasteMap` üzerinden sınırlı |
| B5 | Ölü kod: `src/services/stock-poster-hydration-service.ts` hiçbir yerden içe aktarılmıyor (`startStockPosterHydration`). Faz 2 setinde silindi | search_code (0 içe aktarıcı) | +13 KB temizlik |
| B6 | Kullanımda olan ve KORUNMASI gereken servisler: `idle-enrichment` (App L567 + stock-health), `batchGetEncodings`/`encoding.worker` (encoding-service), `scheduleSeriesPartsValidation` (series-service + wikidata-validator), GitHub senkron, Excel yedek, offline queue | search_code | Çalışan özellikler korunacak |
| B7 | İçerik zekâsı modülü (content-feature-extractor, semantic-analyzer, metadata-processor) tekniktende hazır; Keşfet/öneri hattına semantik kayıt akışının gerçek tüketimi Faz 2'de kanıtlanacak | modül envanteri | Entegrasyon gap'i |

## 2. Faz 2 uygulama planı (aynı dala art arda commit'ler)

- **Faz 2.1** ✅ Ölü kod temizliği (B5) + bu denetim belgesi.
- **Faz 2.2** Tek öneri motora yakınsama: App'in for-you hattını `enrichCatalogItemsWithTaste` üzerinden kur; `createRecommendationAdapter`'ı canlı moda bağla (veto + ağırlıklı blend, açıklanabilir etiketlerle); `RecommendationService` ya gerçek hatta bağlanacak ya kaldırılacaktır; eski/yeni algoritma aynı havuzda `EvaluationManager` ölçütleriyle karşılaştırılacak.
- **Faz 2.3** `App.tsx` monolit çözümü: yükleyici/kaydedici, profil, servis koordinasyonu, öneri, olay ve yönlendirme katmanlarının `src/app`, `src/hooks`, `src/modules/*` altına taşınması; `contracts` tip sözleşmeleri ile döngüsüz bağımlılık (`tests/architecture-boundaries.test.mjs` ile denetlenir).
- **Faz 2.4** Content Intelligence katalog akışı: eksik analiz tespiti, yeniden işleme kuyruğu, sürüm değişiminde yeniden analiz, çalıştırma durumunun İşlem Merkezi'ne yansıması.
- **Faz 2.5` Zorunlu 9 senaryo test seti + profile izolasyon regresyonları.

## 3. Sabitler (bozulmayacak)

- `normalizeProfileId` / p2-hex kimlik standardı (PR #58, #59).
- Kanonik medya anahtarı (`movie:<id>`/`tv:<id>`), puan ölçeği (1..10 | ``), `personal_rating_cleared`.
- GitHub çift yönlü senkron, Excel yedek, çevrimdışı kuyruk davranışı.

## 4. Doğrulama

Yerelde Node bulunmadığından tüm doğrulama depo CI'ı üzerinden yürütülür:
lint + tsc + birim testler + taste testleri + build + prod smoke + Playwright E2E.
PR birleşimi yalnızca CI tamamen yeşilken değerlendirilecek.
