# MIA Dönüşüm Planı — Modular Intelligence Architecture (9. tur, ENTEGRE)

> **Bu belge:** Kullanıcının gönderdiği MIA planı (8 yönetici, 8 faz, olay modeli, kabul kriterleri) ile depo içi teknik planın (M1 + 8. tur dönüşüm haritası) **birleştirilmiş nihai hâlidir**. İnceleme referansı: `ef031af` (27 dosyalık commit: mobil kart dashboard, koyu tema, SQLite birincil depolama) + bu dalın M1 commit'leri (`fb4c04c…d92fffb`).

---

## 0. Uzlaştırma Kararları (iki planın birleştirilme kuralları)

| Konu | 8. tur planı (depo içi) | Kullanıcı MIA planı | **Nihai karar** |
| --- | --- | --- | --- |
| Yönetici sayısı | 11 | 8 | **8 yönetici** — 11'lik harita aşağıda 8'in altına katlandı (aynı dosyalar, daha az yönetim karmaşası) |
| Yürütme biçimi | Tek teslim, 9 adım commit serisi | 8 faz (her faz sonunda uygulama çalışır) | **Faz 0–8 benimsendi** — "tek seferde" kararının yerine kullanıcı kararı olarak geçti; her faz yine tek dalda commit serisi olarak akar |
| Olay sistemi | İki katman (shell-events UI + outbox kalıcı) | Tek Arka Plan Yöneticisi (EventBus + EventQueue) | **İki katman korunur** + kullanıcının `schemaVersion`, `EventRegistry`, öncelik ve durum modeli Outbox'a eklendi. `TasteEvent` zevk öğrenme olaylarının özel modeli olarak ayrı kalır — genel kuyrukla karıştırılmaz |
| Hedef satır sayısı | App.tsx < 1.000 | "Belirli satır sayısı değil, sorumluluk ayrımı" | Kullanıcı kararı: **sorumluluk ayrımı ölçüttür**; <1.000 yan ürün olarak kalır |
| Mimari biçim | Modüler monolit + orkestratör kabuk | Modüler monolit (mikroservis/aşırı parçalama yok) | **Aynı karar** — yönetici = çalışma zamanı agent'ı değil, mülkiyeti olan paket sözleşmesi |

**Mevcut durum notu:** Kullanıcı planı `ef031af` üzerinden analiz edildi; bu daldaki M1 işleri (shell-events, 4 modül bölümü, kayıt defteri) "yapılmış" sütununa işlenmiştir. "Genel EventBus/Outbox bulamadım" bulgusu master için doğru; bu dalda `shell-events.ts` (UI katmanı) hazır, Outbox (kalıcı katman) Faz 4'te.

---

## 1. Sekiz Yönetici — Görev Dağılımı ve Mevcut Dosya Eşlemesi

Her yönetici = dizin + `manifest.ts` (registry kaydı) + `service.ts` (tek giriş noktası). Yönetici → alt modül → yardımcı bileşen; üç seviyeyi aşan parçalama yok.

### Yönetici 1 — Uygulama Yöneticisi (ön plan) · `src/app/`
Sorumluluk: yaşam döngüsü, modül koordinasyonu, profil bağlamı, navigasyon, hata sınırları. **Öneri puanı hesaplamaz, içerik kaydetmez, hafıza işlemez.**

