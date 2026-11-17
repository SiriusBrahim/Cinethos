# R2-A3 — Uygulama Hazırlık Dokümanı (MIA Faz 5)

> **Base Commit:** `49142ca8d552d59b11894a7aa574cce4588c16ce` (master)
> **Tarih:** 17 Kasım 2026
> **Doküman Sürümü:** 1.2.0 (birleşik denetim düzeltmeleri — kullanıcı kararları uygulandı; plan v2.4.0 ile unifikasiyon)
> **İlgili Plan:** `docs/mia/faz5/R2-A3-TEKNİK-ANALİZ-VE-PLAN.md` (v2.4.0, PR #38)
> **Durum:** Hazırlık — **A3 kaynak kodu HENÜZ DEĞİŞTİRİLMEDİ.**

> ⚠️ **Kapsam notu:** Bu doküman yalnızca A3 kodlamasına hazırlıktır. Kod yazımı, mimari
> karar kesinleştirme ve migration içermez. Plan dokümanındaki ifadeler kaynağıyla
> yeniden doğrulanmıştır; doğrulanamayan ifadeler "açık konu" olarak işaretlenmiştir
> (bkz. §12) ve gerçek kabul edilmemiştir.

---

## İçindekiler

1. [Doğrulanmış Kaynak Kod Durumu](#1-doğrulanmış-kaynak-kod-durumu)
2. [A3 İş Paketleri ve Bağımlılık Sırası](#2-a3-iş-paketleri-ve-bağımlılık-sırası)
3. [İş Paketi Detayları](#3-iş-paketi-detayları)
4. [Sorumluluk Ayrımı: Adapter / Router / Coordinator](#4-sorumluluk-ayrımı-adapter--router--coordinator)
5. [ProfileContext Uçtan Uca Aktarım Planı](#5-profilecontext-uçtan-uca-aktarım-planı)
6. [ForProfile API Geçiş Tablosu](#6-forprofile-api-geçiş-tablosu)
7. [Rebuild Coordinator Profil İzolasyonu Planı](#7-rebuild-coordinator-profil-izolasyonu-planı)
8. [Hydration Akışı ve Profil İzolasyonu](#8-hydration-akışı-ve-profil-izolasyonu)
9. [Test Senaryoları](#9-test-senaryoları)
10. [Geriye Dönük Uyumluluk ve Regresyon Kontrolleri](#10-geriye-dönük-uyumluluk-ve-regresyon-kontrolleri)
11. [Tamamlanma Kriterleri Özeti](#11-tamamlanma-kriterleri-özeti)
12. [Açık Teknik Konular (Çözülemeyen / Kullanıcı Kararı)](#12-açık-teknik-konular)
13. [Agent 2 İncelemesiyle Çakışabilecek Noktalar](#13-agent-2-incelemesiyle-çakışabilecek-noktalar)
14. [Kesin Sınırlar — Karar Verilmeyen Konular](#14-kesin-sınırlar)

---

## 1. Doğrulanmış Kaynak Kod Durumu

Aşağıdaki noktalar bu hazırlık sırasında **kaynak koddan birebir doğrulanmıştır**
(plan dokümanındaki ifadelerden bağımsız olarak):

| # | Nokta | Dosya:Satır | Doğrulama |
|---|-------|-------------|-----------|
| V1 | `ProfileContext` kurulumu yalnızca boş profil kimliğini reddeder; `PROFILE_ID_PATTERN` doğrulaması **yapmaz** (kurucu `:42-56`; fabrika `createProfileContext` `:209-211`) | `src/app/ProfileContext.ts:42-56, 209-211` | ✅ Okundu |
| V2 | `ProfileContext` API: `getCurrent()`, `assertCurrent(ref)`, `assertWritable(ref)`, `getRevision()`, `commitRevision()`, `switchProfile()`, `onProfileChange()` | `src/app/ProfileContext.ts:60-236` | ✅ Okundu |
| V3 | `profileContext`, `initialProfileId: 'default'` ile oluşturuluyor | `src/server/app.ts:493-496` | ✅ Okundu |
| V4 | Adapter oluşturulurken `profileContext` **iletilmiyor** | `src/server/app.ts:498-501` | ✅ Okundu |
| V5 | `createTasteRouter` çağrısında options'ta `profileContext` **yok**; mevcut alanlar: `tmdbApiKey`, `eventBus`, `tasteAdapter`, `deferAdapterSubscription`, `onDomainEvent`, `onRawTasteEvent` | `src/server/app.ts:2666-2685` | ✅ Okundu |
| V6 | `TasteServiceAdapterOptions.profileContext?: IProfileContext` **zaten mevcut** (options tipi `:40`), sınıf alanı (`:159`) ve constructor'da saklanıyor (`:163-167`) | `src/server/taste-service-adapter.ts:40, 159, 163-167` | ✅ Okundu |
| V7 | Adapter global API kullanıyor: `readTasteProfile` (`getProfile`), `readTasteEvents` + `appendTasteEventIdempotent` (`processEvent`); `assertCurrent`/`assertWritable` çağrıları mevcut | `src/server/taste-service-adapter.ts:167-261` | ✅ Okundu |
| V8 | Adapter `refreshProfile` (`:201`) ve `processEvent` (`:250`) içinde `triggerTasteProfileRebuild(this.dataDir)` çağırıyor | `src/server/taste-service-adapter.ts:201, 250` | ✅ Okundu |
| V9 | `createTasteRouter(dataDir, options)` imzası; options'ta profil alanı yok; fallback adapter `options.tasteAdapter ?? createServerTasteServiceAdapter({ dataDir, rebuildOnEvent: true })` şeklinde oluşturuluyor | `src/server/taste-routes.ts:275-295` | ✅ Okundu |
| V10 | 13 taste endpoint'i tümüyle global API kullanıyor | `src/server/taste-routes.ts:302-732` | ✅ Okundu |
| V11 | ForProfile API'leri mevcut: event (499-533), profile (551-575), index (577-597), manifest okuma (602-607), objections (612-631) | `src/server/taste-store.ts` | ✅ Okundu |
| V12 | `writeTasteProfileForProfile` ve `writeTasteIndexForProfile`, manifest'i kilit altında **kendi içinde** güncelliyor (`writeManifestForPathsUnlocked`). Ayrı bir `writeTasteManifestForProfile` export'u **yok** ve profil yazma yolunda gerekmiyor | `src/server/taste-store.ts:551-575, 198-230` | ✅ Okundu |
| V13 | `validateCanonicalProfileId`, `PROFILE_ID_PATTERN` testini yapıyor; `encodeProfileIdSafe`/`decodeProfileIdSafe` ve `resolveTastePathsForProfile` bu doğrulamaya bağlı | `src/server/taste-profile-scope.ts:125-203, 289-295` | ✅ Okundu |
| V14 | `PROFILE_ID_PATTERN = /^(?:profile-[A-Za-z0-9_-]{1,60}\|p\d{1,10})$/` — `'default'` **eşleşmez**; pattern `src/core/cinetrack-core.ts:809, 850`'de de kullanılıyor | `src/core/cinetrack-core.ts:717` | ✅ Okundu |
| V15 | `activeRebuildChains` anahtarı yalnızca `dataDir`; `triggerTasteProfileRebuild(dataDir)` hâlen tek parametreli (A3 hedefi: `triggerTasteProfileRebuild(profileId, dataDir)`; bkz. §7, §8.4) | `src/server/taste-rebuild-coordinator.ts:69, 494-508` | ✅ Okundu |
| V16 | `performRebuildOnce(dataDir)` ve `ensureInitialTasteBootstrap(dataDir)` global store API'lerini kullanıyor; `upsertTasteMetadataInputs` global index/objections okuyor | `src/server/taste-rebuild-coordinator.ts:333-369, 431-492, 519-660` | ✅ Okundu |
| V17 | `bootstrapPromises` ve `bootstrapSignatures` haritaları yalnızca `dataDir` anahtarlı | `src/server/taste-rebuild-coordinator.ts:70-71` | ✅ Okundu |
| V18 | Bootstrap, `data/cinetrack-data.json`'ı **yalnızca okur** (Mutlak Kural: asla yazılmaz) | `src/server/taste-rebuild-coordinator.ts:545-553` | ✅ Okundu |
| V19 | Başlangıç sağlık kontrolü global `readTasteManifest(resolvedDataDir)` okuyor | `src/server/app.ts:588` | ✅ Okundu |
| V20 | A2 profil kapsamlı store testleri mevcut: 8 test | `tests/taste/taste-profile-store.test.mjs` | ✅ Sayıldı |
| V21 | `/api/taste` router'ı `personalReadGuard` arkasında mount ediliyor | `src/server/app.ts:2662-2665` | ✅ Okundu |
| V22 | Metadata cache `shared-metadata-cache` kilit kapsamıyla korunuyor, `contentId` bazlı ve paylaşımlı | `src/server/taste-store.ts:319-333`, `src/server/taste-metadata-hydrator.ts:51-93` | ✅ Okundu |
| V23 | Profil-siz route testi: router options'sız kurulur (`createTasteRouter(tmpDir)`) ve global yolda başarılı yanıt bekleyen uçlar içerir — zorunlu `profileContext` kararının etkilediği mevcut test | `tests/taste/stock-and-live-profile.test.mjs:358` | ✅ Okundu |

**Doğrulama yöntemi:** Dosyaların ilgili bölümleri okundu; test çalıştırması **yapılmadı**.
Bu hazırlık dokümanında hiçbir test sonucu çalıştırılmış/geçmiş olarak sunulmaz.

---

## 2. A3 İş Paketleri ve Bağımlılık Sırası

| Sıra | Paket | Ad | Dosyalar | Bağımlılık |
|------|-------|-----|----------|------------|
| 1 | **WP-1** | ProfileContext wiring (app.ts → adapter → router options) | `app.ts`, `taste-routes.ts` (yalnızca options tipi) | — |
| 2 | **WP-2** | Route katmanında profil kimliği kaynağı | `taste-routes.ts` | WP-1 |
| 3 | **WP-3** | Rebuild coordinator profil izolasyonu | `taste-rebuild-coordinator.ts` | WP-1 |
| 4 | **WP-4** | Route Store çağrılarının ForProfile'a geçirilmesi | `taste-routes.ts` | WP-1, WP-2, WP-3 |
| 5 | **WP-5** | Adapter Store çağrılarının ForProfile'a geçirilmesi | `taste-service-adapter.ts` | WP-1, WP-3 |
| 6 | **WP-6** | Regresyon, uyumluluk ve izolasyon testleri | `tests/taste/*` | WP-1..WP-5 |

**Sıralama gerekçesi:**

- WP-3, WP-4/WP-5'ten önce gelir: `triggerTasteProfileRebuild`'in `profileId`
  parametresi kazanması route ve adapter çağrılarını kırar; imza önce değişir,
  çağıranlar kendi paketlerinde güncellenir.
- WP-4 ve WP-5 birbirinden bağımsız paralel yürütülebilir (ikisi de yalnızca
  WP-1..WP-3'e bağlıdır).
- WP-1 dışındaki hiçbir paket `app.ts`'in ProfileContext oluşturma biçimini
  değiştirmez.
- **A3/A4 kapsam sınırı (plan v2.4.0 §15.3 ile aynı):** A4 BackgroundManager
  (`src/modules/background/*`), backup/sync/restore ve öneri algoritmaları A3
  kapsamı dışıdır (§14). Bağımlılık sırası WP-1→WP-2→WP-3→WP-4/WP-5→WP-6'dır.

---

## 3. İş Paketi Detayları

### WP-1 — ProfileContext Wiring

**Değişecek dosyalar ve fonksiyonlar:**

| Dosya | Değişiklik |
|-------|-----------|
| `src/server/app.ts:498-501` | `createServerTasteServiceAdapter` çağrısına `profileContext` eklenir |
| `src/server/app.ts:2666-2685` | `createTasteRouter` options'ına `profileContext` eklenir |
| `src/server/taste-routes.ts:276-293` | Options tipine **ZORUNLU** `profileContext: IProfileContext` alanı eklenir; verilmezse tanımlı açık hata üretilir |

**Yeniden kullanılacak mevcut fonksiyonlar (değişiklik yok):**

- `createProfileContext` — `src/app/ProfileContext.ts:209-211`
- `TasteServiceAdapterOptions.profileContext` — `src/server/taste-service-adapter.ts:38`
  (adapter tarafında yeni kod **gerekmez**)
- `personalReadGuard` mount zinciri — `src/server/app.ts:2662-2665`

**Tamamlanma kriterleri:**

- [ ] `app.ts` içindeki tek `profileContext` örneği hem adapter'a hem router options'ına iletilir.
- [ ] Fallback adapter (`taste-routes.ts:294-295`) da aynı `profileContext`'i alır.
- [ ] `profileContext` options alanı **ZORUNLUDUR** (birleşik denetim P1-2): verilmeden `createTasteRouter` çağrısı tanımlı açık hata üretir; küresel fallback **eklenmez**. Profil-siz mevcut testler açık ProfileContext sağlayacak şekilde güncellenir (örnek: `tests/taste/stock-and-live-profile.test.mjs:358`, V23); kabul kriteri "profil-siz testler açık ProfileContext ile güncellenerek geçer"dir.
- [ ] `ProfileContext.ts` dosyasında hiçbir değişiklik yapılmaz.

### WP-2 — Route Katmanında Profil Kimliği Kaynağı

**Değişecek dosyalar ve fonksiyonlar:**

| Dosya | Değişiklik |
|-------|-----------|
| `src/server/taste-routes.ts` | Yeni iç yardımcı: profil kimliğini yalnızca `profileContext.getCurrent()`'dan okuyan fonksiyon (plan dokümanında `getProfileIdFromRequest(profileContext)` olarak adlandırılır) |
| `src/server/taste-routes.ts:302-732` | 13 handler, profil kimliğini bu yardımcıdan alır |

**Yeniden kullanılacak mevcut fonksiyonlar:**

- `ProfileContext.getCurrent()` — `src/app/ProfileContext.ts:68`
- Router options/closure üzerinden context erişimi (WP-1 ile gelir)

**Tasarım kuralları (plan dokümanı §10.1 ile tutarlı, kaynak kodla çelişmez):**

- HTTP isteği (query/header/body) üzerinden gelen profil kimliği **doğrudan
  Store'a aktarılmaz**.
- `req.profileContext` gibi var olmayan request alanları **kullanılmaz**.
- `profileContext` options'ta verilmediyse handler açık hata döndürür
  (sessiz global fallback **yapılmaz**).

**Tamamlanma kriterleri:**

- [ ] Hiçbir taste handler'ı istemci kontrollü profil kimliğini Store'a iletmez.
- [ ] Context yoksa davranış tanımlıdır (açık hata) ve test edilmiştir.
- [ ] `POST /domain-event` kimlik otoritesi sunucudadır (KULLANICI KARARI — v1.2.0, birleşik denetim P2-11): istemciden gelen `profileId` yetkili kimlik değildir; hedef profil her zaman `profileContext.getCurrent().profileId`'dir; `sourceRevision` sunucu tarafında doğrulanır; profil veya revision uyuşmazlığında istek 409 ile reddedilir (plan v2.4.0 §4.3, §15.2 ile aynı).

### WP-3 — Rebuild Coordinator Profil İzolasyonu

**Değişecek dosyalar ve fonksiyonlar:**

| Fonksiyon | Dosya:Satır | Değişiklik |
|-----------|-------------|-----------|
| `triggerTasteProfileRebuild` | `taste-rebuild-coordinator.ts:494-508` | Hedef imza `triggerTasteProfileRebuild(profileId, dataDir)` (plan v2.4.0 §10.3 ile aynı); zincir anahtarı `${dataDir}:${profileId}` |
| `performRebuildOnce` | `taste-rebuild-coordinator.ts:431-492` | `profileId` parametresi; 4 okuma + profil yazma ForProfile API'lerine geçer |
| `ensureInitialTasteBootstrap` | `taste-rebuild-coordinator.ts:519-660` | `profileId` parametresi; okuma/yazma ve `bootstrapPromises`/`bootstrapSignatures` anahtarları profil kapsamlı |
| `upsertTasteMetadataInputs` | `taste-rebuild-coordinator.ts:333-369` | `profileId` parametresi; index/objections okuma ForProfile |
| `activeRebuildChains` | `taste-rebuild-coordinator.ts:69` | Anahtar `${dataDir}:${profileId}` |
| `bootstrapPromises`, `bootstrapSignatures` | `taste-rebuild-coordinator.ts:70-71` | Anahtar `${dataDir}:${profileId}` |
| `runHydrationLoop` | `taste-rebuild-coordinator.ts:154-171` | `profileId` parametresi; içindeki `upsertTasteMetadataInputs(result.inputs, dataDir)` (satır 165) ve `triggerTasteProfileRebuild(dataDir)` (satır 166) çağrıları profil kapsamlı hâle getirilir; cache-hit turu davranışi düzeltilir (§8.5) |
| `scheduleTasteMetadataHydration` | `taste-rebuild-coordinator.ts:172-186` | `profileId` parametresi; `activeHydrations` guard'ı profil kapsamlı (§8.4) |
| `configureTasteHydration` | `taste-rebuild-coordinator.ts:144-152` | **Değişmez** — `hydrationApiKeys` `dataDir` anahtarlı kalır (profil-agnostik süreç kimlik bilgisi; §8.4). Çağıranlar: `app.ts:571`, `taste-routes.ts:293` |
| `activeHydrations` | `taste-rebuild-coordinator.ts:73` | Anahtar `dataDir` → `${dataDir}:${profileId}` (§8.4) |
| `hydrationApiKeys` | `taste-rebuild-coordinator.ts:72` | Anahtar **`dataDir` kalır** — profil-agnostik süreç kimlik bilgisi; tek yazma noktası `configureTasteHydration(dataDir, apiKey)` (§8.4) |

**Yeniden kullanılacak mevcut fonksiyonlar (değişiklik yok):**

- `executeAggregationOffMainThread` — saf hesaplama, profil bağımsız (`:371-429`)
- `computeBootstrapSignature` — `taste-rebuild-coordinator.ts:198-226`; bugün yalnızca global dosyaları imzalar, profil kapsamlı girdi içermez (birleşik denetim P2-8). WP-3 bunu profil kapsamlı girdilerle genişletir; bkz. §12.2
- `ensureProfileTasteStoreEntry` / `resolveProfileTasteStore` — `src/server/taste-store.ts:181-196`
  (profil dizini + ID manifest girişi oluşturma A2'de hazır)
- `coerceItemToTasteMetadata`, `configureTasteHydration`, `scheduleTasteMetadataHydration`
  — metadata akışı (yalnızca çağıran taraf profil parametresi alır)
- `hydrateTasteMetadataBatch` — `src/server/taste-metadata-hydrator.ts:230-308`;
  imzası **değişmez**: cache katmanı profil-agnostiktir, yalnızca çağıran zincir
  profil kimliği taşır (§8.3)

**Tamamlanma kriterleri:**

- [ ] Coordinator modülünde global okuma/yazma Store API çağrısı **kalmaz**. Bu kriter
      rebuild, bootstrap **ve hydration** akışlarının tamamını kapsar: `performRebuildOnce`,
      `ensureInitialTasteBootstrap`, `upsertTasteMetadataInputs`, `runHydrationLoop` ve
      `scheduleTasteMetadataHydration` içindeki tüm `readTaste*`/`writeTaste*` çağrıları
      §6 tablosundaki ForProfile karşılıklarına geçmiştir. Tek istisna bootstrap'in
      `cinetrack-data.json` salt-okunur okumasıdır (Store API çağrısı değildir, V18).
- [ ] Farklı profiller için aynı anda tetiklenen rebuild'ler birbirini bloklamaz.
- [ ] Aynı profil için ardışık rebuild'ler sıralanır (mevcut zincir davranışı korunur).
- [ ] `activeHydrations` `${dataDir}:${profileId}` anahtarlıdır; `hydrationApiKeys` `dataDir` anahtarlı **kalır** (profil-agnostik API anahtarı, §8.4); bir profilin hydration'ı başka bir profilin hydration'ını engellemez.
- [ ] Metadata cache tamamen dolu olduğunda (`fetched === 0`) dahi çağıran profilin
      Taste index'i cache'ten güncellenir; döngü index yazımını atlamaz (§8.5).
- [ ] Cache'ten profil index'i oluşturma tek ortak yardımcı
      `seedProfileIndexFromCache(profileId, dataDir, contentIds)` üzerinden yapılır;
      bootstrap ve hydration için mükerrer mantık yazılmaz (birleşik denetim P2-9; §8.5,
      plan §10.4 ile aynı).
- [ ] Bootstrap yalnızca `profileId === doc.activeProfileId` iken yazım yapar; aksi
      hâlde no-op + açık uyarı (hedef profil garantisi, birleşik denetim P1-3; §7, §12.2).

### WP-4 — Route ForProfile Geçişi

**Değişecek dosyalar ve fonksiyonlar:** `src/server/taste-routes.ts` — 13 endpoint
(satır numaraları V10 doğrulamasındadır). Geçiş tablosu: §6.

**Yeniden kullanılacak mevcut fonksiyonlar:** Tüm `ForProfile` API'leri
(`taste-store.ts:499-631`) olduğu gibi kullanılır; Store katmanına kod **eklenmez**.

**Tamamlanma kriterleri:**

- [ ] `taste-routes.ts` içinde global taste Store API importu kalmaz.
- [ ] Her endpoint, WP-2'deki tek kaynaktan aldığı `profileId` ile ForProfile API çağırır.
- [ ] `triggerTasteProfileRebuild` çağrıları profil kimliği ile yapılır (546, 596, 622, 732 civarı).
- [ ] Route içi `upsertTasteMetadataInputs([meta], dataDir)` çağrıları (`taste-routes.ts:645, 707`)
      profil kimliği ile ForProfile index yazımına geçer (§8.2).

### WP-5 — Adapter ForProfile Geçişi

**Değişecek dosyalar ve fonksiyonlar:**

| Fonksiyon | Dosya:Satır | Değişiklik |
|-----------|-------------|-----------|
| `getProfile` | `taste-service-adapter.ts:167-190` | `readTasteProfile(this.dataDir)` → `readTasteProfileForProfile(ref.profileId, this.dataDir)` |
| `processEvent` | `taste-service-adapter.ts:220-261` | `readTasteEvents` → `readTasteEventsForProfile(event.profileId, ...)`; `appendTasteEventIdempotent` → `appendTasteEventIdempotentForProfile(event.profileId, ...)`; rebuild çağrısı profil kimliğiyle |
| `refreshProfile` | `taste-service-adapter.ts:177-200` | `triggerTasteProfileRebuild` çağrısına `ref.profileId` eklenir |

**Yeniden kullanılacak mevcut fonksiyonlar:**

- `translateAppEventToTasteEvent` — saf çevirici, değişmez (`:88-146`)
- `subscribeTasteAdapterToEventBus` — abonelik mekanizması değişmez (`:271-309`)
- `profileContext.assertCurrent/assertWritable` akışı — mevcut doğrulama sırası korunur

**Tamamlanma kriterleri:**

- [ ] Adapter içinde global taste Store API çağrısı kalmaz.
- [ ] `profileContext` **zorunludur**: verilmediği senaryoda tanımlı hata üretilir, küresel fallback yok; testler açık ProfileContext ile kurulur (§10).
- [ ] `processedEventIds` idempotency Set'inin profil kapsamı açıkça karara bağlanmıştır (bkz. §12.5).

### WP-6 — Regresyon, Uyumluluk ve İzolasyon Testleri

**Değişecek dosyalar:** `tests/taste/` altında yeni test dosyaları (isimler planlanan;
plan dokümanı ile bu doküman arasındaki isim farkları §13.4'te işaretlidir).

| Dosya (planlanan) | Kapsam |
|--------------------|--------|
| `tests/taste/taste-profile-flow.test.mjs` | HTTP handler → ProfileContext → ForProfile API zinciri |
| `tests/taste/taste-profile-isolation.test.mjs` | İki profilin veri yolu ve kilit izolasyonu |
| `tests/taste/taste-rebuild-isolation.test.mjs` | `${dataDir}:${profileId}` zincir anahtarı davranışı |
| `tests/taste/taste-router-wiring.test.mjs` | WP-1 wiring: aynı context adapter + router + fallback |

**Tamamlanma kriterleri:**

- [ ] Mevcut `npm run test:taste` paketi (V20 dahil) değişmeden geçer.
- [ ] `npm run lint` (eslint + çift tsc) geçer.
- [ ] Yeni test dosyaları `package.json` → `test:taste` listesine eklenir.
- [ ] Test sonuçları raporlanır; çalıştırılmayan hiçbir sonuç çalıştırılmış gösterilmez.

---

## 4. Sorumluluk Ayrımı: Adapter / Router / Coordinator

| Sorumluluk | Sahip | Sahip olmayan |
|------------|-------|---------------|
| ProfileContext'i **oluşturmak** | `app.ts` | Adapter, router, coordinator |
| ProfileContext'i adapter'a vermek (`profileContext` parametresi) | `app.ts` | Adapter |
| ProfileContext'i route katmanına vermek (options) | `app.ts` | Adapter |
| Router örneğini oluşturmak | `createTasteRouter` | Adapter |
| Profil kimliğine route'lar için karar vermek (tek kaynak: ProfileContext) | `taste-routes.ts` (options/closure) | Adapter |
| AppEvent → TasteEvent çevirimi ve kendi doğrulamaları (`assertCurrent`/`assertWritable`) | `ServerTasteServiceAdapter` | Router |
| Rebuild zincirleme ve profil izolasyonu (`${dataDir}:${profileId}` anahtarları) | `taste-rebuild-coordinator.ts` | Adapter, router |
| Profil dizini/ID manifest yönetimi ve profil kapsamlı kilitler | `taste-store.ts` + `taste-profile-scope.ts` (A2, değişmez) | — |

**Kural:** Adapter, router OLUŞTURMAZ ve ProfileContext'i router'a AKTARMAZ.
Adapter yalnızca kendisine verilen context ile kendi doğrulamalarını yapar ve
Store çağrılarında olayın/referansın profil kimliğini kullanır.

---

## 5. ProfileContext Uçtan Uca Aktarım Planı

**Hedef wiring (WP-1):**

```
app.ts
  ├─ createProfileContext({ initialProfileId, initialRevision, eventPublisher })   [493-496]
  ├─ createServerTasteServiceAdapter({ dataDir, profileContext, rebuildOnEvent })  [498-501]
  └─ app.use('/api/taste', personalReadGuard,
        createTasteRouter(resolvedDataDir, { ..., profileContext }))               [2666-2685]

createTasteRouter (taste-routes.ts:275-295)
  ├─ options.tasteAdapter ?? createServerTasteServiceAdapter({
  │     dataDir, profileContext: options.profileContext, rebuildOnEvent: true })   [fallback — aynı context]
  └─ route handler'ları → profileContext.getCurrent().profileId (closure/options)
```

**Değişmeyenler:**

- `initialProfileId` değeri (`'default'`) **dokunulmaz** — kimlik sözleşmesi kararı
  kullanıcıya aittir (bkz. §14). WP-1 bu değerin ne olduğunu değiştirmez; yalnızca
  context'in taşınmasını sağlar.
- `ProfileContext` sınıfı ve `createProfileContext` değişmez.
- `switchProfile`/`commitRevision` akışları A3 kapsamı dışındadır.

**Aktarım sırasında korunacak tek-örnek garantisi:** Aynı nesne örneği adapter'a,
router options'a ve fallback adapter'a verilir; kopya/ikinci context oluşturulmaz.

**Kimlik zinciri (plan v2.4.0 ile ortak):** Kimlik kaynağı `DataDocument.activeProfileId`
→ `synchronizeProfileContext()` (`src/server/app.ts:79-97`; okunan değer:
`document.activeProfileId || document.profiles?.[0]?.id || 'default'` — `app.ts:83-85`)
→ `ProfileContext` türetilmiş bir çalışma-zamanı önbelleğidir. Adapter, router ve
coordinator kimliği yalnızca bu zincirden alır; istemciden gelen profil kimliği doğrudan
Store'a geçmez. A3 kuralı: `synchronizeProfileContext` kimliği `validateCanonicalProfileId`
ile doğrulamalıdır (kanonik doğrulama zorunlu kriteri; plan §9.2 kriter 8, §12.3; bu
hazırlıkta §12.1).

---

## 6. ForProfile API Geçiş Tablosu

Tüm hedef API'ler `src/server/taste-store.ts`'de mevcuttur (V11); Store katmanında
yeni fonksiyon **gerekmez**.

| Global API (bugün) | ForProfile karşılığı (hedef) | Kullanım noktaları (doğrulanmış satırlar) |
|--------------------|------------------------------|--------------------------------------------|
| `readTasteProfile(dataDir)` | `readTasteProfileForProfile(profileId, dataDir)` | routes: 302, 316, 391, 432, 481, 524, 546, 596 · adapter: 173 · coordinator: 433, 443, 481 |
| `readTasteEvents(dataDir)` | `readTasteEventsForProfile(profileId, dataDir)` | routes: 316, 471 · adapter: 240 · coordinator: 433, 538 |
| `appendTasteEventIdempotent(event, dataDir)` | `appendTasteEventIdempotentForProfile(profileId, event, dataDir)` | routes: 622 · adapter: 246 |
| `writeTasteProfile(profile, dataDir, wm)` | `writeTasteProfileForProfile(profileId, profile, dataDir, wm)` | routes: 481, 524 · coordinator: 481 |
| `readTasteIndex(dataDir)` | `readTasteIndexForProfile(profileId, dataDir)` | routes: 316, 391, 546 · coordinator: 337 (upsert), 434, 538 |
| `writeTasteIndex(index, dataDir)` | `writeTasteIndexForProfile(profileId, index, dataDir)` | routes: 546, 596 · coordinator (`upsertTasteMetadataInputs` üzerinden, satır 361): çağıranlar routes: 645, 707 · hydration: 165 · bootstrap: 625 |
| `readTasteManifest(dataDir)` | `readTasteManifestForProfile(profileId, dataDir)` | routes: 458 · coordinator: 443, 482 · **istisna:** `app.ts:588` startup sağlık kontrolü (bkz. §12.4) |
| `readTasteObjections(dataDir)` | `readTasteObjectionsForProfile(profileId, dataDir)` | routes: 546, 596 · coordinator: 336, 341 |
| `writeTasteObjections(obj, dataDir)` | `writeTasteObjectionsForProfile(profileId, obj, dataDir)` | routes: 546, 596 |
| `writeTasteEvents(events, dataDir)` | `writeTasteEventsForProfile(profileId, events, dataDir)` | coordinator: 635 (bootstrap) |
| `triggerTasteProfileRebuild(dataDir)` | `triggerTasteProfileRebuild(profileId, dataDir)` | routes: 546, 596, 622, 732 · adapter: 201, 250 · coordinator (hydration): 166 |

**Notlar:**

- Global API'lerin kendileri **değişmez**; yalnızca çağıranlar geçer (bkz. §14/§10).
- Manifest ayrı yazma API'si gerekmez: profil yazmaları manifest'i kilit altında
  kendi içinde günceller (V12).
- `readTasteMetadataCache`/`writeTasteMetadataCache` paylaşımlı kalmaya devam eder
  (V22); profil bazlı cache ayrımı kapsam dışıdır (§14).
- Hydration zinciri (`runHydrationLoop` → `upsertTasteMetadataInputs` →
  `triggerTasteProfileRebuild`) ayrıntılı izolasyon analizinde ele alınmıştır: §8.

---

## 7. Rebuild Coordinator Profil İzolasyonu Planı

**Hedef durum (WP-3):**

1. **Zincir anahtarı:** `activeRebuildChains` (69), `bootstrapPromises` (70),
   `bootstrapSignatures` (71) ve `activeHydrations` (73) haritaları `${dataDir}:${profileId}`
   anahtarıyla çalışır; `hydrationApiKeys` (72) `dataDir` anahtarlı **kalır** (§8.4).
   - Etki: Farklı profillerin rebuild/bootstrap işlemleri paralel ilerler;
     aynı profilin işlemleri mevcut FIFO zincirleme davranışıyla sıralanır.
2. **Fonksiyon imzaları:**
   - `performRebuildOnce(profileId, dataDir)`
   - `ensureInitialTasteBootstrap(profileId, dataDir)`
   - `upsertTasteMetadataInputs(inputs, profileId, dataDir)`
   - `triggerTasteProfileRebuild(profileId, dataDir)`
3. **Store çağrıları:** §6 tablosundaki ForProfile karşılıklarına geçer; profil
   dizini ve ID manifest girişi `ensureProfileTasteStoreEntry` ile otomatik
   oluşturulur (A2'den yeniden kullanım).
4. **Kilit izolasyonu:** Yazma işlemleri `serializeTasteWriteForProfile` →
   `tasteProfileLockScope(profileDir)` üzerinden profil kapsamlı kilide gider
   (`taste-store.ts:115-179`); global `taste-data` kilidi yalnızca global API'lerde kalır.
5. **Değişmeyenler:**
   - `executeAggregationOffMainThread` (saf hesaplama)
   - `cinetrack-data.json` salt-okunur okuma kuralı (V18)
   - Metadata hidrasyon mimarisi (yalnızca çağıran profil parametresi alır)

**Hydration akışı:** `ensureInitialTasteBootstrap` sonunda çağrılan
`scheduleTasteMetadataHydration` (satır 651) ve tüm hydration zinciri ayrı bir
bölümde analiz edilmiştir: **bkz. §8**. Bootstrap ile hydration'ın profil kapsamı
orada birlikte ele alınmıştır.

**Hedef profil garantisi (birleşik denetim P1-3):** Bootstrap'in hedef profili ile
verinin türetildiği profil aynı olmalıdır. Mevcut kaynak: aktif profil
`doc.profiles.find((p) => p && p.id === doc.activeProfileId) ?? doc.profiles[0]` ile
seçilir (`taste-rebuild-coordinator.ts:551-552`; eşleşmeyen belgede ilk profile düşer),
item'lar aktif profilden okunur (`:593-607`) ve olaylar
`migrateExistingData({ dataDocument: doc, asOf })` içinde `doc.activeProfileId`'den
türetilir (`src/core/taste/migration.ts:59-61`). **A3 kuralı:** bootstrap yalnızca
`profileId === doc.activeProfileId` iken yazım yapar; aksi hâlde no-op + açık uyarı;
`doc.profiles[0]` fallback'i kaldırılır ya da açık gerekçeyle korunur. "Bootstrap'i
profil başına tam işlemeye almak" bir A4 önerisidir, karar değildir (bkz. §12.2).

---

## 8. Hydration Akışı ve Profil İzolasyonu

> Bu bölüm v1.1.0'da eklenmiştir. WP-3'ün ilk kabul kriteri ("Coordinator modülünde
> global okuma/yazma API çağrısı kalmaz") ilk sürümde hydration akışını kapsamıyordu;
> bu bölüm eksik analizi tamamlar ve kriter §3 (WP-3) içinde yeniden yazılmıştır.

### 8.1 Mevcut Akış (Kaynak Kodla Doğrulanmış)

**Durum Map'leri (bugün yalnızca `dataDir` anahtarlı; satırlar 69-73; A3 hedefi §8.4):**

| Map | Dosya:Satır | Anahtar | İçerik |
|-----|-------------|---------|--------|
| `hydrationApiKeys` | `taste-rebuild-coordinator.ts:72` | `dataDir` | TMDB API anahtarı |
| `activeHydrations` | `taste-rebuild-coordinator.ts:73` | `dataDir` | Devam eden hydration döngüsü Promise'ı |

**Fonksiyon zinciri (bugünkü hâliyle tamamen global):**

```
configureTasteHydration(dataDir, apiKey)                    [coordinator:144-152]
  └─ hydrationApiKeys.set(dataDir, key)
     Çağıranlar: app.ts:571 (startup), taste-routes.ts:293 (createTasteRouter)

scheduleTasteMetadataHydration(dataDir, contentIds)         [coordinator:172-186]
  └─ guard: activeHydrations.has(dataDir) → varsa SESSİZCE DÜŞER (dataDir başına tek döngü)

runHydrationLoop(dataDir, contentIds)                       [coordinator:154-171]
  └─ 24 tura kadar: hydrateTasteMetadataBatch({dataDir, apiKey, contentIds})
       ├─ upsertTasteMetadataInputs(result.inputs, dataDir)   [satır 165 — GLOBAL index yazımı]
└─ triggerTasteProfileRebuild(dataDir)                 [satır 166 — GLOBAL rebuild zinciri]
```

**`upsertTasteMetadataInputs` (coordinator:333-369):** global `readTasteIndex`,
`readTasteObjections`, `writeTasteIndex` kullanır (satırlar 339-340, 361).

**Çağıranlar ve `contentIds` kaynağı:**

| Çağıran | Dosya:Satır | contentIds kaynağı |
|---------|-------------|--------------------|
| `ensureInitialTasteBootstrap` | `coordinator:651` | `collectEvidenceContentIds(allEvents)` — `allEvents` `readTasteEvents(dataDir)` (satır 533) çıktısı; olaylar `migrateExistingData` ile `doc.activeProfileId`'den türetilir (`migration.ts:59-61`; aktif profil seçimi `:551-552`, bkz. §8.2 ve §7 hedef profil garantisi) |
| Route: `POST /event` | `taste-routes.ts:645` | İstekle gelen tek metadata girdisi |
| Route: `POST /domain-event` | `taste-routes.ts:707` | İstekle gelen tek metadata girdisi |

**`hydrateTasteMetadataBatch`** (`taste-metadata-hydrator.ts:230-308`): paylaşımlı
metadata cache'i (`shared-metadata-cache` kilidi, V22) okur; yalnızca cache'te
olmayan `contentId`'leri TMDB'den çeker (`pending`, satır 247); cache'i kilit
altında günceller (satırlar 291-296); `inputs` **yalnızca yeni çekilen** öğeleri
içerir (satırlar 303-310).

**Sonuç:** Hydration bugün profil izolasyonuna tamamen kapalıdır — index yazımı ve
rebuild tetiklemesi globaldir, `contentIds` kümesi global event deposundan türetilir.
A3'te bu akış profil kapsamlı hâle getirilmelidir.

### 8.2 Profil Aidiyeti, `contentIds` Kaynağı ve Kimlik Taşıma Zinciri

**Hangi profile ait?** A3'te hydration, ProfileContext'ten gelen **aktif profil
kimliğiyle** çalışır (tek kimlik kaynağı: ProfileContext, §5). Hydration profil
başına ayrı bir kimlik kaynağı üretmez.

**`contentIds` kaynağı (A3 hedefi):**

- Bootstrap yolu: `ensureInitialTasteBootstrap(profileId, dataDir)` kendi profilinin
  event kümesini `readTasteEventsForProfile(profileId, dataDir)`'den alır ve
  `collectEvidenceContentIds` bu **profil kapsamlı** küme üzerinde çalışır (satır 651
  hedef hâli: `scheduleTasteMetadataHydration(profileId, dataDir, ...)`).
- Route yolu: `taste-routes.ts:645, 707` çağrıları zaten aktif profilin isteğine
  bağlıdır; profil kimliği WP-2'deki tek kaynaktan alınır.
- **Veri sahipliği üç katmandır (birleşik denetim P2-7):** (a) **shared
  catalog/stock** — global salt-okunur kaynaklar (`catalog/movies.json`,
  `catalog/tv.json`, `stock.json`; bootstrap okumaları `coordinator:555-591`);
  (b) **`activeProfile.items`** — `cinetrack-data.json` belgesine AİT profillendirilmiş
  veridir (belge profilsiz global bir kaynak DEĞİLDİR); bootstrap aktif profilin
  item'larını okur (`coordinator:593-607`); (c) **metadata cache** — global
  paylaşımlı (§8.3). Bootstrap'in hedef profili yalnızca aktif profil olabilir
  (§7 hedef profil garantisi; yazım §12.2 kuralına tabidir).

**Kimlik taşıma zinciri (hedef imzalar):**

```
ensureInitialTasteBootstrap(profileId, dataDir)
  └─ scheduleTasteMetadataHydration(profileId, dataDir, contentIds)
       └─ runHydrationLoop(profileId, dataDir, contentIds)
            ├─ hydrateTasteMetadataBatch({dataDir, apiKey, contentIds})   [imza değişmez]
            ├─ upsertTasteMetadataInputs(result.inputs, profileId, dataDir)
            └─ triggerTasteProfileRebuild(profileId, dataDir)
```

### 8.3 Ortak Metadata Cache vs Profil Kapsamlı Taste Index

| Katman | Kapsam | A3'te durum |
|--------|--------|-------------|
| TMDB metadata cache (`cinetrack-taste-metadata-cache.json`) | `contentId` bazlı, **tüm profiller ortak**, `shared-metadata-cache` kilidi (V22) | **Ortak kalır** — TMDB fetch maliyeti profil başına çoğalmaz |
| Taste index (`profiles/p1-b64url-.../cinetrack-taste-index.json`) | Profil kapsamlı | **Ayrık** — hydration sonrası upsert `writeTasteIndexForProfile` ile çağıran profilin index'ine yazar |

**Ayrıştırma kuralı:** Hydration'ın **fetch+cache** katmanı profil-agnostiktir
(`hydrateTasteMetadataBatch` imzası değişmez); hydration'ın **index yazımı** katmanı
profil kapsamlıdır. Profil izolasyonu index ve rebuild katmanında uygulanır; cache
katmanında uygulanmaz (bkz. §12.3).

### 8.4 `activeHydrations` ve `hydrationApiKeys` Anahtar Değerlendirmesi

**Soru:** Mevcut `dataDir` anahtarları yeterli mi? **Değerlendirme: Hayır** —
index yazımı profil kapsamlı hâle geldiğinde:

1. `activeHydrations` `dataDir` anahtarlı kalırsa, profil A için devam eden bir
   hydration, profil B'nin hydration isteğini **sessizce düşürür**
   (`if (activeHydrations.has(dataDir)) return;`, satır 177). B profilinin index'i
   güncellenmeden kalır.
2. Döngü (`runHydrationLoop`), hangi profilin index'ine yazacağını bilemez; mevcut
   imza profil taşımaz.

**Karar (plan v2.4.0 ile tekleştirildi — kullanıcı gerekçesiyle):**
`activeHydrations` `${dataDir}:${profileId}` anahtarına geçer (WP-3); `hydrationApiKeys`
ise **`dataDir` anahtarlı kalır** — TMDB API anahtarı profil-agnostik bir süreç kimlik
bilgisidir; tek yazma noktası `configureTasteHydration(dataDir, apiKey)`
(`coordinator:144-152`) profil parametresi almaz; `${dataDir}:${profileId}` anahtarına
geçirilseydi `runHydrationLoop`/`scheduleTasteMetadataHydration` guard'ları
(`coordinator:155-156, 176-177`) anahtarı bulamaz ve hidrasyon her profil için
sessizce hiç çalışmazdı (birleşik denetim P1-1; plan §10.3/§10.4 ile aynı).

**Ayrım (§8.3 ile birlikte okunacak):** paylaşımlı metadata cache ile profil kapsamlı
Taste index'in ayrımı şudur: fetch+cache katmanı profil-agnostiktir; index yazımı,
`activeHydrations`口语 concurrency guard'ı ve rebuild tetiklemesi profil kapsamlıdır.

### 8.5 Aynı İçeriğin Birden Fazla Profilde Hydration'ı (Doğrulanmış Boşluk)

**Senaryo:** Profil A ve Profil B aynı `contentId`'leri içeriyor.

**Doğru olması gereken davranış:**

1. TMDB fetch `contentId` başına **bir kez** yapılır; ikinci profil cache hit alır
   (ortak cache'in getirisi, §8.3).
2. Ancak her profilin **kendi index'i** cache'ten beslenmelidir.

**Doğrulanmış boşluk:** `hydrateTasteMetadataBatch` cache tamamen doluysa
`{ inputs: [], fetched: 0, ... }` döndürür (`taste-metadata-hydrator.ts:251-258`) ve
`runHydrationLoop` `fetched === 0` olduğunda **turu ve döngüyü hemen bitirir**
(`taste-rebuild-coordinator.ts:164`). Sonuç: A profili içeriği cache'e doldurduktan sonra başlatılan
B profili hydration'ı **index yazımını hiç yapmadan** çıkar. A3'te döngü, cache-hit
turunda dahi profil index'ini cache'ten upsert etmelidir (WP-3 kabul kriteri olarak
eklendi: §3 WP-3 son madde).

**`fetched === 0` üç farklı nedene bağlıdır ve üçü de hydration'ı sessizce bitirir
(birleşik denetim ayrımı):** (1) **cache-hit** — batch `inputs: []` döndürür
(`taste-metadata-hydrator.ts:251-258`); (2) **API anahtarı yokluğu** — döngü başta
döner (`coordinator:155-156`; `scheduleTasteMetadataHydration` guard'ı `:176`);
(3) **fetch başarısızlığı** — `failed` sayacı artar (`hydrator:270-277`) ve
`fetched = 0` kalır. A3'te bu üç durum ayrı kabul senaryoları olarak ele alınır (§9);
yalnızca neden (1), tek ortak yardımcıyla profil index beslemesine çevrilir.

**Tek ortak yardımcı (birleşik denetim P2-9):** cache'ten profil index'i oluşturma
mantığı tek yardımcıda toplanır: `seedProfileIndexFromCache(profileId, dataDir,
contentIds)`. Mevcut `tasteMetadataCacheToInput` çevirimi (`coordinator:136-142`,
çağrı `:617`) temel alınır; bootstrap'in cache→input döngüsü (`coordinator:614-619`)
ve hydration'ın cache-hit turu bu yardımcıyı kullanır; bootstrap ve hydration için
mükerrer mantık yazılmaz (plan §10.4, §11.1 adım 5 ile aynı).

**Eşzamanlılık notu (birleşik denetim P2-10):** cache okuması kilit dışındadır
(`hydrator:239, 247`), yazım kilit içindedir (`:291-296`): sıralı akışta aynı
`contentId` için tek TMDB fetch gerçekleşir; iki profil aynı `pending` kümesini
eşzamanlı görürse çift fetch olasılığı vardır — kilit yalnızca cache yazımını korur.
Bu sınırlama A3'te belgelenir; `pending` hesabının kilit içine alınması isteğe bağlı
iyileştirmedir (değerlendirme A3 uygulamasına bırakılmıştır).

**Rebuild etkileşimi:** Her profil kendi `${dataDir}:${profileId}` zincirinde rebuild
tetikler; cache yazımı `shared-metadata-cache` kilidi altında profiller arası
çakışmasızdır (V22).

---

## 9. Test Senaryoları

> ⚠️ Aşağıdaki senaryolar **planlanmıştır**; bu hazırlık dokümanında test
> **çalıştırılmamıştır**. Sayılar tahmindir.

### WP-1 (wiring)

| Senaryo | Beklenen |
|---------|----------|
| `createTasteRouter` options ile `profileContext` alır | Handler'lar context'e erişir |
| Adapter options ile `profileContext` alır | `assertCurrent`/`assertWritable` aktif |
| Fallback adapter oluşturulursa | Aynı context örneğini alır (aynı referans) |
| Options'ta `profileContext` verilmezse | Tanımlı açık hata üretilir; küresel fallback **yok**; profil-siz mevcut testler (`tests/taste/stock-and-live-profile.test.mjs:358`, V23) açık ProfileContext ile güncellenir |

### WP-2 (kimlik kaynağı)

| Senaryo | Beklenen |
|---------|----------|
| Aktif profil `profile-1` iken `GET /profile` | `readTasteProfileForProfile('profile-1', ...)` çağrılır |
| İstekte `?profileId=profile-2` gönderilse | Yoksayılır; Store'a aktarılmaz |
| Context boş kimlikli olsa | Handler açık hata döndürür, global okumaya düşmez |
| İstemci `POST /domain-event` gövdesinde `profileId`/`sourceRevision` gönderirse | Yetkili kimlik değildir; hedef profil her zaman `profileContext.getCurrent().profileId`; `sourceRevision` sunucuda doğrulanır; uyuşmazlıkta 409 reddi (KULLANICI KARARI, v1.2.0) |

### WP-3 (coordinator izolasyonu)

| Senaryo | Beklenen |
|---------|----------|
| Profil A rebuild sırasında profil B rebuild tetiklenirse | Paralel ilerler, ayrı dizinlere yazar |
| Aynı profilde ardışık iki tetikleme | Zincirleme sıralama korunur |
| Rebuild sonrası manifest | Profil dizininde güncellenir, global manifest etkilenmez |

### Hydration (bkz. §8)

| Senaryo | Beklenen |
|---------|----------|
| Aynı `contentId` iki profil için hydrate edilirse | TMDB fetch tek kez yapılır (ortak cache); **her iki profilin index'i** güncellenir (§8.5) |
| Profil A hydration'ı sürerken Profil B hydration tetiklenirse | B düşmez; kendi `${dataDir}:${profileId}` döngüsünde çalışır (§8.4) |
| Cache tamamen doluysa (`fetched === 0`) | Profil index'i cache'ten upsert edilir; döngü yazımı atlamaz (§8.5) |
| API anahtarı yapılandırılmamışsa (`hydrationApiKeys` `dataDir` anahtarlı) | Hydration hiç çalışmaz (`coordinator:155-156`, `:176`) — ayrı kabul senaryosu (§8.5) |
| TMDB fetch başarısız olursa (`failed` sayacı artar) | `fetched = 0` olduğundan döngü biter; cache ve profil index güncellenmez — ayrı kabul senaryosu (§8.5) |
| Bootstrap sonrası hydration | `contentIds` yalnızca ilgili profilin event kümesinden türetilir (§8.2) |
| Route kaynaklı metadata girdisi (`taste-routes.ts:645, 707`) | Yalnızca aktif profilin index'ine yazılır |

### WP-4/WP-5 (ForProfile geçişi)

| Senaryo | Beklenen |
|---------|----------|
| `POST /event` sonrası | Olay yalnızca aktif profilin `profiles/p1-b64url-.../` dizinine yazılır |
| İkinci profil aynı contentId'ye olay yazsa | İki profilin event dosyaları bağımsız kalır |
| Adapter `processEvent` profil değişikliği algılarsa | `ProfileConflictError` → `ok:false, retryable:false` (mevcut davranış) |
| Override/objection işlemleri | Yalnızca aktif profilin index/objection dosyalarını değiştirir |
| Uzun süren rebuild/yazım sırasında profil değişirse | Yazma sonrası yeniden `assertWritable(ref)` (adapter kalıbı: `taste-service-adapter.ts:204-205`) veya revision damgalı yazım (§12.6) |

### WP-6 (regresyon)

| Senaryo | Beklenen |
|---------|----------|
| `npm run test:taste` (V20 dahil) | Tümü geçer |
| Global API doğrudan kullanımı (store testleri) | Davranış değişmeden geçer |
| `npm run lint` | Uyarısız geçer |

---

## 10. Geriye Dönük Uyumluluk ve Regresyon Kontrolleri

**Korunması zorunlu davranışlar:**

1. **Global Store API'leri değişmez** — `readTasteProfile(dataDir)` vb. imza ve
   davranış olarak bugünkü hâlini korur (V11'deki global blok: `taste-store.ts:335-490`).
   Wrapper, yönlendirme veya migration **yapılmaz** (§14).
2. **`profileContext` zorunluluğu (birleşik denetim P1-2 — KARAR, v1.2.0):** yeni
   router options alanı **ZORUNLU**dur; profil-siz çağrı küresel fallback'e düşmez,
   tanımlı hata verir; profil-siz mevcut testler açık ProfileContext sağlayarak
   güncellenir (örnek: `tests/taste/stock-and-live-profile.test.mjs:358`, V23) — kabul
   kriteri "güncellenen testlerle geçer"dir. `TasteServiceAdapterOptions.profileContext`
   alanı mevcut hâliyle korunur (adapter iyi tanımlı, V6).
3. **`personalReadGuard` zinciri değişmez** (V21).
4. **`cinetrack-data.json` salt-okunur kuralı** korunur (V18).
5. **Profil ID manifest sözleşmesi değişmez** — `_profile-id-map.json` şeması,
   `p1-b64url` dizin şeması ve `PROFILE_ID_PATTERN` dokunulmaz (V13, V14; §14).
6. **Kilit davranışı** — lease/heartbeat/FIFO parametreleri değişmez.
7. **Eski global veri politikası (KULLANICI KARARI — v1.2.0):** eski `data/taste/`
   global verisi otomatik dağıtılmaz ve korunur; otomatik profil aktarımı yapılmaz;
   hedef profil açıkça belirlenmeden migration yapılmaz; legacy global API davranışı
   ve geriye dönük uyumluluk sınırları belgelenir (plan v2.4.0 §12.4 Karar Durumu —
   B esası ile aynı).

**Regresyon kontrol listesi (WP-6'da çalıştırılacak):**

- [ ] `npm run test:taste` — mevcut 23 dosyalık paket (V20: `taste-profile-store.test.mjs` 8 test dahil)
- [ ] `npm run lint` — `eslint src server.ts tests --max-warnings 0 && tsc --noEmit && tsc --noEmit -p tsconfig.tests.json`
- [ ] `tests/taste/migration.test.mjs` ve `tests/taste/faz5-migration.test.mjs` değişmeden geçer
- [ ] Global API kullanan mevcut testler (`taste-store.test.mjs`, `taste-store-integration.test.mjs`, `stock-and-live-profile.test.mjs`) değişmeden geçer
- [ ] Elle smoke: sunucu başlar, `/api/taste/manifest` yanıt verir, başlangıç sağlık kontrolü çalışır

---

## 11. Tamamlanma Kriterleri Özeti

| Paket | Kriter |
|-------|--------|
| WP-1 | Tek `profileContext` örneği adapter + router options + fallback'e iletilir; `profileContext` **ZORUNLU** (küresel fallback yok); `ProfileContext.ts` değişmez |
| WP-2 | Route'lar profil kimliğini yalnızca ProfileContext'ten alır; istemci kimliği Store'a sızmaz |
| WP-3 | Coordinator tamamen profil kapsamlı; `activeRebuildChains`, `bootstrapPromises`, `bootstrapSignatures`, `activeHydrations` `${dataDir}:${profileId}` anahtarlı; `hydrationApiKeys` `dataDir` kalır |
| WP-4 | `taste-routes.ts`'de global Store importu kalmaz |
| WP-5 | Adapter'de global Store çağrısı kalmaz; mevcut doğrulama akışı korunur |
| WP-6 | `test:taste` + `lint` geçer; yeni izolasyon/akış testleri eklenir |
| Genel | §14 sınırlarına hiçbir madde ihlal edilmez; test/CI çalıştırılmayan hiçbir sonuç çalıştırılmış gösterilmez |

---

## 12. Açık Teknik Konular (Çözülemeyen / Kullanıcı Kararı)

### 12.1 "default" vs "profile-default" (plan v2.4.0 §12.3 ile ortak teşhis)

`app.ts:494` ProfileContext'i `initialProfileId: 'default'` ile kurar (V3). **Teşhis:**
kalıcı veri belgelerindeki aktif profil kimliği `profile-default`'tur (normalizasyon
`src/core/cinetrack-core.ts:849-852`; `synchronizeProfileContext` bu değeri belgeden
taşır — `app.ts:83-93`); `PROFILE_ID_PATTERN` `profile-default`'ı kabul eder
(`src/core/cinetrack-core.ts:717`, V14). Dolayısıyla kalıcı belgelerden beslenen
ForProfile çağrıları normal çalışma zamanında hataya düşmez. **`'default'` geçici bir
açılış değeridir**: belge yüklenmeden önceki açılış penceresinde kullanılır
(`app.ts:540` öncesi) ve pencere, belge yok/eksik ya da kanonik olmayan
`activeProfileId` içeren her yüklemede yeniden açılır (çünkü `synchronizeProfileContext`
doğrulamadan yazar — `app.ts:83-85`). **A3 kuralı:** senkronizasyon
`validateCanonicalProfileId` (`src/server/taste-profile-scope.ts:125-173`) ile doğrular;
desen reddi `:166-170`'teki kontrolde `TasteProfileScopeError` üretir; geçersiz/kanonik
olmayan kimlik açık hata olarak reddedilir. Kalıcı veri kimliği `'profile-default'`
korunur; kimlik dönüşümü yapılmaz (§14).

Kullanıcı kararı (v1.2.0): kimlik sözleşmesi değişikliği (plan §12.4 Seçenek C)
**uygulanmaz**; eski veri kararı B esasıdır (bkz. §14 ve plan §12.4 Karar Durumu).

### 12.2 Bootstrap kaynak verisinin profil ataması

`ensureInitialTasteBootstrap` aktif profilin verisinden bootstrap eder (V16, V18):
item katmanı `activeProfile.items`'tan, olay katmanı `migrateExistingData` aracılığıyla
`doc.activeProfileId`'den türetilir (`migration.ts:59-61`; aktif profil seçimi
`coordinator:551-552`). `computeBootstrapSignature` (`coordinator:198-226`) bugün
yalnızca global dosyaları imzalar ve profil kapsamlı girdi içermez (birleşik denetim
P2-8): profil verisindeki değişiklikleri algılamaz; WP-3 kapsamında profil kapsamlı
girdiler eklenir. Hedef/kaynak profil tutarlılığı §7'deki garanti kuralı
(`profileId === doc.activeProfileId`) ile sağlanır. Per-profile bootstrap işletim
modelinin A4'e alınması bir inceleme ÖNERİSİDİR, karar değildir; bu hazırlık veri
taşıma/atama yapmaz (§14).

### 12.3 Metadata cache paylaşımlılığı

Cache `contentId` bazlı ve tüm profiller arasında paylaşımlıdır (V22). Teorik
çakışma riski düşüktür; profil bazlı cache ayrımı bu hazırlığın kapsamı dışındadır.

### 12.4 Startup sağlık kontrolündeki global manifest okuması

`app.ts:588` `readTasteManifest(resolvedDataDir)` global okur (V19). Bunun profil
kapsamına alınması (ve hangi profilin manifest'ine bakılacağı) ayrı bir tasarım
noktasıdır; WP kapsamına alınmadı.

### 12.5 Adapter `processedEventIds` Set'i

`ServerTasteServiceAdapter.processedEventIds` profil bazlı değildir ve sınırsız
büyür (`taste-service-adapter.ts:161`). Profil kapsamına alınması (anahtar biçimi:
`eventId` mi `profileId:eventId` mi) ve bellek büyümesi A3 tasarımında netleştirilmelidir.

### 12.6 Revision senkronizasyonu

Store'un profil kapsamlı yazıcıları (`writeTasteProfileForProfile`
`taste-store.ts:551-565`, `writeTasteIndexForProfile` `:577-590`) revision kontrolü
**yapmaz** ve `ProfileContext.commitRevision`'ı çağırmaz — stale-write korumasının
gerçek sınırı budur (birleşik denetim P2-6; plan v2.4.0 §10.1 NOT ile ortak).
Route/adapter katmanının planı üç aşamalı deseni zorunlu kılar: (1) okuma öncesi
`assertCurrent(ref)`, (2) mutasyon öncesi `assertWritable(ref)`, (3) **yazma sonrası**
yeniden `assertWritable(ref)` — mevcut adapter kalıbı
`taste-service-adapter.ts:204-205` — veya revision damgalı yazım. `commitRevision`
güncellemesi profil geçiş akışında A3 tasarımında tanımlı tutulur.

---

## 13. Agent 2 İncelemesiyle Çakışabilecek Noktalar

Aşağıdaki maddeler Agent 2'nin paralel incelemesinde farklı yorumlanabilir;
karar öncesi koordinasyon önerilir:

1. **Wiring sorumluluk ayrımı (§4):** "Adapter router'a ProfileContext aktarır"
   şeklindeki eski plan ifadelerinin düzeltilmesi gerekir; bu doküman
   "app.ts dağıtır, adapter almaz/aktarmaz" ayrımını esas alır. Plan dokümanı
   v2.4.0 (PR #38) ile uyumludur.
2. **`triggerTasteProfileRebuild` imzası (v1.2.0 — ÇÖZÜLDÜ):** her iki doküman
   `triggerTasteProfileRebuild(profileId, dataDir)` imzasını kullanır (plan v2.4.0
   §7.2/§10.3; bu doküman §7, §8.2). Eski `(dataDir, profileId)` önerisi kaldırılmıştır.
3. **`getProfileIdFromRequest` imzası:** Plan dokümanı §10.1
   `(profileContext)` parametresiyle tanımlar; `req` tabanlı eski ifadeler
   terk edilmiştir. Agent 2 incelemesi aynı imzayı doğrulamalıdır.
4. **Manifest yazma (v1.2.0 — ÇÖZÜLDÜ):** plan v2.4.0 §6.2, profil yazıcılarının
   manifest'i kilit altında kendilerinin güncellediğini doğruladı
   (`writeManifestForPathsUnlocked`, `taste-store.ts:198`; kullanım `:563`, `:588`);
   V12 doğrudur ve ikisinde de aynı anlatımlıdır; çelişki kapanmıştır.
5. **Test dosyası adları/sayıları:** Plan v2.4.0'da eski global API yönlendirme
   testi önerisi kaldırılmıştır; `test:taste` paketi 23 dosyalıktır. Uygulama öncesi
   tek test listesi haline getirilmelidir (bu doküman §3 WP-6 ve §9 listesini esas alır).
6. **`upsertTasteMetadataInputs` kapsam etiketi:** Plan dokümanı bu fonksiyonu
   bazen "A2 entegrasyon" bazen "coordinator sorumluluğu" olarak sınıflandırır;
   bu doküman onu WP-3 (coordinator) içinde ele alır.
7. **Hydration izolasyonu (v1.1.0 eki):** §8, WP-3 kapsamını hydration akışına
   genişletir: `runHydrationLoop`/`scheduleTasteMetadataHydration`/`configureTasteHydration`
   profil parametresi kazanır, `activeHydrations`/`hydrationApiKeys` anahtar şeması
   değişir ve cache-hit turunda index upsert'i zorunlu hâle gelir (§8.5). Plan v2.4.0 hydration akışını da ele alır (§5.3 Map'leri,
   §7.2 Risk 3/5, §10.3/§10.4, §11.1 adım 6); Map şeması (P1-1) ve imza tekleştirmesi
   iki dokümanda aynıdır.
8. **Ortaklaşa kapatılan birleşik denetim kararları (v1.2.0):** zorunlu
   `profileContext` + güncellenen profil-siz testler (P1-2); bootstrap hedef-profil
   garantisi (P1-3); `seedProfileIndexFromCache` ortak yardımcısı (P2-9);
   `fetched === 0` üç-neden ayrımı; stale-write üç aşamalı deseni (P2-6); kanonik
   doğrulama kuralı (P2-5); veri sahipliği triadı (P2-7). Tam karşılıklar plan
   v2.4.0 §5.3/§7.2/§9.2/§10.1/§10.3/§10.4/§12.3/§12.4'tedir.

---

## 14. Kesin Sınırlar — Karar Verilmeyen Konular

Aşağıdaki konularda bu hazırlık dokümanı karar vermez; 1, 3 ve 4 numaralı konular
kullanıcı kararıyla kesinleşmiştir (v1.2.0) ve plan dokümanı v2.4.0 ile aynıdır.
Diğer konularda A3 kodlaması bu dokümandan yetki almaz:

| # | Konu | Sınır |
|---|------|-------|
| 1 | "default" profil kimliği sözleşmesinin değiştirilmesi | **KARAR VERİLDİ (v1.2.0):** sözleşme değişikliği (Seçenek C) uygulanmaz; kalıcı veri kimliği `profile-default` gitmez, `default` geçici açılış değeridir; bkz. §12.1, plan §12.3/§15.2 |
| 2 | `PROFILE_ID_PATTERN` genişletilmesi | Yapılmayacak — pattern ve tüketici noktaları (V14) dokunulmaz |
| 3 | `'profile-default'` dönüşümü | Yapılmayacak — kalıcı veri kimliği korunur; plan §12.4 Karar Durumu (B esası) |
| 4 | Eski global Taste verilerinin taşınması / migration | **KARAR VERİLDİ (v1.2.0):** `data/taste/` verisi korunur; otomatik dağıtım/aktarım yok; hedef profil açıklıca belirlenmeden migration yok; plan §12.4 ile aynı |
| 5 | Global API'lerin ForProfile wrapper'larına dönüştürülmesi | Yapılmayacak — global API'ler davranışını korur (§10.1) |
| 6 | A4 BackgroundManager Taste entegrasyonu | A3'e dahil değildir — `src/modules/background/*` dokunulmaz |
| 7 | Backup, sync, restore, öneri algoritması | Dokunulmaz — `excel-profile-backup.ts`, `github-bidirectional-sync.ts`, `restore-journal.ts`, öneri modülleri kapsam dışı |

---

## Değişiklik Geçmişi

- **v1.2.0:** Birleşik denetim düzeltmeleri; plan v2.4.0 (PR #38) ile unifikasiyon.
  Kullanıcı kararları uygulandı: eski global Taste verisi B esası (otomatik dağıtım/
  taşıma yok, korunur, hedef profil belirlenmeden migration yok, legacy davranış ve
  uyumluluk sınırları belgelenir) ve `/domain-event` kimlik otoritesi sunucuda
  (istemci `profileId` yetkili değil; `sourceRevision` sunucuda doğrulanır; uyuşmazlıkta 409).
  Birleşik denetim kapanışları: `activeHydrations` `${dataDir}:${profileId}`,
  `hydrationApiKeys` `dataDir` kalır (P1-1); zorunlu `profileContext` + profil-siz
  test güncellemesi (P1-2); bootstrap hedef-profil garantisi (P1-3); manifest gerçek
  davranışı (P2-1); `triggerTasteProfileRebuild(profileId, dataDir)` imza tekbiçimleme
  (P2-2); §6 çağrı satırı düzeltmeleri (P2-3/P2-4); "default"/"profile-default" ayrımı
  ve kanonik doğrulama kuralı (P2-5); stale-write üç aşamalı desen (P2-6); veri
  sahipliği triadı (P2-7); `computeBootstrapSignature` profil girdisi (P2-8);
  `seedProfileIndexFromCache` ortak yardımcısı (P2-9); eşzamanlı çift-fetch uyarısı
  (P2-10); `event.profileId` doğrulama girdisi (P2-11); §10 dosya sayısı 23 olarak
  düzeltildi; V6/V8/V9/V15/V23 doğrulama satırları güncellendi. Kaynak kod değişmedi.
- **v1.1.0:** §8 hydration akışı izolasyon analizi eklendi (mevcut akış doğrulaması,
  profil aidiyeti ve `contentIds` kaynağı, ortak cache vs profil index ayrımı,
  `activeHydrations`/`hydrationApiKeys` anahtar değerlendirmesi, çok profilli
  hydration ve cache-hit boşluğu); WP-3 tablosu ve kabul kriteri hydration/bootstrap
  dahil yeniden yazıldı; §6 ve §9 tabloları hydration çağrı zinciriyle güncellendi.
  Kaynak kod değişmedi; test/CI çalıştırılmadı.
- **v1.0.0:** İlk hazırlık dokümanı.

---

## Teslim Durumu

- **A3 kaynak kodu değiştirilmedi.** Bu doküman yalnızca hazırlık kapsamıdır.
- Bu hazırlık sırasında **test ve CI çalıştırılmadı**; hiçbir test sonucu
  çalıştırılmış/geçmiş olarak sunulmaz.
- Kaynak kod doğrulamaları §1'deki V1–V23 listesindedir.
- Doküman tamamlandığında durulmuştur; A3 kodlaması ayrı talimatla başlar (bu
  güncellemede **A3 kaynak kodu değiştirilmedi**, test ve CI çalıştırılmadı).
