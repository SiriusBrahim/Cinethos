# R2-A3 — Uygulama Hazırlık Dokümanı (MIA Faz 5)

> **Base Commit:** `49142ca8d552d59b11894a7aa574cce4588c16ce` (master)
> **Tarih:** 17 Kasım 2026
> **Doküman Sürümü:** 1.0.0
> **İlgili Plan:** `docs/mia/faz5/R2-A3-TEKNİK-ANALİZ-VE-PLAN.md` (v2.2.0, PR #38)
> **Durum:** Hazırlık — **A3 kaynak kodu HENÜZ DEĞİŞTİRİLMEDİ.**

> ⚠️ **Kapsam notu:** Bu doküman yalnızca A3 kodlamasına hazırlıktır. Kod yazımı, mimari
> karar kesinleştirme ve migration içermez. Plan dokümanındaki ifadeler kaynağıyla
> yeniden doğrulanmıştır; doğrulanamayan ifadeler "açık konu" olarak işaretlenmiştir
> (bkz. §11) ve gerçek kabul edilmemiştir.

---

## İçindekiler

1. [Doğrulanmış Kaynak Kod Durumu](#1-doğrulanmış-kaynak-kod-durumu)
2. [A3 İş Paketleri ve Bağımlılık Sırası](#2-a3-iş-paketleri-ve-bağımlılık-sırası)
3. [İş Paketi Detayları](#3-iş-paketi-detayları)
4. [Sorumluluk Ayrımı: Adapter / Router / Coordinator](#4-sorumluluk-ayrımı-adapter--router--coordinator)
5. [ProfileContext Uçtan Uca Aktarım Planı](#5-profilecontext-uçtan-uca-aktarım-planı)
6. [ForProfile API Geçiş Tablosu](#6-forprofile-api-geçiş-tablosu)
7. [Rebuild Coordinator Profil İzolasyonu Planı](#7-rebuild-coordinator-profil-izolasyonu-planı)
8. [Test Senaryoları](#8-test-senaryoları)
9. [Geriye Dönük Uyumluluk ve Regresyon Kontrolleri](#9-geriye-dönük-uyumluluk-ve-regresyon-kontrolleri)
10. [Tamamlanma Kriterleri Özeti](#10-tamamlanma-kriterleri-özeti)
11. [Açık Teknik Konular (Çözülemeyen / Kullanıcı Kararı)](#11-açık-teknik-konular)
12. [Agent 2 İncelemesiyle Çakışabilecek Noktalar](#12-agent-2-incelemesiyle-çakışabilecek-noktalar)
13. [Kesin Sınırlar — Karar Verilmeyen Konular](#13-kesin-sınırlar)

---

## 1. Doğrulanmış Kaynak Kod Durumu

Aşağıdaki noktalar bu hazırlık sırasında **kaynak koddan birebir doğrulanmıştır**
(plan dokümanındaki ifadelerden bağımsız olarak):

| # | Nokta | Dosya:Satır | Doğrulama |
|---|-------|-------------|-----------|
| V1 | `createProfileContext` yalnızca boş profil kimliğini reddeder; `PROFILE_ID_PATTERN` doğrulaması **yapmaz** | `src/app/ProfileContext.ts:42-56` | ✅ Okundu |
| V2 | `ProfileContext` API: `getCurrent()`, `assertCurrent(ref)`, `assertWritable(ref)`, `getRevision()`, `commitRevision()`, `switchProfile()`, `onProfileChange()` | `src/app/ProfileContext.ts:60-236` | ✅ Okundu |
| V3 | `profileContext`, `initialProfileId: 'default'` ile oluşturuluyor | `src/server/app.ts:493-496` | ✅ Okundu |
| V4 | Adapter oluşturulurken `profileContext` **iletilmiyor** | `src/server/app.ts:498-501` | ✅ Okundu |
| V5 | `createTasteRouter` çağrısında options'ta `profileContext` **yok**; mevcut alanlar: `tmdbApiKey`, `eventBus`, `tasteAdapter`, `deferAdapterSubscription`, `onDomainEvent`, `onRawTasteEvent` | `src/server/app.ts:2666-2685` | ✅ Okundu |
| V6 | `TasteServiceAdapterOptions.profileContext?: IProfileContext` **zaten mevcut** ve constructor'da saklanıyor | `src/server/taste-service-adapter.ts:36-40, 152-158` | ✅ Okundu |
| V7 | Adapter global API kullanıyor: `readTasteProfile` (`getProfile`), `readTasteEvents` + `appendTasteEventIdempotent` (`processEvent`); `assertCurrent`/`assertWritable` çağrıları mevcut | `src/server/taste-service-adapter.ts:167-261` | ✅ Okundu |
| V8 | Adapter `refreshProfile` ve `processEvent` içinde `triggerTasteProfileRebuild(this.dataDir)` çağırıyor | `src/server/taste-service-adapter.ts:187, 253` | ✅ Okundu |
| V9 | `createTasteRouter(dataDir, options)` imzası; options'ta profil alanı yok; fallback adapter `options.tasteAdapter ?? createServerTasteServiceAdapter({ dataDir, rebuildOnEvent: true })` şeklinde oluşturuluyor | `src/server/taste-routes.ts:275-291` | ✅ Okundu |
| V10 | 13 taste endpoint'i tümüyle global API kullanıyor | `src/server/taste-routes.ts:302-732` | ✅ Okundu |
| V11 | ForProfile API'leri mevcut: event (499-533), profile (551-575), index (577-597), manifest okuma (602-607), objections (612-631) | `src/server/taste-store.ts` | ✅ Okundu |
| V12 | `writeTasteProfileForProfile` ve `writeTasteIndexForProfile`, manifest'i kilit altında **kendi içinde** güncelliyor (`writeManifestForPathsUnlocked`). Ayrı bir `writeTasteManifestForProfile` export'u **yok** ve profil yazma yolunda gerekmiyor | `src/server/taste-store.ts:551-575, 198-230` | ✅ Okundu |
| V13 | `validateCanonicalProfileId`, `PROFILE_ID_PATTERN` testini yapıyor; `encodeProfileIdSafe`/`decodeProfileIdSafe` ve `resolveTastePathsForProfile` bu doğrulamaya bağlı | `src/server/taste-profile-scope.ts:125-203, 289-295` | ✅ Okundu |
| V14 | `PROFILE_ID_PATTERN = /^(?:profile-[A-Za-z0-9_-]{1,60}\|p\d{1,10})$/` — `'default'` **eşleşmez**; pattern `src/core/cinetrack-core.ts:809, 850`'de de kullanılıyor | `src/core/cinetrack-core.ts:717` | ✅ Okundu |
| V15 | `activeRebuildChains` anahtarı yalnızca `dataDir`; `triggerTasteProfileRebuild(dataDir)` tek parametreli | `src/server/taste-rebuild-coordinator.ts:69, 494-507` | ✅ Okundu |
| V16 | `performRebuildOnce(dataDir)` ve `ensureInitialTasteBootstrap(dataDir)` global store API'lerini kullanıyor; `upsertTasteMetadataInputs` global index/objections okuyor | `src/server/taste-rebuild-coordinator.ts:333-369, 431-492, 519-660` | ✅ Okundu |
| V17 | `bootstrapPromises` ve `bootstrapSignatures` haritaları yalnızca `dataDir` anahtarlı | `src/server/taste-rebuild-coordinator.ts:70-71` | ✅ Okundu |
| V18 | Bootstrap, `data/cinetrack-data.json`'ı **yalnızca okur** (Mutlak Kural: asla yazılmaz) | `src/server/taste-rebuild-coordinator.ts:545-553` | ✅ Okundu |
| V19 | Başlangıç sağlık kontrolü global `readTasteManifest(resolvedDataDir)` okuyor | `src/server/app.ts:588` | ✅ Okundu |
| V20 | A2 profil kapsamlı store testleri mevcut: 8 test | `tests/taste/taste-profile-store.test.mjs` | ✅ Sayıldı |
| V21 | `/api/taste` router'ı `personalReadGuard` arkasında mount ediliyor | `src/server/app.ts:2662-2665` | ✅ Okundu |
| V22 | Metadata cache `shared-metadata-cache` kilit kapsamıyla korunuyor, `contentId` bazlı ve paylaşımlı | `src/server/taste-store.ts:319-333`, `src/server/taste-metadata-hydrator.ts:51-93` | ✅ Okundu |

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

---

## 3. İş Paketi Detayları

### WP-1 — ProfileContext Wiring

**Değişecek dosyalar ve fonksiyonlar:**

| Dosya | Değişiklik |
|-------|-----------|
| `src/server/app.ts:498-501` | `createServerTasteServiceAdapter` çağrısına `profileContext` eklenir |
| `src/server/app.ts:2666-2685` | `createTasteRouter` options'ına `profileContext` eklenir |
| `src/server/taste-routes.ts:276-287` | Options tipine `profileContext?: IProfileContext` alanı eklenir |

**Yeniden kullanılacak mevcut fonksiyonlar (değişiklik yok):**

- `createProfileContext` — `src/app/ProfileContext.ts:239-241`
- `TasteServiceAdapterOptions.profileContext` — `src/server/taste-service-adapter.ts:38`
  (adapter tarafında yeni kod **gerekmez**)
- `personalReadGuard` mount zinciri — `src/server/app.ts:2662-2665`

**Tamamlanma kriterleri:**

- [ ] `app.ts` içindeki tek `profileContext` örneği hem adapter'a hem router options'ına iletilir.
- [ ] Fallback adapter (`taste-routes.ts:287-288`) da aynı `profileContext`'i alır.
- [ ] Options alanı opsiyoneldir; `profileContext` verilmeden `createTasteRouter` çağıran mevcut testler/kullanımlar kırılmaz.
- [ ] `ProfileContext.ts` dosyasında hiçbir değişiklik yapılmaz.

### WP-2 — Route Katmanında Profil Kimliği Kaynağı

**Değişecek dosyalar ve fonksiyonlar:**

| Dosya | Değişiklik |
|-------|-----------|
| `src/server/taste-routes.ts` | Yeni iç yardımcı: profil kimliğini yalnızca `profileContext.getCurrent()`'dan okuyan fonksiyon (plan dokümanında `getProfileIdFromRequest(profileContext)` olarak adlandırılır) |
| `src/server/taste-routes.ts:302-732` | 13 handler, profil kimliğini bu yardımcıdan alır |

**Yeniden kullanılacak mevcut fonksiyonlar:**

- `ProfileContext.getCurrent()` — `src/app/ProfileContext.ts:63-65`
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

### WP-3 — Rebuild Coordinator Profil İzolasyonu

**Değişecek dosyalar ve fonksiyonlar:**

| Fonksiyon | Dosya:Satır | Değişiklik |
|-----------|-------------|-----------|
| `triggerTasteProfileRebuild` | `taste-rebuild-coordinator.ts:494-507` | İkinci parametre `profileId`; zincir anahtarı `${dataDir}:${profileId}` |
| `performRebuildOnce` | `taste-rebuild-coordinator.ts:431-492` | `profileId` parametresi; 4 okuma + profil yazma ForProfile API'lerine geçer |
| `ensureInitialTasteBootstrap` | `taste-rebuild-coordinator.ts:519-660` | `profileId` parametresi; okuma/yazma ve `bootstrapPromises`/`bootstrapSignatures` anahtarları profil kapsamlı |
| `upsertTasteMetadataInputs` | `taste-rebuild-coordinator.ts:333-369` | `profileId` parametresi; index/objections okuma ForProfile |
| `activeRebuildChains` | `taste-rebuild-coordinator.ts:69` | Anahtar `${dataDir}:${profileId}` |
| `bootstrapPromises`, `bootstrapSignatures` | `taste-rebuild-coordinator.ts:70-71` | Anahtar `${dataDir}:${profileId}` |

**Yeniden kullanılacak mevcut fonksiyonlar (değişiklik yok):**

- `executeAggregationOffMainThread` — saf hesaplama, profil bağımsız (`:371-429`)
- `computeBootstrapSignature` — veri kaynağı imzası (profil ataması açık konudur, bkz. §11.2)
- `ensureProfileTasteStoreEntry` / `resolveProfileTasteStore` — `src/server/taste-store.ts:181-196`
  (profil dizini + ID manifest girişi oluşturma A2'de hazır)
- `coerceItemToTasteMetadata`, `configureTasteHydration`, `scheduleTasteMetadataHydration`
  — metadata akışı (yalnızca çağıran taraf profil parametresi alır)

**Tamamlanma kriterleri:**

- [ ] Coordinator modülünde global okuma/yazma API çağrısı kalmaz (bootstrap'in
      `cinetrack-data.json` salt-okunur okuması hariçtir — bu bir Store API çağrısı değildir).
- [ ] Farklı profiller için aynı anda tetiklenen rebuild'ler birbirini bloklamaz.
- [ ] Aynı profil için ardışık rebuild'ler sıralanır (mevcut zincir davranışı korunur).

### WP-4 — Route ForProfile Geçişi

**Değişecek dosyalar ve fonksiyonlar:** `src/server/taste-routes.ts` — 13 endpoint
(satır numaraları V10 doğrulamasındadır). Geçiş tablosu: §6.

**Yeniden kullanılacak mevcut fonksiyonlar:** Tüm `ForProfile` API'leri
(`taste-store.ts:499-631`) olduğu gibi kullanılır; Store katmanına kod **eklenmez**.

**Tamamlanma kriterleri:**

- [ ] `taste-routes.ts` içinde global taste Store API importu kalmaz.
- [ ] Her endpoint, WP-2'deki tek kaynaktan aldığı `profileId` ile ForProfile API çağırır.
- [ ] `triggerTasteProfileRebuild` çağrıları profil kimliği ile yapılır (546, 596, 622, 732 civarı).

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
- [ ] `profileContext` verilmediği senaryoda (opsiyonel param) mevcut davranış tanımlı ve test edilmiştir.
- [ ] `processedEventIds` idempotency Set'inin profil kapsamı açıkça karara bağlanmıştır (bkz. §11.5).

### WP-6 — Regresyon, Uyumluluk ve İzolasyon Testleri

**Değişecek dosyalar:** `tests/taste/` altında yeni test dosyaları (isimler planlanan;
plan dokümanı ile bu doküman arasındaki isim farkları §12.4'te işaretlidir).

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

createTasteRouter (taste-routes.ts:275-291)
  ├─ options.tasteAdapter ?? createServerTasteServiceAdapter({
  │     dataDir, profileContext: options.profileContext, rebuildOnEvent: true })   [fallback — aynı context]
  └─ route handler'ları → profileContext.getCurrent().profileId (closure/options)
```

**Değişmeyenler:**

- `initialProfileId` değeri (`'default'`) **dokunulmaz** — kimlik sözleşmesi kararı
  kullanıcıya aittir (bkz. §13). WP-1 bu değerin ne olduğunu değiştirmez; yalnızca
  context'in taşınmasını sağlar.
- `ProfileContext` sınıfı ve `createProfileContext` değişmez.
- `switchProfile`/`commitRevision` akışları A3 kapsamı dışındadır.

**Aktarım sırasında korunacak tek-örnek garantisi:** Aynı nesne örneği adapter'a,
router options'a ve fallback adapter'a verilir; kopya/ikinci context oluşturulmaz.

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
| `readTasteIndex(dataDir)` | `readTasteIndexForProfile(profileId, dataDir)` | routes: 316, 391, 546 · coordinator: 434, 538 |
| `writeTasteIndex(index, dataDir)` | `writeTasteIndexForProfile(profileId, index, dataDir)` | routes: 546, 596 |
| `readTasteManifest(dataDir)` | `readTasteManifestForProfile(profileId, dataDir)` | routes: 458 · coordinator: 443, 482 · **istisna:** `app.ts:588` startup sağlık kontrolü (bkz. §11.4) |
| `readTasteObjections(dataDir)` | `readTasteObjectionsForProfile(profileId, dataDir)` | routes: 546, 596 · coordinator: 336, 341 |
| `writeTasteObjections(obj, dataDir)` | `writeTasteObjectionsForProfile(profileId, obj, dataDir)` | routes: 546, 596 |
| `writeTasteEvents(events, dataDir)` | `writeTasteEventsForProfile(profileId, events, dataDir)` | coordinator: 635 (bootstrap) |
| `triggerTasteProfileRebuild(dataDir)` | `triggerTasteProfileRebuild(dataDir, profileId)` | routes: 546, 596, 622, 732 · adapter: 187, 253 |

**Notlar:**

- Global API'lerin kendileri **değişmez**; yalnızca çağıranlar geçer (bkz. §13/§9).
- Manifest ayrı yazma API'si gerekmez: profil yazmaları manifest'i kilit altında
  kendi içinde günceller (V12).
- `readTasteMetadataCache`/`writeTasteMetadataCache` paylaşımlı kalmaya devam eder
  (V22); profil bazlı cache ayrımı kapsam dışıdır (§13).

---

## 7. Rebuild Coordinator Profil İzolasyonu Planı

**Hedef durum (WP-3):**

1. **Zincir anahtarı:** `activeRebuildChains`, `bootstrapPromises`,
   `bootstrapSignatures` haritaları `${dataDir}:${profileId}` anahtarıyla çalışır.
   - Etki: Farklı profillerin rebuild/bootstrap işlemleri paralel ilerler;
     aynı profilin işlemleri mevcut FIFO zincirleme davranışıyla sıralanır.
2. **Fonksiyon imzaları:**
   - `performRebuildOnce(profileId, dataDir)`
   - `ensureInitialTasteBootstrap(profileId, dataDir)`
   - `upsertTasteMetadataInputs(inputs, profileId, dataDir)`
   - `triggerTasteProfileRebuild(dataDir, profileId)`
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

**Açık nokta:** Bootstrap'in kaynak verisi (`cinetrack-data.json`) profilsiz/global
bir belgedir; hangi profilin bu veriden bootstrap edileceği ve imza anahtarının
profile nasıl bağlanacağı tasarım sırasında netleştirilmelidir (§11.2). Bu doküman
bu konuda karar vermez.

---

## 8. Test Senaryoları

> ⚠️ Aşağıdaki senaryolar **planlanmıştır**; bu hazırlık dokümanında test
> **çalıştırılmamıştır**. Sayılar tahmindir.

### WP-1 (wiring)

| Senaryo | Beklenen |
|---------|----------|
| `createTasteRouter` options ile `profileContext` alır | Handler'lar context'e erişir |
| Adapter options ile `profileContext` alır | `assertCurrent`/`assertWritable` aktif |
| Fallback adapter oluşturulursa | Aynı context örneğini alır (aynı referans) |
| Options'ta context verilmezse | Mevcut davranış bozulmaz; route'lar tanımlı hatayı verir |

### WP-2 (kimlik kaynağı)

| Senaryo | Beklenen |
|---------|----------|
| Aktif profil `profile-1` iken `GET /profile` | `readTasteProfileForProfile('profile-1', ...)` çağrılır |
| İstekte `?profileId=profile-2` gönderilse | Yoksayılır; Store'a aktarılmaz |
| Context boş kimlikli olsa | Handler açık hata döndürür, global okumaya düşmez |

### WP-3 (coordinator izolasyonu)

| Senaryo | Beklenen |
|---------|----------|
| Profil A rebuild sırasında profil B rebuild tetiklenirse | Paralel ilerler, ayrı dizinlere yazar |
| Aynı profilde ardışık iki tetikleme | Zincirleme sıralama korunur |
| Rebuild sonrası manifest | Profil dizininde güncellenir, global manifest etkilenmez |

### WP-4/WP-5 (ForProfile geçişi)

| Senaryo | Beklenen |
|---------|----------|
| `POST /event` sonrası | Olay yalnızca aktif profilin `profiles/p1-b64url-.../` dizinine yazılır |
| İkinci profil aynı contentId'ye olay yazsa | İki profilin event dosyaları bağımsız kalır |
| Adapter `processEvent` profil değişikliği algılarsa | `ProfileConflictError` → `ok:false, retryable:false` (mevcut davranış) |
| Override/objection işlemleri | Yalnızca aktif profilin index/objection dosyalarını değiştirir |

### WP-6 (regresyon)

| Senaryo | Beklenen |
|---------|----------|
| `npm run test:taste` (V20 dahil) | Tümü geçer |
| Global API doğrudan kullanımı (store testleri) | Davranış değişmeden geçer |
| `npm run lint` | Uyarısız geçer |

---

## 9. Geriye Dönük Uyumluluk ve Regresyon Kontrolleri

**Korunması zorunlu davranışlar:**

1. **Global Store API'leri değişmez** — `readTasteProfile(dataDir)` vb. imza ve
   davranış olarak bugünkü hâlini korur (V11'deki global blok: `taste-store.ts:335-490`).
   Wrapper, yönlendirme veya migration **yapılmaz** (§13).
2. **Opsiyonel parametreler opsiyonel kalır** — `TasteServiceAdapterOptions.profileContext`
   ve yeni router options alanı zorunlu hâle getirilmez; mevcut çağıranlar kırılmaz.
3. **`personalReadGuard` zinciri değişmez** (V21).
4. **`cinetrack-data.json` salt-okunur kuralı** korunur (V18).
5. **Profil ID manifest sözleşmesi değişmez** — `_profile-id-map.json` şeması,
   `p1-b64url` dizin şeması ve `PROFILE_ID_PATTERN` dokunulmaz (V13, V14; §13).
6. **Kilit davranışı** — lease/heartbeat/FIFO parametreleri değişmez.

**Regresyon kontrol listesi (WP-6'da çalıştırılacak):**

- [ ] `npm run test:taste` — mevcut 24 dosyalık paket (V20: `taste-profile-store.test.mjs` 8 test dahil)
- [ ] `npm run lint` — `eslint src server.ts tests --max-warnings 0 && tsc --noEmit && tsc --noEmit -p tsconfig.tests.json`
- [ ] `tests/taste/migration.test.mjs` ve `tests/taste/faz5-migration.test.mjs` değişmeden geçer
- [ ] Global API kullanan mevcut testler (`taste-store.test.mjs`, `taste-store-integration.test.mjs`, `stock-and-live-profile.test.mjs`) değişmeden geçer
- [ ] Elle smoke: sunucu başlar, `/api/taste/manifest` yanıt verir, başlangıç sağlık kontrolü çalışır

---

## 10. Tamamlanma Kriterleri Özeti

| Paket | Kriter |
|-------|--------|
| WP-1 | Tek `profileContext` örneği adapter + router options + fallback'e iletilir; `ProfileContext.ts` değişmez |
| WP-2 | Route'lar profil kimliğini yalnızca ProfileContext'ten alır; istemci kimliği Store'a sızmaz |
| WP-3 | Coordinator tamamen profil kapsamlı; üç harita `${dataDir}:${profileId}` anahtarlı |
| WP-4 | `taste-routes.ts`'de global Store importu kalmaz |
| WP-5 | Adapter'de global Store çağrısı kalmaz; mevcut doğrulama akışı korunur |
| WP-6 | `test:taste` + `lint` geçer; yeni izolasyon/akış testleri eklenir |
| Genel | §13 sınırlarına hiçbir madde ihlal edilmez; test/CI çalıştırılmayan hiçbir sonuç çalıştırılmış gösterilmez |

---

## 11. Açık Teknik Konular

### 11.1 "default" kimliği ForProfile API'leriyle çalışmaz (BLOKE EDİCİ — kullanıcı kararı)

`app.ts:494` ProfileContext'i `initialProfileId: 'default'` ile kurar (V3), ancak
`PROFILE_ID_PATTERN` `'default'` kabul etmez (V14) ve `validateCanonicalProfileId`
hata fırlatır (V13). Sonuç: WP-3/WP-4/WP-5 tamamlandığında **varsayılan profil için
ForProfile çağrıları runtime'da hata üretir.**

Çözüm alternatifleri (kimlik sözleşmesi değişimi, `'profile-default'` dönüşümü vb.)
plan dokümanı §12.4'te kullanıcı onayına sunulmuştur. **Bu hazırlık dokümanı seçim
yapmaz**; A3 kodlaması bu karar olmadan anlamlı biçimde tamamlanamaz.

### 11.2 Bootstrap kaynak verisinin profil ataması

`ensureInitialTasteBootstrap` global `cinetrack-data.json`'dan bootstrap eder (V16,
V18). Bu verinin hangi profile ait sayılacağı ve `computeBootstrapSignature`'ın
profil kapsamı tanımlı değildir. Tasarım sırasında çözülmesi gerekir; bu doküman
veri taşıma/atama yapmaz (§13).

### 11.3 Metadata cache paylaşımlılığı

Cache `contentId` bazlı ve tüm profiller arasında paylaşımlıdır (V22). Teorik
çakışma riski düşüktür; profil bazlı cache ayrımı bu hazırlığın kapsamı dışındadır.

### 11.4 Startup sağlık kontrolündeki global manifest okuması

`app.ts:588` `readTasteManifest(resolvedDataDir)` global okur (V19). Bunun profil
kapsamına alınması (ve hangi profilin manifest'ine bakılacağı) ayrı bir tasarım
noktasıdır; WP kapsamına alınmadı.

### 11.5 Adapter `processedEventIds` Set'i

`ServerTasteServiceAdapter.processedEventIds` profil bazlı değildir ve sınırsız
büyür (`taste-service-adapter.ts:153`). Profil kapsamına alınması (anahtar biçimi:
`eventId` mi `profileId:eventId` mi) ve bellek büyümesi A3 tasarımında netleştirilmelidir.

### 11.6 Revision senkronizasyonu

ForProfile yazmalar `ProfileContext.commitRevision`'ı çağırmamaktadır
(`taste-store.ts:551-575` yalnızca dosya yazar). Yazma sonrası revision'ın
nasıl güncelleneceği A3 tasarımında tanımlanmalıdır.

---

## 12. Agent 2 İncelemesiyle Çakışabilecek Noktalar

Aşağıdaki maddeler Agent 2'nin paralel incelemesinde farklı yorumlanabilir;
karar öncesi koordinasyon önerilir:

1. **Wiring sorumluluk ayrımı (§4):** "Adapter router'a ProfileContext aktarır"
   şeklindeki eski plan ifadelerinin düzeltilmesi gerekir; bu doküman
   "app.ts dağıtır, adapter almaz/aktarmaz" ayrımını esas alır. Plan dokümanı
   v2.2.0 (PR #38) ile uyumlu olmalıdır.
2. **`triggerTasteProfileRebuild` parametre sırası:** Bu doküman
   `(dataDir, profileId)` önerir; `performRebuildOnce` için `(profileId, dataDir)`
   kullanılmıştır (plan dokümanı §10.4 ile aynı). İmzalar kesinleştirilirken tek
   biçime bağlanmalıdır.
3. **`getProfileIdFromRequest` imzası:** Plan dokümanı §10.1
   `(profileContext)` parametresiyle tanımlar; `req` tabanlı eski ifadeler
   terk edilmiştir. Agent 2 incelemesi aynı imzayı doğrulamalıdır.
4. **Manifest yazma:** Plan dokümanı "writeTasteManifestForProfile gerçekten
   eksik" der; bu doküman V12 ile bunun profil yazma yolunda zaten kilit altında
   yapıldığını ve ayrı API gerekmediğini gösterir. İncelemede bu iki ifade
   çelişebilir; V12 kaynak kod temellidir.
5. **Test dosyası adları/sayıları:** Plan dokümanı §9.1.2 ve Ek B'de
   (`taste-legacy-redirect`, `taste-legacy-compat-e2e` vb.) farklı ad/sayılar
   listeler; bu doküman §3 WP-6'daki listeyi esas alır. Uygulama öncesi tek
   liste haline getirilmelidir.
6. **`upsertTasteMetadataInputs` kapsam etiketi:** Plan dokümanı bu fonksiyonu
   bazen "A2 entegrasyon" bazen "coordinator sorumluluğu" olarak sınıflandırır;
   bu doküman onu WP-3 (coordinator) içinde ele alır.

---

## 13. Kesin Sınırlar

Aşağıdaki konularda **bu hazırlık dokümanı karar vermez ve A3 kodlaması bu
dokümandan yetki almaz**; tamamı kullanıcı kararıdır:

| # | Konu | Sınır |
|---|------|-------|
| 1 | "default" profil kimliği sözleşmesinin değiştirilmesi | Karar yok — §11.1'de bloke edici olarak işaretli |
| 2 | `PROFILE_ID_PATTERN` genişletilmesi | Yapılmayacak — pattern ve tüketici noktaları (V14) dokunulmaz |
| 3 | `'profile-default'` dönüşümü | Yapılmayacak — yalnızca plan dokümanı §12.4'te seçenek olarak durur |
| 4 | Eski global Taste verilerinin taşınması / migration | Yapılmayacak — `data/taste/` verisi olduğu gibi kalır |
| 5 | Global API'lerin ForProfile wrapper'larına dönüştürülmesi | Yapılmayacak — global API'ler davranışını korur (§9.1) |
| 6 | A4 BackgroundManager Taste entegrasyonu | A3'e dahil değildir — `src/modules/background/*` dokunulmaz |
| 7 | Backup, sync, restore, öneri algoritması | Dokunulmaz — `excel-profile-backup.ts`, `github-bidirectional-sync.ts`, `restore-journal.ts`, öneri modülleri kapsam dışı |

---

## Teslim Durumu

- **A3 kaynak kodu değiştirilmedi.** Bu doküman yalnızca hazırlık kapsamıdır.
- Bu hazırlık sırasında **test ve CI çalıştırılmadı**; hiçbir test sonucu
  çalıştırılmış/geçmiş olarak sunulmaz.
- Kaynak kod doğrulamaları §1'deki V1–V22 listesindedir.
- Doküman tamamlandığında durulmuş olunur; A3 kodlaması ayrı talimatla başlar.
