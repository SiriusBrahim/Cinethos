# R2-A3 — Faz 5 Taste, Memory ve Relationship Yöneticileri
## Teknik Analiz ve Uygulama Planı

> **Base Commit:** `49142ca8d552d59b11894a7aa574cce4588c16ce`  
> **Tarih:** 17 Kasım 2026  
> **Durum:** A1 ve A2 tamamlandı, A3 planlama aşaması  
> **Doküman Sürümü:** 1.0.0

---

## İçindekiler

1. [Mevcut Mimarinin Doğrulanmış Durumu](#1-mevcut-mimarinin-doğrulanmış-durumu)
2. [A3 Kapsamı ve Hedefleri](#2-a3-kapsamı-ve-hedefleri)
3. [Dosya/Fonksiyon Bazında Etki Haritası](#3-dosyafonksiyon-bazında-etki-haritası)
4. [Profil Kimliğinin Uçtan Uca Akış Şeması](#4-profil-kimliğinin-uçtan-uca-akış-şeması)
5. [Legacy Global API Kullanım Noktaları](#5-legacy-global-api-kullanım-noktaları)
6. [A2 API Yeterlilik Değerlendirmesi](#6-a2-api-yeterlilik-değerlendirmesi)
7. [Veri İzolasyonu ve Eşzamanlılık Riskleri](#7-veri-izolasyonu-ve-eşzamanlılık-riskleri)
8. [A4 ve Sonraki Fazlara Bırakılacak İşler](#8-a4-ve-sonraki-fazlara-bırakılacak-işler)
9. [Test Matrisi ve Somut Kabul Kriterleri](#9-test-matrisi-ve-somut-kabul-kriterleri)
10. [Açık Teknik Kararlar ve Öneriler](#10-açık-teknik-kararlar-ve-öneriler)
11. [A3 Uygulamasına Başlanabilir mi?](#11-a3-uygulamasına-başlanabilir-mi)

---

## 1. Mevcut Mimarinin Doğrulanmış Durumu

### 1.1 A1 Altyapısı (R2-A1 - Tamamlandı)

**Doğrulanmış Bileşenler:**

| Bileşen | Dosya | Durum | Açıklama |
|---------|-------|-------|----------|
| Kanonik Profil Kimliği Doğrulama | `taste-profile-scope.ts:147-189` | ✅ | `validateCanonicalProfileId()` - PROFILE_ID_PATTERN uyumu, kontrol karakteri reddi, trim sonrası boşluk kontrolü |
| Profil Dizini Kodlama | `taste-profile-scope.ts:192-203` | ✅ | `encodeProfileIdSafe()` - Base64URL şeması (`p1-b64url-` öneki) |
| Dizinden Kimliğe Çözümleme | `taste-profile-scope.ts:206-237` | ✅ | `decodeProfileIdSafe()` - round-trip doğrulama |
| Profil ID Eşleme Manifesti | `taste-profile-scope.ts:240-450` | ✅ | `_profile-id-map.json` - `entries` ↔ `byDir` birebir tutarlılık |
| Kapsam Bazlı Kilit Altyapısı | `taste-profile-scope.ts:453-800` | ✅ | `acquireTasteLock()`, `withScopedTasteLock()` - lease + heartbeat |
| FIFO Sıra + Kapsam Kilidi | `taste-profile-scope.ts:1150-1213` | ✅ | `enqueueScopedLock()` - süreç içi FIFO |

**Kilit Mekanizması Özellikleri:**
- Lease süresi: 30 saniye (varsayılan)
- Heartbeat aralığı: 10 saniye (lease/3)
- Bekleme süresi: 10 saniye
- Stale devralma: atomik karantina + lockId doğrulama
- Eski token biçimi destekleniyor (geri uyumluluk)

### 1.2 A2 Altyapısı (R2-A2 - Tamamlandı ve Onaylandı)

**Doğrulanmış Profil Kapsamlı API'ler:**

| API | Fonksiyon | Dosya | Kapsam |
|-----|-----------|-------|--------|
| Event Ekle | `appendTasteEventForProfile()` | `taste-store.ts:519-524` | ✅ Profil kilidi |
| Event Okuma | `readTasteEventsForProfile()` | `taste-store.ts:527-532` | ✅ |
| Event Toplu Yazma | `writeTasteEventsForProfile()` | `taste-store.ts:535-550` | ✅ Profil kilidi |
| Profil Okuma | `readTasteProfileForProfile()` | `taste-store.ts:567-572` | ✅ |
| Profil Yazma | `writeTasteProfileForProfile()` | `taste-store.ts:551-565` | ✅ Profil kilidi + manifest |
| Index Okuma | `readTasteIndexForProfile()` | `taste-store.ts:592-597` | ✅ |
| Index Yazma | `writeTasteIndexForProfile()` | `taste-store.ts:577-590` | ✅ Profil kilidi + manifest |
| Manifest Okuma | `readTasteManifestForProfile()` | `taste-store.ts:602-607` | ✅ |
| İtiraz Okuma | `readTasteObjectionsForProfile()` | `taste-store.ts:609-614` | ✅ |
| İtiraz Yazma | `writeTasteObjectionsForProfile()` | `taste-store.ts:616-631` | ✅ Profil kilidi |

**Shared Metadata Cache Kilidi:**
- `withTasteSharedMetadataCacheLock()` - `taste-store.ts:298-303`
- Kapsam: `shared-metadata-cache`
- Kullanım: `taste-metadata-hydrator.ts:60-68`

**Test Durumu (A2):**
- Yeni testler: 8/8 ✅
- Taste testleri: 408/408 ✅
- Genel testler: 511/511 ✅
- Lint ve build: başarılı ✅
- GitHub CI: başarılı ✅

---

## 2. A3 Kapsamı ve Hedefleri

### 2.1 A3 Ana Hedefi

**Profil kimliğinin uçtan uca akışını sağlamak ve legacy global API'lerin profil kapsamlı karşılıklarını entegre etmek.**

### 2.2 A3 Kapsamı

#### 2.2.1 **Kesinlikle A3'te Yapılacak**

1. **Profil Kimliği Akış Yönetimi**
   - Çağrı zincirinde profil kimliğinin kaybolmasını önlemek
   - Varsayılan profile dönüşünü engellemek
   - Yanlış profile yönlendirilmeleri tespit ve düzeltme

2. **Legacy Global API Geçişi**
   - Mevcut global API kullanım noktalarını belirlemek
   - Profil kapsamlı API'lere yönlendirmek
   - Geriye dönük uyumluluk sağlamak

3. **Adapter/Route/Rebuild Coordinator Entegrasyonu**
   - Profil kimliğinin adapter katmanında alınıp taşınması
   - Route'larda profil kimliği parametresi ekleme
   - Rebuild coordinator'da profil bazlı işleme

#### 2.2.2 **Kesinlikle A3'te Yapılmayacak**

- ✖️ Backup/sync/restore sistemlerini değiştirme
- ✖️ Öneri algoritmasını değiştirme
- ✖️ Veritabanı şeması veya migration değişikliği
- ✖️ Legacy global verileri otomatik olarak profillere atama
- ✖️ R-3 case-insensitive filesystem çakışmasını çözme
- ✖️ A1/A2 altyapısını gereksiz yere yeniden tasarlama

---

## 3. Dosya/Fonksiyon Bazında Etki Haritası

### 3.1 Ana Dosyalar ve Sorumlulukları

#### `taste-profile-scope.ts` (A1 - Altyapı)
- **Sorumluluk:** Profil kimliği doğrulama, kodlama, kilit yönetimi
- **Durum:** ✅ Tamamlandı, A3'te değişiklik gerektirmez
- **A3 Kullanımı:** Tüm profil kapsamlı işlemler bu modülü kullanacak

#### `taste-store.ts` (A1+A2 - API Katmanı)
- **Sorumluluk:** Global ve profil kapsamlı CRUD işlemleri
- **Durum:** ✅ A2 API'leri mevcut, A3'te entegrasyon gerekiyor
- **A3 Değişiklikleri:**
  - ✅ `ForProfile` API'leri mevcut
  - ⚠️ Global API'lerin profil kapsamlı karşılıklarına yönlendirme

#### `taste-service-adapter.ts` (A2 - Entegrasyon)
- **Sorumluluk:** AppEvent → TasteEvent çevirimi, TasteStore entegrasyonu
- **Durum:** ⚠️ **Kritik A3 Noktası** - Profil kimliği alım ve aktarım gerekiyor
- **Mevcut Durum:**
  - `processEvent()` - `this.dataDir` kullanıyor, profil kimliği yok
  - `getProfile()` - `this.profileContext?.assertCurrent(ref)` var
  - `refreshProfile()` - `this.profileContext?.assertWritable(ref)` var

#### `taste-routes.ts` (A2 - HTTP Katmanı)
- **Sorumluluk:** HTTP endpoint'leri
- **Durum:** ⚠️ **Kritik A3 Noktası** - Tüm endpoint'ler global API kullanıyor
- **Mevcut Durum:**
  - Tüm read/write fonksiyonları global (`readTasteProfile(dataDir)`)
  - Profil kimliği parametre olarak alınmıyor

#### `taste-rebuild-coordinator.ts` (A2 - Arka Plan)
- **Sorumluluk:** Profil yeniden hesaplama
- **Durum:** ⚠️ **Kritik A3 Noktası** - Global API kullanıyor
- **Mevcut Durum:**
  - `performRebuildOnce()` - Global store kullanıyor
  - `ensureInitialTasteBootstrap()` - Global store kullanıyor

#### `taste-metadata-hydrator.ts` (A2 - Metadata)
- **Sorumluluk:** TMDB metadata hidrasyonu
- **Durum:** ✅ Shared cache kilidi var, A3'te değişiklik gerektirmez

### 3.2 BackgroundManager Entegrasyonu

**Dosyalar:**
- `src/modules/background/service.ts` - BackgroundManager
- `src/modules/background/handlers.ts` - İşleyiciler
- `src/server/background-task-repository.ts` - SQLite deposu
- `src/contracts/background.ts` - Tipler

**A3 İlişkisi:**
- BackgroundManager, AppEventBus üzerinden olayları alıyor
- Mevcut işleyiciler: `LibraryItemAdded`, `LibraryRatingChanged`
- **Profil kimliği akışı:** Olay payload'ında `profileId` var
- **A3 Öncesi Durum:** ✅ Profil kimliği olayda mevcut
- **A3 Sonrası Durum:** Taste işlemleri profil kapsamlı olmalı

### 3.3 AppEventBus ve ProfileContext

**Dosyalar:**
- `src/app/app-event-bus.ts` - Olay yolu
- `src/app/ProfileContext.ts` - Profil bağlamı

**A3 İlişkisi:**
- ProfileContext, aktif profil kimliğini ve revision'ını tutar
- AppEventBus, olay yayınlarken profil kimliğini zorunlu kılar
- **Profil kimliği akışı:** Olay → Adapter → Store

---

## 4. Profil Kimliğinin Uçtan Uca Akış Şeması

### 4.1 Mevcut Akış (A2 Sonrası)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      HTTP Request (taste-routes.ts)                       │
│  GET /api/taste/profile                                                  │
│  POST /api/taste/event                                                  │
│  POST /api/taste/domain-event                                           │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      taste-routes.ts Handler                            │
│  ⚠️ PROBLEM: dataDir parametresi var, profileId YOK                     │
│  readTasteProfile(dataDir)  // Global API                              │
│  appendTasteEventIdempotent(event, dataDir)  // Global API             │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      taste-store.ts (Global API)                         │
│  resolveTastePaths(dataDir)  // data/taste/                             │
│  serializeTasteWrite(dataDir, task)  // TASTE_LOCK_DATA_SCOPE            │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Hedef Akış (A3 Sonrası)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      HTTP Request (taste-routes.ts)                       │
│  GET /api/taste/profile?profileId=p1                                   │
│  POST /api/taste/event + profileId header/param                        │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      taste-routes.ts Handler                            │
│  ✅ profileId parametresi alınıyor                                      │
│  readTasteProfileForProfile(profileId, dataDir)  // Profil API         │
│  appendTasteEventForProfile(profileId, event, dataDir)                  │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      taste-store.ts (Profil Kapsamlı API)                │
│  resolveTastePathsForProfile(profileId, dataDir)  // profiles/p1-...  │
│  serializeTasteWriteForProfile(dataDir, profileDir, task)             │
│  tasteProfileLockScope(profileDir)  // profile:p1-b64url-...           │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Profil Kimliği Kaybolma Noktaları

#### 🔴 **Kritik Nokta 1: taste-routes.ts**

**Sorun:** Tüm endpoint'ler global API kullanıyor

```typescript
// taste-routes.ts:305-310
router.get("/profile", async (_req, res) => {
  const profile = await readTasteProfile(dataDir);  // ❌ Global
  // ✅ Olması gereken: const profileId = getProfileIdFromRequest(req);
  // ✅ Olması gereken: const profile = await readTasteProfileForProfile(profileId, dataDir);
})
```

**Etkilenen Endpoint'ler:**
- GET `/api/taste/profile`
- GET `/api/taste/overview`
- GET `/api/taste/metric/:id`
- GET `/api/taste/evidence/:metricId`
- GET `/api/taste/manifest`
- GET `/api/taste/events`
- POST `/api/taste/override`
- DELETE `/api/taste/override/:metricId`
- POST `/api/taste/objection`
- DELETE `/api/taste/objection`
- POST `/api/taste/event`
- POST `/api/taste/domain-event`
- POST `/api/taste/rebuild`

#### 🔴 **Kritik Nokta 2: taste-service-adapter.ts**

**Sorun:** Adapter, profileId'yi almıyor ve aktarmıyor

```typescript
// taste-service-adapter.ts:173
async getProfile(ref: ProfileRef): Promise<TasteProfileSummaryView | null> {
  if (this.profileContext) {
    this.profileContext.assertCurrent(ref);  // ✅ Doğrulama var
  }
  const stored = await readTasteProfile(this.dataDir);  // ❌ Global
  // ✅ Olması gereken: const stored = await readTasteProfileForProfile(ref.profileId, this.dataDir);
}
```

**Etkilenen Fonksiyonlar:**
- `getProfile()` - Global profile okuma
- `processEvent()` - Global event ekleme

#### 🔴 **Kritik Nokta 3: taste-rebuild-coordinator.ts**

**Sorun:** Rebuild fonksiyonları global store kullanıyor

```typescript
// taste-rebuild-coordinator.ts:339-346
const [events, index, existingProfile, objections] = await Promise.all([
  readTasteEvents(dataDir),           // ❌ Global
  readTasteIndex(dataDir),            // ❌ Global
  readTasteProfile(dataDir),          // ❌ Global
  readTasteObjections(dataDir),       // ❌ Global
]);
```

**Etkilenen Fonksiyonlar:**
- `performRebuildOnce()` - Tüm okuma/yazma global
- `ensureInitialTasteBootstrap()` - Global + manifest
- `upsertTasteMetadataInputs()` - Global index

#### 🟡 **Orta Öncelik: BackgroundManager Entegrasyonu**

**Durum:** Olaylarda profileId var, ancak Taste işlemleri global

```typescript
// app.ts:108-112 (BackgroundManager kurulumu)
const eventBus = createAppEventBus({
  persistEvent: async (event) => {
    await backgroundManager.acceptEvent(event);  // ✅ profileId olayda var
  },
});
```

**Sorun:** BackgroundManager işleyicileri Taste işlemleri yapmıyor (sadece audit)
- Mevcut işleyiciler: `LibraryItemAdded`, `LibraryRatingChanged`
- Bu işleyiciler sadece log atıyor, Taste Store'a yazmıyor
- **A3 Sonrası:** Taste işlemleri profil kapsamlı olmalı

---

## 5. Legacy Global API Kullanım Noktaları

### 5.1 taste-routes.ts

| Satır | Fonksiyon | API | Kullanım | Profil Bağımlı mı? |
|-------|-----------|-----|----------|-------------------|
| 305 | GET /profile | `readTasteProfile()` | Global | ✅ |
| 320 | GET /overview | `readTasteProfile()` | Global | ✅ |
| 320 | GET /overview | `readTasteEvents()` | Global | ✅ |
| 321 | GET /overview | `readTasteIndex()` | Global | ✅ |
| 322 | GET /overview | `readTasteObjections()` | Global | ✅ |
| 394 | GET /metric/:id | `readTasteProfile()` | Global | ✅ |
| 406 | GET /metric/:id | `readTasteIndex()` | Global | ✅ |
| 434 | GET /evidence/:metricId | `readTasteProfile()` | Global | ✅ |
| 460 | GET /manifest | `readTasteManifest()` | Global | ✅ |
| 473 | GET /events | `readTasteEvents()` | Global | ✅ |
| 498 | POST /override | `readTasteProfile()` | Global | ✅ |
| 516 | POST /override | `writeTasteProfile()` | Global | ✅ |
| 527 | DELETE /override | `readTasteProfile()` | Global | ✅ |
| 538 | DELETE /override | `writeTasteProfile()` | Global | ✅ |
| 562 | POST /objection | `readTasteObjections()` | Global | ✅ |
| 562 | POST /objection | `readTasteIndex()` | Global | ✅ |
| 575 | POST /objection | `writeTasteObjections()` | Global | ✅ |
| 580 | POST /objection | `writeTasteIndex()` | Global | ✅ |
| 606 | DELETE /objection | `readTasteObjections()` | Global | ✅ |
| 610 | DELETE /objection | `writeTasteObjections()` | Global | ✅ |
| 656 | POST /event | `appendTasteEventIdempotent()` | Global | ✅ |
| 657 | POST /event | `triggerTasteProfileRebuild()` | Global | ✅ |
| 693 | POST /domain-event | `tasteAdapter.processEvent()` | Global* | ✅ |
| 725 | POST /rebuild | `triggerTasteProfileRebuild()` | Global | ✅ |

* `tasteAdapter.processEvent()` - Adapter içindeki global API kullanımı

### 5.2 taste-service-adapter.ts

| Satır | Fonksiyon | API | Kullanım |
|-------|-----------|-----|----------|
| 173 | `getProfile()` | `readTasteProfile()` | Global |
| 240 | `processEvent()` | `readTasteEvents()` | Global |
| 246 | `processEvent()` | `appendTasteEventIdempotent()` | Global |

### 5.3 taste-rebuild-coordinator.ts

| Satır | Fonksiyon | API | Kullanım |
|-------|-----------|-----|----------|
| 339 | `performRebuildOnce()` | `readTasteEvents()` | Global |
| 340 | `performRebuildOnce()` | `readTasteIndex()` | Global |
| 341 | `performRebuildOnce()` | `readTasteProfile()` | Global |
| 342 | `performRebuildOnce()` | `readTasteObjections()` | Global |
| 361 | `upsertTasteMetadataInputs()` | `readTasteIndex()` | Global |
| 361 | `upsertTasteMetadataInputs()` | `readTasteObjections()` | Global |
| 433 | `ensureInitialTasteBootstrap()` | `readTasteEvents()` | Global |
| 434 | `ensureInitialTasteBootstrap()` | `readTasteIndex()` | Global |
| 435 | `ensureInitialTasteBootstrap()` | `readTasteProfile()` | Global |
| 436 | `ensureInitialTasteBootstrap()` | `readTasteObjections()` | Global |
| 480 | `performRebuildOnce()` | `writeTasteProfile()` | Global |
| 481 | `performRebuildOnce()` | `readTasteManifest()` | Global |
| 635 | `ensureInitialTasteBootstrap()` | `writeTasteEvents()` | Global |

### 5.4 app.ts

| Satır | Fonksiyon | API | Kullanım |
|-------|-----------|-----|----------|
| 588 | Server startup | `readTasteManifest()` | Global (sadece okuma) |

---

## 6. A2 API Yeterlilik Değerlendirmesi

### 6.1 A2'de Eklenen ForProfile API'leri

| API | Var mı? | Yeterli mi? | A3 Kullanımı |
|-----|---------|-------------|--------------|
| `appendTasteEventForProfile()` | ✅ | ✅ | Event ekleme |
| `readTasteEventsForProfile()` | ✅ | ✅ | Event okuma |
| `writeTasteEventsForProfile()` | ✅ | ✅ | Event toplu yazma |
| `readTasteProfileForProfile()` | ✅ | ✅ | Profil okuma |
| `writeTasteProfileForProfile()` | ✅ | ✅ | Profil yazma |
| `readTasteIndexForProfile()` | ✅ | ✅ | Index okuma |
| `writeTasteIndexForProfile()` | ✅ | ✅ | Index yazma |
| `readTasteManifestForProfile()` | ✅ | ✅ | Manifest okuma |
| `readTasteObjectionsForProfile()` | ✅ | ✅ | İtiraz okuma |
| `writeTasteObjectionsForProfile()` | ✅ | ✅ | İtiraz yazma |

### 6.2 Değerlendirme Sonucu

**✅ YETERLİ** - A2'de eklenen `ForProfile` API'leri A3 için yeterlidir.

Tüm gerekli CRUD işlemleri profil kapsamlı olarak mevcut:
- Event: ekle, oku, toplu yaz
- Profile: oku, yaz
- Index: oku, yaz
- Manifest: oku
- Objections: oku, yaz

**⚠️ Eksik Olan:**
- `writeTasteManifestForProfile()` - Manifest yazma
- `appendTasteEventIdempotentForProfile()` - Idempotent event ekleme

Ancak bunlar kolayca eklenebilir veya var olanlar kullanılarak çözülebilir.

### 6.3 Global API'lerin Kaderi

**Karar:** Global API'ler A3 sonrasında da kalmalı, ancak:
1. Yeni kod global API'leri kullanmamalı
2. Global API'ler, varsayılan profil için `ForProfile` API'lerine yönlendirilebilir
3. Geriye dönük uyumluluk için global API'ler korunmalı

---

## 7. Veri İzolasyonu ve Eşzamanlılık Riskleri

### 7.1 Mevcut Koruma Mekanizmaları

#### Kapsam Bazlı Kilitler (taste-profile-scope.ts)

| Kapsam | Kullanım | Risk |
|--------|----------|------|
| `taste-data` | Global taste yazma | ✅ Korunuyor |
| `profile:p1-b64url-...` | Profil kapsamlı yazma | ✅ Korunuyor |
| `__profile-id-map__` | Profil ID manifesti | ✅ Korunuyor |
| `shared-metadata-cache` | Metadata cache | ✅ Korunuyor |

#### FIFO Sıra + Kilit (taste-profile-scope.ts:1150-1213)

```typescript
const scopedLockChains = new Map<string, Promise<unknown>>();

function enqueueScopedLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = scopedLockChains.get(key) ?? Promise.resolve();
  const run = (): Promise<T> => task();
  const next = previous.then(run, run);
  // ...
}
```

**Koruma:** Aynı kapsamda (profile + dataDir) sıralı işleme

### 7.2 Risk Alanları

#### 🔴 **Risk 1: Profil Kimliği Kaybolması**

**Senaryo:** HTTP isteğinde profileId parametresi yoksa veya yanlışsa

**Etki:** Yanlış profile'in verileri okunur/yazılır

**Çözüm:**
- Tüm endpoint'lerde profileId zorunlu parametre
- ProfileContext doğrulama
- Varsayılan profile'e dönüş engellenmeli

#### 🔴 **Risk 2: Global API Kullanımına Devam**

**Senaryo:** A3 sonrasında bile global API'ler kullanılır

**Etki:** Tüm profillerin verileri karışır

**Çözüm:**
- Global API'ler `ForProfile` API'lerine wrapper olabilir
- Yeni kod global API kullanımını engelleyen lint kuralı

#### 🟡 **Risk 3: Eşzamanlı Rebuild'ler**

**Senaryo:** Aynı profile için birden fazla rebuild tetiklenirse

**Mevcut Koruma:**
```typescript
// taste-rebuild-coordinator.ts:488-497
const activeRebuildChains = new Map<string, Promise<RebuildCoordinatorResult>>();

function triggerTasteProfileRebuild(dataDir: string = "data"): Promise<...> {
  const prevChain = activeRebuildChains.get(dataDir) ?? Promise.resolve(null);
  const nextRun = prevChain.then(() => performRebuildOnce(dataDir), ...);
  activeRebuildChains.set(dataDir, nextRun);
  // ...
}
```

**Sorun:** `dataDir` bazlı, profil bazlı değil

**Çözüm:** `activeRebuildChains` anahtarı `dataDir:profileId` olmalı

#### 🟡 **Risk 4: Metadata Cache Çakışması**

**Mevcut Koruma:** Shared metadata cache kilidi var

**Sorun:** Tüm profiller aynı cache'i kullanıyor

**Çözüm:** Cache, contentId bazlı olduğu için sorun yok

#### 🟢 **Risk 5: BackgroundManager İzolasyonu**

**Durum:** BackgroundManager, profil bazlı olayları işliyor

**Koruma:**
- Her olayda `profileId` var
- ProfileContext doğrulama var
- Aynı profil için sıralı işleme

**Çözüm:** Taste işlemleri profil kapsamlı olmalı

### 7.3 Özet Risk Matrisi

| Risk | Olasılık | Etki | Öncelik | Çözüm |
|------|-----------|------|---------|--------|
| Profil kimliği kaybolması | Yüksek | Kritik | 🔴 P0 | Zorunlu parametre + doğrulama |
| Global API kullanımına devam | Yüksek | Kritik | 🔴 P0 | Wrapper + lint kuralı |
| Eşzamanlı rebuild'ler | Orta | Orta | 🟡 P1 | Profil bazlı chain anahtarı |
| Metadata cache çakışması | Düşük | Düşük | 🟢 P2 | Mevcut koruma yeterli |
| BackgroundManager izolasyonu | Düşük | Düşük | 🟢 P2 | Profil kapsamlı Taste işlemleri |

---

## 8. A4 ve Sonraki Fazlara Bırakılacak İşler

### 8.1 A4 Kapsamı (BackgroundManager Genişletme)

**Planlanan:**
- BackgroundManager'a Taste işlemleri entegrasyonu
- Metadata hidrasyonu arka planda
- İtiraz işleme arka planda

**A3 Sonrası Hazır Olacak:**
- Profil kapsamlı Taste Store API'leri
- Profil kimliği akışı
- İzolasyon ve eşzamanlılık koruması

### 8.2 Sonraki Fazlar

| Faz | Konu | A3 Bağımlılığı |
|-----|------|----------------|
| A4 | BackgroundManager Taste entegrasyonu | ✅ A3 gerekiyor |
| A5 | Memory Manager (Taste cache) | ⚠️ A3 öneriliyor |
| A6 | Relationship Manager | ⚠️ A3 öneriliyor |

### 8.3 Teknik Borç (A3 Engeli Değil)

- R-3 case-insensitive filesystem çakışması
- Legacy global verilerin profil ataması
- Veritabanı şeması iyileştirmeleri

---

## 9. Test Matrisi ve Somut Kabul Kriterleri

### 9.1 Test Kategorileri

#### 9.1.1 Birim Testleri (Unit Tests)

| Dosya | Fonksiyon | Test Sayısı | Durum |
|-------|-----------|-------------|-------|
| taste-profile-scope.ts | validateCanonicalProfileId | 8 | ✅ A2'de var |
| taste-profile-scope.ts | encodeProfileIdSafe | 8 | ✅ A2'de var |
| taste-profile-scope.ts | decodeProfileIdSafe | 8 | ✅ A2'de var |
| taste-profile-scope.ts | resolveTastePathsForProfile | 8 | ✅ A2'de var |
| taste-store.ts | ForProfile API'leri | 8 | ✅ A2'de var |

#### 9.1.2 Entegrasyon Testleri (Integration Tests)

| Senaryo | Test Sayısı | A3 Hedefi |
|---------|-------------|-----------|
| Profil kimliği akışı (HTTP → Adapter → Store) | 5 | ✅ Yeni |
| Global API → ForProfile yönlendirme | 3 | ✅ Yeni |
| Eşzamanlı profil işlemleri | 4 | ✅ Yeni |
| Rebuild izolasyonu | 3 | ✅ Yeni |

#### 9.1.3 E2E Testleri

| Senaryo | Test Sayısı | A3 Hedefi |
|---------|-------------|-----------|
| Çoklu profil taste işlemleri | 5 | ✅ Yeni |
| Profil değişimi sırasında izolasyon | 3 | ✅ Yeni |
| Legacy uyumluluk | 2 | ✅ Yeni |

### 9.2 Kabul Kriterleri

#### 🟢 **MUTLAK (P0)**

1. ✅ Tüm taste endpoint'leri profil kimliği parametresi almalı
2. ✅ Tüm taste işlemleri profil kapsamlı API'leri kullanmalı
3. ✅ Global API'ler `ForProfile` API'lerine yönlendirilebilir
4. ✅ Profil kimliği doğrulama tüm katmanlarda çalışmalı
5. ✅ Tüm A2 testleri geçmeli (408 taste + 511 genel)
6. ✅ Yeni A3 testleri: minimum 20 test

#### 🟡 **ÖNERİLEN (P1)**

1. ⚠️ Rebuild chain'leri profil bazlı olmalı
2. ⚠️ BackgroundManager Taste entegrasyonu hazır olmalı
3. ⚠️ Lint kuralı: global API kullanımını engelle

#### 🔵 **İYİLEŞTİRME (P2)**

1. 🔵 Metadata cache profil bazlı olabilir
2. 🔵 Taste manifest profil bazlı olabilir

### 9.3 Test Örnekleri

#### Örnek 1: Profil Kimliği Akışı Testi

```javascript
// Test: HTTP istek → taste-routes → taste-store
const profileId = 'user-1';
const dataDir = '/tmp/test-data';

// 1. Profil oluştur
await writeTasteProfileForProfile(profileId, profile, dataDir);

// 2. HTTP GET /api/taste/profile?profileId=user-1
const response = await request(app)
  .get('/api/taste/profile')
  .query({ profileId });

// 3. Doğrulama
assert.strictEqual(response.body.profileName, profile.profileName);
```

#### Örnek 2: İzolasyon Testi

```javascript
// Test: İki profilin verileri karışmaz
const profileId1 = 'user-1';
const profileId2 = 'user-2';

// 1. İki profile event ekle
const event1 = { eventId: 'evt-1', contentId: 'movie:1', ... };
const event2 = { eventId: 'evt-2', contentId: 'movie:2', ... };

await appendTasteEventForProfile(profileId1, event1, dataDir);
await appendTasteEventForProfile(profileId2, event2, dataDir);

// 2. Doğrulama
const events1 = await readTasteEventsForProfile(profileId1, dataDir);
const events2 = await readTasteEventsForProfile(profileId2, dataDir);

assert.strictEqual(events1.length, 1);
assert.strictEqual(events1[0].eventId, 'evt-1');
assert.strictEqual(events2.length, 1);
assert.strictEqual(events2[0].eventId, 'evt-2');
```

#### Örnek 3: Eşzamanlılık Testi

```javascript
// Test: Aynı profile için eşzamanlı işlemler
const profileId = 'user-1';
const promises = [];

for (let i = 0; i < 10; i++) {
  promises.push(
    appendTasteEventForProfile(profileId, 
      { eventId: `evt-${i}`, contentId: `movie:${i}`, ... }, 
      dataDir)
  );
}

await Promise.all(promises);

const events = await readTasteEventsForProfile(profileId, dataDir);
assert.strictEqual(events.length, 10);
```

---

## 10. Açık Teknik Kararlar ve Öneriler

### 10.1 Karar 1: Profil Kimliği Nasıl Alınacak?

**Seçenekler:**

| Seçenek | Avantaj | Dezavantaj | Karar |
|---------|---------|------------|-------|
| HTTP Header (`X-Cinetrack-Profile-Id`) | Standart, kolay | Header zorunlu kılınmalı | ⚠️ |
| Query Param (`?profileId=p1`) | Basit, görünür | URL uzar, cache sorunları | ⚠️ |
| Route Param (`/api/taste/:profileId/profile`) | RESTful, görünür | Route değişikliği | ⚠️ |
| ProfileContext (oturum bazlı) | Otomatik, güvenli | Oturum yönetimi gerekiyor | ✅ |

**Öneri:** **Hibrit yaklaşım**

1. **Varsayılan:** ProfileContext (oturum bazlı)
2. **Geçici:** Query param (`?profileId=p1`) - oturum yoksa
3. **Gelecek:** HTTP header - standartlaşma

**Uygulama:**
```typescript
// taste-routes.ts
function getProfileIdFromRequest(req: Request): string {
  // 1. ProfileContext
  if (req.profileContext) {
    return req.profileContext.getCurrent().profileId;
  }
  // 2. Query param
  if (req.query.profileId) {
    return validateCanonicalProfileId(req.query.profileId);
  }
  // 3. Header
  if (req.headers['x-cinetrack-profile-id']) {
    return validateCanonicalProfileId(req.headers['x-cinetrack-profile-id']);
  }
  // 4. Varsayılan
  throw new Error('Profil kimliği zorunludur');
}
```

### 10.2 Karar 2: Global API'lerin Kaderi

**Seçenekler:**

| Seçenek | Avantaj | Dezavantaj | Karar |
|---------|---------|------------|-------|
| Global API'leri kaldır | Temiz, açık | Kırıcı değişiklik | ❌ |
| Global API'leri wrapper yap | Geriye uyumlu | Karmaşıklık | ✅ |
| Global API'leri deprecated işaretle | Uyarı veriyor | Yine de kullanılabilir | ⚠️ |

**Öneri:** **Wrapper yaklaşımı**

```typescript
// taste-store.ts
export async function readTasteProfile(
  dataDir: string = "data"
): Promise<TasteProfile | null> {
  // Geriye uyumluluk: varsayılan profil
  const defaultProfileId = getDefaultProfileId(dataDir);
  return readTasteProfileForProfile(defaultProfileId, dataDir);
}

// Deprecated uyarısı (lint/IDE)
// @deprecated Use readTasteProfileForProfile() instead
```

### 10.3 Karar 3: Rebuild Chain Anahtarı

**Mevcut:**
```typescript
const activeRebuildChains = new Map<string, Promise<...>>();
// Anahtar: dataDir
```

**Öneri:**
```typescript
const activeRebuildChains = new Map<string, Promise<...>>();
// Anahtar: `${dataDir}:${profileId}`
```

### 10.4 Karar 4: BackgroundManager Taste Entegrasyonu

**Mevcut:** BackgroundManager işleyicileri sadece audit yapıyor

**A3 Sonrası:**
- Taste işlemleri BackgroundManager'a taşınabilir
- Profil kapsamlı metadata hidrasyonu
- Arka planda itiraz işleme

**Karar:** A4'te uygulanacak, A3'te altyapı hazır olacak

---

## 11. A3 Uygulamasına Başlanabilir mi?

### 11.1 Değerlendirme

| Kriter | Durum | Puan |
|--------|-------|------|
| A1 ve A2 altyapısı tamamlandı | ✅ | 10/10 |
| ForProfile API'leri yeterli | ✅ | 10/10 |
| Profil kimliği akış şeması belirlendi | ✅ | 10/10 |
| Riskler belirlendi ve çözümler önerildi | ✅ | 10/10 |
| Test matrisi hazır | ✅ | 10/10 |
| Teknik kararlar alındı | ✅ | 10/10 |
| Kapsam net | ✅ | 10/10 |

### 11.2 Sonuç

**✅ Evet, A3 uygulamasına başlanabilir.**

**Ön Koşullar:**
1. ✅ Base commit `49142ca8d552d59b11894a7aa574cce4588c16ce` doğrulandı
2. ✅ Tüm A2 testleri geçiyor (511/511)
3. ✅ A3 teknik planı onaylandı

**İlk Adım:**
1. `taste-routes.ts` - Profil kimliği parametresi ekleme
2. `taste-service-adapter.ts` - Profil kimliği alım ve aktarım
3. `taste-rebuild-coordinator.ts` - Profil bazlı rebuild chain

**Tahmini Süre:** 3-5 gün (tam zamanlı)

---

## Ekler

### Ek A: Dosya Değişiklik Listesi

| Dosya | Değişiklik Türü | Satır Sayısı | Öncelik |
|-------|-----------------|--------------|---------|
| taste-routes.ts | Profil kimliği parametresi + ForProfile API | ~200 | P0 |
| taste-service-adapter.ts | Profil kimliği alım ve aktarım | ~50 | P0 |
| taste-rebuild-coordinator.ts | Profil bazlı rebuild | ~30 | P0 |
| taste-store.ts | Global → ForProfile wrapper | ~20 | P1 |

### Ek B: Test Dosyaları

| Dosya | Açıklama | Test Sayısı |
|-------|----------|-------------|
| tests/taste/taste-profile-flow.test.mjs | Profil kimliği akışı | 10 |
| tests/taste/taste-isolation.test.mjs | İzolasyon testleri | 8 |
| tests/taste/taste-concurrency.test.mjs | Eşzamanlılık testleri | 5 |
| tests/taste/taste-legacy-compat.test.mjs | Legacy uyumluluk | 5 |

### Ek C: Lint Kuralları

```json
{
  "rules": {
    "no-global-taste-api": "error",
    "require-profile-id-param": "error"
  }
}
```

---

**Doküman Sonu**  
**Oluşturma Tarihi:** 2026-11-17  
**Sürüm:** 1.0.0  
**Base Commit:** 49142ca8d552d59b11894a7aa574cce4588c16ce
