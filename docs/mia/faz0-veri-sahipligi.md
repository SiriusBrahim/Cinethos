# MIA Faz 0 — Veri Sahipliği Matrisi

> **Kapsam:** Sunucu dosyaları (`src/server/*`), IndexedDB depoları ve localStorage anahtarları. Bugünkü erişimler `npm run inventory:arch` çıktısındaki R/W taramasından, hedef sahiplik MIA planı §1/§8'den gelir.
> **Kural:** Bir varlığın **tek yazıcısı** olur. Diğer yöneticiler yalnızca sahibin `service.ts` sözleşmesi üzerinden okur/yazdırır; doğrudan depoya dokunamaz.

## 1. Yönetici kısaltmaları

`U` Uygulama · `V` Veri · `K` Kütüphane · `İ` İçerik · `Z` Zevk · `H` Hafıza · `R` İlişki · `Ö` Öneri · `B` Arka Plan · `D` Deneyim
**W** = yazar/siler · **R** = okur · **–** = erişemez.

## 2. Sunucu veri dosyaları

| Varlık | Bugün yazan (doğrulandı) | Bugün okuyan | Hedef sahip | U | V | K | İ | Z | H | R | Ö | B | D |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `data/cinetrack-data.json` (DataDocument: profiller, items, preferences, tombstones) | `server/storage.ts`, `server/github-bidirectional-sync.ts`, `server/app.ts` (`PUT /api/data`, restore) | `App.tsx`, `services/api.ts`, arşiv/Excel yedeği | **V** | R | **W** | R¹ | – | R | – | R | R | R | R |
| `data/profile.json`, `data/user-lists.json` (izole kopyalar) | `server/storage.ts` | `App.tsx` (hidrasyon), `services/storage-idb.ts` | **V** | R | **W** | R¹ | – | – | – | – | – | – | – |
| `data/profiles/*.json` (türetilmiş profil) | `server/storage.ts`, `server/github-bidirectional-sync.ts`, `POST /api/profiles/derived/upsert` | `App.tsx`, `services/api.ts` | **V** (yazar) · **Z** (üretir) | – | **W** | – | – | W² | – | – | R | – | – |
| `data/catalog/{movies,tv,manifest}.json` | `server/persistent-store.ts`, `server/github-catalog-sync.ts`, `POST /api/catalog/upsert` | `services/api.ts`, `App.tsx` (havuz tamamlama) | **İ** | – | R³ | – | **W** | – | – | – | R | R⁴ | – |
| `data/sync-state.json` | `server/persistent-store.ts` | `server/github-bidirectional-sync.ts`, `/api/sync/status` | **V** | – | **W** | – | – | – | – | – | R | R | R |
| `data/stock.json` | `server/persistent-store.ts`, `POST /api/stock/upload` | `App.tsx`, `services/api.ts` | **İ** | – | R³ | – | **W** | – | – | – | R | R⁴ | – |
| `data/sinema-kunyesi.json` | `server/persistent-store.ts`, `POST /api/cinema-kunye` | `hooks/useCinemaKunye.ts` | **İ** | – | R³ | – | **W** | – | – | – | R | – | – |
| `data/taste/*.json` (taxonomy, index, events, profile, manifest, objections) | `server/taste-store.ts`, `server/taste-rebuild-coordinator.ts` | `core/taste/*`, `services/api.ts` | **Z** | – | R³ | – | – | **W** | R⁵ | – | R | R⁶ | – |
| `data/archives/*.sqlite` | `server/sqlite-archive.ts` | arşiv geri yükleme akışı | **V** | R | **W** | – | R | R | – | – | – | – | – |
| `data/cinetrack.db` (SQLite birincil, `CINETRACK_STORAGE=sqlite`) | `server/sqlite-primary-store.ts` (yalnız `storage.ts` üzerinden) | `server/storage.ts` | **V** | – | **W** | – | – | – | – | – | R³ | – | – |

