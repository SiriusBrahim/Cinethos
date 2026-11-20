# Faz 3 — Veri Bütünlüğü, Senkronizasyon ve Kalan Mimari Eksikler

Tarih: 2026-11-20
Taban: `master` @ `14a2466` (PR #59 ve #60 birleşmiş) + PR #62 (`feat/phase2-integration-completion` @ `938f4b1`).

Bu belge, Ajan 3 mimari incelemesindeki altı bulgunun kod üzerinden doğrulanmasını,
yapılan düzeltmeleri ve doğrulanamayan noktaları kaydeder.

## Bulgu sınıflandırması

| # | Bulgu | Sınıf | Kanıt / düzeltme |
|---|-------|-------|------------------|
| 1 | `ratedAt`/`watchedAt`/`completedAt` ayrımı yok; `updatedAt`'e düşülüyor | **Doğrulandı ve düzeltildi** | `ratedAt`/`completedAt`/`addedAt` vardı, `watchedAt` yoktu. `getUserSignalV3` beş dalda `signalDecay(item.updatedAt \|\| item.addedAt)` kullanıyordu: not düzenlemesi sinyali tazeliyordu. CSV "WatchedDate" ve yıllık özet de `updatedAt`'e düşüyordu. Yeni `src/core/item-dates.ts` tek çözümleyici; `watchedAt` alanı eklendi; geri doldurma `normalizeDataDocument` içinde idempotent çalışıyor. |
| 2 | `season_progress` `Math.max(local, remote)` ile birleşiyor; geri alma engelleniyor | **Doğrulandı ve düzeltildi** | `mergeTwoSavedItemsLossless` gerçekten `Math.max` kullanıyordu. Yeni model: `watched_episodes` (sezon → bölüm numaraları), `progress_updated_at` (sezon → damga) ve deterministik sezon-bazlı birleştirme. Geri alma (10 → 8) yeni damgayla kazanır; farklı sezonlar bağımsız; silinen bölüm geri dirilmez; damgasız legacy veride eski `Math.max` korunur. |
| 3 | Aynı içerik hem `items` hem `disliked` içinde | **Doğrulandı ve düzeltildi** | Her modül kendi filtresini yazıyordu (keşif `disliked` süzüyor, arama süzmüyordu). Yeni `src/core/item-effective-state.ts`: `disliked > hidden > saved > available`, `inLibrary` ayrı bayrak. Keşfet/arama katalog yolu `filterCatalogItemsByPreferences` ile tek merkezden süzülüyor. CSV `#StateConflict` satırı, Excel Özet sayfasındaki mevcut "çift durum" bilgisi korunuyor. Hiçbir kayıt silinmiyor. |
| 4 | GitHub senkronizasyonu dayanıklılığı | **Doğrulandı ve düzeltildi** | 7 `fetch` çağrısında retry/backoff/`Retry-After` yoktu; yalnızca 409 sınıflandırması vardı. Yeni `src/server/github-request.ts`: ağ hatası, 408, 429, 5xx ve rate-limit 403'te exponential backoff + jitter; `Retry-After` ve `X-RateLimit-Reset` öncelikli. Tüm GitHub çağrıları `githubFetch` üzerinden geçiyor; gövde aynen yeniden gönderildiği için PUT idempotent. `verifiedEqual` başarısız olduğunda veri ezilmiyor, `warnings` içinde uyuşmazlık raporlanıyor. |
| 5 | App.tsx'te kalan sorumluluklar | **Doğrulandı, kısmen düzeltildi** | Sunucu birleştirmesinin saf hesabı `src/app/server-sync.ts`, yedek/geri yükleme saf yardımcıları `src/app/profile-backup.ts` dosyalarına taşındı; App state ataması ve efekt koordinasyonu yapıyor. Kalan senkron efektleri/çakışma eylemleri hâlâ App içinde (aşağıdaki "Kalan işler"). |
| 6 | Keşfet genel sıralaması Content Intelligence verisini kullanmıyor | **Doğrulandı ve düzeltildi** | `loadSemanticRelationHints` yalnızca Sana Özel/İlişki Keşfi yolunda kullanılıyordu. Keşfet'in `trending`, `gems`, `provider` kategorilerinde semantik/atmosferik afinite sınırlı (azami +8 uyum puanı) ikincil sıralama anahtarı olarak kullanılıyor. Sunucu kapalıysa veya analiz yoksa sıralama değişmiyor. Sana Özel hattı etkilenmiyor. |
| 7 | Öneri algoritması objektif değerlendirme | **Doğrulandı ve düzeltildi** | `EvaluationManager` yalnızca çevrimdışı metrikleri sunuyordu, eski/yeni karşılaştırma raporu yoktu. Yeni `src/core/recommendation-comparison.ts` aynı sabit veri kümesi ve profille iki yapılandırmayı koşar ve ilk 20 kesişimi, sıra değişimleri, favori oyuncu, tür/ruh hâli uyumu, kullanıcı puanları, film/dizi dengesi, benzer içerik yoğunluğu ve elenenleri raporlar. Puanlama formülü değiştirilmedi. |
| 8 | Node.js sürümü ve döngüsel bağımlılık | **Kısmen düzeltildi** | Sürüm zaten tutarlıydı (`engines >=22.18.0`, README, CI `22.18.0`); `.nvmrc` + `engine-strict` + CI sürüm doğrulaması eklendi. Döngü denetimi (`scripts/check-cycles.mjs`) iki mevcut döngü buldu: `relationship-explorer ↔ relationship-wordlists` (düzeltildi: `relationship-types.ts`) ve `github-bidirectional-sync ↔ persistent-store` (belgelendi, baseline 1). Yeni modüller döngü oluşturmuyor; `tests/phase3-architecture.test.mjs` sayının artmasını engelliyor. |

## Doğrulanamayan noktalar

- **Playwright E2E yerel sandbox'ta çalıştırılamadı** (Chromium sistem kütüphaneleri yok, `sudo` yok). CI'da koşuyor.
- **Görsel/arayüz doğrulaması yapılmadı** (bu ortamda tarayıcı yok).

## Veri ve migration politikası

- Şema sürümü **artırılmadı**: yeni alanlar (`watchedAt`, `watched_episodes`,
  `progress_updated_at`) isteğe bağlı ve geriye dönük uyumlu; eski istemciler
  bilinmeyen alanları yok sayar, yeni istemciler eski alanları okur.
- `normalizeDataDocument` her yüklemede `backfillInteractionDates` uygular:
  `completedAt` → `watchedAt` (yalnızca tamamlanmış kayıtta), `addedAt` →
  `firstAddedAt`. Var olan değerlerin üzerine yazılmaz, `updatedAt` izlenme
  tarihi olarak kullanılmaz, ikinci koşum değişiklik üretmez.
- Mevcut kullanıcı verisi silinmez: "ilgilenmiyorum" kaydı kütüphaneden
  çıkarılmaz, yalnızca öneri/keşif uygunluğu değişir.

## Kalan işler

1. App.tsx'teki sunucu senkron efektleri ve çakışma eylemlerinin
   `useServerSyncCoordinator` kancasına taşınması (davranış riski nedeniyle bu
   aşamada yalnızca saf hesap katmanı ayrıldı).
2. `github-bidirectional-sync ↔ persistent-store` döngüsünün ortak tip
   modülüne ayrılarak tamamen kaldırılması.
3. `#StateConflict` bilgisinin Excel'e ayrı bir rapor sekmesi olarak eklenmesi
   (Özet sayfasındaki mevcut çift durum bilgisi korunuyor).
