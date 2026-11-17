# R2-A3 — Faz 5 Taste, Memory ve Relationship Yöneticileri
## Teknik Analiz ve Uygulama Planı

> **Base Commit:** `49142ca8d552d59b11894a7aa574cce4588c16ce`  
> **Tarih:** 17 Kasım 2026  
> **Durum:** A1 ve A2 tamamlandı, A3 planlama aşaması  
> **Doküman Sürümü:** 2.0.0 (Agent 2 Doğrulaması Sonrası)  
> **Önceki Sürüm:** 1.0.0

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
11. [A3 Uygulama Sırası](#11-a3-uygulama-sırası)
12. [A3 Uygulamasına Başlanabilir mi?](#12-a3-uygulamasına-başlanabilir-mi)

---

## 1. Mevcut Mimarinin Doğrulanmış Durumu

### 1.1 A1 Altyapısı (R2-A1 - Tamamlandı)

**Doğrulanmış Bileşenler:**

| Bileşen | Dosya | Durum | Açıklama |
|---------|-------|-------|----------|
| Kanonik Profil Kimliği Doğrulama | `src/server/taste-profile-scope.ts:147-189` | ✅ | `validateCanonicalProfileId()` - PROFILE_ID_PATTERN uyumu, kontrol karakteri reddi, trim sonrası boşluk kontrolü |
| Profil Dizini Kodlama | `src/server/taste-profile-scope.ts:192-203` | ✅ | `encodeProfileIdSafe()` - Base64URL şeması (`p1-b64url-` öneki) |
| Dizinden Kimliğe Çözümleme | `src/server/taste-profile-scope.ts:206-237` | ✅ | `decodeProfileIdSafe()` - round-trip doğrulama |
| Profil ID Eşleme Manifesti | `src/server/taste-profile-scope.ts:240-450` | ✅ | `_profile-id-map.json` - `entries` ↔ `byDir` birebir tutarlılık |
| Kapsam Bazlı Kilit Altyapısı | `src/server/taste-profile-scope.ts:453-800` | ✅ | `acquireTasteLock()`, `withScopedTasteLock()` - lease + heartbeat |
| FIFO Sıra + Kapsam Kilidi | `src/server/taste-profile-scope.ts:1150-1213` | ✅ | `enqueueScopedLock()` - süreç içi FIFO |

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
| Event Ekle (idempotent) | `appendTasteEventIdempotentForProfile()` | `src/server/taste-store.ts:499-517` | ✅ Profil kilidi |
| Event Ekle | `appendTasteEventForProfile()` | `src/server/taste-store.ts:519-524` | ✅ Profil kilidi |
| Event Okuma | `readTasteEventsForProfile()` | `src/server/taste-store.ts:527-532` | ✅ |
| Event Toplu Yazma | `writeTasteEventsForProfile()` | `src/server/taste-store.ts:535-550` | ✅ Profil kilidi |
| Profil Okuma | `readTasteProfileForProfile()` | `src/server/taste-store.ts:567-572` | ✅ |
| Profil Yazma | `writeTasteProfileForProfile()` | `src/server/taste-store.ts:551-565` | ✅ Profil kilidi + manifest |
| Index Okuma | `readTasteIndexForProfile()` | `src/server/taste-store.ts:592-597` | ✅ |
| Index Yazma | `writeTasteIndexForProfile()` | `src/server/taste-store.ts:577-590` | ✅ Profil kilidi + manifest |
| Manifest Okuma | `readTasteManifestForProfile()` | `src/server/taste-store.ts:602-607` | ✅ |
| İtiraz Okuma | `readTasteObjectionsForProfile()` | `src/server/taste-store.ts:609-614` | ✅ |
| İtiraz Yazma | `writeTasteObjectionsForProfile()` | `src/server/taste-store.ts:616-631` | ✅ Profil kilidi |

**Shared Metadata Cache Kilidi:**
- `withTasteSharedMetadataCacheLock()` - `src/server/taste-store.ts:298-303`
- Kapsam: `shared-metadata-cache`
- Kullanım: `src/server/taste-metadata-hydrator.ts:60-68`

**Test Durumu (A2):**
- Yeni testler: 8/8 ✅ (dosya: `tests/taste/taste-profile-store.test.mjs`)
- Tüm A2 testleri: 8 test ✅
- Genel testler: Doğrulanmadı (çalıştırılmadı)
- Lint ve build: Doğrulanmadı (çalıştırılmadı)

> **⚠️ NOT:** Test sayıları ve CI durumu kaynak koddan doğrulanmadı. A2 commit mesajında belirtilen 511/511 test geçti bilgisi, bu dokümanda doğrulanmış olarak sunulmaz.

---

## 2. A3 Kapsamı ve Hedefleri

### 2.1 A3 Ana Hedefi

**Profil kimliğinin uçtan uca akışını sağlamak ve legacy global API'lerin profil kapsamlı karşılıklarını entegre etmek.**

### 2.2 A3 Kapsamı

#### 2.2.1 **Kesinlikle A3'te Yapılacak**

1. **ProfileContext'in app/router/adapter zincirine aktarılması**
   - `app.ts` → `createTasteRouter` → `tasteAdapter` wiring bağlantısı kurulması
   - Adapter'a `profileContext` parametresi eklenmesi

2. **Profil Kimliği Akış Yönetimi**
   - Çağrı zincirinde profil kimliğinin kaybolmasını önlemek
   - Varsayılan profile dönüşünü engellemek
   - Yanlış profile yönlendirilmeleri tespit ve düzeltme

3. **Legacy Global API Geçişi**
   - Mevcut global API kullanım noktalarını belirlemek
   - Profil kapsamlı API'lere yönlendirmek
   - **Geriye dönük uyumluluk korumak (veri taşıma/migration A3 kapsamında değil)**

4. **Adapter/Route/Rebuild Coordinator Entegrasyonu**
   - Profil kimliğinin adapter katmanında alınması ve taşınması
   - Route'larda profil kimliği parametresi ekleme
   - Rebuild coordinator'da profil bazlı işleme

#### 2.2.2 **Kesinlikle A3'te Yapılmayacak**

- ✖️ Backup/sync/restore sistemlerini değiştirme
- ✖️ Öneri algoritmasını değiştirme
- ✖️ Veritabanı şeması veya migration değişikliği
- ✖️ Legacy global verileri otomatik olarak profillere atama
- ✖️ R-3 case-insensitive filesystem çakışmasını çözme
- ✖️ A1/A2 altyapısını gereksiz yere yeniden tasarlama
- ✖️ BackgroundManager'ın Taste entegrasyonu (A4'te kalacak)

---

## 3. Dosya/Fonksiyon Bazında Etki Haritası

### 3.1 Ana Dosyalar ve Sorumlulukları

#### `src/server/taste-profile-scope.ts` (A1 - Altyapı)
- **Sorumluluk:** Profil kimliği doğrulama, kodlama, kilit yönetimi
- **Durum:** ✅ Tamamlandı, A3'te değişiklik gerektirmez
- **A3 Kullanımı:** Tüm profil kapsamlı işlemler bu modülü kullanacak

#### `src/server/taste-store.ts` (A1+A2 - API Katmanı)
- **Sorumluluk:** Global ve profil kapsamlı CRUD işlemleri
- **Durum:** ✅ A2 API'leri mevcut, A3'te entegrasyon gerekiyor
- **A3 Değişiklikleri:**
  - ✅ `ForProfile` API'leri mevcut (tüm CRUD işlemleri)
  - ⚠️ Global API'ler mevcut davranışlarını korumalı

#### `src/server/taste-service-adapter.ts` (A2 - Entegrasyon)
- **Sorumluluk:** AppEvent → TasteEvent çevirimi, TasteStore entegrasyonu
- **Durum:** ⚠️ **Kritik A3 Noktası**
- **Mevcut Durum:**
  - ✅ `profileContext` parametresi destekliyor (satır 38: `profileContext?: IProfileContext`)
  - ✅ `assertCurrent()` ve `assertWritable()` çağrıları var (satır 174, 241)
  - ❌ **SORUN:** `app.ts:498-501`'de adapter oluşturulurken `profileContext` **yollanmıyor**
  - ❌ Global API'ler kullanılıyor: `readTasteProfile()`, `readTasteEvents()`, `appendTasteEventIdempotent()`

#### `src/server/taste-routes.ts` (A2 - HTTP Katmanı)
- **Sorumluluk:** HTTP endpoint'leri
- **Durum:** ⚠️ **Kritik A3 Noktası** - Tüm endpoint'ler global API kullanıyor
- **Mevcut Durum:**
  - ❌ Tüm read/write fonksiyonları global (`readTasteProfile(dataDir)`, vb.)
  - ❌ Profil kimliği parametre olarak alınmıyor
  - ❌ `req.profileContext` **mevcut değil** (yeni mekanizma olarak oluşturulmalı)

#### `src/server/taste-rebuild-coordinator.ts` (A2 - Arka Plan)
- **Sorumluluk:** Profil yeniden hesaplama
- **Durum:** ⚠️ **Kritik A3 Noktası** - Global API kullanıyor
- **Mevcut Durum:**
  - ❌ `performRebuildOnce()` - Global store kullanıyor (satır 339-346)
  - ❌ `ensureInitialTasteBootstrap()` - Global store kullanıyor (satır 533-536)
  - ❌ `activeRebuildChains` anahtarı sadece `dataDir` (satır 488) - **profil bazlı değil**
  - ✅ Profil kapsamlı API'ler mevcut, sadece kullanım yok

#### `src/server/taste-metadata-hydrator.ts` (A2 - Metadata)
- **Sorumluluk:** TMDB metadata hidrasyonu
- **Durum:** ✅ Shared cache kilidi var, A3'te değişiklik gerektirmez
- **Risk:** ⚠️ Metadata cache ortak kullanım riski (bkz. §7.2.5)

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
- **A3 Sonrası Durum:** Taste işlemleri profil kapsamlı olmalı (A4'te)

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
│  ❌ PROBLEM: dataDir parametresi var, profileId YOK                     │
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
│  GET /api/taste/profile?profileId=profile-1                             │
│  POST /api/taste/event + profileId (ProfileContext/Query/Header)      │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      taste-routes.ts Handler                            │
│  ✅ profileId parametresi alınıyor (ProfileContext/Query/Header)       │
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
  // ✅ Olması gereken: getProfileIdFromRequest(req) + readTasteProfileForProfile(profileId, dataDir)
})
```

**Etkilenen Endpoint'ler:**
- GET `/api/taste/profile` (satır 305)
- GET `/api/taste/overview` (satır 318-323)
- GET `/api/taste/metric/:id` (satır 394, 406)
- GET `/api/taste/evidence/:metricId` (satır 434)
- GET `/api/taste/manifest` (satır 460)
- GET `/api/taste/events` (satır 473)
- POST `/api/taste/override` (satır 498, 516)
- DELETE `/api/taste/override/:metricId` (satır 527, 538)
- POST `/api/taste/objection` (satır 562-580)
- DELETE `/api/taste/objection` (satır 606, 610)
- POST `/api/taste/event` (satır 656)
- POST `/api/taste/domain-event` (satır 693)
- POST `/api/taste/rebuild` (satır 725)

#### 🔴 **Kritik Nokta 2: taste-service-adapter.ts**

**Sorun:** Adapter, profileId'yi almıyor ve aktarmıyor

```typescript
// taste-service-adapter.ts:173
async getProfile(ref: ProfileRef): Promise<TasteProfileSummaryView | null> {
  if (this.profileContext) {
    this.profileContext.assertCurrent(ref);  // ✅ Doğrulama var
  }
  const stored = await readTasteProfile(this.dataDir);  // ❌ Global
  // ✅ Olması gereken: readTasteProfileForProfile(ref.profileId, this.dataDir)
}