| Mevcut | Hedef | İşlem |
| --- | --- | --- |
| `src/App.tsx` (4.650) | `AppShell.tsx` + yönetici birleştirme | State/işlem koordinasyonu kancalara ve yöneticilere dağıtılır (Faz 7) |
| `app/module-registry.ts`, `navigation.ts`, `useHashNavigation.ts` | Aynen kalır | ✅ M1'de yapıldı |
| `app/shell-context.tsx`, `shell-events.ts` | Aynen kalır | UI olay katmanı; §3 |
| `app/AppModals.tsx`, `hooks/useAppModals.ts` | `app/modals/` | Modal koordinasyonu |
| Profil geçiş/oluşturma mantığı (App.tsx ~120 satır) | `app/ProfileContext.ts` + `modules/profile/state.ts` (`useProfiles`) | Geçişte `ProfileSwitched` olayı (mevcut `profile:changed` Outbox'e taşınır) |
| `ProfileModal.tsx` (634), `ProfileStatsTab.tsx` (514) | `modules/profile/` | Profil UI'ı; Veri Merkezi ile sınırı §6'da |

### Yönetici 2 — Kullanıcı Deneyimi Yöneticisi (ön plan) · `src/presentation/`
Sorumluluk: mobil/masaüstü düzenler, dashboard, tasarım sistemi.

| Mevcut | Hedef | İşlem |
| --- | --- | --- |
| `app/mobile/` (MobileDashboard 552, MobileDock, MobileTopBar) | `presentation/layouts/MobileLayout.tsx` | Taşınır (Faz 7) |
| `design-system/cards/` (HeroCard, StackDeck, ProgressCard, MetricCard, DiscoveryCard, RelationshipCard) | `presentation/design-system/cards/` | **Korunur**; yeni kart yalnızca gerçek görsel/etkileşim ihtiyacında |
| `styles/design-system.css` (1.562), `tokens.css`, `theme.ts` | `presentation/design-system/` | Tema yönetimi |
| `modules/discover/`, `modules/list/` bölümleri | `presentation/layouts/DesktopLayout.tsx` içine bağlanır | Bölümler modül kalır, sunum burada |
| Dashboard tercihi: `MobileDashboard.tsx` `ct:mobile-dashboard:*` (localStorage, doğrulandı) | `DashboardRepository` | **P2:** tercih okuma/yazma depo üzerinden; kullanıcı verisiyle karıştırılmaz, profil bazlı saklanır |

### Yönetici 3 — İçerik Yöneticisi (her ikisi) · `src/modules/content/`
Sorumluluk: TMDB metaverisi, kimlik standardizasyonu, katalog stoku, posterler. **TMDB puanı kullanıcı puanının üzerine asla yazılmaz.**

| Mevcut | Hedef | İşlem |
| --- | --- | --- |
| `services/api.ts` (1.787), `server/tmdb-proxy.ts` (1.048) | `content/providers/tmdb/` (TmdbClient + TmdbAdapter) | İstemci/sunucu sınırı korunur |
| `services/series-service.ts` (946), `series-*` | `content/catalog/` | Dizi katalog servisi |
| `stock-engine.ts` (991) + 6 stock-* | `content/stock/` | Stok işleri Arka Plan Yöneticisi'ne devredilir (`CatalogRefreshJob`) |
| `poster-hydration-service.ts` (736), `poster-cache-manager.ts` | `content/posters/` | Poster tamamlama arka plan işi |
| `cinetrack-core.ts` içindeki normalizasyon | `content/metadata/MetadataNormalizer.ts` | Faz 5'te sınıflandırılarak ayrılır (§5.2) |

### Yönetici 4 — Kütüphane Yöneticisi (ön plan) · `src/modules/library/`
Sorumluluk: kullanıcının içerikle yaptığı **bütün** işlemlerin tek giriş noktası. Hangi ekrandan eklenirse eklensin aynı işlem hattı.

| Mevcut | Hedef | İşlem |
| --- | --- | --- |
| `hooks/useItemActions.ts` | `library/operations/` (AddItem, UpdateItem, RemoveItem, ChangeStatus) | Tek işlem hattı; her işlem + ilgili olayı yayınlar (§2) |
| App.tsx `listStatus` + `Controls.tsx` | `library/state.ts` | Durum filtreleri |
| `core/duplicate-detector.ts` (620) | referansla bağlanır | core'da kalır (saf) |
| `core/tv-progress.ts` | `library/services/WatchProgressService.ts` | Bölüm ilerlemesi |
| Puanlama | `library/services/RatingService.ts` | Kullanıcı puanı ⊥ TMDB puanı |

### Yönetici 5 — Zevk ve Hafıza Yöneticisi (her ikisi) · `src/modules/intelligence/`
En kritik yönetici. Üç sorumluluk birlikte çalışır, **birbirinin verisini doğrudan değiştirmez**.

| Alt modül | Mevcut kaynak | İşlem |
| --- | --- | --- |
| `taste/` | `core/taste/taxonomy.ts` (674), `core/loved-similarity.ts`, `core/mood-affinity.ts` (641), `core/scoring.ts` | Hesaplama **core'da kalır** (767 test); `ProfileAnalyzer`/`FeatureExtractor` ince sarmalayıcı |
| `memory/` | **YOK — yeni** | `EvidenceLedger` (kanıtlar), `LearningState` (öğrenme durumu), `decay` (solma/pekiştirme); idb deposu + `MemoryRepository` |
| `relationships/` | `core/relationship-explorer.ts` (925), `relationship-semantics.ts` (790), `core/person-insights.ts` | `SemanticAnalyzer` + `GraphBuilder`; UI `modules/relationships/`'ta kalır |
| Sinyal ağırlıkları | `RECOMMENDATION_WEIGHTS_V3` | `core/scoring.ts`'e `SIGNAL_WEIGHTS`: watchlist 0.3 · watching 0.6 · watched 1.0 (puanla çarpılır) · disliked −0.8 |

**Kural:** Zevk Yöneticisi tercihleri hesaplar; Öneri Yöneticisi bunları kullanır; **öneri motoru hafızaya yazamaz**.

### Yönetici 6 — Öneri ve Keşif Yöneticisi (her ikisi) · `src/modules/recommendations/`
Mevcut algoritmanın **sonuçları korunarak** bağımsızlaştırılır — aynı girdi aynı puanı üretir (Faz 6'da önce/sonra karşılaştırma testi).

| Mevcut | Hedef | İşlem |
| --- | --- | --- |
| `core/recommendation-orchestrator.ts` | `RecommendationEngine.ts` + `CandidatePoolManager.ts` | Mevcut yardımcılar korunur |
| `core/evaluation.ts` | `EvaluationManager.ts` | Geri bildirim değerlendirme |
| `core/actor-recommendations.ts` (780) | `RankingManager.ts` yanına | Oyuncu önerileri |
| `core/derived-profile-cache.ts` | `ExplanationManager.ts` ile birlikte | reasons/signals zaten türetilmiş önbellekte |
| App.tsx `forYou*` (~15 state) + `catalog*` | `modules/discover/state.ts` (`useForYou`, `useCatalog`) | Faz 6 |

### Yönetici 7 — Veri Yöneticisi (her ikisi) · `src/modules/data/`
Sorumluluk: kalıcı verinin güvenli saklanması. **İş mantığı kararı veremez.**

| Mevcut | Hedef | İşlem |
| --- | --- | --- |
| `server/sqlite-primary-store.ts` | `data/adapters/SQLiteAdapter.ts` | SQLite = ana kullanıcı verisi birincil kaynağı |
| `services/storage-idb.ts` (775), `idb-schema-version.ts`, `discovery-storage.ts` (536), `relationship-cache.ts`, `client-depots.ts` | `data/adapters/IndexedDBAdapter.ts` + `repositories/` | idb = büyük katalog, aday havuzu, tarayıcı önbelleği |
| `server/storage.ts` (780), `server/atomic-json.ts` | `data/adapters/JsonBackupAdapter.ts` | JSON = taşınabilir yedek/kurtarma formatı |
| `server/restore-journal.ts`, `archive-integrity.ts`, `server/excel-profile-backup.ts` (3.446), `sqlite-archive.ts` (698), `auto-backup-service.ts` | `data/backup/` | BackupManager + RestoreManager |
| `server/github-bidirectional-sync.ts` (4.753), `github-catalog-sync.ts`, `github-token-refresh.ts`, `services/offline-queue.ts`, `useOfflineSync.ts` | `data/synchronization/GitHubSyncManager.ts` | offline-queue = *sunucuya yazma* kuyruğu; Outbox ile kardeş (§3) |
| `core/keys.ts` | `data/repositories/` sahiplik kaydı | Anahtar sahipliği tek kaynak |

**Kural:** SQLite + JSON arasında **iki ana veri kaynağı oluşamaz** (bkz. §5.1).

### Yönetici 8 — Arka Plan Yöneticisi (arka plan, UI'sız) · `src/modules/background/`
Diğer yöneticilerden farklı: olayları ve zamanlanmış görevleri çalıştırır, modüllerin özel verisine dokunmaz.

```text
src/modules/background/
├── EventBus.ts          # Katman 1: bellek içi (shell-events'in tüketici tarafı)
├── EventQueue.ts        # Katman 2: kalıcı Outbox (idb)
├── EventRegistry.ts     # Olay → abone işleyici eşlemesi (her olay için açık)
├── EventProcessor.ts    # idle-time + Web Locks tek-sekme işleyici
├── RetryManager.ts      # Üstel geri çekilme (2sn→5dk, offline-queue deseni)
└── jobs/
    ├── ProfileRefreshJob.ts
    ├── MemoryUpdateJob.ts
    ├── RelationshipUpdateJob.ts
    ├── RecommendationRefreshJob.ts
    └── CatalogRefreshJob.ts
```

**Hemen / arka plan / zamanlanmış ayrımı:**

| Hemen (senkron) | Arka plan (Outbox) | Zamanlanmış |
| --- | --- | --- |
| Listeye ekleme, puan kaydetme, durum değişikliği | Temel profil güncellemesi, kanıt hafızası, ilişki grafiği, öneri önbelleği yenileme, GitHub yedekleme, poster tamamlama | Büyük katalog taraması |

**Artımlı vs tam hesaplama:** Ekleme → yalnızca değişen içerik özellikleri + ilgili metrikler + etkilenen ilişki kenarları + önbellek geçersizleme. **Silme/durum değişikliği → sinyal yeniden hesabı + kanıt geçerlilik güncellemesi + gerektiğinde tam profil hesabı.** (Mevcut `derived-profile-cache.ts` fingerprint/hash mekanizması bunun temelidir.)

---

## 2. Olay Modeli

```ts
export interface AppEvent<T extends keyof AppEventMap = keyof AppEventMap> {
  eventId: string;          // crypto.randomUUID()
  eventType: T;             // string DEĞİL — birleşim tip, derleyici denetler
  profileId: string;
  entityId?: string;        // örn. "movie:157336"
  occurredAt: string;       // ISO-8601
  schemaVersion: number;    // olay şeması evrimi için
  payload: AppEventMap[T];
}
```

**Olay türleri ve aboneler (EventRegistry'de açık tanım):**

| Olay | Tetikleyen | Aboneler |
| --- | --- | --- |
| `LibraryItemAdded` | Kütüphane ekleme | Profil İşleyici, Hafıza İşleyici, İlişki İşleyici, Öneri İşleyici, İstatistik İşleyici |
| `LibraryItemUpdated` / `LibraryStatusChanged` | Güncelleme/durum | Profil (artımlı), Öneri İşleyici |
| `LibraryRatingChanged` | Puan | Zevk Analizcisi (ağırlıklı), Hafıza İşleyici, Öneri İşleyici |
| `LibraryItemRemoved` | Silme | Profil (yeniden hesap), Hafıza (kanıt geçerliliği), İlişki İşleyici, Öneri İşleyici |
| `FavoriteActorChanged` | Favori oyuncu | Zevk Analizcisi |
| `ProfileSwitched` | Profil geçişi | Tüm işleyiciler (profil izolasyonu: kuyruk profil bazlı ayrılır) |
| `CatalogItemEnriched` | Metaveri tamamlandı | Öneri İşleyici (yeniden skorlama) |

**Kablolama örneği (Faz 4):** `useItemActions.addItem()` → Veri Yöneticisi yazımı → `outbox.emit('LibraryItemAdded')` → kullanıcıya anında dönüş → EventProcessor idle'da aboneleri sırayla çalıştırır.

---

## 3. Outbox Güvenlik Sözleşmesi (idb-keyval)

1. **Idempotansiy:** `processed[`${eventId}:${handlerId}`]` defteri; işleyici çalışmadan kontrol, tekrar işleme yok. İşleyiciler idempotent yazım (çekirdek fonksiyonlar türetilmiş değer üretir → doğal idempotent).
2. **Retry + Dead Letter:** hata → `attempts++`, üstel geri çekilme; 5 denemeden sonra dead-letter + `outbox:dead-letter` UI olayı. Başarısız işleyici diğer işleyicilerin tamamlanmış işini **geri almaz** (bağımsız çalışma, transaction yok).
3. **Profil izolasyonu:** kuyruk kayıtları `profileId` ile etiketlenir; işleyici başka profile yazamaz.
4. **Durum takibi:** `bekliyor → çalışıyor → başarılı | başarısız | dead-letter` — Sistem Yönetimi paneli (§6) bunu görselleştirir.
5. **Öncelik:** profil güncellemesi > hafıza > ilişki > öneri yenileme.
6. **Tek-sekme kilidi:** `navigator.locks`; desteklenmezse idempotansiy defteri zaten çift işlemeyi engeller.
7. **Ömür kuralı:** sayfa yenilenince tamamlanması **gerekmeyen** olay (modal açma vb.) Outbox'a girmez — `shell-events`'te kalır.

---

## 4. Bağımlılık Kuralları ve Mimari Yasaklar

**Sorgu / Komut / Olay** — modüller arası üç haberleşme yolu. Modüller birbirinin iç işleyişini bilmez; dışa açılmış `service.ts` arayüzünü kullanır.

| Modül | Kullanabilir | Doğrudan müdahale edemez |
| --- | --- | --- |
| Dashboard | Kütüphane, öneri, profil sorguları | Veritabanı |
| Kütüphane | İçerik, veri servisleri | Zevk hafızası |
| İçerik | TMDB, katalog, veri | Kullanıcı puanları |
| Zevk | Kütüphane olayları, içerik özellikleri | Kütüphane kayıtları |
| Hafıza | Zevk olayları, içerik özellikleri | Kullanıcı listeleri |
| İlişkiler | Hafıza, içerik özellikleri | Profil kayıtları |
| Öneriler | Zevk profili, katalog, geri bildirim | Hafıza kayıtları |
| Veri | Repository istekleri | İş mantığı kararları |
| Arka Plan | Olaylar, görevler | Modüllerin özel verileri |

**Mimari yasaklar (Faz 8'de otomatik test hâline gelir — ESLint `no-restricted-imports` / dependency-cruiser):**
- UI bileşenleri SQLite adaptörünü doğrudan import edemez.
- Zevk motoru (`core/`) React bileşenlerine bağımlı olamaz.
- Öneri motoru Dashboard bileşenlerini kullanamaz.
- Modüller birbirinin repository dosyasına erişemez (yalnızca `service.ts`).
- Sunucuya özgü Node modülleri tarayıcı paketine giremez.
- Depolama anahtarı `keys.ts`'te sahibiyle kayıtlı değilse kullanılamaz.

---

## 5. Doğrulanmış Mimari Boşluklar (kod üzerinde teyitli)

| Bulgu | Önem | Teyit | Öneri |
| --- | --- | --- | --- |
| Genel kalıcı olay kuyruğu yok | P1 | master'da yok; bu dalda shell-events (UI) hazır | Faz 4: Outbox |
| App.tsx sorumluluk yoğunluğu | P1 | 4.650 satır; M1 ile 4 modül bölümü çıkarıldı | Faz 6–7: kancalar + yöneticiler |
| Core yoğunluğu | P1 | `cinetrack-core.ts` 4.690 satır | §5.2 sınıflandırma |
| Persistent Store yoğunluğu | P1 | 4.229 satır; katalog + türetilmiş profil + GitHub + senkron durumu | Servis sınırları önce, taşıma sonra |
| **SQLite sessiz JSON fallback** | P1 | `sqlite-primary-store.ts`: başarısızlıkta `available=false` + içsel `lastError`; kullanıcıya açık bildirim yok | §5.1 |
| Dashboard tercihi doğrudan localStorage | P2 | `ct:mobile-dashboard:*` doğrulandı | `DashboardRepository` |
| Modül sözleşmeleri yok | P1 | — | Faz 1: TypeScript arayüzleri |
| Mimari sınır testleri yok | P2 | — | Faz 8: import sınırı testleri |

### 5.1 SQLite çalışma modu (Faz 2'de uygulanır)
- `sqlite` **açıkça seçilmişse** başlatma hatası belirgin hata + durum bildirimi üretir; sessiz JSON'a dönüşmez.
- JSON fallback yalnızca **açık kurtarma modunda** çalışır.
- Sağlık ekranında (§6) gerçek aktif veri kaynağı gösterilir.
- SQLite ↔ JSON revision farkı izlenir; iki ana veri kaynağı oluşamaz.

### 5.2 Büyük dosyaların ayrıştırma sırası
- **`cinetrack-core.ts` (4.690):** rastgele taşıma yok — önce sorumluluk sınıflandırması (veri modeli/normalizasyon, profil hesabı, öneri puanlama, aday havuzu, Zevk Haritası, medya anahtarları, benzerlik). Eski dosya geçiş süresince **geriye dönük uyumluluk export katmanı** olarak kalır; Faz 8'de kaldırılır.
- **`persistent-store.ts` (4.229):** tek hamle taşıma yok — önce katalog / türetilmiş profil / GitHub / senkron durumu servis sınırları çizilir.
- **`App.tsx`:** ekran bileşenleri ve işlem fonksiyonları yöneticilere aktarılır; bileşen yalnızca yöneticileri birleştirir.

---

## 6. Sistem Yönetimi Paneli (Veri Merkezi altında)

Yalnızca gösterge değil: modül çalışma süreleri, hata sayıları, bekleyen Outbox görevleri, son başarılı işlem, **aktif veri kaynağı** (SQLite mı JSON mı), son yedek/senkron zamanı, SQLite↔JSON revision farkı, dead-letter listesi. Veri kaynağı: Outbox durum defteri + `sqlite-primary-store` sağlık API'si.

---

## 7. Faz Planı ve Kabul Kriterleri

| Faz | Yapılacak iş | Öncelik | Bu plandaki karşılık |
| --- | --- | --- | --- |
| 0 | Mimari envanter + bağımlılık haritası (import grafiği, çoklu-kullanım fonksiyonları, test kapsamı; taşıma/dokunulmaz işaretleme) | P0 | §1 tabloları başlangıç noktası; `madge`/dependency-cruiser raporu |
| 1 | Modül sözleşmeleri: `LibraryManager`, `TasteManager`, `MemoryManager`, `RecommendationManager` arayüzleri (gerçek tipler kod incelemesinden) | P1 | §1 service.ts sözleşmeleri |
| 2 | Veri Yöneticisi: repository'ler, adaptörler, revision, transaction, profil izolasyonu, migration, kurtarma + **SQLite çalışma modu (§5.1)** | P1 | Outbox üretim verisi üzerinde ancak bundan sonra |
| 3 | Kütüphane + İçerik Yöneticileri: tek işlem hattı | P1 | `library/operations/*` |
| 4 | Arka Plan Yöneticisi: kalıcı kuyruk, abonelik, retry, idempotency, izolasyon, durumlar — **önce yalnız `LibraryItemAdded` + `LibraryRatingChanged`** | P1 | §2–3 |
| 5 | Zevk + Hafıza + İlişki: mevcut engine korunur; profil/kanıt/öğrenme/zamansal analiz/özellikler/grafik ayrılır | P1 | §1 Yönetici 5 |
| 6 | Öneri motoru: önce/sonra aynı veri setinde **puan karşılaştırma testi** — puanlar değişmemeli | P1 | §1 Yönetici 6 |
| 7 | Uygulama + Arayüz: mobil kart sistemi ve masaüstü yöneticilere bağlanır; tüm veri işlemleri yönetici servisleri üzerinden | P1 | §1 Yönetici 1–2 |
| 8 | Temizlik: eski export katmanları, ölü kod, döngüsel import, **mimari yasak testleri**, performans + E2E regresyon | P2 | §4 |

**Faz kabul kriterleri (her faz için zorunlu):**

| Kontrol | Kriter |
| --- | --- |
| Veri bütünlüğü | Eski/yeni sistem kullanıcı kayıtları eşleşir |
| Profil izolasyonu | Bir profilin işlemi başka profili etkilemez |
| Öneri algoritması | Aynı girdi → aynı sonuç |
| Hafıza | Aynı olay iki kez işlenirse çift kanıt oluşmaz |
| Arka plan | Uygulama kapanıp açıldığında bekleyen işler kaybolmaz |
| Hata yönetimi | Bir görevin başarısızlığı diğer görevleri bozmaz |
| Senkronizasyon | Yerel/uzak veri kayıpsız birleştirilir |
| Arayüz | Mobil ve masaüstü aynı iş mantığını kullanır |
| Test | `npm run lint && npm test && npm run test:taste && npm run build` + E2E yeşil |

**İlk hafta sırası (Faz 0–1 + güvenli veri kaynağı):** ① dosya/bağımlılık envanteri → ② yönetici sözleşmeleri → ③ klasör iskeleti → ④ Veri Yöneticisi tasarımı → ⑤ SQLite çalışma modu kontrolü → ⑥ Kütüphane Yöneticisi prototipi → ⑦ mimari regresyon testleri. Hafta sonunda bütün uygulama taşınmış olması **beklenmez**; sonraki modüllerin kuralları kesinleşmiş olur.

---

## 8. Nihai Mimari Kararlar (geliştirme standardı)

| Konu | Karar |
| --- | --- |
| Mimari | Modüler monolit (mikroservis yok) |
| Ana yapı | Yönetici → alt modül → yardımcı bileşen (8 yönetici) |
| İletişim | Servis sözleşmeleri (sorgu/komut) + tipli olaylar |
| Arka plan | Kalıcı olay kuyruğu (Outbox, idb) + idle işleyici |
| Ana veri kaynağı | SQLite (tek ana kaynak; JSON yalnızca açık kurtarma modunda) |
| Tarayıcı depolaması | IndexedDB |
| Taşınabilir yedek | JSON |
| Uzak yedek | GitHub |
| İş mantığı | React'ten bağımsız (`core/` saf) |
| Mobil/masaüstü | Ortak iş mantığı, farklı sunum (`presentation/`) |
| Hafıza | Profil verisinden ayrı katman |
| Öneri | Bağımsız yönetici; hafızaya yazamaz |
| Dağıtım | Tek uygulama, tek sunucu |

**Değişmez güvence:** Mevcut kullanıcı profilleri, içerik stokları, Zevk Haritası, ilişki verileri ve öneri geçmişi hiçbir aşamada kaybolmaz; 767 test + E2E her fazda yeşil kalmak zorundadır.