¹ Kütüphane yazmaz; ekleme/silme **komut** olarak Veri'ye gider ve Veri tek yazıcı kalır.
² Zevk profili üretir, dosyayı Veri yazar.
³ Salt okunur ayna/senkron ihtiyacı; yazma yetkisi yok.
⁴ Arka plan yalnızca **iş** tetikler (katalog tazeleme, yedek), dosyaya yazmaz.
⁵ Öğrenme kanıtı Hafıza'ya aittir; Zevk yalnızca türetilmiş profili okur.
⁶ Arka plan `MemoryUpdateJob`/`ProfileRefreshJob` çalıştırır, dosya yazmaz.

## 3. IndexedDB depoları (12)

| Depo | İçerik | Bugün erişen (doğrulandı) | Hedef sahip | Not |
| --- | --- | --- | --- | --- |
| `cinetrack-profile-db` | Profil dokümanı | `services/storage-idb.ts` | **V** | Sunucu kapalıyken birincil kopya |
| `cinetrack-user-lists-db` | Kullanıcı listeleri | `services/storage-idb.ts` | **V** | `data/user-lists.json` aynası |
| `cinetrack-stock-db` | İçerik stoku (500+500) | `services/storage-idb.ts`, `services/stock-engine.ts` | **İ** | Boyut nedeniyle tarayıcıda kalır |
| `cinetrack-series-index-db` | Dizi indeksi | `services/storage-idb.ts`, `services/series-service.ts` | **İ** | |
| `cinetrack-actor-credits-db` | Oyuncu filmografisi | `services/client-depots.ts` | **İ** | `ct:actor-credits:*` anahtarıyla eşleşir |
| `cinetrack-poster-lru-db` | Poster LRU (200 MiB) | `services/poster-cache-manager.ts` | **İ** | `ct:poster-hydration` ile kota yönetimi |
| `cinetrack-encodings-db` | Zevk kodlamaları | `services/encoding-service.ts` | **Z/H** | Hafıza katmanına devredilecek |
| `cinetrack-relationship-cache` | İlişki grafiği önbelleği | `services/relationship-cache.ts`, `services/idb-schema-version.ts` | **R** | Şema sürümü Veri'nin sorumluluğunda |
| `cinetrack-candidate-pool-db` | Aday havuzu | `services/discovery-storage.ts` | **Ö** | `cinetrack_pool_*_*` anahtarlarıyla |
| `cinetrack-discovery-history-db` | Keşif geçmişi | `services/discovery-storage.ts` | **Ö** | |
| `cinetrack-skip-log-db` | "İlgilenmiyorum" geri bildirimi | `services/client-depots.ts` | **Ö** | Kütüphane `disliked` ile karıştırılmamalı |
| `cinetrack-surfaced-db` | Gösterilen öneriler | `services/storage-idb.ts` | **Ö** | Tekrar göstermeme |
| `cinetrack-ui-prefs-db` | UI tercihleri | `services/client-depots.ts` | **D** | |
| `cinetrack-offline-queue-db` | Sunucuya yazma kuyruğu | `services/offline-queue.ts`, `services/storage-idb.ts` | **V** | İki dosya aynı depoyu açıyor → çakışma listesi |

> Plan §1'de 12 depo sayılmıştı; burada 14 satır var çünkü `candidate-pool` ve `discovery-history` ayrı depo olarak açılıyor (önceki raporda tek satırda birleştirilmişti).

## 4. localStorage anahtarları — sahiplik