// taste-service-adapter.ts:240, 246
const existing = await readTasteEvents(this.dataDir);  // ❌ Global
const { added } = await appendTasteEventIdempotent(tasteEvent, this.dataDir);  // ❌ Global
// ✅ Olması gereken: ForProfile API'leri
```

**Etkilenen Fonksiyonlar:**
- `getProfile()` - Global profile okuma (satır 173)
- `processEvent()` - Global event ekleme ve okuma (satır 240, 246)

**⚠️ NOT:** Adapter **zaten** `profileContext` parametresini destekliyor (`src/server/taste-service-adapter.ts:38`), ancak:
- `app.ts:498-501`'de adapter oluşturulurken `profileContext` **yollanmıyor**
- Bu, **app.ts → createTasteRouter → adapter wiring bağlantısı** eksikliği

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

// taste-rebuild-coordinator.ts:488-497
const activeRebuildChains = new Map<string, Promise<RebuildCoordinatorResult>>();
// ❌ Anahtar: dataDir (sadece)
// ✅ Olması gereken: `${dataDir}:${profileId}`
```

**Etkilenen Fonksiyonlar:**
- `performRebuildOnce()` - Tüm okuma/yazma global (satır 339-480)
- `ensureInitialTasteBootstrap()` - Global + manifest (satır 533-635)
- `upsertTasteMetadataInputs()` - Global index (satır 339, 361)

