# MIA Faz 0 — Denetim Kontrol Listesi Sonuçları

> **Durum:** 2026-11-16 · dal `freebuff/faz0-f47140` · 202 kaynak dosya, 25+1 test dosyası
> **İlkeler:** Faz 1'den itibaren bağlayıcı sekiz kural ve doğrulama eşlemesi: [`mimari-ilkeler.md`](./mimari-ilkeler.md).
> **Kural:** Her madde bir kanıta bağlanır. Doğrulanmayan davranış "doğrulanmadı" olarak işaretlenir; tamamlanmış gibi gösterilmez.
> **Doğrulama:** `npm run lint` temiz · `npm test` **425/425** · `npm run test:taste` **362/362** · `npm run build` başarılı · Playwright **4/11** (nedenleri §0.5)

## 0.1 Kaynak kod envanteri

| Madde | Durum | Kanıt |
| --- | --- | --- |
| Tüm kaynak dosyaları listele | ✅ | [Envanter verisi §2–3](./faz0-envanter-veri.md) — 202 dosya, 82.134 satır, katman dağılımı |
| Sorumluluklara göre sınıflandır | ✅ | Aynı belge §2 (15 katman) + [fonksiyon sahipliği](./faz0-fonksiyon-sahipligi.md) (15 büyük dosya, blok bazında) |
| Büyük ve yoğun dosyaları belirle | ✅ | Envanter §3: `github-bidirectional-sync` 4.754 · `cinethos-core` 4.691 · `App.tsx` 4.651 · `persistent-store` 4.230 · `excel-profile-backup` 3.447 |
| Mevcut Manager/Service yapısını tespit et | ✅ | Envanter §15 — **73 otomatik tespit**. Elle doğrulanan ana servisler: `createDataStorage`, `createSqlitePrimaryStore`, `PersistentDataStore`, `GitHubBidirectionalSyncManager`, `createCinethosApp`, `createTmdbProxyService`, `stockEngine`, `TasteStore`, `relationship-cache`, `offline-queue`, `api.ts` istemcisi |
| Kullanılmayan / tekrar eden / eski kodu belirle | ✅ | Envanter §14 — **11 dosya hiçbir yerden import edilmiyor** (aşağıda), 189 "dışa aktarılmış ama dışarıdan kullanılmıyor" adayı, 10 aynı adlı export |
| Test dosyalarını kapsadıkları modüllerle eşleştir | ✅ | Envanter §9 — 26 test dosyası, hedef kaynaklar ve vaka sayıları |

### Ölü kod adayları (silmeden önce doğrulanmalı)
`src/components/IdentityView.tsx` (973) · `src/services/stock-import-export.ts` (672) · `src/components/UniversesHub.tsx` (599) · `src/components/UniversesView.tsx` (525) · `src/components/taste/TasteComparePanel.tsx` (227) · `src/components/FloatingGlassDock.tsx` (200) · `TasteEvolutionPanel` (174) · `TasteCategoryDetail` (141) · `TasteEvidenceList` (110) · `MoodSelectorBar` (67) · `src/core/sources/index.ts` (22).
Tarama yöntemi: statik + dinamik (`import()`), default import, `new URL(..., import.meta.url)` ve test importları birlikte değerlendirildi; buna rağmen hiçbirinden erişim bulunmadı. Kaldırma Faz 8 kapsamı.

## 0.2 Bağımlılık analizi

| Madde | Durum | Kanıt |
| --- | --- | --- |
| Import ilişkilerini çıkar | ✅ | [Bağımlılık grafiği](./faz0-bagimlilik-grafigi.md) — 640 dosya kenarı (130 tip), tam liste envanter §13 |
| Döngüsel bağımlılıkları tespit et | ✅ | Grafik §2 — 3 SCC; **1 gerçek değer döngüsü** (`persistent-store ↔ github-bidirectional-sync ↔ github-catalog-sync`) |
| Modüllerin birbirine bağımlılığı | ✅ | Grafik §1 — matris + 53 modül çifti; 407 kenar |
| Ortak kullanılan yardımcı fonksiyonlar | ✅ | Envanter §7 — `SavedItem` 57 dosya (8 değer/49 tip), `displayTitle` 16, `getPoster` 12, `BRAND_NAME` 15 |
| Birbirinin sorumluluğunu üstlenmiş modüller | ✅ | Aşağıdaki tablo |

| Sorumluluk çakışması | Kanıt | Hedef |
| --- | --- | --- |
| `App.tsx` hem kabuk hem kütüphane hem öneri hattı | `handleSaveItem` 2978, `handleSetStatus` 2997, `loadCategoryResults` 1510, render 4326 | Faz 3/6/7'de bölünür |
| `storage.ts` + `persistent-store.ts` iki ayrı dosya yazıcısı | ikisi de `data/*.json` yazıyor; `DataDocument` 4 yol | Tek `PrimaryDataRepository` |
| `core/cinethos-core.ts` model + puanlama + Zevk Haritası + havuz | blok tablosu §3 | `core/media/*`, `taste/`, `recommendations/` |
| `services/api.ts` TMDB + sunucu verisi + GitHub + yedek | api.ts blok tablosu §8 | `content/providers/tmdb`, `data/synchronization` |
| `useItemActions` yalnız yardımcı; gerçek işlemler App'te | `useItemActions.ts` export'ları: 32/58/104/207 — `addItem` yok | Faz 3 `library/operations` |

## 0.3 Veri mimarisi denetimi