| Anahtar | Bugün erişen | Hedef sahip |
| --- | --- | --- |
| `cinetrack.profiles.v1`, `cinetrack.activeProfile.v1`, `cinetrack.profile.v1` | `App.tsx` | **V** |
| `cinetrack.profile.*.watchlist.v1`, `cinetrack.profile.*.preferences.v1` | `App.tsx` (yazar), `services/storage-idb.ts` (okur) | **V** |
| `cinetrack.dirty.v2` | `App.tsx` | **V** (senkron durumu) |
| `cinetrack_deleted_keys_*` | `App.tsx` | **V** (mezar taşı) |
| `cinetrack_disliked_cache` | `App.tsx` | **K** |
| `cinetrack_hide_listed_items` | `App.tsx` | **D** (görünüm filtresi) |
| `cinetrack_fav_actors_*` | `App.tsx` | **K** |
| `cinetrack_taste_map_*` | `core/cinetrack-core.ts` (anahtar üretimi), `services/discovery-storage.ts` | **Z** |
| `cinetrack_pool_*_*` | `services/discovery-storage.ts` | **Ö** |
| `cinetrack_evidence_objections` | `components/EvidenceModal.tsx` | **H** (kanıt itirazı) |
| `cinetrack_offline_sync_queue_v1`, `cinetrack_offline_queue_store` | `services/offline-queue.ts` | **V** |
| `cinetrack_client_token_v1` | `services/api-client.ts` | **U** (güvenlik) |
| `cinetrack_prefer_image_proxy` | `utils/helpers.ts` | **D** |
| `cinetrack_idb_depot_versions_v1` | `services/idb-schema-version.ts` | **V** (şema sürümü) |
| `cinetrack.actor-accordions.v1`, `cinetrack.series-accordions.v1` | `components/*RecommendationsSection.tsx` | **D** |
| `ct:ui-prefs`, `ct:library-view` | `App.tsx`, `components/MediaGrid.tsx` | **D** |
| `ct:mobile-dashboard:*` | `app/mobile/MobileDashboard.tsx` | **D** (Faz 7: `DashboardRepository`) |
| `ct:theme` | `utils/theme.ts` | **D** |
| `ct:cinema-kunye`, `ct:stock`, `ct:encodings`, `ct:profile`, `ct:user-lists`, `ct:series-index` | `hooks/useCinemaKunye.ts`, `services/*` | İlgili sahip (İ / Z / V) — **idb sürüm anahtarları** |
| `ct:auto-backup-meta` | `services/auto-backup-service.ts` | **V** |
| `ct:idle-enrichment-quota`, `ct:poster-hydration`, `ct:stock-poster-hydration` | `services/idle-enrichment-service.ts`, `poster-hydration-service.ts`, `stock-poster-hydration-service.ts` | **İ** |
| `ct:actor-credits:*` | `services/actor-recommendations-engine.ts`, `services/client-depots.ts` | **İ** |

## 5. Bugünkü çakışmalar (tek yazıcı kuralını ihlal edenler)

| Varlık | Çoklu erişim | Risk | Faz 2 çözümü |
| --- | --- | --- | --- |
| `data/cinetrack-data.json` | `storage.ts`, `github-bidirectional-sync.ts`, `app.ts`, `App.tsx` PUT | Aynı belgeye 4 yol yazıyor; revizyon çakışması | Tek `PrimaryDataRepository`; senkron ve rotalar yalnızca onu çağırır |
| `ct:stock` | `App.tsx`, `stock-engine.ts`, `actor-recommendations-engine.ts`, `idb-schema-version.ts` | Stok hem içerik hem UI tarafından yazılıyor | Yalnız İçerik yazar; UI salt okur |
| `cinetrack-offline-queue-db` | `offline-queue.ts` + `storage-idb.ts` (ikisi de `createStore`) | İki bağlantı, tek kuyruk | Kuyruk tek modülde (`data/synchronization/`), diğer dosya import eder |
| `cinetrack-relationship-cache` | `relationship-cache.ts` + `idb-schema-version.ts` | Şema göçü ile veri yazımı ayrı sahiplerde | Şema Veri, veri İlişki |
| `cinetrack_taste_map_*` | `cinetrack-core.ts` (saf hesaplama) + `discovery-storage.ts` | Hesaplama modülü depolama anahtarı biliyor | Anahtar `keys.ts`'e, yazma Zevk repository'sine |
| `ct:ui-prefs`, `ct:library-view`, `ct:mobile-dashboard:*` | `App.tsx`, `MediaGrid.tsx`, `MobileDashboard.tsx`, `theme.ts` | UI tercihleri 4 ayrı yerde | `DashboardRepository` + tek UI tercih deposu |
| `cinetrack.profile.*` | `App.tsx` yazar, `storage-idb.ts` okur | İki farklı okuma yolu, kota davranışı farklı | Veri repository'si tek okuma/yazma yolu |