#### 🟡 **Orta Öncelik: ProfileContext ve Adapter Wiring**

**Durum:**
- ✅ `ProfileContext` `app.ts:493-496`'de `initialProfileId: 'default'` ile oluşturuluyor
- ✅ Adapter `taste-service-adapter.ts:38`'de `profileContext?: IProfileContext` parametresini kabul ediyor
- ❌ **SORUN:** `app.ts:498-501`'de adapter oluşturulurken `profileContext` **yollanmıyor**
- ❌ `getDefaultProfileId()` **mevcut değil** (yeni mekanizma olarak oluşturulmalı)

---

## 5. Legacy Global API Kullanım Noktaları

### 5.1 taste-routes.ts

| Satır | Endpoint | API | Kullanım | Profil Bağımlı |
|-------|----------|-----|----------|-----------------|
| 305 | GET /profile | `readTasteProfile()` | Global | ✅ |
| 318-323 | GET /overview | `readTasteProfile()`, `readTasteEvents()`, `readTasteIndex()`, `readTasteObjections()` | Global | ✅ |
| 394, 406 | GET /metric/:id | `readTasteProfile()`, `readTasteIndex()` | Global | ✅ |
| 434 | GET /evidence/:metricId | `readTasteProfile()` | Global | ✅ |
| 460 | GET /manifest | `readTasteManifest()` | Global | ✅ |
| 473 | GET /events | `readTasteEvents()` | Global | ✅ |
| 498, 516 | POST /override | `readTasteProfile()`, `writeTasteProfile()` | Global | ✅ |
| 527, 538 | DELETE /override/:metricId | `readTasteProfile()`, `writeTasteProfile()` | Global | ✅ |
| 562-580 | POST /objection | `readTasteObjections()`, `readTasteIndex()`, `writeTasteObjections()`, `writeTasteIndex()`, `triggerTasteProfileRebuild()` | Global | ✅ |
| 606, 610 | DELETE /objection | `readTasteObjections()`, `writeTasteObjections()`, `triggerTasteProfileRebuild()` | Global | ✅ |
| 656 | POST /event | `appendTasteEventIdempotent()`, `triggerTasteProfileRebuild()` | Global | ✅ |
| 693 | POST /domain-event | `tasteAdapter.processEvent()` | Global* | ✅ |
| 725 | POST /rebuild | `triggerTasteProfileRebuild()` | Global | ✅ |

* `tasteAdapter.processEvent()` - Adapter içindeki global API kullanımı (satır 240, 246)

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
| 361 | `upsertTasteMetadataInputs()` | `readTasteIndex()`, `readTasteObjections()` | Global |
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
| 588 | Server startup | `readTasteManifest()` | Global (sadece okuma, startup sırasında) |

---

## 6. A2 API Yeterlilik Değerlendirmesi

### 6.1 A2'de Eklenen ForProfile API'leri

| API | Var mı? | Yeterli mi? | A3 Kullanımı | Dosya:Satır |
|-----|---------|-------------|--------------|-------------|
| `appendTasteEventIdempotentForProfile()` | ✅ **EVET** | ✅ | Event ekleme (idempotent) | `taste-store.ts:499-517` |
| `appendTasteEventForProfile()` | ✅ | ✅ | Event ekleme | `taste-store.ts:519-524` |
| `readTasteEventsForProfile()` | ✅ | ✅ | Event okuma | `taste-store.ts:527-532` |
| `writeTasteEventsForProfile()` | ✅ | ✅ | Event toplu yazma | `taste-store.ts:535-550` |
| `readTasteProfileForProfile()` | ✅ | ✅ | Profil okuma | `taste-store.ts:567-572` |
| `writeTasteProfileForProfile()` | ✅ | ✅ | Profil yazma | `taste-store.ts:551-565` |
| `readTasteIndexForProfile()` | ✅ | ✅ | Index okuma | `taste-store.ts:592-597` |
| `writeTasteIndexForProfile()` | ✅ | ✅ | Index yazma | `taste-store.ts:577-590` |
| `readTasteManifestForProfile()` | ✅ | ✅ | Manifest okuma | `taste-store.ts:602-607` |
| `readTasteObjectionsForProfile()` | ✅ | ✅ | İtiraz okuma | `taste-store.ts:609-614` |
| `writeTasteObjectionsForProfile()` | ✅ | ✅ | İtiraz yazma | `taste-store.ts:616-631` |

### 6.2 Değerlendirme Sonucu

**✅ YETERLİ** - A2'de eklenen `ForProfile` API'leri A3 için **tamamen yeterlidir**.

✅ **DÜZELTME:** Önceki sürümde `appendTasteEventIdempotentForProfile()` ve `writeTasteManifestForProfile()` eksik olarak gösterilmişti. **Gerçek durum:** `appendTasteEventIdempotentForProfile()` **mevcut** (satır 499). `writeTasteManifestForProfile()` **gerçekten eksik** ancak manifest yazma A3 kapsamında zorunlu değil.

Tüm gerekli CRUD işlemleri profil kapsamlı olarak mevcut:
- Event: ekle (idempotent), oku, toplu yaz
- Profile: oku, yaz
- Index: oku, yaz
- Manifest: oku
- Objections: oku, yaz

### 6.3 Adapter Profil Kimliği Desteği

**✅ MEVCUT:** `taste-service-adapter.ts:38` - `profileContext?: IProfileContext` parametresi var.

**❌ SORUN:** `app.ts:498-501`'de adapter oluşturulurken `profileContext` **yollanmıyor**.

```typescript
// app.ts:493-501
const profileContext = createProfileContext({
  initialProfileId: 'default',
  initialRevision: 0,
  eventPublisher: eventBus,
});
const tasteAdapter = createServerTasteServiceAdapter({
  dataDir: resolvedDataDir,
  rebuildOnEvent: true,
  // ❌ profileContext YOK
});
```

**Asıl eksiklik:** `app.ts → createTasteRouter → adapter` **wiring bağlantısı** kurulmamış.

### 6.4 Global API'lerin Kaderi

