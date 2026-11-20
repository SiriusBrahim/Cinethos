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
| 8 | Node.js sürümü ve döngüsel bağımlılık | **Tamamlandı** | `.nvmrc` + `engine-strict` + CI sürüm doğrulaması sürüm sözleşmesini sabitler. `relationship-explorer ↔ relationship-wordlists` ve `github-bidirectional-sync ↔ persistent-store` döngüleri kaldırıldı: ortak tipler `persistent-store-types.ts`, saf yardımcılar `persistent-store-utils.ts` içine taşındı; sync manager artık dar bir `PersistentDataStoreSyncPort` sözleşmesi kullanıyor. Mimari testi artık sıfır döngü şartı koyuyor. |

## Doğrulanamayan noktalar

- **Playwright E2E yerel sandbox'ta çalıştırılamadı** (Chromium sistem kütüphaneleri yok, `sudo` yok). CI'da koşuyor.
- **Görsel/arayüz doğrulaması yapılmadı** (bu ortamda tarayıcı yok).

## Profil kimliği migration politikası

- `taste-profile-scope.ts` zaten `p1-b64url` manifestlerini `p2-hex` şemasına dönüştüren doğrulamalı geçişi içerir. Eski dizin önce geçici alana kopyalanır, dosya hash'leri ve dizin ağacı karşılaştırılır; hedef doğrulanmadan manifest güncellenmez.
- Eski dizin, geçiş doğrulamasından sonra da geriye dönüş/inceleme için korunur; hedef dizin farklı içerik taşıyorsa otomatik birleştirme yapılmaz ve `profile_id_map_conflict` üretilir.
- `tests/taste/taste-profile-p2-migration.test.mjs` temel p1 → p2 akışını doğrular; bu PR'da çakışma ve çoklu profil izolasyonu regresyon testleri de eklenecektir.

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

1. App.tsx'teki senkronizasyon efektleri, çakışma eylemleri ve Excel yedekleme akışının `useServerSyncCoordinator` / yedekleme kancasına ayrılması.
2. Mobil/masaüstü arayüzünün gerçek tarayıcıda görsel QA kontrolü.
3. Gerçek kullanıcı profilinin kişisel verisini dışarı çıkarmadan, iki yönlü GitHub sync, çakışma çözümü ve Excel geri yükleme kabul testlerini çalıştırmak.