| Madde | Durum | Kanıt |
| --- | --- | --- |
| SQLite tabloları ve ilişkiler | ✅ | [İş akışları §1.1](./faz0-is-akislari.md) — birincil store `documents/meta`; arşivde 7 tablo + 2 indeks |
| JSON veri yapısı ve kullanım alanları | ✅ | İş akışları §1 tablosu; `DataDocument` alanları `faz0-fonksiyon-sahipligi.md` §3 |
| IndexedDB kullanımı | ✅ | [Veri sahipliği §3](./faz0-veri-sahipligi.md) — 14 depo, erişen dosyalar |
| GitHub yedekleme ve senkron | ✅ | İş akışları §9 — A→E aşamaları, `data/sync-state.json`, çakışma seçenekleri |
| Kullanıcı verisini hangi modül yazıyor | ✅ | Veri sahipliği §2 — `storage.ts` tek yazıcı olmalı; bugün 4 yol |
| Aynı veri birden fazla yerde mi | ✅ | Veri sahipliği §5 — **7 çakışma** (`ct:stock`, offline kuyruk, ilişki önbelleği, taste map, UI tercihleri, profil anahtarları, DataDocument) |
| Silme / güncelleme / geri yükleme | ✅ | İş akışları §10 + `tests/faz0-baseline.test.mjs` (silme → mezar taşı → geri ekleme) |

## 0.4 İş akışlarının haritalandırılması

| Akış | Durum | Belge |
| --- | --- | --- |
| Film/dizi ekleme | ✅ | İş akışları §2 |
| İzleme listeleri arası geçişler | ✅ | §3 (watchlist/watching/completed, dislike, hide, silme) |
| Zevk profili oluşturma/güncelleme | ✅ | §4 (istemci `buildTasteProfileV3` + sunucu `TasteEvent → worker → profile`) |
| Öneri üretme ve yenileme | ✅ | §5 + baseline testi (puanlar kilitli) |
| Zevk Haritası ve İlişki Keşif Motoru | ✅ | §6 |
| İçerik indirme ve önbellekleme | ✅ | §7 (bellek TTL, sunucu LRU, IDB poster LRU, stok) |
| Profil değiştirme sırasındaki asenkron işler | ⚠️ | §8 — sıra ve çalışan işler belgelendi; **öneri sonucunun profile damgalanması yok**, yarış testi yok |

## 0.5 Mevcut sistemin doğrulanması

| Madde | Durum | Sonuç |
| --- | --- | --- |
| TypeScript kontrolü | ✅ | `tsc --noEmit` + `tsconfig.tests.json` temiz |
| Lint | ✅ | eslint `--max-warnings 0` · 0 hata/0 uyarı |
| Mevcut testler | ✅ | `npm test` **425/425**, `npm run test:taste` **362/362** |
| SQLite ve JSON veri bütünlüğü | ✅ | `sqlite-primary-store.test.mjs` 4/4 + `faz0-baseline.test.mjs` 3/3 |
| Profil değiştirmede veri karışması | ⚠️ | Veri katmanı ✅ (yeni test: A profili kayıtları B'ye geçişte bozulmuyor, eski revizyon 409) · E2E ✅ (`profiles-and-conflict` geçti) · **asenkron öneri yarışı doğrulanmadı** |
| Öneri sisteminin mevcut davranışı | ✅ | `tests/faz0-baseline.test.mjs` — aynı girdi → 66/49 puan, bileşen kırılımı sabitlendi |
| Kritik kullanıcı senaryoları | ⚠️ | Playwright 4/11; 7 başarısızlık testlerin eski header/tab seçicilerinden (§0.2 E2E tablosu) |

### Yeni eklenen testler
`tests/faz0-baseline.test.mjs` — 3 test:
1. **Öneri baseline:** sabit geçmiş + 2 aday → `tasteScore`/`priorityScore` 66 ve 49, `ring0`, parça değerleri (`genre .742/.5`, `keywords .704/.5`, `story 1/.3`, `lovedSim .608/.272`, `quality .81/.61`). Sıralama da kilitli.
2. **Profil izolasyonu:** iki profilli belge, geçişte kayıtlar korunur; eski revizyondan yazma `409 revision_conflict` döner ve diske uygulanmaz.
3. **Silme/geri yükleme:** silinen kayıt `deleted_keys` mezar taşı bırakır, yeniden eklenince taş temizlenir.

## Faz 0 kabul kriteri karşılığı

| Kriter | Durum |
| --- | --- |
| Mevcut mimari ve veri akışları belgelenmiş | ✅ `faz0-is-akislari.md`, `faz0-fonksiyon-sahipligi.md` |
| Bağımlılık haritası çıkarılmış | ✅ `faz0-bagimlilik-grafigi.md` (+ tam kenar listesi) |
| Veri sahipliği netleşmiş | ✅ `faz0-veri-sahipligi.md` (7 çakışma ve hedef sahip) |
| Kritik davranışlar testle kayıt altında | ✅ öneri baseline, profil izolasyonu, silme/geri yükleme, SQLite/JSON ± E2E 4/11 |
| Doğrulanmamış sorunlar tamam gösterilmiyor | ✅ 3 madde ⚠️ olarak işaretli (asenkron profil yarışı, E2E seçicileri, uçtan uca veri diyagramı) |

**Faz 1'e geçiş:** sözleşme tasarımı için engel yok. Faz 2 veri taşıması için iki ön koşul: `SyncStorePort` çıkarımı ve asenkron sonuçlara `{ profileId, baseRevision }` damgası.