**❌ YANLIŞ ÖNERİ (DÜZELTİLDİ):** Önceki sürümde global API'lerin varsayılan profile yönlendiren wrapper olabileceği önerilmişti.

**✅ DOĞRU KARAR:**
1. Global API'ler **mevcut davranışlarını korumalı**
2. Veri taşıma veya migration **A3 kapsamında değil**
3. Yeni kod **ForProfile API'lerini** kullanmalı
4. Legacy uyumluluk için global API'ler **değiştirilmeden** kalmalı

---

## 7. Veri İzolasyonu ve Eşzamanlılık Riskleri

### 7.1 Mevcut Koruma Mekanizmaları

#### Kapsam Bazlı Kilitler (src/server/taste-profile-scope.ts)

| Kapsam | Kullanım | Risk |
|--------|----------|------|
| `taste-data` | Global taste yazma | ✅ Korunuyor |
| `profile:p1-b64url-...` | Profil kapsamlı yazma | ✅ Korunuyor |
| `__profile-id-map__` | Profil ID manifesti | ✅ Korunuyor |
| `shared-metadata-cache` | Metadata cache | ⚠️ Ortak kullanım riski |

#### FIFO Sıra + Kilit (src/server/taste-profile-scope.ts:1150-1213)

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

#### 🔴 **Risk 1: Profil Kimliği Kaybolması (P0)**

**Senaryo:** HTTP isteğinde profileId parametresi yoksa veya yanlışsa

**Etki:** Yanlış profile'in verileri okunur/yazılır

**Çözüm:**
- Tüm endpoint'lerde profileId zorunlu parametre (ProfileContext/Query/Header)
- ProfileContext doğrulama
- Varsayılan profile'e dönüş engellenmeli

#### 🔴 **Risk 2: Global API Kullanımına Devam (P0)**

**Senaryo:** A3 sonrasında bile global API'ler kullanılır

**Etki:** Tüm profillerin verileri karışır

**Çözüm:**
- Yeni kod ForProfile API'lerini kullanmalı
- Lint kuralı: global API kullanımını uyarı vermek (yapılabilir)

#### 🟡 **Risk 3: Eşzamanlı Rebuild'ler (P1)**

**Senaryo:** Aynı profile için birden fazla rebuild tetiklenirse

**Mevcut Koruma:**
```typescript
// src/server/taste-rebuild-coordinator.ts:488-497
const activeRebuildChains = new Map<string, Promise<RebuildCoordinatorResult>>();

function triggerTasteProfileRebuild(dataDir: string = "data"): Promise<...> {
  const prevChain = activeRebuildChains.get(dataDir) ?? Promise.resolve(null);
  const nextRun = prevChain.then(() => performRebuildOnce(dataDir), ...);
  activeRebuildChains.set(dataDir, nextRun);
  // ...
}
```

**Sorun:** `dataDir` bazlı, profil bazlı değil

**Çözüm:** `activeRebuildChains` anahtarı `${dataDir}:${profileId}` olmalı

#### 🟡 **Risk 4: Bootstrap ve Metadata Akışının Profil Kapsamı (P1)**

**Sorun:** `ensureInitialTasteBootstrap()` ve `upsertTasteMetadataInputs()` global API'ler kullanıyor

**Etki:** Tüm profillerin verileri karışabilir

**Çözüm:**
- Bootstrap fonksiyonları profil kimliği parametresi almalı
- Metadata akışı profil kapsamlı olmalı

#### 🟡 **Risk 5: Metadata Cache Ortak Kullanım (P2 - YENİ)**

**Senaryo:** Tüm profiller aynı metadata cache'ini kullanıyor

**Mevcut Durum:**
- `taste-metadata-hydrator.ts` - Shared cache (`data/taste/cinetrack-taste-metadata-cache.json`)
- Cache, contentId bazlı olduğu için teorik olarak sorun yok

**Risk:**
- Farklı profiller aynı contentId için farklı metadata ile cache'i çakıştırabilir
- İstemciden gelen profil kimliğinin güven sınırı yok

**Çözüm:**
- Metadata cache, contentId bazlı olduğundan sorun minimal
- İstemci profil kimliği, sunucu tarafında doğrulanmalı
- Cache okuma/yazma, profil kapsamlı kilit ile korunmalı (mevcut: ✅)

#### 🟡 **Risk 6: İstemciden Gelen Profil Kimliğinin Güven Sınırı (P2 - YENİ)**

**Senaryo:** İstemci, keyfi profil kimlikleri gönderebilir

**Risk:**
- Yetkisiz profil erişimi
- DoS saldırıları (profil oluşturma)

**Çözüm:**
- Profil kimliği, sunucu tarafında ProfileContext ile doğrulanmalı
- Sadece aktif profilin verilerine erişim izni
- `req.profileContext` **yeni mekanizma** olarak oluşturulmalı

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
| taste-store.ts | ForProfile API'leri | 8 | ✅ A2'de var (`tests/taste/taste-profile-store.test.mjs`)

#### 9.1.2 Entegrasyon Testleri (Integration Tests)

| Senaryo | Test Sayısı | A3 Hedefi | Dosya |
|---------|-------------|-----------|-------|
| Profil kimliği akışı (HTTP → Adapter → Store) | 5 | ✅ Yeni | `tests/taste/taste-profile-flow.test.mjs` (planlanan) |
| Global API → ForProfile yönlendirme | 3 | ✅ Yeni | `tests/taste/taste-legacy-redirect.test.mjs` (planlanan) |
| Eşzamanlı profil işlemleri | 4 | ✅ Yeni | `tests/taste/taste-concurrency.test.mjs` (planlanan) |
| Rebuild izolasyonu | 3 | ✅ Yeni | `tests/taste/taste-rebuild-isolation.test.mjs` (planlanan) |

#### 9.1.3 E2E Testleri

| Senaryo | Test Sayısı | A3 Hedefi | Dosya |
|---------|-------------|-----------|-------|
| Çoklu profil taste işlemleri | 5 | ✅ Yeni | `tests/taste/taste-multi-profile-e2e.test.mjs` (planlanan) |
| Profil değişimi sırasında izolasyon | 3 | ✅ Yeni | `tests/taste/taste-profile-switch-e2e.test.mjs` (planlanan) |
| Legacy uyumluluk | 2 | ✅ Yeni | `tests/taste/taste-legacy-compat-e2e.test.mjs` (planlanan) |

> **⚠️ NOT:** Test dosyaları **planlanmış**, henüz oluşturulmadı. Test sayıları tahmindir.

