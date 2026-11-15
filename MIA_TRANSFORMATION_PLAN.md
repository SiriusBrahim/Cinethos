# MIA Dönüşüm Planı — Modular Intelligence Architecture (8. tur)

> **Karar:** Kullanıcının önerdiği hiyerarşik, olay tabanlı mimari benimsendi. Mevcut M1 "Modüler Monolit + Orkestratör Kabuk" kararı **değişmiyor** — MIA onun üzerine inşa edilen sorumluluk haritasıdır. "Yönetici" = çalışma zamanı agent'ı/DI konteyneri **değil**; kendi verisinin sahibi olan, manifest'i kayıtlı, servisi üzerinden konuşulan bir **paket sözleşmesidir**.
>
> Bu belge, mevcut GitHub kodunun MIA'ya göre sınıflandırması + her yöneticinin taşınacak sorumlulukları + bağımlılık kuralları + tek teslimlik yürütme sırasıdır.

---

## 0. Kritik Tespit: MIA'nın Yarısı Zaten Var

MIA sıfırdan kurulmuyor. Kod tabanında karşılığı olan parçalar:

| MIA kavramı | Mevcut karşılık | Durum |
| --- | --- | --- |
| Arka Plan Olay Yöneticisi (bellek içi, UI) | `src/app/shell-events.ts` (tipli ShellEventMap, 4 olay) | ✅ M1'de kuruldu; genişletilecek |
| Kalıcı olay kuyruğu (Outbox) | `src/services/offline-queue.ts` (idb + 5 deneme üstel geri çekilme) | 🟡 Yalnızca senkron anlık görüntüsü taşıyor; genel Outbox'a genellenecek |
| Zevk Analizi | `src/core/taste/taxonomy.ts` (674), `mood-affinity.ts` (641), `server/taste-rebuild-coordinator.ts` (655) | ✅ Saf fonksiyon; yönetici paketine sarılacak |
| İlişki Analizi | `core/relationship-explorer.ts` (925), `relationship-semantics.ts` (790), `loved-similarity.ts` | ✅ Aynı |
| Öneri Hesaplama | `core/recommendation-orchestrator.ts`, `scoring.ts`, `actor-recommendations.ts` (780), `derived-profile-cache.ts` | ✅ Aynı; sinyal ağırlıkları `RECOMMENDATION_WEIGHTS_V3` içinde |
| Profil İşleme | `core/user-data-merge.ts` (784), `server/hybrid-merge.ts` (631) | ✅ Aynı |
| İçerik Stok Yönetimi | `services/stock-engine.ts` (991) + 6 stock-* servisi | 🟡 Window'lu, App'ten sürülüyor; olaya bağlanacak |
| Veri Yöneticisi | `core/keys.ts` (anahtar sahipliği), `services/storage-idb.ts` (775), `server/persistent-store.ts` (4.229) | ✅ Repository kuralının tohumu `keys.ts`'te zaten var |
| Entegrasyon Yöneticisi | `services/api.ts` (1.787), `api-client.ts`, `server/tmdb-proxy.ts` (1.048), `server/github-bidirectional-sync.ts` (4.753) | ✅ Aynı |
| Hafıza Yöneticisi | **YOK** — en büyük gerçek boşluk | ❌ Yeni kurulacak (bkz. §3) |

**Sonuç:** Dönüşüm ağırlıklı olarak *yeniden yazma değil, yeniden konumlandırma + olay kablolama*dır. 767 test bu geçişin güvenlik ağıdır.

---

## 1. İki Katmanlı Olay Sistemi (bilinçli mimari tercih)

Kullanıcının tek olay yöneticisi önerisi **ikiye ayrılır** — çünkü iki farklı güvenilirlik sözleşmesi var:

| | Katman 1: `shell-events` (bellek içi) | Katman 2: `outbox` (kalıcı) |
| --- | --- | --- |
| Amaç | UI koordinasyonu (modal aç, sekme değiştir, toast) | Arka plan iş yükü (zevk yeniden hesap, hafıza işleme, senkron) |
| Ömür | Sayfa yenilenince kaybolur — **bu doğrudur**, UI olayı geçicidir | idb'de kalıcı; uygulama kapansa bile işlenir |
| Teslim garantisi | En iyi çaba (at-most-once) | En az bir kez + idempotansiy (bkz. §2) |
| Tip güvenliği | `ShellEventMap` (mevcut) | `AppEventMap` — aynı desen, `type: string` DEĞİL, birleşim tipi |
| Örnek | `detail:opened`, `palette:open` | `library:item-added`, `taste:rebuild-requested` |