## 6. Profil izolasyonu — doğrulanan durum ve açık risk

**Doğrulanan:** Profil geçişi tek noktada (`App.tsx` `handleSwitchProfile`, ≈3906) yapılıyor ve M1 kabuk olayı yayınlıyor; belge kökü `activeProfileId` + `revision` taşıyor; sunucu tarafında `If-Match`/`expectedRevision` zorunluluğu var (`src/server/app.ts` P0-01 yazma hattı).

**Doğrulanmayan (açık):** Uzun süren öneri/katalog hesapları sonucu hangi profilin ekranına yazıyor? Kodda `forYou*` durumu tek `App` bileşeninde tutulduğu için profil değişiminde eski hesaplamanın sonucunu atacak **açık bir `profileId` damgası** görülmedi — bu, plan §3'teki `ProfileSwitched` olayı ve Faz 2 sözleşmesiyle kapatılacak.

**Faz 1/2 sözleşme şartı:** her asenkron sonuç `{ profileId, baseRevision }` taşır; handler yalnızca `profileId === aktif profil` **ve** sonuç revizyonu güncelken yazar. Aksi hâlde sonuç atılır ve `stale-result` olarak sayılır.

## 7. Faz 1 için veri erişim sözleşmesi taslağı

```ts
// Faz 1'de kesinleşecek; mevcut davranış §2–3'teki tablolarla doğrulandı.
interface PrimaryDataRepository {
  read(): Promise<DataDocument>;
  save(document: DataDocument, options?: SaveDataOptions): Promise<SaveDataResult>;
  getRevision(): Promise<number>;
  getHealth(): Promise<{ driver: 'sqlite' | 'json'; available: boolean; revision: number | null }>;
}
```

Kurallar:
- `save`, `revision` ve `expectedRevision` kontrolünü **repository içinde** yapar (bugün `storage.ts` + `app.ts` ikiye bölünmüş durumda).
- SQLite birincil, JSON taşınabilir yedek; **tek ana kaynak** kuralı repository'de zorlanır.
- Profil bazlı yazma `profileId` olmadan çağrılamaz.
- Bu arayüz, `IApplicationModule.healthCheck()` çıktısındaki `StorageHealth` ile aynı tipi paylaşır.

## 8. Faz 0 kapanışı için kalan iki madde

| Madde | Durum | Neden |
| --- | --- | --- |
| Profil değiştirme yarışı | ⚠️ Analiz edildi, **çalıştırılarak doğrulanmadı** | Gerçek tarayıcıda iki profil arasında yarış senaryosu (yavaş öneri + geçiş) E2E gerektirir; Faz 2 sözleşmesiyle birlikte test edilmeli |
| Uçtan uca (E2E) regresyon | ❌ Çalıştırılmadı | Repoda `e2e/` ve `playwright.config.ts` var; bu turda çalıştırılmadı, sonuç raporlanmadı |

Geri kalan tüm Faz 0 çıktıları üretildi: import grafiği (§[`faz0-bagimlilik-grafigi.md`](./faz0-bagimlilik-grafigi.md)), fonksiyon sahipliği (§[`faz0-fonksiyon-sahipligi.md`](./faz0-fonksiyon-sahipligi.md)), veri sahipliği (bu belge), test eşlemesi ve lint/tsc/test/build doğrulaması.