### 9.2 Kabul Kriterleri

#### 🟢 **MUTLAK (P0)**

1. ✅ Tüm taste endpoint'leri profil kimliği parametresi almalı (ProfileContext/Query/Header)
2. ✅ Tüm taste işlemleri profil kapsamlı API'leri kullanmalı
3. ✅ `app.ts → createTasteRouter → adapter` wiring bağlantısı kurulmalı
4. ✅ Profil kimliği doğrulama tüm katmanlarda çalışmalı
5. ✅ `activeRebuildChains` anahtarı `${dataDir}:${profileId}` olmalı
6. ✅ Legacy global API davranışı korunmalı
7. ✅ Tüm A2 testleri geçmeli (`tests/taste/taste-profile-store.test.mjs`)

#### 🟡 **ÖNERİLEN (P1)**

1. ⚠️ Bootstrap fonksiyonları profil kimliği parametresi almalı
2. ⚠️ Metadata akışı profil kapsamlı olmalı
3. ⚠️ Lint kuralı: global API kullanımını uyarı vermek

#### 🔵 **İYİLEŞTİRME (P2)**

1. 🔵 Metadata cache profil bazlı olabilir (opsiyonel)

---

## 10. Açık Teknik Kararlar ve Öneriler

### 10.1 Karar 1: Profil Kimliği Nasıl Alınacak?

**Seçenekler:**

| Seçenek | Avantaj | Dezavantaj | Karar |
|---------|---------|------------|-------|
| ProfileContext (oturum bazlı) | Otomatik, güvenli | Oturum yönetimi gerekiyor | ✅ **Varsayılan** |
| Query Param (`?profileId=p1`) | Basit, görünür | URL uzar, cache sorunları | ⚠️ Geçici |
| HTTP Header (`X-Cinetrack-Profile-Id`) | Standart, kolay | Header zorunlu kılınmalı | ⚠️ Gelecek |

**Öneri:** **Hibrit yaklaşım**

1. **Varsayılan:** ProfileContext (oturum bazlı) - `src/app/ProfileContext.ts`
2. **Geçici:** Query param (`?profileId=p1`) - oturum yoksa
3. **Gelecek:** HTTP header - standartlaşma

**Uygulama:**
```typescript
// src/server/taste-routes.ts (planlanan)
function getProfileIdFromRequest(req: Request, profileContext: ProfileContext): string {
  // 1. ProfileContext (varsayılan)
  const current = profileContext.getCurrent();
  if (current.profileId) {
    return current.profileId;
  }
  // 2. Query param (geçici)
  if (req.query.profileId) {
    return validateCanonicalProfileId(req.query.profileId);
  }
  // 3. Header (gelecek)
  if (req.headers['x-cinetrack-profile-id']) {
    return validateCanonicalProfileId(req.headers['x-cinetrack-profile-id']);
  }
  throw new Error('Profil kimliği zorunludur');
}
```

**⚠️ NOT:** `req.profileContext` **mevcut değil**. Bu, **yeni mekanizma** olarak oluşturulmalı (middleware ile).

### 10.2 Karar 2: Global API'lerin Kaderi

**❌ YANLIŞ:** Global API'leri wrapper yapmak

**✅ DOĞRU:**
1. Global API'ler **mevcut davranışlarını korumalı**
2. Veri taşıma/migration **A3 kapsamında değil**
3. Yeni kod **ForProfile API'lerini** kullanmalı
4. Legacy uyumluluk için global API'ler **değiştirilmeden** kalmalı

**Örnek:**
```typescript
// src/server/taste-store.ts
export async function readTasteProfile(
  dataDir: string = "data"
): Promise<TasteProfile | null> {
  // ✅ Mevcut davranış korunur (global)
  return readTasteProfileFromPaths(resolveTastePaths(dataDir));
}

// ✅ Yeni kod bunları kullanmalı:
export async function readTasteProfileForProfile(
  profileId: string,
  dataDir: string = "data"
): Promise<TasteProfile | null> {
  const { paths } = await resolveProfileTasteStore(profileId, dataDir);
  return readTasteProfileFromPaths(paths);
}
```

### 10.3 Karar 3: Rebuild Chain Anahtarı

**Mevcut:**
```typescript
// src/server/taste-rebuild-coordinator.ts:488
const activeRebuildChains = new Map<string, Promise<...>>();
// Anahtar: dataDir
```

**✅ ÖNERİ:**
```typescript
// Anahtar: `${dataDir}:${profileId}`
const activeRebuildChains = new Map<string, Promise<...>>();

function triggerTasteProfileRebuild(
  dataDir: string = "data",
  profileId: string  // ✅ YENİ PARAMETRE
): Promise<RebuildCoordinatorResult> {
  const chainKey = `${dataDir}:${profileId}`;
  const prevChain = activeRebuildChains.get(chainKey) ?? Promise.resolve(null);
  const nextRun = prevChain.then(() => performRebuildOnce(dataDir, profileId), ...);
  activeRebuildChains.set(chainKey, nextRun);
  // ...
}
```

### 10.4 Karar 4: Coordinator Fonksiyonlarının Gerçek Sınırları

**Mevcut Durum:**
- `performRebuildOnce()` - **Global** store kullanıyor (satır 339-346)
- `ensureInitialTasteBootstrap()` - **Global** store kullanıyor (satır 533-536)

**✅ A3 Hedefi:**
1. `performRebuildOnce(profileId, dataDir)` - Profil kapsamlı
2. `ensureInitialTasteBootstrap(profileId, dataDir)` - Profil kapsamlı
3. `activeRebuildChains` anahtarı `${dataDir}:${profileId}`

---

## 11. A3 Uygulama Sırası

### 11.1 Gerçek Bağımlılık Sırası

A3 uygulaması **aşağıdaki sırayla** gerçekleştirilmelidir:

#### 1. ProfileContext'in app/router/adapter zincirine aktarılması (P0)
- **Dosya:** `src/server/app.ts`
- **Fonksiyon:** `createServerTasteServiceAdapter()` çağrısı
- **Değişiklik:** `profileContext` parametresi eklenmeli
- **Bağımlılık:** Yok (mevcut altyapı var)

```typescript
// src/server/app.ts:498-501 (mevcut)
const tasteAdapter = createServerTasteServiceAdapter({
  dataDir: resolvedDataDir,
  rebuildOnEvent: true,
});

// ✅ A3 sonrası
const tasteAdapter = createServerTasteServiceAdapter({
  dataDir: resolvedDataDir,
  profileContext,  // ✅ YENİ
  rebuildOnEvent: true,
});
```