**Kural:** Bir olayın işlenmesi sayfa yenilense bile tamamlanmak zorundaysa → Outbox. Değilse → shell-events. Bir olay iki katmanda da yayınlanabilir (UI anında tepki verir, arka plan işi Outbox'tan akar).

## 2. Outbox Sözleşmesi (idb-keyval üzerinde)

```ts
// src/app/outbox/types.ts
export interface AppEvent<T extends keyof AppEventMap = keyof AppEventMap> {
  id: string;                    // crypto.randomUUID() — idempotansiy anahtarının yarısı
  type: T;
  profileId: string;
  occurredAt: string;            // ISO-8601
  entityId?: string;             // örn. mediaKey "movie:157336"
  payload: AppEventMap[T];
}

// Her (eventId, handlerId) çifti en fazla bir kez işlenir:
// { processed: Record<`${eventId}:${handlerId}`, { at: string; result: 'ok' | 'retry' | 'dead' }> }
```

Üç güvenlik kuralının uygulanışı:

1. **Tekrarlı işlem koruması:** İşleyici çalışmadan önce `processed[`${eventId}:${handlerId}`]` kontrol edilir; varsa atlanır. İşleyiciler **idempotent yazılmalı** (mevcut core fonksiyonlarının çoğu zaten türetilmiş değer üretir → yeniden hesap doğal olarak idempotent).
2. **İşlem takibi:** `processed` defteri hangi işleyicinin ne zaman işlediğini tutar; `MIA Durum` ekranı (Veri Merkezi alt modülü) bu defteri görselleştirir.
3. **Hata kurtarma:** İşleyici hatası olayı **düşürmez** — `attempts++`, üstel geri çekilme (offline-queue'daki 2sn→5dk deseni kopyalanır), 5 denemeden sonra `dead-letter` durumuna alınır ve `sync:completed` benzeri bir `outbox:dead-letter` olayı shell-events'e yayınlanır. Diğer işleyicilerin tamamlanmış işleri geri alınmaz (işleyiciler bağımsız çalışır, transaction yok).

**Kuyruk işleyicisi:** `src/app/outbox/processor.ts` — tek `setInterval` değil; `requestIdleCallback` + çevrimiçi durumu + sekme görünürlüğü tetiklemeli (mevcut `idle-enrichment-service.ts` deseni). Sekmeler arası çift işlemeyi önlemek için `navigator.locks` (Web Locks API) ile tek-sekme kilidi.

## 3. Hafıza Yöneticisi — gerçek yeni katman

Üç veri kavramının ayrımı (kullanıcı verisi / profil / hafıza) mevcut kodda kısmen var: kullanıcı verisi = profiles dokümanı, profil = `derived-profile-cache.ts` + taste taxonomy. **Hafıza yok** ve kurulacak:

```text
src/core/memory/           # saf fonksiyonlar (test edilebilir, React'siz)
  memory-store-port.ts     # repository arayüzü (candidate-pool-store-port.ts deseni)
  concept-extraction.ts    # içerikten kavram çıkarımı (tür/atmosfer/tema → kavram düğümleri)
  association.ts           # içerik-içerik ve kavram-kavram ilişki kenarları
  decay.ts                 # zamanla solma / pekiştirme (izleme sinyali ağırlığına göre)
src/services/memory-service.ts   # idb deposu + outbox işleyicileri (handlerId: 'memory')
```

**Sinyal ağırlıkları** (kullanıcının 4. maddesi) `core/scoring.ts`'e tek konfigürasyon olarak girer:

```ts
export const SIGNAL_WEIGHTS = {
  watchlist: 0.3,   // ilgi sinyali
  watching: 0.6,    // devam eden ilgi
  watched: 1.0,     // gerçek tüketim; puan varsa rating ile çarpılır
  disliked: -0.8,   // negatif tercih
} as const;
```

Mevcut `RECOMMENDATION_WEIGHTS_V3` bu tabloya referans verecek şekilde güncellenir — davranış değişikliği değil, ağırlıkların **görünür ve tek kaynaklı** olması.

## 4. Yönetici Haritası — mevcut dosyaların MIA sınıflandırması

Her yönetici = `src/<alan>/<yönetici>/` dizini + `manifest.ts` (registry kaydı) + `service.ts` (tek giriş noktası). **Hiçbir yönetici başka yöneticinin deposuna doğrudan yazamaz** — yalnızca sahibinin `service.ts`'ini çağırır.

### 4.1 Uygulama Yöneticisi (ön plan) — `src/app/`
| Sorumluluk | Mevcut dosya | İşlem |
| --- | --- | --- |
| Modül kaydı + navigasyon | `module-registry.ts`, `navigation.ts`, `useHashNavigation.ts` | Kalır (M1'de yapıldı) |
| Kabuk bağlamı/olayları | `shell-context.tsx`, `shell-events.ts` | Kalır; outbox §2'de kardeşlenir |
| Ekran/modal koordinasyonu | `AppModals.tsx`, `hooks/useAppModals.ts` | App.tsx'ten buraya taşınır |
| Tema | `theme.ts` (design-system) | Buraya bağlanır |

### 4.2 Kütüphane Yöneticisi (ön plan) — `src/modules/list/`
| Sorumluluk | Mevcut dosya | İşlem |
| --- | --- | --- |
| Liste bölümleri | `ListSection.tsx`, `components/Stats.tsx`, `MediaGrid.tsx` (liste modu) | Bölüm zaten çıkarıldı; MediaGrid liste modu props'u burada kalır |
| Durum filtreleri (izledim/izleyeceğim/izliyorum/ilgilenmiyorum) | App.tsx `listStatus` state + `Controls.tsx` | `modules/list/state.ts` kancasına taşınacak |
| Tekil öğe aksiyonları | `hooks/useItemActions.ts` | Kalır; kaydetme sonrası **yalnızca `outbox.emit('library:item-added')`** yayınlar |
| Çift kayıt birleştirme | `core/duplicate-detector.ts` (620) | `modules/list/` altına referansla bağlanır (core'da kalabilir — saf) |

### 4.3 Keşif Yöneticisi (ön plan) — `src/modules/discover/`
| Sorumluluk | Mevcut dosya | İşlem |
| --- | --- | --- |
| Keşfet bölümü | `DiscoverSection.tsx`, `Hero.tsx` | Bölüm çıkarıldı |
| Sana Özel / öneri akışı | App.tsx `forYou*` state'leri (~15 adet) + `core/recommendation-orchestrator.ts` | `modules/discover/state.ts` (`useForYou` kancası); hesaplama core'da kalır |
| Katalog/sayfalama | App.tsx `catalog*` state'leri + `services/discovery-storage.ts` (536) | `useCatalog` kancası |
| Gelişmiş arama | App.tsx `query` akışı + `CommandPalette` TMDB arama | `modules/discover/search.ts` |

### 4.4 Zevk Yöneticisi (ön plan + arka plan) — `src/modules/taste-map/` + `src/core/taste*`
| Sorumluluk | Mevcut dosya | İşlem |
| --- | --- | --- |
| Zevk Haritası UI | `TasteMapSection.tsx`, `IdentityView.tsx` (972), `components/taste/*` | Bölüm çıkarıldı; view'lar buraya taşınır |
| Zevk profili hesabı | `core/taste/taxonomy.ts`, `cinetrack-core.ts` içindeki V3 fonksiyonları | **core'da kalır** (saf, 767 testin konusu) |
| Zevk yeniden hesap koordinasyonu | `server/taste-rebuild-coordinator.ts` (655), `taste-routes.ts` (646) | Sunucuda kalır; istemci tetikleyicisi Outbox `taste:rebuild-requested` olur |
| İlişki Keşfi UI | `RelationshipsSection.tsx`, `RelationshipExplorer.tsx` (987), `UniversesView.tsx` (524) | `modules/relationships/` altına taşınır |

### 4.5 Profil Yöneticisi (her ikisi) — `src/modules/profile/` (yeni)
| Sorumluluk | Mevcut dosya | İşlem |
| --- | --- | --- |
| Profil modal'ı | `ProfileModal.tsx` (634), `ProfileStatsTab.tsx` (514), `ProfileIdentityCard*` | `modules/profile/` altına; registry'ye `section: 'settings'` manifesti |
| Profil geçiş/oluşturma mantığı | App.tsx `handleSwitchProfile`/`handleCreateProfile` (~120 satır) | `modules/profile/state.ts` (`useProfiles` kancası); geçişte `profile:changed` yayınlanır (mevcut) |
| Profil işleme (arka plan) | `core/user-data-merge.ts`, `server/hybrid-merge.ts` | Yerinde kalır; Outbox işleyicisi `profile` |

### 4.6 İçerik Detayı Yöneticisi (ön plan) — `src/modules/detail/` (yeni)
| Sorumluluk | Mevcut dosya | İşlem |
| --- | --- | --- |
| Detay modal'ı | `DetailModal.tsx` (1.040) | `modules/detail/` altına; `shell-context.openDetails` zaten servisi |
| Oyuncu çekmecesi | App.tsx `personId/personName` + `ActorRecommendationsSection.tsx` (572), `core/person-insights.ts` | `modules/detail/person.ts` |
| Sinema künyesi | `core/cinema-kunye.ts` (1.029), `hooks/useCinemaKunye.ts` | Referansla bağlanır |

### 4.7 İçerik Yöneticisi (her ikisi) — `src/services/content/` (mevcut services yeniden gruplanır)
| Sorumluluk | Mevcut dosya |
| --- | --- |
| TMDB istemci + proxy | `services/api.ts` (1.787), `server/tmdb-proxy.ts` (1.048), `api-client.ts` |
| Dizi ilerleme | `services/series-service.ts` (946), `core/tv-progress.ts` |
| Poster önbelleği | `poster-cache-manager.ts`, `poster-hydration-service.ts` (736), `stock-poster-*` |
| Stok motoru | `stock-engine.ts` (991), `stock-*` 6 dosya — Outbox işleyicisi `stock` |

### 4.8 Veri Yöneticisi (her ikisi) — `src/services/data/`
| Sorumluluk | Mevcut dosya | İşlem |
| --- | --- | --- |
| Anahtar sahipliği | `core/keys.ts` | Kalır — repository kuralının temeli |
| idb depoları | `storage-idb.ts` (775), `idb-schema-version.ts`, `discovery-storage.ts`, `relationship-cache.ts`, `client-depots.ts` | `data/` altında depo başına bir dosya; her depo tek yöneticinin mülkiyetinde |
| Sunucu kalıcılığı | `server/persistent-store.ts` (4.229), `sqlite-primary-store.ts`, `storage.ts` (780) | Sunucu katmanı — dokunulmaz (Y2 delta yolu buraya gelecek) |
| Yedekleme/geri yükleme | `server/excel-profile-backup.ts` (3.446), `sqlite-archive.ts` (698), `restore-journal.ts`, `archive-integrity.ts`, `services/auto-backup-service.ts` | Yerinde; Veri Merkezi UI'ı §4.9 |

### 4.9 Veri Merkezi (ön plan, yeni kullanıcı modülü) — `src/modules/data-center/`
Profil Yönetimi içine gömülü dağınık yedek/senkron arayüzlerinin (`ProfileGitHubSyncSection.tsx` 856, `ProfileBackupTab.tsx` 619, `ProfileModal` senkron bölümleri) tek çatı altında toplanması: yerel hafıza durumu, stok sağlığı (`stock-health-service.ts`), yedekleme, senkron geçmişi + **Outbox durum ekranı** (§2'deki processed defteri).

### 4.10 Senkronizasyon Yöneticisi (arka plan) — `src/services/sync/`
| Sorumluluk | Mevcut dosya | İşlem |
| --- | --- | --- |
| GitHub çift yönlü senkron | `server/github-bidirectional-sync.ts` (4.753), `github-catalog-sync.ts`, `github-token-refresh.ts` | Sunucuda kalır |
| Çevrimdışı kuyruk | `offline-queue.ts` | `sync/` altına taşınır; Outbox ile aynı geri çekilme altyapısını paylaşır |
| Otomatik yedek | `auto-backup-service.ts`, `useOfflineSync.ts` | `sync/` altına |

### 4.11 Entegrasyon Yöneticisi — zaten `server/` + `services/api*` olarak var
TMDB proxy, GitHub, Respan telemetri (`server/respan-telemetry.ts`). Yeni iş yok; yalnızca sınırlar belgelenir.

## 5. Bağımlılık Kuralları (derleyici ile denetlenir)

1. **Sahiplik:** Her idb/localStorage anahtarı `keys.ts`'te tek sahibiyle kayıtlıdır; anahtar, sahibi olmayan dosyada geçerse ESLint kuralı (`no-restricted-syntax` + anahtar listesi) uyarır.
2. **Yön:** `modules/*` → `services/*` → `core/*`. `core/*` hiçbir yere bağımlı değildir (bugün zaten böyle). `modules/*` başka bir modülün içinden **import alamaz** — yalnızca shell-context/shell-events/outbox üzerinden konuşur.
3. **Olay sözleşmesi:** Çapraz-modül her etki ya (a) tipli olay, ya (b) sahibin `service.ts` çağrısıdır. Doğrudan state/depo müdahalesi yok.
4. **Sunucu istisnası:** `server/*` kendi katman kurallarıyla yönetilir; istemci yöneticileri yalnızca HTTP üzerinden görüşür.

## 6. Yürütme Sırası (tek teslim, doğal commit serisi — faz değil)

| # | İş | Çıktı |
| --- | --- | --- |
| 1 | `src/app/outbox/` — tipli `AppEventMap`, kalıcı kuyruk, idempotansiy defteri, işleyici döngüsü (Web Locks + idle) + `tests/outbox.test.mjs` | Arka plan omurgası |
| 2 | `library:item-added` olayının kablolanması: `useItemActions` → outbox; mevcut `consumeStockItem`/`recordProfileChangeAndMaybeBackup` çağrıları işleyiciye dönüşür | İlk gerçek olay akışı |
| 3 | `core/scoring.ts` SIGNAL_WEIGHTS + mevcut ağırlıkların bağlanması | Sinyal ağırlıkları tek kaynak |
| 4 | `src/core/memory/` + `memory-service.ts` — kavram çıkarımı/ilişkilendirme/solma + `tests/memory.test.mjs` | Hafıza Yöneticisi |
| 5 | `useCatalog`/`useForYou` kancaları (App.tsx'ten keşif mantığı) | App.tsx ~4.650 → ~2.500 |
| 6 | `useProfiles` kancası + `modules/profile/` (ProfilModal taşınır) | App.tsx → ~1.800 |
| 7 | `modules/detail/` (DetailModal + kişi çekmecesi) | App.tsx → ~1.200 |
| 8 | `modules/data-center/` + `services/sync/` yeniden gruplama | App.tsx → <1.000 |
| 9 | Regresyon turu: 767 test + E2E + build chunk denetimi | Güvence |

Her adım sonrası ritüel: `npm run lint && npm test && npm run test:taste && npm run build`. `core/` ve `server/` saf katmanlarına **davranış değişikliği yok** — yalnızca konumlandırma ve olay kablolama.

## 7. Riskler ve Karşı Önlemler

| Risk | Önlem |
| --- | --- |
| Outbox işleyicileri UI'ı bloklarsa | idle-time işleme + iş başına zaman bütçesi (16ms dilim) |
| Çift sekme çift işleme | `navigator.locks` tek-sekme kilidi; kilit yoksa (Safari eski) `attempts` defteri idempotansiyi zaten korur |
| Hafıza katmanı şişerse | decay + üst sınır (zevk haritası gibi LRU); kavram kenarları ağırlık eşiğinin altına düşününce silinir |
| App.tsx kanca çıkarmada davranış sürprizi | Kancalar **state'i taşır, mantığı yeniden yazar değil**; her kanca çıkışı ayrı commit + tam test turu |
| Outbox/ offline-queue ikiliği kafa karıştırırsa | offline-queue = *sunucuya* yazma kuyruğu; outbox = *yerel arka plan iş* kuyruğu. Belge + isimlendirme bunu sabitler |

## 8. MIA'nın Açtığı Kapılar (Y6 ile bağlantı)

- **Zevk Anlatıcısı (Y6.1):** Hafıza katmanı hazır olunca LLM'e verilecek bağlam = profil + hafıza özeti — ayrı mühendislik yok.
- **Anlamsal arama (Y6.3):** Kavram düğümleri zaten çıkarılmış olacak.
- **Watch-party / taste twin (Y6.2/6.5):** Olay zarfı (`profileId` + `occurredAt`) paylaşılabilir olay günlüğünün doğal formatıdır.