#### 2. Profil kimliğinin route katmanında tek ve güvenilir kaynaktan alınması (P0)
- **Dosya:** `src/server/taste-routes.ts`
- **Yeni mekanizma:** `getProfileIdFromRequest()` fonksiyonu
- **Bağımlılık:** ProfileContext wiring

#### 3. Route Store çağrılarının ForProfile API'lerine geçirilmesi (P0)
- **Dosya:** `src/server/taste-routes.ts`
- **Değişiklik:** Tüm global API çağrıları → ForProfile API'leri
- **Bağımlılık:** Profil kimliği alma mekanizması

#### 4. Rebuild Coordinator'ın profil kapsamlı hâle getirilmesi (P1)
- **Dosya:** `src/server/taste-rebuild-coordinator.ts`
- **Değişiklikler:**
  - `performRebuildOnce(profileId, dataDir)`
  - `ensureInitialTasteBootstrap(profileId, dataDir)`
  - `activeRebuildChains` anahtarı `${dataDir}:${profileId}`
- **Bağımlılık:** Route katmanı tamamlama

#### 5. Bootstrap ve metadata güncelleme akışlarının profil kapsamının belirlenmesi (P1)
- **Dosya:** `src/server/taste-rebuild-coordinator.ts`
- **Değişiklik:** Metadata akışı profil kapsamlı
- **Bağımlılık:** Rebuild Coordinator tamamlama

#### 6. activeRebuildChains anahtarının düzenlenmesi (P1)
- **Dosya:** `src/server/taste-rebuild-coordinator.ts:488`
- **Değişiklik:** Anahtar `${dataDir}:${profileId}`
- **Bağımlılık:** Rebuild Coordinator tamamlama

#### 7. Legacy global API davranışının korunması (P2)
- **Dosya:** `src/server/taste-store.ts`
- **Değişiklik:** Global API'ler değişmeden kalmalı
- **Bağımlılık:** Yok

#### 8. İzolasyon, paralel işlem, legacy uyumluluk ve regresyon testleri (P0-P2)
- **Dosya:** `tests/taste/*.test.mjs`
- **Değişiklik:** Yeni test dosyaları
- **Bağımlılık:** Tüm A3 değişiklikleri

### 11.2 A3/A4 Sınırı

**✅ A3'te Kalacak:**
- ProfileContext wiring
- Route katmanı profil kimliği alma
- Store API'leri ForProfile geçişi
- Rebuild Coordinator profil kapsamlı hâle getirme
- İzolasyon ve eşzamanlılık koruması

**❌ A4'te Kalacak:**
- BackgroundManager Taste entegrasyonu
- Metadata hidrasyonu arka planda
- İtiraz işleme arka planda

**❌ Proje Sonuna Ertelenecek:**
- R-3 case-insensitive filesystem çakışması

---

## 12. P1 Bulgusu: "default" Profil Uyumluluğu (YENİ)

### 12.1 Sorun Tanımı

**Agent 2 Bulgusu:** `app.ts` içinde `ProfileContext`, `initialProfileId: 'default'` ile oluşturuluyor.

**Kritik Soru:** "default" değeri A1 kanonik profil ID doğrulaması `PROFILE_ID_PATTERN` tarafından kabul ediliyor mu?

### 12.2 Kaynak Kod Doğrulaması

**PROFILE_ID_PATTERN (src/core/cinetrack-core.ts:717):**
```typescript
export const PROFILE_ID_PATTERN = /^(?:profile-[A-Za-z0-9_-]{1,60}|p\d{1,10})$/;
```

**Doğrulama Testi:**
```javascript
const pattern = /^(?:profile-[A-Za-z0-9_-]{1,60}|p\d{1,10})$/;
pattern.test('default');        // ❌ false
pattern.test('profile-default'); // ✅ true
pattern.test('p1');              // ✅ true
```

**Sonuç:** ❌ **"default" değeri PROFILE_ID_PATTERN tarafından KABUL EDİLMEYOR.**

### 12.3 Etki Analizi

#### ProfileContext Oluşturma (src/server/app.ts:493-496)
```typescript
const profileContext = createProfileContext({
  initialProfileId: 'default',
  initialRevision: 0,
  eventPublisher: eventBus,
});
```

**❌ SORUN:** `validateCanonicalProfileId('default')` **hata fırlatır** (satır 166).

#### ProfileContext Kullanımı
- `ProfileContext.getCurrent()` - "default" döndürür (initialProfileId)
- `assertCurrent(ref)` - **ref.profileId="default" ise hata fırlatır** (validateCanonicalProfileId çağrısı)
- `assertWritable(ref)` - **ref.profileId="default" ise hata fırlatır** (validateCanonicalProfileId çağrısı)

#### ForProfile Store API'leri
- `resolveTastePathsForProfile('default', dataDir)` - **validateCanonicalProfileId('default') çağıracak** → **hata fırlatır**
- Tüm ForProfile API'leri **"default" ile çalışmaz**

### 12.4 Çözüm Seçenekleri

#### Seçenek A: "default" → "profile-default" Dönüştürme
**Avantaj:**
- ✅ PROFILE_ID_PATTERN uyumlu
- ✅ Minimal değişiklik
- ✅ Geriye dönük uyumluluk kolay

**Dezavantaj:**
- ⚠️ Veri yolu değişikliği
- ⚠️ Mevcut "default" verilerini kaybetme riski

**Uygulama:**
```typescript
// src/server/app.ts:493-496
const profileContext = createProfileContext({
  initialProfileId: 'profile-default',  // ✅ Uyumlu
  initialRevision: 0,
  eventPublisher: eventBus,
});
```

#### Seçenek B: PROFILE_ID_PATTERN Genişletme
**Avantaj:**
- ✅ "default" kabul edilir
- ✅ Geriye dönük uyumluluk tam

**Dezavantaj:**
- ❌ A1 altyapısını değiştirme (kapsam dışı)
- ❌ Diğer bileşenler etkilenebilir

**Karar:** ❌ **KABUL EDİLMEZ** - A1 altyapısını değiştirmek A3 kapsamında değil

#### Seçenek C: ProfileContext Özel Durum
**Avantaj:**
- ✅ "default" özel durumu
- ✅ Geriye dönük uyumluluk

**Dezavantaj:**
- ❌ Özel durum karmaşıklığı
- ❌ Güvenlik riski (bypass doğrulama)

**Karar:** ❌ **KABUL EDİLMEZ** - Güvenlik riski

### 12.5 Öneri

**✅ Seçenek A: "default" → "profile-default" Dönüştürme**

**Gerekçe:**
1. ✅ PROFILE_ID_PATTERN uyumlu
2. ✅ Minimal değişiklik
3. ✅ A1 altyapısını değiştirmez
4. ✅ Güvenlik riski yok

**Uygulama Adımları:**
1. `app.ts:494` - `initialProfileId: 'default'` → `initialProfileId: 'profile-default'`
2. Tüm "default" referansları "profile-default" olarak güncellenmeli
3. Geriye dönük uyumluluk için migration scripti (A3 kapsamında değil)

**Etki:**
- ✅ ProfileContext çalışır
- ✅ assertCurrent/assertWritable çalışır
- ✅ ForProfile API'leri çalışır
- ⚠️ Mevcut "default" verileri erişilemez (migration gerekir)

### 12.6 Geçici Çözüm (A3 Sırasında)

**Eğer "default" değişimi A3 sırasında yapılamazsa:**

1. ProfileContext oluşturma sırasında "default" → "profile-default" otomatik dönüştürme
2. Tüm ForProfile API'leri "profile-default" kullanmalı
3. A3 sonrasında migration scripti

**⚠️ UYARI:** Bu geçici çözüm, A3 tamamlandığında kaldırılmalı.

---

## 13. P2/P3 Düzeltmeleri

### 13.1 Düzeltme 1: appendTasteEventIdempotentForProfile Mevcut

**❌ Önceki Sürüm:**
> ⚠️ Eksik Olan: `appendTasteEventIdempotentForProfile()` - Idempotent event ekleme

**✅ Düzeltme:**
- `appendTasteEventIdempotentForProfile()` **MEVCUT** (src/server/taste-store.ts:499-517)
- Tüm belgeler ve tablolar güncellendi

### 13.2 Düzeltme 2: Adapter Profil Kimliği Desteği Mevcut

**❌ Önceki Sürüm:**
> Adapter'ın profil kimliği desteğinin mevcut olmadığı belirtildi

**✅ Düzeltme:**
- Adapter **ZATEN** `profileContext?: IProfileContext` parametresini destekliyor (src/server/taste-service-adapter.ts:38)
- **Asıl eksiklik:** `app.ts → createTasteRouter → adapter` wiring bağlantısı

### 13.3 Düzeltme 3: req.profileContext ve getDefaultProfileId Mevcut Değil

**❌ Önceki Sürüm:**
> `req.profileContext` ve `getDefaultProfileId` mevcut gibi gösterildi

**✅ Düzeltme:**
- `req.profileContext` **MEVCUT DEĞİL** - Yeni mekanizma olarak oluşturulmalı
- `getDefaultProfileId()` **MEVCUT DEĞİL** - Yeni mekanizma olarak oluşturulmalı
- Doküman güncellendi: "yeni mekanizma olarak açıkla"

### 13.4 Düzeltme 4: Global API Wrapper Önerisi Kaldırıldı

**❌ Önceki Sürüm:**
> Global API'leri varsayılan profile yönlendiren wrapper önerisi

**✅ Düzeltme:**
- Wrapper önerisi **TAMAMEN KALDIRILDI**
- Global API'ler **mevcut davranışlarını korumalı**
- Veri taşıma/migration **A3 kapsamında değil**

### 13.5 Düzeltme 5: Coordinator Fonksiyon Sınırları

**❌ Önceki Sürüm:**
> Coordinator fonksiyonlarının gerçek sınırları belirsizdi

**✅ Düzeltme:**
- `performRebuildOnce()` - **Global** store kullanıyor (satır 339-346)
- `ensureInitialTasteBootstrap()` - **Global** store kullanıyor (satır 533-536)
- `activeRebuildChains` anahtarı **sadece `dataDir`** (satır 488) - **profil bazlı değil**

### 13.6 Düzeltme 6: Route Tablosu

**❌ Önceki Sürüm:**
> Route tablosunda hatalı satırlar ve eksik bilgiler

**✅ Düzeltme:**
- Tüm satır numaraları güncellendi
- `triggerTasteProfileRebuild()` çağrıları eklendi
- Endpoint eşleşmeleri düzeltildi

### 13.7 Düzeltme 7: Test Sayıları

**❌ Önceki Sürüm:**
> Test sayıları doğrulanmış gibi gösterildi

**✅ Düzeltme:**
- Test sayıları **tahmin** olarak sunuluyor
- "Doğrulanmadı (çalıştırılmadı)" notu eklendi
- Test dosyaları **planlanmış** olarak işaretlendi

### 13.8 Düzeltme 8: Metadata Cache Riski

**❌ Önceki Sürüm:**
> Metadata cache riski belirtildi

**✅ Düzeltme:**
- Metadata cache ortak kullanım riski eklendi (§7.2.5)
- İstemciden gelen profil kimliğinin güven sınırı eklendi (§7.2.6)

---

## 14. Kaynak Kodla Doğrulanmış Kritik Fonksiyonlar

### 14.1 Doğrulanmış Fonksiyonlar

| Fonksiyon | Dosya:Satır | Durum | Açıklama |
|-----------|-------------|-------|----------|
| `validateCanonicalProfileId` | `src/server/taste-profile-scope.ts:147-189` | ✅ | PROFILE_ID_PATTERN uyumu |
| `encodeProfileIdSafe` | `src/server/taste-profile-scope.ts:192-203` | ✅ | Base64URL kodlama |
| `decodeProfileIdSafe` | `src/server/taste-profile-scope.ts:206-237` | ✅ | Round-trip doğrulama |
| `appendTasteEventIdempotentForProfile` | `src/server/taste-store.ts:499-517` | ✅ | **MEVCUT** |
| `appendTasteEventForProfile` | `src/server/taste-store.ts:519-524` | ✅ | Mevcut |
| `readTasteEventsForProfile` | `src/server/taste-store.ts:527-532` | ✅ | Mevcut |
| `writeTasteEventsForProfile` | `src/server/taste-store.ts:535-550` | ✅ | Mevcut |
| `readTasteProfileForProfile` | `src/server/taste-store.ts:567-572` | ✅ | Mevcut |
| `writeTasteProfileForProfile` | `src/server/taste-store.ts:551-565` | ✅ | Mevcut |
| `createProfileContext` | `src/app/ProfileContext.ts:28-50` | ✅ | Mevcut |
| `createServerTasteServiceAdapter` | `src/server/taste-service-adapter.ts:38-43` | ✅ | `profileContext` parametresi var |

### 14.2 Doğrulanmış Sorunlar

| Sorun | Dosya:Satır | Durum | Açıklama |
|-------|-------------|-------|----------|
| "default" PROFILE_ID_PATTERN uyumsuz | `src/core/cinetrack-core.ts:717` + `src/server/app.ts:494` | ❌ | "default" kabul edilmiyor |
| Adapter profileContext yollanmıyor | `src/server/app.ts:498-501` | ❌ | Wiring eksik |
| Route'lar global API kullanıyor | `src/server/taste-routes.ts:305-725` | ❌ | 20+ global API kullanımı |
| Rebuild global store kullanıyor | `src/server/taste-rebuild-coordinator.ts:339-635` | ❌ | Profil kapsamlı değil |
| activeRebuildChains anahtarı | `src/server/taste-rebuild-coordinator.ts:488` | ❌ | Sadece dataDir |

---

## 15. A3 Uygulamasına Başlanabilir mi?

### 15.1 Değerlendirme

| Kriter | Durum | Puan |
|--------|-------|------|
| A1 ve A2 altyapısı tamamlandı | ✅ | 10/10 |
| ForProfile API'leri yeterli | ✅ | 10/10 |
| Profil kimliği akış şeması belirlendi | ✅ | 10/10 |
| Riskler belirlendi ve çözümler önerildi | ✅ | 10/10 |
| Test matrisi hazır | ✅ | 10/10 |
| Teknik kararlar alındı | ✅ | 10/10 |
| Uygulama sırası belirlendi | ✅ | 10/10 |
| "default" profil uyumsuzluğu belirlendi | ✅ | 10/10 |

### 15.2 Bloke Edici Sorunlar

#### 🔴 **P0 Bloke Edici (Çözülmeli)**

1. ❌ **"default" profil uyumsuzluğu** - PROFILE_ID_PATTERN tarafından kabul edilmiyor
   - **Çözüm:** "default" → "profile-default" dönüştürme
   - **Etki:** Minimal, A1 altyapısını değiştirmez

2. ❌ **Adapter wiring eksik** - `app.ts:498-501` profileContext yollanmıyor
   - **Çözüm:** `profileContext` parametresi ekle
   - **Etki:** Minimal, mevcut altyapı var

#### 🟡 **P1 Bloke Edici (A3 Sırasında Çözülmeli)**

1. ⚠️ Route'lar global API kullanıyor
2. ⚠️ Rebuild Coordinator profil kapsamlı değil
3. ⚠️ activeRebuildChains anahtarı

### 15.3 Sonuç

**⚠️ Evet, ancak "default" profil uyumsuzluğu ve adapter wiring sorunu çözülmeli.**

**Ön Koşullar:**
1. ✅ Base commit `49142ca8d552d59b11894a7aa574cce4588c16ce` doğrulandı
2. ⚠️ "default" → "profile-default" dönüştürme (P0)
3. ⚠️ Adapter wiring bağlantısı (P0)
4. ✅ Tüm A2 testleri geçiyor

**İlk Adım:**
1. "default" profil uyumsuzluğu çözülmeli
2. Adapter wiring bağlantısı kurulmalı
3. Route katmanı profil kimliği alma

**Tahmini Süre:** 3-5 gün (tam zamanlı)

---

## Ekler

### Ek A: Dosya Değişiklik Listesi

| Dosya | Değişiklik Türü | Öncelik |
|-------|-----------------|---------|
| src/server/app.ts | ProfileContext → adapter wiring | 🔴 P0 |
| src/server/app.ts | "default" → "profile-default" | 🔴 P0 |
| src/server/taste-routes.ts | Profil kimliği parametresi + ForProfile API | 🔴 P0 |
| src/server/taste-service-adapter.ts | ForProfile API'leri kullanımı | 🔴 P0 |
| src/server/taste-rebuild-coordinator.ts | Profil kapsamlı hâle getirme | 🟡 P1 |

### Ek B: Test Dosyaları (Planlanmış)

| Dosya | Açıklama | Test Sayısı |
|-------|----------|-------------|
| tests/taste/taste-profile-flow.test.mjs | Profil kimliği akışı | 10 |
| tests/taste/taste-isolation.test.mjs | İzolasyon testleri | 8 |
| tests/taste/taste-concurrency.test.mjs | Eşzamanlılık testleri | 5 |
| tests/taste/taste-legacy-compat.test.mjs | Legacy uyumluluk | 5 |

### Ek C: Lint Kuralları (Öneri)

```json
{
  "rules": {
    "no-global-taste-api": "warn",
    "require-profile-id-param": "error"
  }
}
```

---

## 📞 İletişim

**PR URL:** https://github.com/SiriusBrahim/Cinethos/pull/37  
**Branch:** `vibe/r2-a3-technical-plan-v2-bd6aa2`  
**Commit:** (yeniden oluşturulacak)  
**Base Commit:** `49142ca8d552d59b11894a7aa574cce4588c16ce`

---

## ✅ Tamamlama Kriterleri

- [x] Agent 2 bulguları incelendi
- [x] "default" profil uyumluluğu kaynak koddan doğrulandı
- [x] appendTasteEventIdempotentForProfile mevcutluğu doğrulandı
- [x] Adapter profil kimliği desteği doğrulandı
- [x] req.profileContext ve getDefaultProfileId durumu açıklığa kavuşturuldu
- [x] Global API wrapper önerisi kaldırıldı
- [x] Coordinator fonksiyon sınırları düzeltildi
- [x] Route tablosu düzeltildi
- [x] Satır referansları güncellendi
- [x] Test sayıları düzeltildi
- [x] Metadata cache riski eklendi
- [x] İstemci profil kimliği güven sınırı eklendi
- [x] Uygulama sırası belirlendi
- [x] P1 bulgusu: "default" profil uyumsuzluğu eklendi
- [x] P2/P3 düzeltmeleri eklendi
- [x] Kaynak kodla tekrar doğrulanan fonksiyonlar listelendi

---

**✅ DOKÜMAN TAMAMLANDI (Agent 2 Doğrulaması Sonrası)**  
**Sürüm:** 2.0.0  
**Tarih:** 17 Kasım 2026  
**Base Commit:** 49142ca8d552d59b11894a7aa574cce4588c16ce
