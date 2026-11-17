# R2-A3 — Faz 5 Taste, Memory ve Relationship Yöneticileri
## Teknik Analiz ve Uygulama Planı

> **Base Commit:** `49142ca8d552d59b11894a7aa574cce4588c16ce`  
> **Tarih:** 17 Kasım 2026  
> **Durum:** A1 ve A2 tamamlandı, A3 planlama aşaması  
> **Doküman Sürümü:** 2.4.0 (Birleşik Denetim Düzeltmeleri — kullanıcı kararları uygulandı; PR #39 v1.2.0 ile unifikasiyon)  
> **Önceki Sürüm:** 2.3.0

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
12. [Açılış Anı Profil Kimliği Tutarsızlığı](#12-açılış-anı-profil-kimliği-tutarsızlığı)
13. [P2/P3 Düzeltmeleri](#13-p2p3-düzeltmeleri)
14. [Kaynak Kodla Doğrulanmış Kritik Fonksiyonlar](#14-kaynak-kodla-doğrulanmış-kritik-fonksiyonlar)
15. [A3 Uygulamasına Başlanabilir mi?](#15-a3-uygulamasına-başlanabilir-mi)

---

## 1. Mevcut Mimarinin Doğrulanmış Durumu

### 1.1 A1 Altyapısı (R2-A1 - Tamamlandı)

**Doğrulanmış Bileşenler:**

| Bileşen | Dosya | Durum | Açıklama |
|---------|-------|-------|----------|
| Kanonik Profil Kimliği Doğrulama | `src/server/taste-profile-scope.ts:125-177` | ✅ | `validateCanonicalProfileId()` - PROFILE_ID_PATTERN uyumu, kontrol karakteri reddi, trim sonrası boşluk kontrolü |
| Profil Dizini Kodlama | `src/server/taste-profile-scope.ts:179-187` | ✅ | `encodeProfileIdSafe()` - Base64URL şeması (`p1-b64url-` öneki) |
| Dizinden Kimliğe Çözümleme | `src/server/taste-profile-scope.ts:189-233` | ✅ | `decodeProfileIdSafe()` - round-trip doğrulama |
| Profil ID Eşleme Manifesti | `src/server/taste-profile-scope.ts:352-614` (parse: 352, read: 520, write: 588, ensure: 614) | ✅ | `_profile-id-map.json` - `entries` ↔ `byDir` birebir tutarlılık |
| Kapsam Bazlı Kilit Altyapısı | `src/server/taste-profile-scope.ts:735-1189` (`acquireTasteLock`: 1013, `readTasteLockState`: 839) | ✅ | `acquireTasteLock()`, `withScopedTasteLock()` - lease + heartbeat |
| FIFO Sıra + Kapsam Kilidi | `src/server/taste-profile-scope.ts:1159-1189` (`withScopedTasteLock`: 1185) | ✅ | `enqueueScopedLock()` - süreç içi FIFO |

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
| İtiraz Okuma | `readTasteObjectionsForProfile()` | `src/server/taste-store.ts:612-618` | ✅ |
| İtiraz Yazma | `writeTasteObjectionsForProfile()` | `src/server/taste-store.ts:620-638` | ✅ Profil kilidi |

**Shared Metadata Cache Kilidi:**
- `withTasteSharedMetadataCacheLock()` - `src/server/taste-store.ts:319-327` (kapsam sabiti: `taste-profile-scope.ts:39`)
- Kapsam: `shared-metadata-cache`
- Kullanım: `src/server/taste-metadata-hydrator.ts:69-92` (cache okuma/yazma), `291` (batch yazım)

**Test Durumu (A2):**
- Yeni testler: 8 test (dosya: `tests/taste/taste-profile-store.test.mjs`)
- Genel testler: Bu doküman güncellemesinde çalıştırılmadı
- Lint ve build: Bu doküman güncellemesinde çalıştırılmadı

> **⚠️ NOT:** Test sayıları ve CI durumu bu doküman güncellemesinde çalıştırılmadı. A2 commit mesajında belirtilen 511/511 test geçti bilgisi, bu dokümanda doğrulanmış olarak sunulmaz.

---

## 2. A3 Kapsamı ve Hedefleri

### 2.1 A3 Ana Hedefi

**Profil kimliğinin uçtan uca akışını sağlamak ve legacy global API'lerin profil kapsamlı karşılıklarını entegre etmek.**

### 2.2 A3 Kapsamı

#### 2.2.1 **Kesinlikle A3'te Yapılacak**

1. **ProfileContext'in app/router/adapter zincirine aktarılması**
   - `app.ts` ProfileContext'i oluşturur (satır 493-496)
   - Aynı ProfileContext, adapter oluşturulurken `profileContext` parametresiyle verilir (satır 498-501, bugün eksik)
   - Adapter zaten `profileContext?: IProfileContext` parametresini destekliyor (src/server/taste-service-adapter.ts:38)
   - Aynı ProfileContext, ayrıca `createTasteRouter` options üzerinden route katmanına aktarılır (satır 2666, bugün eksik)
   - Route handler'ları ProfileContext'e router options/closure üzerinden erişir
   - Fallback adapter oluşturuluyorsa aynı ProfileContext'i alır

2. **Profil Kimliği Akış Yönetimi**
   - Çağrı zincirinde profil kimliğinin kaybolmasını önlemek
   - Varsayılan profile dönüşünü engellemek
   - Yanlış profile yönlendirilmeleri tespit ve düzeltme

3. **Legacy Global API Desteği**
   - Mevcut global API kullanım noktalarını belirlemek
   - Yeni profil kapsamlı çağrılar ForProfile API'lerini kullanacak
   - **Global API'ler global davranışlarını korumalı - wrapper yapılmayacak, otomatik veri taşıma/migration yapılmayacak**

4. **Adapter/Route/Rebuild Coordinator Entegrasyonu**
   - Profil kimliğinin adapter katmanında alınması ve taşınması
   - Route'larda profil kimliğinin ProfileContext'ten alınması (istekte profil kimliği taşıma sözleşmesi YOK; bkz. §4.2, §13.3)
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
  - ✅ `assertCurrent()` ve `assertWritable()` çağrıları var (satır 171, 192, 223)
  - ❌ **SORUN:** `app.ts:498-501`'de adapter oluşturulurken `profileContext` **yollanmıyor** (wiring bağlantısı eksik)
  - ❌ Global API'ler kullanılıyor: `readTasteProfile()`, `readTasteEvents()`, `appendTasteEventIdempotent()`

#### `src/server/taste-routes.ts` (A2 - HTTP Katmanı)
- **Sorumluluk:** HTTP endpoint'leri
- **Durum:** ⚠️ **Kritik A3 Noktası** - Tüm endpoint'ler global API kullanıyor
- **Mevcut Durum:**
  - ❌ Tüm read/write fonksiyonları global (`readTasteProfile(dataDir)`, vb.)
  - ❌ Profil kimliği parametre olarak alınmıyor
  - `req.profileContext` **mevcut değildir ve eklenmeyecektir**. Route katmanı ProfileContext'e `createTasteRouter` options/closure üzerinden erişecektir (bkz. §11.1).
  - ⚠️ Stale-write korumasının gerçek sınırı (birleşik denetim P2-6): Store'un profil kapsamlı yazıcıları (`writeTasteProfileForProfile` `taste-store.ts:551-565`, `writeTasteIndexForProfile` `:577-590`) revision kontrolü **yapmaz**; yazma süren yazımda profil değişirse yine tamamlanır. Gerçek koruma üç aşamalıdır: (1) okuma öncesi `assertCurrent(ref)`, (2) mutasyon öncesi `assertWritable(ref)`, (3) **yazma sonrası** yeniden `assertWritable(ref)` (mevcut adapter kalıbı: `src/server/taste-service-adapter.ts:204-205`) veya revision damgalı yazım; aksi hâlde "stale write engellenir" iddiası kaynak kodla desteklenemez (bkz. §10.1).

#### `src/server/taste-rebuild-coordinator.ts` (A2 - Arka Plan)
- **Sorumluluk:** Profil yeniden hesaplama
- **Durum:** ⚠️ **Kritik A3 Noktası** - Global API kullanıyor
- **Mevcut Durum:**
  - ❌ `performRebuildOnce()` - Global store kullanıyor (satır 431; okumalar 433-436, yazım 480)
  - ❌ `ensureInitialTasteBootstrap()` - Global store kullanıyor (satır 519; okumalar 533-536, olay yazımı 635)
  - ❌ `upsertTasteMetadataInputs()` - Global index okuma/yazma (satır 333; okumalar 339-340, yazım 361)
  - ❌ `runHydrationLoop()` - Global upsert + rebuild çağırıyor (satır 154-171; çağrılar 165, 167)
  - ❌ `activeRebuildChains` anahtarı sadece `dataDir` (satır 69) - **profil bazlı değil**; `bootstrapPromises`/`bootstrapSignatures` (70-71) ve `hydrationApiKeys`/`activeHydrations` (72-73) de öyle
  - ✅ Profil kapsamlı API'ler mevcut, sadece kullanım yok

#### `src/server/taste-metadata-hydrator.ts` (A2 - Metadata)
- **Sorumluluk:** TMDB metadata hidrasyonu
- **Durum:** ⚠️ Fetch+cache katmanı profil-agnostik kalabilir (contentId bazlı, shared lock: `taste-store.ts:319-327`); ancak koordinatörün hydration döngüsünün index yazımı (`runHydrationLoop` → `upsertTasteMetadataInputs`, `taste-rebuild-coordinator.ts:154-171`) profil kapsamlı hâle getirilmelidir
- **Risk:** ⚠️ Metadata cache ortak kullanım riski (bkz. §7.2 Risk 5); hydration izolasyon detayları PR #39 §8 analizinde işlenmiştir

### 3.2 BackgroundManager Entegrasyonu

**Dosyalar:**
- `src/modules/background/service.ts` - BackgroundManager
- `src/modules/background/handlers.ts` - İşleyiciler
- `src/server/background-task-repository.ts` - SQLite deposu
- `src/contracts/background.ts` - Tipler

**A3 İlişkisi:**
- BackgroundManager, AppEventBus üzerinden olayları alıyor
- Mevcut işleyiciler: `LibraryItemAdded`, `LibraryRatingChanged`
- **Profil kimliği akışı:** `profileId` olay payload'ında DEĞİL, olayın üst düzey alanıdır (`src/contracts/events.ts:25` — `readonly profileId: string`); adapter `event.profileId` ve `event.sourceRevision` kullanır (`src/server/taste-service-adapter.ts:223-227`)
- **Mevcut işleyici davranışı:** İşleyiciler **audit-only**'dir (`src/modules/background/handlers.ts:1-13`): salt-okunur doğrulama yapar, hiçbir taste yazımı üretmez
- **A3/A4 sınırı:** A3'te işleyicilere taste yan etkisi EKLENMEZ; taste entegrasyonu A4 kapsamındadır (bkz. §8.1)

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

**Gerçek kimlik zinciri (kaynak kodla doğrulanmış; bkz. §10.1):** `DataDocument.activeProfileId` → `synchronizeProfileContext()` (`src/server/app.ts:79-97`; çağrı noktaları `app.ts:540, 1183, 1231, 1688, 2399`) → `ProfileContext`. ProfileContext kimliğin kalıcı kaynağı değil, veri belgesinden türetilen **çalışma zamanı önbelleğidir**; süreç içindeki tek erişim noktasıdır.

Normal uygulama akışında route handler'ları profil kimliğini yalnızca ProfileContext'ten alır. HTTP isteği üzerinden (query/header/body) gelen profil kimliği doğrudan Store'a aktarılmaz. `app.ts` ProfileContext'i oluşturur; aynı context hem adapter'a (`profileContext` parametresiyle) hem `createTasteRouter` options üzerinden route katmanına verilir (bkz. §11.1). Route handler'ları istek başında bir `ProfileRef` yakalar: okuma öncesi `assertCurrent(ref)`, mutasyon öncesi `assertWritable(ref)` çağırır (stale-revision koruması: `src/contracts/profile.ts:44-56`).

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      HTTP Request (taste-routes.ts)                      │
│  GET /api/taste/profile                                                  │
│  POST /api/taste/event                                                   │
│  (İstekte ayrıca profil kimliği taşıma sözleşmesi YOK)                   │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      taste-routes.ts Handler                             │
│  ✅ Profil kimliği ProfileContext'ten alınıyor                           │
│     (router options/closure; tek kaynak: ProfileContext)                 │
│  const ref = profileContext.getCurrent()   // ProfileRef yakalanır       │
│  profileContext.assertCurrent(ref)          // okuma öncesi              │
│  readTasteProfileForProfile(ref.profileId, dataDir)  // Profil API      │
│  profileContext.assertWritable(ref)         // mutasyon öncesi           │
│  appendTasteEventForProfile(ref.profileId, event, dataDir)              │
│  ❌ İstemciden gelen profileId doğrudan Store'a aktarılmaz               │
│  (POST /domain-event dahil — otorite ProfileContext; bkz. §4.3)          │
└──────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                      taste-store.ts (Profil Kapsamlı API)                │
│  resolveTastePathsForProfile(profileId, dataDir)  // profiles/p1-...     │
│  serializeTasteWriteForProfile(dataDir, profileDir, task)                │
│  tasteProfileLockScope(profileDir)  // profile:p1-b64url-...             │
└──────────────────────────────────────────────────────────────────────────┘
```

### 4.3 Profil Kimliği Kaybolma Noktaları

#### 🔴 **Kritik Nokta 1: taste-routes.ts**

**Sorun:** Tüm endpoint'ler global API kullanıyor

```typescript
// taste-routes.ts:302-307
router.get("/profile", async (_req, res) => {
  await ensureInitialTasteBootstrap(dataDir);        // ❌ Global bootstrap (satır 304)
  const profile = await readTasteProfile(dataDir);   // ❌ Global
  // ✅ Olması gereken: const ref = profileContext.getCurrent(); assertCurrent(ref);
  //                    readTasteProfileForProfile(ref.profileId, dataDir)
})
```

**Etkilenen Endpoint'ler (router kayıt satırları):**
- GET `/api/taste/profile` (satır 302)
- GET `/api/taste/overview` (satır 316)
- GET `/api/taste/metric/:id` (satır 391)
- GET `/api/taste/evidence/:metricId` (satır 432)
- GET `/api/taste/manifest` (satır 458)
- GET `/api/taste/events` (satır 471)
- POST `/api/taste/override` (satır 481)
- DELETE `/api/taste/override/:metricId` (satır 524)
- POST `/api/taste/objection` (satır 546)
- DELETE `/api/taste/objection` (satır 596)
- POST `/api/taste/event` (satır 622)
- POST `/api/taste/domain-event` (satır 678)
- POST `/api/taste/rebuild` (satır 732)

> ⚠️ **Bootstrap ve metadata upsert çağrıları da global'dir** (§5.1 tablosunda ayrı satırlar): `ensureInitialTasteBootstrap(dataDir)` 8 endpoint'te çağrılır (`taste-routes.ts:304, 318, 393, 497, 560, 640, 696, 734`); `upsertTasteMetadataInputs([meta], dataDir)` 2 endpoint'te çağrılır (`taste-routes.ts:645, 707`). Route store çağrıları ForProfile'a geçirilse bile bu çağrılar global store'a yazmaya ve global rebuild tetiklemeye devam eder (bkz. §11.1 adım 5).

> ✅ **POST /domain-event kimlik otoritesi (KARAR VERİLDİ — v2.4.0, birleşik denetim P2-11):** Route, gövdedeki olayın `profileId` alanını zorunlu tutar (`taste-routes.ts:690-693`) ve adapter'a iletir; adapter `profileContext` bağlandığında `assertWritable({profileId: event.profileId, revision: event.sourceRevision})` çağırır (`taste-service-adapter.ts:222-227`) ve uyuşmayan olayları 409 ile reddeder. **Onaylanan kural:** istemciden gelen `profileId` **yetkili kimlik değildir**; hedef profil her zaman `profileContext.getCurrent().profileId`'dir; `sourceRevision` sunucu tarafında doğrulanır; profil veya revision uyuşmazlığında istek reddedilir; istemci verisi sunucu kimlik otoritesini geçersiz kılamaz. Bu kural "istemciden gelen profileId doğrudan Store'a aktarılmaz" ilkesiyle **uyumludur**: `event.profileId` yalnızca doğrulama girdisidir, store hedefi değildir (bkz. §15.2, PR #39 WP-2/WP-5).

#### 🔴 **Kritik Nokta 2: taste-service-adapter.ts**

**Sorun:** Adapter, profileId'yi almıyor ve aktarmıyor

```typescript
// taste-service-adapter.ts:169-173
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
- `getProfile()` - Global profile okuma (satır 169; `assertCurrent` 171)
- `processEvent()` - Global event ekleme ve okuma (satır 220; `assertWritable` 223, okuma 240, ekleme 246)

**⚠️ NOT:** Adapter **zaten** `profileContext` parametresini destekliyor (`src/server/taste-service-adapter.ts:38`), ancak:
- `app.ts:498-501`'de adapter oluşturulurken `profileContext` **yollanmıyor** (wiring bağlantısı eksik)
- Bu, **app.ts → ProfileContext → { adapter, createTasteRouter } wiring bağlantısı** eksikliği

#### 🔴 **Kritik Nokta 3: taste-rebuild-coordinator.ts**

**Sorun:** Rebuild fonksiyonları global store kullanıyor

```typescript
// taste-rebuild-coordinator.ts:431-436 (performRebuildOnce)
const [events, index, existingProfile, objections] = await Promise.all([
  readTasteEvents(dataDir),           // ❌ Global
  readTasteIndex(dataDir),            // ❌ Global
  readTasteProfile(dataDir),          // ❌ Global
  readTasteObjections(dataDir),       // ❌ Global
]);

// taste-rebuild-coordinator.ts:69 (Map), 494-512 (triggerTasteProfileRebuild)
const activeRebuildChains = new Map<string, Promise<RebuildCoordinatorResult>>();
// ❌ Anahtar: dataDir (sadece)
// ✅ Olması gereken: `${dataDir}:${profileId}`
```

**Etkilenen Fonksiyonlar:**
- `performRebuildOnce()` - Tüm okuma/yazma global (satır 431-492; okumalar 433-436, yazım 480, manifest 481)
- `ensureInitialTasteBootstrap()` - Global okuma/yazma + rebuild (satır 519-660; okumalar 533-536, olay yazımı 635)
- `upsertTasteMetadataInputs()` - Global index (satır 333-369; okumalar 339-340, yazım 361)
- `runHydrationLoop()` - Global upsert + rebuild (satır 154-171; çağrılar 165, 167)

#### 🟡 **Orta Öncelik: ProfileContext ve Adapter Wiring**

**Durum:**
- ✅ `ProfileContext` `app.ts:493-496`'de `initialProfileId: 'default'` ile oluşturuluyor (açılış penceresi: bkz. §12.2-§12.3)
- ✅ Adapter `taste-service-adapter.ts:38`'de `profileContext?: IProfileContext` parametresini kabul ediyor
- ❌ **SORUN:** `app.ts:498-501`'de adapter oluşturulurken `profileContext` **yollanmıyor** (wiring bağlantısı eksik)
- `getDefaultProfileId()` **oluşturulmayacak**; profil kimliği için ikinci bir kaynak tanımlanmayacaktır. Tek kaynak ProfileContext'tir.

---

## 5. Legacy Global API Kullanım Noktaları

### 5.1 taste-routes.ts

| Satır | Endpoint | API | Kullanım | Profil Bağımlı |
|-------|----------|-----|----------|-----------------|
| 304, 318, 393, 497, 560, 640, 696, 734 | (8 endpoint öncesi) | `ensureInitialTasteBootstrap()` | Global | ✅ |
| 305 | GET /profile | `readTasteProfile()` | Global | ✅ |
| 318-323 | GET /overview | `readTasteProfile()`, `readTasteEvents()`, `readTasteIndex()`, `readTasteObjections()` | Global | ✅ |
| 394, 406 | GET /metric/:id | `readTasteProfile()`, `readTasteIndex()` | Global | ✅ |
| 434 | GET /evidence/:metricId | `readTasteProfile()` | Global | ✅ |
| 460 | GET /manifest | `readTasteManifest()` | Global | ✅ |
| 473 | GET /events | `readTasteEvents()` | Global | ✅ |
| 498, 516 | POST /override | `readTasteProfile()`, `writeTasteProfile()` | Global | ✅ |
| 527, 538 | DELETE /override/:metricId | `readTasteProfile()`, `writeTasteProfile()` | Global | ✅ |
| 562-580 | POST /objection | `readTasteObjections()`, `readTasteIndex()`, `writeTasteObjections()`, `writeTasteIndex()`, `triggerTasteProfileRebuild()` (583) | Global | ✅ |
| 606, 610 | DELETE /objection | `readTasteObjections()`, `writeTasteObjections()`, `triggerTasteProfileRebuild()` (611) | Global | ✅ |
| 645 | POST /event | `upsertTasteMetadataInputs()` | Global | ✅ |
| 656, 658 | POST /event | `appendTasteEventIdempotent()`, `triggerTasteProfileRebuild()` | Global | ✅ |
| 707 | POST /domain-event | `upsertTasteMetadataInputs()` | Global | ✅ |
| 711 | POST /domain-event | `tasteAdapter.processEvent()` | Global* | ✅ |
| 735 | POST /rebuild | `triggerTasteProfileRebuild()` | Global | ✅ |

* `tasteAdapter.processEvent()` - Adapter içindeki global API kullanımı (satır 240, 246). "Satır" sütunu çağrı satırlarıdır; router kayıt satırları §4.3 Kritik Nokta 1'de listelenmiştir.

> ⚠️ **Bootstrap ve upsert satırları (P1-4):** `ensureInitialTasteBootstrap(dataDir)` 8 endpoint handler'ının başında çağrılır (`src/server/taste-routes.ts:304, 318, 393, 497, 560, 640, 696, 734`); `upsertTasteMetadataInputs([meta], dataDir)` 2 endpoint'te çağrılır (`src/server/taste-routes.ts:645, 707`). Route store çağrıları ForProfile API'lerine geçirilse bile bu çağrılar global store'a yazmaya ve global rebuild tetiklemeye devam eder; profil kapsamı planı §11.1 adım 5'te ve PR #39 §8'de işlenmiştir.

### 5.2 taste-service-adapter.ts

| Satır | Fonksiyon | API | Kullanım |
|-------|-----------|-----|----------|
| 173 | `getProfile()` | `readTasteProfile()` | Global |
| 201 | `refreshProfile()` | `triggerTasteProfileRebuild()` | Global |
| 240 | `processEvent()` | `readTasteEvents()` | Global |
| 246 | `processEvent()` | `appendTasteEventIdempotent()` | Global |
| 250 | `processEvent()` | `triggerTasteProfileRebuild()` | Global |

**Mevcut profil koruması (profileContext bağlıysa):** `assertCurrent` satır 171 (`getProfile`), `assertWritable` satır 192 ve 205 (`refreshProfile`), satır 223 (`processEvent` — `event.profileId` + `event.sourceRevision`). `profileContext` bugün bağlı olmadığı için bu korumalar pasif kalır (bkz. §6.3).

### 5.3 taste-rebuild-coordinator.ts

| Satır | Fonksiyon | API | Kullanım |
|-------|-----------|-----|----------|
| 433 | `performRebuildOnce()` | `readTasteEvents()` | Global |
| 434 | `performRebuildOnce()` | `readTasteIndex()` | Global |
| 435 | `performRebuildOnce()` | `readTasteProfile()` | Global |
| 436 | `performRebuildOnce()` | `readTasteObjections()` | Global |
| 480 | `performRebuildOnce()` | `writeTasteProfile()` | Global |
| 481 | `performRebuildOnce()` | `readTasteManifest()` | Global |
| 533 | `ensureInitialTasteBootstrap()` | `readTasteEvents()` | Global |
| 534 | `ensureInitialTasteBootstrap()` | `readTasteProfile()` | Global |
| 535 | `ensureInitialTasteBootstrap()` | `readTasteManifest()` | Global |
| 536 | `ensureInitialTasteBootstrap()` | `readTasteMetadataCache()` | Global (paylaşımlı cache; bootstrap'ta `readTasteIndex`/`readTasteObjections` çağrısı YOKTUR) |
| 625 | `ensureInitialTasteBootstrap()` | `upsertTasteMetadataInputs()` | Global |
| 635 | `ensureInitialTasteBootstrap()` | `writeTasteEvents()` | Global |
| 647 | `ensureInitialTasteBootstrap()` | `triggerTasteProfileRebuild()` | Global |
| 651 | `ensureInitialTasteBootstrap()` | `scheduleTasteMetadataHydration()` | Global (hydr. döngüsü) |
| 165 | `runHydrationLoop()` | `upsertTasteMetadataInputs()` | Global |
| 166 | `runHydrationLoop()` | `triggerTasteProfileRebuild()` | Global |
| 339-340 | `upsertTasteMetadataInputs()` | `readTasteIndex()`, `readTasteObjections()` | Global |
| 361 | `upsertTasteMetadataInputs()` | `writeTasteIndex()` | Global |

**Map yapıları (satır 69-73):** `activeRebuildChains` (69), `bootstrapPromises` (70), `bootstrapSignatures` (71), `hydrationApiKeys` (72), `activeHydrations` (73) — bugün beşinin anahtarı da yalnızca `dataDir`'dir. **A3 hedefi:** `activeRebuildChains`, `bootstrapPromises`, `bootstrapSignatures` ve `activeHydrations` `${dataDir}:${profileId}` anahtarına geçer; `hydrationApiKeys` ise `dataDir` anahtarlı **kalır** (birleşik denetim P1-1: TMDB API anahtarı profil-agnostik bir süreç kimlik bilgisidir; bkz. §10.3, §10.4).

**Bootstrap okuma gerçekleri (birleşik denetim P2-4 düzeltmesi):** Bootstrap'ta `readTasteIndex`/`readTasteObjections` çağrısı **yoktur**; profil index'i `upsertTasteMetadataInputs` üzerinden güncellenir (satır 623-625) ve cache→input çevirimi `tasteMetadataCacheToInput` (`:136-142`) ile yapılır (satırlar 614-619).

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
| `readTasteObjectionsForProfile()` | ✅ | ✅ | İtiraz okuma | `taste-store.ts:612-618` |
| `writeTasteObjectionsForProfile()` | ✅ | ✅ | İtiraz yazma | `taste-store.ts:620-638` |

### 6.2 Değerlendirme Sonucu

**✅ YETERLİ** - A2'de eklenen `ForProfile` API'leri A3 için **tamamen yeterlidir**.

✅ **DÜZELTME:** Önceki sürümde `appendTasteEventIdempotentForProfile()` ve `writeTasteManifestForProfile()` eksik olarak gösterilmişti. **Gerçek durum:** `appendTasteEventIdempotentForProfile()` **mevcut** (satır 499). `writeTasteManifestForProfile()` adında ayrı bir export **yoktur ve gerekmez**: profil yazıcıları manifest'i kilit altında **kendileri günceller** — `writeTasteProfileForProfile` (`taste-store.ts:551-565`, manifest güncellemesi `:563`) ve `writeTasteIndexForProfile` (`taste-store.ts:577-590`, manifest güncellemesi `:588`) her ikisi de `writeManifestForPathsUnlocked` çağırır (`src/server/taste-store.ts:198`). Olay tabanlı akışta ayrıca manifest yazımı gerekmez: `appendTasteEventForProfile` (`taste-store.ts:519-524`) sonrası `rebuildOnEvent` zinciri `performRebuildOnce()`'ı tetikler ve manifest rebuild içinde yeniden üretilir. A3'te manifest'i yazıcılar dışında doğrudan yazan yeni bir profil kapsamlı kod yolu eklenirse `writeManifestForPathsUnlocked` kalıbı o adımda kullanılmalıdır (bkz. PR #39 §7).

Tüm gerekli CRUD işlemleri profil kapsamlı olarak mevcut:
- Event: ekle (idempotent), oku, toplu yaz
- Profile: oku, yaz
- Index: oku, yaz
- Manifest: oku
- Objections: oku, yaz

### 6.3 Adapter Profil Kimliği Desteği

**✅ MEVCUT:** `taste-service-adapter.ts:38` - `profileContext?: IProfileContext` parametresi var.

**❌ SORUN:** `app.ts:498-501`'de adapter oluşturulurken `profileContext` **yollanmıyor** (wiring bağlantısı eksik).

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

**Asıl eksiklik:** `app.ts → ProfileContext → { adapter, createTasteRouter }` **wiring bağlantısı** kurulmamış.

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

#### FIFO Sıra + Kilit (src/server/taste-profile-scope.ts:1159-1189 — `withScopedTasteLock`: 1185)

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

#### 🔴 **Risk 1: Profil Kimliği Kaybolması (P1)**

**Senaryo:** HTTP isteğinde profileId parametresi yoksa veya yanlışsa

**Etki:** Yanlış profile'in verileri okunur/yazılır

**Çözüm:**
- Profil kimliği ProfileContext'ten alınmalı (tek kaynak; bkz. §10.1)
- ProfileContext doğrulama
- Varsayılan profile'e dönüş engellenmeli

#### 🟡 **Risk 2: Yeni Profil Akışında Yanlışlıkla Global API Çağrılması (P1)**

**Karar:**
- Legacy global API'ler **eski global veri yolunu** (`data/taste/`) kullanmaya devam edecek
- Profil kapsamlı yeni işlemler **ForProfile API'lerini** (`data/taste/profiles/...`) kullanacak
- Global API wrapper veya otomatik migration **yapılmayacak**

**A3'teki Risk:** Yeni profil akışında yanlışlıkla global API çağrılmasıdır. Bu durumda:
- Yeni profil verileri global veri yoluna yazılabilir
- Veri izolasyonu bozulabilir
- Farklı profillerin verileri karışabilir

**Çözüm:**
- Yeni kod **sadece** ForProfile API'lerini kullanmalı
- Lint kuralı: global API kullanımını uyarı vermek (yapılabilir)
- Code review: global API kullanımını kontrol etmek

#### 🟡 **Risk 3: Eşzamanlı Rebuild'ler (P1)**

**Senaryo:** Aynı profile için birden fazla rebuild tetiklenirse

**Mevcut Koruma:**
```typescript
// src/server/taste-rebuild-coordinator.ts:69 (Map), 494-512 (triggerTasteProfileRebuild)
const activeRebuildChains = new Map<string, Promise<RebuildCoordinatorResult>>();

function triggerTasteProfileRebuild(dataDir: string = "data"): Promise<...> {
  const prevChain = activeRebuildChains.get(dataDir) ?? Promise.resolve(null);
  const nextRun = prevChain.then(() => performRebuildOnce(dataDir), ...);
  activeRebuildChains.set(dataDir, nextRun);
  // ...
}
```

**Sorun:** `dataDir` bazlı, profil bazlı değil

**Çözüm:** `activeRebuildChains` anahtarı `${dataDir}:${profileId}` olmalı; aynı standardın `bootstrapPromises`, `bootstrapSignatures` ve `activeHydrations` Map'lerine de uygulanması gerekir. `hydrationApiKeys` ise `dataDir` anahtarlı **kalır** — TMDB API anahtarı profil-agnostik bir süreç kimlik bilgisidir; tek yazma noktası `configureTasteHydration(dataDir, apiKey)` (`taste-rebuild-coordinator.ts:144-152`) profil parametresi almaz ve `${dataDir}:${profileId}` anahtarına geçirilirse hydration her profil için sessizce hiç çalışmaz (birleşik denetim P1-1; bkz. §10.3, §10.4)

#### 🟡 **Risk 4: Bootstrap ve Metadata Akışının Profil Kapsamı (P1)**

**Gerçek kontaminasyon mekanizması (kaynak kodla doğrulanmış):**

1. `ensureInitialTasteBootstrap()` salt **aktif profili** kaynak alır: profil olaylarını aktif profil üzerinden toplar (`src/server/taste-rebuild-coordinator.ts:547-557`; aktif profil seçimi `src/core/taste/migration.ts:59-78`).
2. Toplanan olaylar **tek global events dosyasına** eklenir: `collectNewEvents` çıktısı `writeTasteEvents(..., dataDir)` ile `data/taste/` altındaki global dosyaya yazılır (`taste-rebuild-coordinator.ts:635`).
3. Profil değiştiğinde bootstrap **eski profilin olaylarını temizlemez**; yeni profilin olayları aynı global dosyaya eklenir.
4. `performRebuildOnce()` (satır 431) global events dosyasını bütünüyle okur (satır 433) ve tüm profillerin olaylarını **tek profil profilinde birlikte** işler → kontaminasyon.

**Bu nedenle profileId parametresi eklemek tek başına yeterli değildir:** Bootstrap'e profil kimliği parametresi eklense bile olaylar global dosyaya yazılmaya devam ederse kontaminasyon sürer. Seçenek B onaylanırsa zorunlu kural: profil kapsamlı rebuild **yalnızca ForProfile API'lerini** okur/yazar, legacy global dosyalara asla dokunmaz.

**Bootstrap Map'lerinin profil kapsamı:** `bootstrapPromises` (satır 70) ve `bootstrapSignatures` (satır 71) anahtarı yalnızca `dataDir`'dir; ilk profil için başlatılan bootstrap, ikinci profilin bootstrap'ını engeller/atlar. Her ikisi de `${dataDir}:${profileId}` anahtarına geçirilmelidir.

**Hedef profil garantisi (birleşik denetim P1-3):** Bootstrap'in hedef profili ve verinin türetildiği profil iki ayrı kimliktir: aktif profil `doc.profiles.find((p) => p && p.id === doc.activeProfileId) ?? doc.profiles[0]` ile seçilir (`taste-rebuild-coordinator.ts:551-552` — bulunamazsa belgedeki **ilk profile** düşer), item'lar bu aktif profilden okunur (`:600`), olaylar ise `migrateExistingData({ dataDocument: doc, asOf })` içinde `doc.activeProfileId`'den üretilir (`src/core/taste/migration.ts:59-61`) ve hedef `profileId`'ye yazılır (`:635`). Hedef ≠ belgenin aktif profili olduğunda bir profilin item/event verisi başka profilin deposuna yazılabilir. **Kural (A3'te zorunlu güvenlik kuralı):** Bootstrap yalnızca `profileId === doc.activeProfileId` iken yazım yapar; aksi hâlde no-op + açık uyarı. `doc.profiles[0]` fallback'i kaldırılır ya da açık gerekçeyle korunur; `migrateExistingData` çıktısı ancak bu uyum sağlandığında hedefe yazılır. Not: "Bootstrap'in profil başına tam işleyişinin A4'e bırakılması" bir inceleme önerisidir, karar değildir; bu kural A3'te uygulanır.

**Metadata akışı:** `upsertTasteMetadataInputs` (satır 333-369) ve `runHydrationLoop` (satır 154-171) global index okur/yazar; ayrıntılı hydration izolasyon analizi PR #39 §8 ile hizalıdır (fetch+cache ortak kalır, index yazımı profil kapsamlı olur).

#### 🟡 **Risk 5: Metadata Cache Ortak Kullanım (P2 - YENİ)**

**Senaryo:** Tüm profiller aynı metadata cache'ini kullanıyor

**Mevcut Durum:**
- `taste-metadata-hydrator.ts` - Shared cache (`data/taste/cinetrack-taste-metadata-cache.json`)
- Cache, contentId bazlı olduğu için teorik olarak sorun yok

**Risk:**
- Farklı profiller aynı contentId için farklı metadata ile cache'i çakıştırabilir (TMDB metadata içerik bazlı olduğundan pratikte düşük)

**Çözüm:**
- Metadata cache, contentId bazlı olduğundan sorun minimal
- Cache okuma/yazma, shared metadata cache kilidi ile korunmalı (mevcut: ✅ `withTasteSharedMetadataCacheLock` — `src/server/taste-store.ts:319-327`)
- Profil kapsamı gereken katman cache DEĞİL, hydration döngüsünün index yazımıdır (bkz. §3.1, PR #39 §8.3). `hydrationApiKeys` bu profil kapsamının dışındadır: API anahtarı profil-agnostik bir süreç kimlik bilgisidir ve `dataDir` anahtarlı kalır (birleşik denetim P1-1; bkz. §10.3)

#### 🟡 **Risk 6: İstemciden Gelen Profil Kimliğinin Güven Sınırı (P2 - YENİ)**

**Senaryo:** İstemci, keyfi profil kimlikleri gönderebilir

**Risk:**
- Yetkisiz profil erişimi
- DoS saldırıları (profil oluşturma)

**Çözüm:**
- Profil kimliği, sunucu tarafında ProfileContext ile doğrulanmalı
- Sadece aktif profilin verilerine erişim izni
- `req.profileContext` **kullanılmayacak ve oluşturulmayacaktır**. Route katmanı ProfileContext'e router options/closure üzerinden erişecektir.

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

| Dosya | Kapsam | Doğrulanmış Sayım | Durum |
|-------|--------|--------------------|-------|
| `tests/taste/taste-profile-scope.test.mjs` | Kapsam modülü (8 `describe` bloğu: doğrulama, kodlama/çözümleme, manifest, kilit) | 26 `it()` / 8 `describe()` | ✅ A2'de var |
| `tests/taste/taste-profile-store.test.mjs` | ForProfile store API'leri | 8 test | ✅ A2'de var |

> ⚠️ **NOT:** Fonksiyon bazında test dağılımı (hangi fonksiyonun kaç testi olduğu) bu doküman güncellemesinde doğrulanmadı; yukarıdaki sayılar dosya bazlı sayımdır. Testlerin kabul kriteri olması ile çalıştırılıp geçmiş olması farklı konulardır; bu doküman güncellemesinde test ve CI **çalıştırılmadı** (bkz. §9.2).
#### 9.1.2 Entegrasyon Testleri (Integration Tests)

| Senaryo | Test Sayısı | A3 Hedefi | Dosya |
|---------|-------------|-----------|-------|
| Profil kimliği akışı (ProfileContext → ProfileRef → Adapter → Store) | 5 | ✅ Yeni | `tests/taste/taste-profile-flow.test.mjs` (planlanan) |
| Profil kapsamlı rebuild izolasyonu (bootstrap + hydration dahil) | 3 | ✅ Yeni | `tests/taste/taste-rebuild-isolation.test.mjs` (planlanan) |
| Eşzamanlı profil işlemleri | 4 | ✅ Yeni | `tests/taste/taste-concurrency.test.mjs` (planlanan) |
| Global API davranışı değişmedi (regresyon; yönlendirme YOK) | 3 | ✅ Yeni | `tests/taste/taste-legacy-compat.test.mjs` (planlanan) |
| POST /domain-event istemci sözleşmesi (`event.profileId`/`sourceRevision`) | 2 | ✅ Yeni | `tests/taste/taste-profile-flow.test.mjs` (planlanan) |

> ℹ️ **Yönlendirme testi kaldırıldı:** Global API'lerin ForProfile'a yönlendirilmesi tasarım gereği YOKTUR (§10.2); bu yüzden "Global API → ForProfile yönlendirme" testi yerine "global API davranışı değişmedi" regresyon senaryosu konmuştur.

#### 9.1.3 E2E Testleri

| Senaryo | Test Sayısı | A3 Hedefi | Dosya |
|---------|-------------|-----------|-------|
| Çoklu profil taste işlemleri | 5 | ✅ Yeni | `tests/taste/taste-multi-profile-e2e.test.mjs` (planlanan) |
| Profil değişimi sırasında izolasyon (ProfileRef/`assertCurrent` sözleşmesi; bkz. §4.2) | 3 | ✅ Yeni | `tests/taste/taste-profile-switch-e2e.test.mjs` (planlanan) |
| Legacy uyumluluk | 2 | ✅ Yeni | `tests/taste/taste-legacy-compat-e2e.test.mjs` (planlanan) |

> **⚠️ NOT:** Test dosyaları **planlanmış**, henüz oluşturulmadı. Test sayıları tahmindir.

### 9.2 Kabul Kriterleri

#### 🟢 **MUTLAK — Zorunlu Kabul Kriterleri**

1. ✅ Tüm taste endpoint'leri profil kimliğini ProfileContext'ten almalı; istek başına `ProfileRef` yakalanmalı, okuma öncesi `assertCurrent(ref)`, mutasyon öncesi `assertWritable(ref)` çağrılmalı (tek kaynak; bkz. §4.2, §10.1). Store yazıcıları revision kontrolü yapmadığından (`taste-store.ts:551-565, 577-590`) uzun süren yazma akışlarında **yazma sonrası yeniden `assertWritable(ref)`** çağrılmalı (mevcut adapter kalıbı: `taste-service-adapter.ts:204-205`) veya yazım revision damgası taşımalıdır (bkz. §10.1)
2. ⬜ Tüm taste işlemleri profil kapsamlı API'leri kullanmalı — **Karar verildi (v2.4.0):** §12.4 Karar Durumu'nda onaylanan B esasına göre kullanıcıya dönük akış profil kapsamlı API'lere geçer; eski global veri korunur ve otomatik dağıtım/migration yapılmaz. Kriter artık koşullu değildir
3. ✅ `app.ts → ProfileContext → { adapter, createTasteRouter }` wiring bağlantısı kurulmalı (aynı örnek iki kanala da verilir; bkz. §11.1)
4. ✅ Profil kimliği doğrulama tüm katmanlarda çalışmalı (`validateCanonicalProfileId` → `resolveTastePathsForProfile` zinciri)
5. ✅ Coordinator Map'lerinde (`taste-rebuild-coordinator.ts:69-73`) `activeRebuildChains` (69), `bootstrapPromises` (70), `bootstrapSignatures` (71) ve `activeHydrations` (73) `${dataDir}:${profileId}` anahtarına geçirilmeli; `hydrationApiKeys` (72) `dataDir` anahtarlı **kalır** — API anahtarı profil-agnostik süreç kimlik bilgisidir ve tek yazma noktası `configureTasteHydration(dataDir, apiKey)` (`:144-152`) profil parametresi almaz (bkz. §10.3, §10.4)
6. ✅ Legacy global API davranışı korunmalı; global API'ler ForProfile'a **yönlendirilmez** (yönlendirme testi önerisi kaldırıldı; yerine "davranış değişmedi" regresyonu gelir — bkz. §9.1.2)
7. ✅ Coordinator modülünde global okuma/yazma API çağrısı kalmaz — `performRebuildOnce`, `ensureInitialTasteBootstrap`, `upsertTasteMetadataInputs`, `runHydrationLoop` ve bootstrap/hydration akışları dahil (bkz. §5.3, PR #39 §8)
8. ⬜ `getCurrent()` üzerinden alınan profil kimliği `validateCanonicalProfileId`'den her zaman geçmeli (açılış anı tutarlılığı; bkz. §12.3). **Bu kriter zorunludur:** mevcut kaynakta `synchronizeProfileContext()` kimliği doğrulamadan context'e yazar (`app.ts:83-85`); senkronizasyon `validateCanonicalProfileId` ile doğrulamalı veya geçersiz/kanonik olmayan kimliği reddetmelidir; aksi hâlde pencere her eksik/geçersiz veri belgesi yüklemesinde yeniden açılır (bkz. §12.3)
9. ⬜ A2 testlerinin geçmesi A3 kabul kriteridir (`tests/taste/taste-profile-store.test.mjs`, `taste-profile-scope.test.mjs`) — Bu doküman güncellemesinde çalıştırılmadı, geçme durumu doğrulanmadı

> ⚠️ **Kabul kriteri ≠ test sonucu:** Yukarıdaki maddeler A3'ün kabul kriterleri olarak tanımlanmıştır; testlerin kabul kriteri olması ile testlerin gerçekten çalıştırılıp geçmiş olması farklı konulardır. Bu doküman güncellemesinde test ve CI **çalıştırılmadı**; hiçbir kriter çalıştırılmış veya geçmiş olarak sunulmaz.

#### 🟡 **ÖNERİLEN (P1)**

1. ⚠️ Bootstrap fonksiyonları profil kimliği parametresi almalı; `bootstrapPromises`/`bootstrapSignatures` Map'leri de `${dataDir}:${profileId}` anahtarına geçirilmeli (bkz. §7.2 Risk 4)
2. ⚠️ Metadata akışı: hydration fetch+cache katmanı ortak kalabilir; hydration döngüsünün Taste index yazımı profil kapsamlı olmalı (bkz. §3.1, PR #39 §8.3-§8.4)
3. ⚠️ Lint kuralı: global API kullanımını uyarı vermek

#### 🔵 **İYİLEŞTİRME (P2)**

1. 🔵 Metadata cache profil bazlı olabilir (opsiyonel)

---

## 10. Açık Teknik Kararlar ve Öneriler

### 10.1 Karar 1: Profil Kimliği Nasıl Alınacak?

**Karar:** ProfileContext, çalışma zamanındaki tek profil kimliği erişim noktasıdır.

**Gerçek kimlik zinciri (kaynak kodla doğrulanmış):**
- Kalıcı kaynak: `DataDocument.activeProfileId` (şema/belge normalizasyonu `profile-default` üretir: `src/core/cinetrack-core.ts:849-852`)
- `synchronizeProfileContext()` (`src/server/app.ts:79-97`) her belge yükleme/kaydetme sonrası ProfileContext'i belgeyle eşitler (çağrı noktaları: `app.ts:540, 1183, 1231, 1688, 2399`)
- ProfileContext bu zincirin **türetilmiş çalışma zamanı önbelleğidir**; kalıcı kimlik kaynağı değildir (bkz. §4.2)

**Normal uygulama akışında:**
- Route handler'ları profil kimliğini **yalnızca** ProfileContext'ten almalı
- Query/Header üzerinden gelen kimlik **doğrudan Store'a aktarılmamalı**
- İstek başına `ProfileRef` yakalanmalı; okuma öncesi `assertCurrent(ref)`, mutasyon öncesi `assertWritable(ref)` çağrılmalı (`src/contracts/profile.ts:44-56`)

**İstisnalar (gelecekte):**
- Çoklu profil desteklenirse: Açık yetkilendirme ve yapılandırma şartı tanımlanmalı
- Geliştirme/modu: Açık yapılandırma ile etkinleştirilmeli
- `personalReadGuard` tek başına profil yetkilendirmesi olarak **kabul edilmemeli**

**Uygulama:**
```typescript
// src/server/taste-routes.ts (planlanan)
function getProfileRef(profileContext: IProfileContext): WriteProfileRef {
  // Tek erişim noktası: ProfileContext
  const ref = profileContext.getCurrent();
  if (!ref.profileId) {
    throw new Error('Aktif profil kimliği bulunamadı');
  }
  return ref;
}

// Handler kalıbı:
// const ref = getProfileRef(profileContext);
// profileContext.assertCurrent(ref);   // okuma öncesi (sync; profile.ts:44-56)
// const profile = await readTasteProfileForProfile(ref.profileId, dataDir);
// profileContext.assertWritable(ref);  // mutasyon öncesi (sync)
// await appendTasteEventForProfile(ref.profileId, event, dataDir);
```

**⚠️ NOT:** `req.profileContext` **mevcut değil ve eklenmemeli**. ProfileContext zaten uygulama katmanında mevcut, route handler'larına enjeksiyon/closure yoluyla aktarılmalı.

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
// src/server/taste-rebuild-coordinator.ts:69 (Map), 494-512 (tanım)
const activeRebuildChains = new Map<string, Promise<...>>();
// Anahtar: dataDir
```

**✅ ÖNERİ (geçerli TypeScript imzası):**
```typescript
// Anahtar: `${dataDir}:${profileId}`
const activeRebuildChains = new Map<string, Promise<...>>();

function triggerTasteProfileRebuild(
  profileId: string,
  dataDir: string = "data"
): Promise<RebuildCoordinatorResult> {
  const chainKey = `${dataDir}:${profileId}`;
  const prevChain = activeRebuildChains.get(chainKey) ?? Promise.resolve(null);
  const nextRun = prevChain.then(() => performRebuildOnce(profileId, dataDir), ...);
  activeRebuildChains.set(chainKey, nextRun);
  // ...
}
```

> ℹ️ **İmza tekbiçimleme (birleşik denetim P2-2):** `triggerTasteProfileRebuild(profileId, dataDir)` imzası PR #39 (v1.2.0) ile birebir aynıdır (PR #39 §6, §7.2, §13.2); önceki sürümdeki `(dataDir, profileId)` çelişkisi ve bu notun eski hatalı TypeScript gerekçesi kaldırılmıştır — varsayılanlı parametreden sonra zorunlu parametre TypeScript'te zaten geçerlidir. Sıra, A2 store konvansiyonu `(profileId, …, dataDir)` ile tutarlıdır.

**Çağrı noktaları (9):** imza değişikliği tüm çağrıları etkiler:

| Çağrı noktası | Dosya:Satır |
|---------------|-------------|
| Route: POST /objection | `src/server/taste-routes.ts:583` |
| Route: DELETE /objection | `src/server/taste-routes.ts:611` |
| Route: POST /event | `src/server/taste-routes.ts:658` |
| Route: POST /rebuild | `src/server/taste-routes.ts:735` |
| Adapter: `refreshProfile()` | `src/server/taste-service-adapter.ts:201` |
| Adapter: `processEvent()` | `src/server/taste-service-adapter.ts:250` |
| Coordinator: `runHydrationLoop()` | `src/server/taste-rebuild-coordinator.ts:166` |
| Coordinator: `ensureInitialTasteBootstrap()` | `src/server/taste-rebuild-coordinator.ts:647` |
| Tanım | `src/server/taste-rebuild-coordinator.ts:494` |

Aynı anahtar standardı `bootstrapPromises` (70), `bootstrapSignatures` (71) ve `activeHydrations` (73) Map'lerine de uygulanmalıdır. `hydrationApiKeys` (72) ise `dataDir` anahtarlı **kalır** (birleşik denetim P1-1): TMDB API anahtarı profil-agnostik bir süreç kimlik bilgisidir; tek yazma noktası `configureTasteHydration(dataDir, apiKey)` (`:144-152`) profil parametresi almaz ve `${dataDir}:${profileId}` anahtarına geçirilirse `runHydrationLoop`/`scheduleTasteMetadataHydration` anahtarı bulamaz, hidrasyon her profil için sessizce hiç çalışmaz. Karar PR #39 §8.4 ile aynı dildir.

### 10.4 Karar 4: Coordinator Fonksiyonlarının Gerçek Sınırları

**Mevcut Durum (doğrulanmış):**
- `performRebuildOnce()` - **Global** store kullanıyor (satır 431; okumalar 433-436, yazım 480, manifest 481)
- `ensureInitialTasteBootstrap()` - **Global** okuma/yazma + rebuild + hydration (satır 519; okumalar 533-536, olay yazımı 635, trigger 647, hydration 651)
- `upsertTasteMetadataInputs()` - Global index okuma/yazma (satır 333-369; okumalar 339-340, yazım 361)
- `runHydrationLoop()` - Global upsert + rebuild (satır 154-171; çağrılar 165, 167)
- Beş Map'in tamamı `dataDir` anahtarlı (satır 69-73)

**✅ A3 Hedefi:**
1. `performRebuildOnce(profileId, dataDir)` - Profil kapsamlı
2. `ensureInitialTasteBootstrap(profileId, dataDir)` - Profil kapsamlı; bootstrap Map'leri de profil anahtarlı
3. `upsertTasteMetadataInputs`/`runHydrationLoop` - metadata fetch+cache ortak kalır, index yazımı profil kapsamlı olur (PR #39 §8.3); cache→index beslemesi bootstrap (satırlar 614-619) ve hydration cache-hit turu için tek ortak yardımcı üzerinden yapılır (`seedProfileIndexFromCache`, birleşik denetim P2-9; PR #39 §8.5)
4. `activeRebuildChains`, `bootstrapPromises`, `bootstrapSignatures`, `activeHydrations` `${dataDir}:${profileId}` anahtarlı; `hydrationApiKeys` `dataDir` anahtarlı kalır (profil-agnostik süreç kimlik bilgisi; bkz. §10.3)

---

## 11. A3 Uygulama Sırası

### 11.1 Gerçek Bağımlılık Sırası

A3 uygulaması **aşağıdaki sırayla** gerçekleştirilmelidir:

> ℹ️ **Öncelik notu (v2.4.0):** §12.4 kararları kullanıcı tarafından **verilmiştir**: eski global veri korunur, otomatik dağıtım/migration yapılmaz; kullanıcıya dönük taste akışı profil kapsamlı ForProfile API'lerine geçer (bkz. §12.4 Karar Durumu). Adımların tamamı (1-8) teknik ön koşullardır; koşullu adım kalmamıştır.

#### 1. ProfileContext'in app/router/adapter zincirine aktarılması (P1)

**Zincir:** `app.ts` → `ProfileContext` → { `TasteServiceAdapter` (`profileContext` parametresi), `createTasteRouter` (options) } → `route handlers`

**Sorumluluklar:**
- **app.ts:** ProfileContext'i oluşturur (`src/server/app.ts:493-496`)
- **app.ts:** Aynı ProfileContext'i adapter oluşturulurken `profileContext` parametresiyle verir (`src/server/app.ts:498-501`, bugün eksik)
- **app.ts:** Aynı ProfileContext'i `createTasteRouter` options üzerinden route katmanına aktarır (`src/server/app.ts:2666`, bugün eksik)
- **createTasteRouter:** Router örneğini oluşturur; ProfileContext'i options'tan route handler'larına closure/options yoluyla ulaştırır
- **route handlers:** ProfileContext'e yalnızca router options/closure üzerinden erişir
- **Fallback adapter:** `createTasteRouter` içinde oluşturuluyorsa (`src/server/taste-routes.ts:294-295`) aynı ProfileContext'i alır

**Gerekli router options değişikliği (açık):** `createTasteRouter` imzasına (`src/server/taste-routes.ts:275-293`) yeni bir **ZORUNLU** `profileContext: IProfileContext` options alanı eklenmelidir (isteğe bağlı değildir). Mevcut options alanları: `tmdbApiKey`, `eventBus`, `tasteAdapter`, `deferAdapterSubscription`, `onDomainEvent`, `onRawTasteEvent`. `profileContext` verilmeden `createTasteRouter` çağrısı tanımlı bir açık hata üretir; küresel fallback **eklenmez**.

> ⚠️ **Sorumluluk sınırı:** Adapter, router OLUŞTURMAZ ve ProfileContext'i router'a AKTARMAZ. ProfileContext'in dağıtımı `app.ts`'in sorumluluğudur; adapter yalnızca kendi doğrulamaları (`assertCurrent`/`assertWritable`) için context'i kullanır.

> ✅ **Kullanıcı kararı uygulandı (birleşik denetim P1-2 — zorunlu `profileContext`):** Router options'ta `profileContext` **zorunludur**; profil-siz çağrı için global fallback **eklenmez**. Mevcut profil-siz route testleri açık bir `ProfileContext` sağlayacak şekilde güncellenir — örnek: `tests/taste/stock-and-live-profile.test.mjs:358` router'ı `createTasteRouter(tmpDir)` olarak options'sız kurar ve `/metric`, `/override`, `/objection` uçlarında başarı bekler. İlgili test matrisi kriteri "mevcut testler değişmeden geçer" değil, **"profil-siz testler açık ProfileContext ile güncellenerek geçer"** olarak değiştirilir (bkz. §9.2).

**Mevcut Durum:**
```typescript
// src/server/app.ts:493-501
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
// src/server/app.ts:2666 — createTasteRouter options'ında profileContext YOK
```

**Hedef Durum:**
```typescript
// src/server/app.ts (hedef)
const profileContext = createProfileContext({
  initialProfileId: 'default',  // ⚠️ Açılış anı tutarlılığı: teknik ön koşul, bkz. §12.3
  initialRevision: 0,
  eventPublisher: eventBus,
});
const tasteAdapter = createServerTasteServiceAdapter({
  dataDir: resolvedDataDir,
  profileContext,  // ✅ ProfileContext aktarılıyor
  rebuildOnEvent: true,
});
// ...
app.use('/api/taste', personalReadGuard, createTasteRouter(resolvedDataDir, {
  // ... mevcut options ...
  profileContext,  // ✅ Aynı ProfileContext route katmanına da aktarılıyor
}));
```

**Fallback Adapter:**
```typescript
// src/server/taste-routes.ts (hedef) — fallback adapter aynı ProfileContext'i alır
const tasteAdapter =
  options.tasteAdapter ??
  createServerTasteServiceAdapter({
    dataDir,
    profileContext: options.profileContext,  // ✅ Aynı ProfileContext
    rebuildOnEvent: true,
  });
```

**⚠️ NOT:** `req.profileContext` gibi var olmayan request özellikleri kullanılmaz. ProfileContext zaten uygulama katmanında mevcut, dependency injection yoluyla aktarılır.

#### 2. Profil kimliğinin route katmanında tek ve güvenilir kaynaktan alınması (P1)
- **Dosya:** `src/server/taste-routes.ts`
- **Yeni mekanizma:** `getProfileRef(profileContext: IProfileContext)` - tek erişim noktası ProfileContext; handler ProfileRef yakalayıp `assertCurrent`/`assertWritable` çağırır (bkz. §10.1)
- **Bağımlılık:** ProfileContext wiring (app.ts → adapter → router)

#### 3. Route Store çağrılarının ForProfile API'lerine geçirilmesi (P1)
- **Dosya:** `src/server/taste-routes.ts`
- **Değişiklik:** Global API çağrıları → ForProfile API'leri
- **Karar uygulandı (v2.4.0):** Kullanıcıya dönük taste okuma/yazma çağrıları profil kapsamlı ForProfile API'lerine geçer; eski `data/taste/` global verisi olduğu gibi korunur ve otomatik dağıtım/migration yapılmaz (bkz. §12.4 Karar Durumu). Bootstrap/upsert çağrıları (`taste-routes.ts:304, 318, 393, 497, 560, 640, 696, 734` ve `645, 707`) da profil kapsamlı hâle getirilir (bkz. §5.1, adım 5).
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
- **Değişiklik:** Hedef imza `ensureInitialTasteBootstrap(profileId, dataDir)`; `bootstrapPromises`/`bootstrapSignatures` Map'leri `${dataDir}:${profileId}` anahtarına geçer (satır 70-71). Metadata akışında fetch+cache katmanı ortak kalır; `upsertTasteMetadataInputs`/`runHydrationLoop`'un index yazımı profil kapsamlı olur (PR #39 §8.3). **Hedef profil garantisi (P1-3):** bootstrap yalnızca `profileId === doc.activeProfileId` iken yazım yapar; aksi hâlde no-op + uyarı (`doc.profiles[0]` fallback'i `coordinator:551-552`; `migrateExistingData` olayları `doc.activeProfileId`'den üretir: `migration.ts:59-61`; bkz. §7.2 Risk 4). **Tek ortak yardımcı (P2-9):** cache→index beslemesi bootstrap (satırlar 614-619) ve hydration cache-hit turu için tek `seedProfileIndexFromCache(profileId, dataDir, contentIds)` yardımcısı üzerinden yapılır (`tasteMetadataCacheToInput`, `coordinator:136-142`; PR #39 §8.5).
- **Bağımlılık:** Rebuild Coordinator tamamlama

#### 6. Coordinator Map anahtarlarının düzenlenmesi (P1)
- **Dosya:** `src/server/taste-rebuild-coordinator.ts:69-73`
- **Değişiklik:** `activeRebuildChains` (69), `bootstrapPromises` (70), `bootstrapSignatures` (71) ve `activeHydrations` (73) anahtarı `${dataDir}:${profileId}`; `hydrationApiKeys` (72) `dataDir` anahtarlı **kalır** (profil-agnostik süreç kimlik bilgisi; bkz. §10.3)
- **Bağımlılık:** Rebuild Coordinator tamamlama

#### 7. Legacy global API davranışının korunması (P2)
- **Dosya:** `src/server/taste-store.ts`
- **Değişiklik:** Global API'ler değişmeden kalmalı
- **Bağımlılık:** Yok

#### 8. İzolasyon, paralel işlem, legacy uyumluluk ve regresyon testleri (P1-P2)
- **Dosya:** `tests/taste/*.test.mjs`
- **Değişiklik:** Yeni test dosyaları
- **Bağımlılık:** Tüm A3 değişiklikleri

### 11.2 A3/A4 Sınırı

**✅ A3'te Kalacak:**
- ProfileContext wiring (app.ts → adapter → router)
- Route katmanı profil kimliği alma
- Store API'leri ForProfile geçişi
- Rebuild Coordinator profil kapsamlı hâle getirme
- İzolasyon ve eşzamanlılık koruması
- Bootstrap ve hydration akışlarının profil kapsamı (bkz. §7.2 Risk 4, PR #39 §8)
- Açılış anı profil kimliği tutarlılığı (bkz. §12.3; kullanıcı kararı gerektirmez)

**❌ A4'te Kalacak:**
- BackgroundManager Taste entegrasyonu
- Metadata hidrasyonu arka planda
- İtiraz işleme arka planda

**❌ Proje Sonuna Ertelenecek:**
- R-3 case-insensitive filesystem çakışması

---

## 12. Açılış Anı Profil Kimliği Tutarsızlığı

### 12.1 Sorun Tanımı

**Agent 2 Bulgusu:** `app.ts` içinde `ProfileContext`, `initialProfileId: 'default'` ile oluşturuluyor.

**Kritik Soru:** "default" değeri A1 kanonik profil ID doğrulaması `PROFILE_ID_PATTERN` tarafından kabul ediliyor mu?

**Güncel teşhis (Agent 2 nihai denetimi + kaynak kod):** Bu, koşulsuz bir blokaj DEĞİLDİR. Kalıcı veri belgelerinde aktif profil kimliği `profile-default` olarak yazılır (belge normalizasyonu: `src/core/cinetrack-core.ts:849-852`; `synchronizeProfileContext()` bu değeri belgeden ProfileContext'e taşır: `src/server/app.ts:83-93`). `PROFILE_ID_PATTERN` `profile-default`'ı kabul eder (`src/core/cinetrack-core.ts:717`); dolayısıyla ForProfile API'leri normal çalışma zamanında kimlikle sorunsuz çalışır. Kalan sorun **açılış penceresiyle sınırlıdır** ve §12.3'te ayrı bir teknik konu olarak ele alınır; kullanıcı kararı gerektiren eski global veri konusu (§12.4) ile karıştırılmamalıdır.

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

**Sonuç:** ❌ **"default" değeri PROFILE_ID_PATTERN tarafından KABUL EDİLMİYOR** (ancak kalıcı verilerde bu değer kullanılmaz; bkz. §12.1, §12.3).

**Şema/belge normalizasyonu ve eşitleme zinciri (Agent 2 denetimi + kaynak kod):**
```typescript
// src/core/cinetrack-core.ts:849-852 — geçersiz/eksik profileId → 'profile-default'
id:
  typeof raw.profileId === 'string' && PROFILE_ID_PATTERN.test(raw.profileId)
    ? raw.profileId
    : 'profile-default',
```
- `synchronizeProfileContext()` (`src/server/app.ts:79-97`) her yükleme/kaydetmede `document.activeProfileId`'yi ProfileContext'e yazar; çağrı noktaları: `app.ts:540, 1183, 1231, 1688, 2399`.
- Sonuç: Kalıcı belgelerde `profile-default` kullanılır; `"default"` yalnızca birincil depolamanın ilk yüklenmesinden önceki açılış penceresinde (`app.ts:540` öncesi) ve veri belgesi olmayan kurulumlarda görülür.

### 12.3 Etki Analizi ve Açılış Penceresi

#### ProfileContext Oluşturma (src/server/app.ts:493-496)
```typescript
const profileContext = createProfileContext({
  initialProfileId: 'default',
  initialRevision: 0,
  eventPublisher: eventBus,
});
```

**Açılış penceresi:** Sunucu başlangıcından birincil depolamanın ilk `synchronizeProfileContext()` çağrısına kadar (`app.ts:540`) ProfileContext `"default"` taşır. Bu pencerede bir taste isteği gelirse `resolveTastePathsForProfile('default', dataDir)` kanonik doğrulamadan hata fırlatır (`src/server/taste-profile-scope.ts:166-169`). **Pencerenin açılma koşulları (birleşik denetim P2-5):** pencere yalnızca ilk yükleme öncesi değildir; `synchronizeProfileContext()` kimliği doğrulamadan yazar (`document.activeProfileId || document.profiles?.[0]?.id || 'default'` — `app.ts:83-85`). Belge **yok/eksik** veya **kanonik olmayan `activeProfileId`** içeren her belge yüklemesi pencereyi yeniden açar. **A3 kuralı:** senkronizasyon `validateCanonicalProfileId` (`src/server/taste-profile-scope.ts:125-173`) ile doğrulamalı veya geçersiz kimliği reddetmelidir; geçersiz kimlik davranışı açık hata olarak tanımlanır (bkz. §9.2 kriter 8, PR #39 §12.1).

#### ProfileContext Kullanımı
- `ProfileContext.getCurrent()` - açılış penceresinde `"default"`, ilk eşitlemeden sonra belgedeki değer (`profile-default`) döndürür
- `assertCurrent(ref)` / `assertWritable(ref)` - ref.profileId ile current.profileId (ve revision) karşılaştırması yapar, kanonik doğrulama çağırmaz (`src/contracts/profile.ts:44-56`); `"default"` değerini reddetmez
- ForProfile Store API'leri - `resolveTastePathsForProfile()` kanonik doğrulama yapar (`src/server/taste-profile-scope.ts:125-177`); `"default"` ile hata fırlatır

**ℹ️ TEŞHİS (güncel):** Uyumsuzluk kalıcı bir veri sorunu değil, **açılış anı kimlik tutarlılığı** sorunudur. Bu, §12.4'teki kullanıcı kararından AYRI bir teknik konudur ve A3 uygulaması sırasında çözülecek teknik işlerdendir (bkz. §15.2). İki olası mekanizma vardır: (a) `initialProfileId`'in belge normalizasyonuyla (`profile-default`) hizalanması, (b) ilk `synchronizeProfileContext()` tamamlanana kadar taste route'larının geçici olarak gate'lenmesi. Hangisinin seçileceği A3 uygulama zamanında karara bağlanır; bu doküman karar vermez.

### 12.4 Eski Verilerin Korunması: Çözüm Seçenekleri (KARAR VERİLDİ — B ESASI)

**SORU:** Eski global Taste verileri `data/taste/` altında kalırken yeni ForProfile API'leri `data/taste/profiles/...` altından çalışacak. A3 sonrasında eski veriler nasıl korunacak ve kullanıcıya nasıl sunulacak?

Aşağıda **üç ayrı alternatif** karşılaştırılmaktadır. **A ve B aynı çözüm değildir:** A, kullanıcıya dönük akışı A3 boyunca legacy global yolda tutar (profil kapsamlı kullanıcı verisi oluşmaz); B, akışı hemen profil kapsamlı yapıya taşır ve eski veriyi ayrı tutar. İkisi farklı teslim kapsamlarıdır ve biri diğerinin ilk adımı olarak sunulamaz.

> ℹ️ **Kapsam notu:** Bu bölüm yalnızca **eski global verilerin korunması** kararını kapsar. "default"/açılış anı kimlik tutarlılığı bu kararın parçası değildir; bkz. §12.3.

> ⚠️ **Ortak not — "profile-default" yaklaşımı:** `initialProfileId: 'profile-default'` ataması, PROFILE_ID_PATTERN uyumsuzluğunu pattern'i değiştirmeden giderir; ancak bu yaklaşım eski `data/taste/` verilerini **kendiliğinden yeni profile TAŞIMAZ**. Eski veriler `data/taste/` altında ayrı kalır; aşağıdaki seçeneklerin tamamında veri ikiliği sorunu bu yaklaşımda da aynen vardır.

#### Seçenek A — A3 boyunca legacy global okuma davranışını korumak

**Tanım:** A3'te ProfileContext/adapter/router wiring kurulur; ancak kullanıcıya dönük taste okuma/yazma akışı A3 boyunca legacy global veri yolunda (`data/taste/`) kalır. ForProfile API'leri A3'te kullanıcı verisi için devreye alınmaz.

| Kriter | Değerlendirme |
|--------|---------------|
| **Veri yolları** | Okuma/yazma `data/taste/` global yolunda kalır. Profil dizinleri (`data/taste/profiles/...`) A3'te kullanıcı verisi içermez. |
| **Eski veriye erişim** | ✅ Kesintisiz; global API'ler değişmez. |
| **Yeni veriye erişim** | ➖ Yok; ForProfile API'leri yalnızca altyapı/test düzeyinde kullanılabilir. |
| **Geriye dönük uyumluluk** | ✅ Tam; mevcut davranış korunur. |
| **Migration gereksinimi** | A3'te yok; sonraki aşamaya ertelenir (ayrı karar). |
| **Kullanıcıya yansıyan davranış** | Değişmez; tek global taste veri seti görünür. |
| **Riskler** | Profil izolasyonu A3'te kullanıcıya teslim edilmez; sonraki geçiş iki aşamalı iş yükü yaratır; global/profil kod yolları uzun süre ayrışır. |

#### Seçenek B — Yeni profil kapsamlı yapıya geçmek, eski global verileri ayrı tutmak, sonraki aşamada kontrollü geçiş

**Tanım:** A3'te route/adapter/rebuild ForProfile API'lerine geçer; yeni veriler `data/taste/profiles/p1-b64url-.../` altında birikir. Eski `data/taste/` verileri olduğu gibi, dokunulmadan kalır. Kontrollü migration sonraki bir aşamada **ayrı bir karar** olarak yapılır.

| Kriter | Değerlendirme |
|--------|---------------|
| **Veri yolları** | Yeni veriler `data/taste/profiles/p1-b64url-.../`; eski veriler `data/taste/` (değişmez). İki yol bağımsız. |
| **Eski veriye erişim** | Yalnızca legacy global API'ler üzerinden; profil kapsamlı endpoint'lerden görünmez. |
| **Yeni veriye erişim** | ✅ ForProfile API'leri üzerinden. |
| **Geriye dönük uyumluluk** | Legacy API'ler değişmez; ancak kullanıcıya dönük veri ikiye bölünür (data duality). |
| **Migration gereksinimi** | A3 kapsamında yok; sonraki aşamada kontrollü geçiş zorunlu. |
| **Kullanıcıya yansıyan davranış** | Mevcut taste verisi profil kapsamlı görünümlerde boş/eksik görünür; yeni olaylar profil bazında birikir. |
| **Riskler** | Veri ikiliği, kullanıcı kafa karışıklığı ("profilim boş görünüyor"), iki veri kaynağının tutarsızlaşması. |

#### Seçenek C — PROFILE_ID_PATTERN / kimlik sözleşmesini "default" destekleyecek şekilde değiştirmek

**Tanım:** `PROFILE_ID_PATTERN` (`src/core/cinetrack-core.ts:717`) `|default` alternatifiyle genişletilir (veya kimlik sözleşmesi eşdeğer biçimde değiştirilir); `validateCanonicalProfileId('default')` kabul eder hâle gelir.

| Kriter | Değerlendirme |
|--------|---------------|
| **Veri yolları** | `default` profili için `data/taste/profiles/p1-b64url-.../` (`encodeProfileIdSafe('default')`); eski veriler `data/taste/` (değişmez). |
| **Eski veriye erişim** | Yine yalnızca legacy global API'ler üzerinden. |
| **Yeni veriye erişim** | ✅ `default` kimliğiyle ForProfile API'leri. |
| **Geriye dönük uyumluluk** | ⚠️ A1 altyapısında (`validateCanonicalProfileId`, `encodeProfileIdSafe`/`decodeProfileIdSafe`, profil ID manifesti) kapsam dışı değişiklik; `PROFILE_ID_PATTERN`'ın diğer tüketicileri etkilenebilir. |
| **Migration gereksinimi** | Pattern değişimi veri TAŞIMAZ; eski veriler yine ayrı kalır, migration yine gerekir. |
| **Kullanıcıya yansıyan davranış** | B ile aynı ikilik; ayrıca sözleşme genişlemesinin sistem genelinde etkisi. |
| **Riskler** | Kimlik sözleşmesinin gevşetilmesi (güvenlik/tutarlılık riski), A1 altyapısının yeniden tasarımı, A3 kapsam dışı değişiklik. |

**`PROFILE_ID_PATTERN` tüketicileri (Seçenek C etkisi):** Pattern değişirse en az şu tüketiciler etkilenir: profil/belge normalizasyonu (`src/core/cinetrack-core.ts:804`; pattern testi 809 ve 850) ve eski/yeni veri birleştirmedeki `profile-default` yer tutucu mantığı (`src/core/user-data-merge.ts:455-486`; birleştirme uygulaması 689-702). Ayrıca `validateCanonicalProfileId`, `encodeProfileIdSafe`/`decodeProfileIdSafe` ve profil ID manifesti A1 altyapısı sözleşme değişikliğinden etkilenir. Seçenek C bu yüzden önerilmez; yalnızca tamlık için listelenmiştir.

#### Karar Durumu

**✅ KARAR VERİLDİ (kullanıcı onayı — v2.4.0):** Seçenek **B esası** uygulanır; onaylanan karar şu maddelerden oluşur:
> - Eski global Taste verisi diğer profillere **otomatik dağıtılmaz**.
> - Mevcut global veri **korunur**; `data/taste/` yoluna dokunulmaz.
> - Profil aktarımı **otomatik yapılmaz**.
> - Hangi profile aktarılacağı **açıkça belirlenmeden migration yapılmaz**; kontrollü geçiş, hedef profil açıkça belirlendiğinde ayrı bir kararla yapılır.
> - Legacy global API davranışı ve geriye dönük uyumluluk sınırları **açıkça belgelenir** (bkz. §6.4, §10.2).
>
> Seçenek A ve C uygulanmaz. B'nin bilinen veri ikiliği riski kullanıcıya yansıyan davranış olarak yukarıdaki tabloda belgelenmiştir; onay bu riskin bilinmesiyle verilmiştir.

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
- **Asıl eksiklik:** `app.ts → ProfileContext → { adapter, createTasteRouter }` wiring bağlantısı

### 13.3 Düzeltme 3: Profil Kimliği Erişim Sözleşmesi

**Önceki sürümdeki yanlış yönlendirmeler:**
- `req.profileContext` varmış gibi ele alınıyor veya request nesnesine eklenmesi öneriliyordu.
- `getDefaultProfileId()` ikinci bir profil kimliği kaynağı olarak öneriliyordu.

**Güncel ve geçerli tasarım:**
- `req.profileContext` **kullanılmayacak ve oluşturulmayacak**.
- `getDefaultProfileId()` **oluşturulmayacak**; varsayılan profil için ikinci bir kimlik otoritesi tanımlanmayacak.
- Normal uygulama akışında tek kimlik otoritesi `ProfileContext`'tir.
- `app.ts`, aynı ProfileContext örneğini adapter'a ve `createTasteRouter` options'a ayrı ayrı verir.
- Route handler'ları ProfileContext'e router options/closure üzerinden erişir; geçerli profil kimliğini `ProfileContext.getCurrent()` üzerinden alır.
- Bu düzenleme, `default` kimliğinin kanonik Store sözleşmesiyle uyumsuzluğu için §12.4'teki kullanıcı kararının yerine geçmez.

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

**✅ Düzeltme (v2.3.0'da güncellendi):**
- `performRebuildOnce()` - **Global** store kullanıyor (satır 431; okumalar 433-436, yazım 480)
- `ensureInitialTasteBootstrap()` - **Global** okuma/yazma + rebuild (satır 519; okumalar 533-536, olay yazımı 635)
- `upsertTasteMetadataInputs()` - Global index okuma/yazma (satır 333-369)
- `runHydrationLoop()` - Global upsert + rebuild (satır 154-171)
- Coordinator Map'leri **sadece `dataDir`** anahtarlı (satır 69-73) - **profil bazlı değil**

### 13.6 Düzeltme 6: Route Tablosu

**❌ Önceki Sürüm:**
> Route tablosunda hatalı satırlar ve eksik bilgiler

**✅ Düzeltme:**
- Tüm satır numaraları güncellendi
- `triggerTasteProfileRebuild()` çağrıları eklendi
- Endpoint eşleşmeleri düzeltildi

> ⚠️ **v2.3.0 notu:** Önceki sürümdeki "tüm satır numaraları güncellendi" ifadesi eksikti: §5.1 tablosunda bootstrap (8 çağrı) ve `upsertTasteMetadataInputs` (2 çağrı) satırları yoktu; §5.3'te `performRebuildOnce` okumaları yanlışlıkla `ensureInitialTasteBootstrap`'a atfedilmişti. Her iki tablo da Agent 2 nihai denetimiyle kaynak koddan yeniden doğrulanarak düzeltildi.

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
| `validateCanonicalProfileId` | `src/server/taste-profile-scope.ts:125-177` | ✅ | PROFILE_ID_PATTERN uyumu |
| `encodeProfileIdSafe` | `src/server/taste-profile-scope.ts:179-187` | ✅ | Base64URL kodlama |
| `decodeProfileIdSafe` | `src/server/taste-profile-scope.ts:189-233` | ✅ | Round-trip doğrulama |
| `appendTasteEventIdempotentForProfile` | `src/server/taste-store.ts:499-517` | ✅ | **MEVCUT** |
| `appendTasteEventForProfile` | `src/server/taste-store.ts:519-524` | ✅ | Mevcut |
| `readTasteEventsForProfile` | `src/server/taste-store.ts:527-532` | ✅ | Mevcut |
| `writeTasteEventsForProfile` | `src/server/taste-store.ts:535-550` | ✅ | Mevcut |
| `readTasteProfileForProfile` | `src/server/taste-store.ts:567-572` | ✅ | Mevcut |
| `writeTasteProfileForProfile` | `src/server/taste-store.ts:551-565` | ✅ | Mevcut |
| `createProfileContext` | `src/app/ProfileContext.ts:209` | ✅ | Fabrika fonksiyonu |
| `synchronizeProfileContext` | `src/server/app.ts:79-97` | ✅ | Belge ↔ ProfileContext eşitleme (çağrılar: 540, 1183, 1231, 1688, 2399) |
| `createServerTasteServiceAdapter` | `src/server/taste-service-adapter.ts:270` (options: 37-43) | ✅ | `profileContext` parametresi var |

### 14.2 Doğrulanmış Sorunlar

| Sorun | Dosya:Satır | Durum | Açıklama |
|-------|-------------|-------|----------|
| "default" PROFILE_ID_PATTERN uyumsuz | `src/core/cinetrack-core.ts:717` + `src/server/app.ts:494` | ❌ | "default" kabul edilmiyor |
| Adapter profileContext yollanmıyor | `src/server/app.ts:498-501` | ❌ | Wiring eksik |
| Route'lar global API kullanıyor | `src/server/taste-routes.ts:302-740` (kayıt; çağrılar 305-735) | ❌ | 25+ global API çağrısı + 8 bootstrap + 2 upsert |
| Coordinator global store kullanıyor | `src/server/taste-rebuild-coordinator.ts:154-171, 333-369, 431-492, 519-660` | ❌ | Rebuild + upsert + bootstrap + hydration global |
| Coordinator Map anahtarları | `src/server/taste-rebuild-coordinator.ts:69-73` | ❌ | Beş Map'in tamamı sadece dataDir (A3 hedefi: dört Map `${dataDir}:${profileId}`, `hydrationApiKeys` `dataDir` kalır) |
| `computeBootstrapSignature` yalnızca global dosyaları imzalıyor | `src/server/taste-rebuild-coordinator.ts:198-226` | ❌ | Profil kapsamlı dosya girdisi yok; imza girdisi profil dosya kümesine genişletilmeli (birleşik denetim P2-8) |

---

## 15. A3 Uygulamasına Başlanabilir mi?

### 15.1 Değerlendirme

| Kriter | Durum |
|--------|-------|
| A1 ve A2 altyapısı tamamlandı | ✅ |
| ForProfile API'leri yeterli | ✅ |
| Profil kimliği akış şeması belirlendi | ✅ |
| Riskler belirlendi ve çözümler önerildi | ✅ |
| Test matrisi hazır | ✅ |
| Teknik kararlar | ✅ Kullanıcı kararları verildi (v2.4.0): eski global veri stratejisi B esası (§12.4 Karar Durumu); /domain-event kimlik otoritesi sunucuda (§4.3, §15.2). Açılış mekanizması seçimi (initialProfileId hizalama / route gating) uygulama zamanında yapılır (§12.3) |
| Uygulama sırası belirlendi | ✅ |
| Açılış anı kimlik tutarsızlığı belirlendi | ✅ |

> ℹ️ **Puan kolonu kaldırıldı:** Önceki sürümdeki "x/10" puanları kanıtsız nicelendirme olarak kaldırılmıştır; değerlendirme nitel yapılır.

### 15.2 Bloke Edici Sorunlar

#### ✅ KARAR VERİLDİ — Kullanıcı Onayı Sonucu (v2.4.0)

1. ✅ **Eski global Taste verilerinin korunma stratejisi (§12.4 — B esası):** kullanıcı kararı verildi:
   - Eski global veri otomatik olarak profillere dağıtılmaz; mevcut `data/taste/` verisi korunur.
   - Profil aktarımı otomatik yapılmaz; hedef profil açıkça belirlenmeden migration yapılmaz.
   - Legacy global API davranışı ve geriye dönük uyumluluk sınırları açıkça belgelenir (§6.4, §10.2).
   - **C uygulanmaz:** A1 kimlik sözleşmesi değişikliği taşır ve tüketicileri genişletir (bkz. §12.4 Seçenek C).
2. ✅ **POST /domain-event kimlik otoritesi (§4.3 Kritik Nokta 1):** kullanıcı kararı verildi:
   - İstemciden gelen `profileId` yetkili kimlik değildir; sunucu aktif profili `ProfileContext` üzerinden belirler (`profileContext.getCurrent().profileId` her zaman store hedefidir).
   - `sourceRevision` sunucu tarafında doğrulanır; profil veya revision uyuşmazlığında istek 409 ile reddedilir.
   - İstemci verisi sunucu kimlik otoritesini geçersiz kılamaz (`taste-routes.ts:690-693`; `taste-service-adapter.ts:222-227`).

#### 🟡 P1 — A3 Uygulaması Sırasında Çözülecek Teknik İşler

1. ⚠️ **Adapter wiring eksik** — `app.ts:498-501` adapter oluşturulurken `profileContext` gönderilmiyor.
   - **Çözüm:** Mevcut ProfileContext'i adapter'a aktar; `TasteServiceAdapterOptions` zaten `profileContext?: IProfileContext` destekliyor (`src/server/taste-service-adapter.ts:38`).
   - **Ayrıca:** Aynı ProfileContext, `createTasteRouter` options üzerinden route katmanına ayrı olarak aktarılmalı.
2. ⚠️ Route'lar global API kullanıyor (`src/server/taste-routes.ts:302-740`; 8 bootstrap + 2 upsert çağrısı dahil); onaylanan veri stratejisine göre uygun API yoluna geçirilmeli.
3. ⚠️ Rebuild Coordinator profil kapsamlı değil (`src/server/taste-rebuild-coordinator.ts:154-171, 333-369, 431-492, 519-660`; bootstrap + hydration dahil).
4. ⚠️ Coordinator Map anahtarları yalnızca `dataDir` (`src/server/taste-rebuild-coordinator.ts:69-73`); profil kapsamı eklenirken `activeRebuildChains`, `bootstrapPromises`, `bootstrapSignatures`, `activeHydrations` `${dataDir}:${profileId}` anahtarına geçirilir; `hydrationApiKeys` `dataDir` anahtarlı kalır (bkz. §10.3).
5. ⚠️ Açılış anı kimlik tutarlılığı: açılış penceresinde `"default"` kimliğiyle taste isteği gelmemesi sağlanmalı (bkz. §12.3).

### 15.3 Sonuç ve Başlama Koşulları

**Teknik planın durumu:** Doküman, mevcut mimariyi, A3 kapsamını, riskleri, test matrisini ve uygulama sırasını tanımlayan bir plan olarak teknik incelemeye sunulabilir. Bu durum, açık veri/kimlik kararlarının verilmiş olduğu veya A3 kodlamasının başlamasına izin verildiği anlamına gelmez.

**Kullanıcı onayı gerektiren kararlar (v2.4.0 itibarıyla VERİLDİ):**
1. ✅ Eski global Taste verisi: otomatik dağıtım yok, mevcut veri korunur, otomatik profil aktarımı yok, hedef profil belirlenmeden migration yok, legacy davranış/uyumluluk sınırları belgelenir (B esası; bkz. §12.4 Karar Durumu).
2. ✅ POST /domain-event kimlik otoritesi: hedef profil her zaman `profileContext.getCurrent().profileId`; `event.profileId`/`sourceRevision` yalnızca doğrulama girdisi; uyuşmazlıkta 409 (bkz. §4.3, §15.2).

**A3 uygulaması sırasında çözülecek teknik ön koşullar (kullanıcı kararı gerektirmez):**
1. Açılış anı kimlik tutarlılığı: açılış penceresinde `"default"` kimliğiyle taste isteği gelmemesi (bkz. §12.3; `initialProfileId` hizalaması veya route gating, uygulama zamanında seçilir).
2. Adapter/router wiring: ProfileContext'in adapter'a ve `createTasteRouter` options'a aktarılması (bkz. §11.1).
3. Coordinator profil kapsamı: beş Map'in `${dataDir}:${profileId}` anahtarına geçirilmesi; bootstrap + hydration dahil (bkz. §7.2 Risk 4, PR #39 §8).
4. Bootstrap kaynak verisi atfı ve hydration cache-hit boşluğu: PR #39 §8.5 (cache-hit) ve §12.2 (bootstrap atfı) maddeleri.
5. `app.ts:588` startup manifest okumasının kapsam kararı (PR #39 §12.4).

**Kullanıcı kararı verilmeden yapılmayacaklar:**
- `PROFILE_ID_PATTERN` veya A1 kimlik doğrulama sözleşmesini genişletmek.
- Legacy global verileri profil dizinine kopyalamak, taşımak veya otomatik ilişkilendirmek.
- Eski global veriyi otomatik profillere dağıtmak, otomatik profil aktarımı yapmak veya hedef profile belirlenmeden migration çalıştırmak (§12.4 Karar Durumu'nda açıkça korunmuştur).

**A3 uygulama sırası (kararlar v2.4.0 itibarıyla verildi; başlama için ayrı onay gereklidir):**
1. Onaylanan kimlik ve eski veri koruma kararını uygulama planına sabitlemek.
2. `app.ts` içinde ProfileContext'i adapter'a ve `createTasteRouter` options'a ayrı ayrı aktarmak.
3. Route katmanında profil kimliğini yalnızca ProfileContext'ten almak.
4. Kullanıcıya dönük Store çağrılarını profil kapsamlı ForProfile API'lerine geçirmek; legacy global veriye dokunmaz (§12.4 Karar Durumu).
5. Rebuild Coordinator'ı aynı profil/veri stratejisine göre kapsamlandırmak ve `activeRebuildChains` anahtarını `dataDir + profileId` olacak şekilde ayırmak.
6. İzolasyon, geriye dönük uyumluluk, eşzamanlılık ve rebuild testlerini çalıştırmak.

**Tahmini süre:** 3-5 gün (tam zamanlı); kararların netleşmesi, kod incelemesi ve test düzeltmeleri bu tahmine dahil değildir.

## Ekler

### Ek A: Dosya Değişiklik Listesi

**Sorumluluk Tanımları:**
- **TasteServiceAdapter:** AppEvent → TasteEvent çevirimi, TasteStore entegrasyonu. Zaten `profileContext?: IProfileContext` parametresini destekliyor (src/server/taste-service-adapter.ts:38). **Yeni API/fonksiyon eklenmez.**
- **createTasteRouter:** Router örneğini oluşturur. ProfileContext, app.ts tarafından options üzerinden verilir; route handler'larına closure/options yoluyla ulaştırılır. Router'ı oluşturmaz ve ProfileContext'i kendisi dağıtmaz.
- **TasteRebuildCoordinator:** Profil yeniden hesaplama işlemleri. Global store kullanımını (rebuild, bootstrap, metadata upsert, hydration) ForProfile API'lerine geçirmek gerekiyor (bkz. §5.3, PR #39 §8).

| Dosya | Değişiklik Türü | Öncelik |
|-------|-----------------|---------|
| src/server/app.ts | ProfileContext → adapter + createTasteRouter options wiring | 🟡 P1 |
| src/server/app.ts | "default" kimlik sözleşmesi çözümü | 🟡 P1 (kullanıcı onayı gerektirir) |
| src/server/taste-routes.ts | createTasteRouter options'ına `profileContext` alanı ekleme + Profil kimliği alma + ForProfile API geçişi | 🟡 P1 |
| src/server/taste-service-adapter.ts | ProfileContext aktarımı (zaten destek var) | 🟡 P1 |
| src/server/taste-rebuild-coordinator.ts | Profil kapsamlı hâle getirme | 🟡 P1 |

### Ek B: Test Dosyaları (Planlanmış)

| Dosya | Açıklama | Planlanan Test Sayısı |
|-------|----------|----------------------|
| tests/taste/taste-profile-flow.test.mjs | Profil kimliği akışı | 10 |
| tests/taste/taste-isolation.test.mjs | İzolasyon testleri | 8 |
| tests/taste/taste-concurrency.test.mjs | Eşzamanlılık testleri | 5 |
| tests/taste/taste-legacy-compat.test.mjs | Legacy uyumluluk | 5 |

> **⚠️ NOT:** Test dosyaları planlanmış, henüz oluşturulmadı. Test sayısı tahminidir. Bu doküman güncellemesinde test ve CI durumu çalıştırılmadı.

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

**PR URL:** https://github.com/SiriusBrahim/Cinethos/pull/38  
**Branch:** `vibe/r2-a3-technical-plan-v2-bd6aa2`  
**Commit:** PR #38 dalının en güncel commit'i  
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
- [x] §4.2 hedef akış şeması §10.1 ile hizalandı (tek kaynak: ProfileContext)
- [x] §11.1 router wiring sorumlulukları düzeltildi (ProfileContext app.ts'ten adapter'a ve createTasteRouter options'a)
- [x] §12.4 eski veri koruma seçenekleri üç ayrı alternatif (A/B/C) olarak ayrıştırıldı; karar kullanıcı tarafından **onaylandı (B esası)** (v2.4.0)
- [x] POST /domain-event kimlik otoritesi kullanıcı kararıyla kesinleştirildi (sunucu otoritesi; 409 reddi) (v2.4.0)
- [x] Birleşik denetim P1-1/P1-2/P1-3 ve P2-1..P2-11 düzeltmeleri uygulandı; PR #39 (v1.2.0) ile imza/Map/tablo unifikasiyonu yapıldı (v2.4.0)
- [x] §9 kabul kriteri ile test sonucu ayrıştırıldı; test/CI çalıştırılmadı notu korundu
- [x] Eski referanslar temizlendi (PR #37 → PR #38, sürüm 2.1.0 → 2.2.0, teslim bilgileri)

---

**✅ DOKÜMAN GÜNCELLENDİ (Birleşik Denetim Raporu — PR #38 + PR #39 — Sonrası)**  
**Sürüm:** 2.4.0  
**Tarih:** 17 Kasım 2026  
**Base Commit:** 49142ca8d552d59b11894a7aa574cce4588c16ce

---

## Değişiklik Özeti (v2.1.0)

### P1 Düzeltmeleri
- ProfileContext analizini düzelt: ProfileContext 'default' değerini kabul ediyor, validateCanonicalProfileId reddediyor
- 'profile-default' karar tablosu eklendi ve kesin uygulanacak çözüm olarak sunuldu (v2.2.0'da yeniden açıldı; kesin çözüm değildir)
- Adapter wiring planı tamamlandı: TasteServiceAdapterOptions zaten profileContext destekliyor

### P2 Düzeltmeleri
- Legacy API kapsamı tutarlı hale getirildi: Global API'ler global davranışlarını koruyacak
- Test ve önem dereceleri düzeltildi

---

## Değişiklik Özeti (v2.2.0)

### P1 Düzeltmeleri
- profile-default kararı yeniden açıldı: Seçenekler karşılaştırıldı, kullanıcı onayı gerektirildi
- P0/P1 sınıflandırması düzeltildi: Tüm bloke edici sorunlar P1 olarak sınıflandırıldı
- ProfileContext tek kimlik otoritesi olarak belirlendi

### P2 Düzeltmeleri
- Global API riski doğru tanımlandı: Eski veriler ayrı tutulacak
- Test ifadeleri düzeltildi: Çalıştırılmadı notu eklendi
- Ek A sorumlulukları düzeltildi: Mevcut API destekleri belirtildi

### Son Tutarlılık Düzeltmeleri (v2.2.0 devamı)

- §4.2 hedef akış şeması §10.1 ile hizalandı: Profil kimliğinin tek kaynağı ProfileContext; query/header üzerinden profil seçimi ifadeleri kaldırıldı, istemciden gelen profileId doğrudan Store'a aktarılmaz
- §11.1 router wiring sorumlulukları düzeltildi: ProfileContext app.ts tarafından hem adapter'a (`profileContext` parametresiyle) hem `createTasteRouter` options üzerinden route katmanına aktarılır; adapter router oluşturmaz ve ProfileContext'i router'a aktarmaz
- §12.4 eski verilerin korunması seçenekleri üç ayrı alternatif (A/B/C) olarak yeniden yapılandırıldı; A ve B'nin farklı çözümler olduğu netleştirildi; "profile-default" yaklaşımının eski verileri kendiliğinden taşımadığı belirtildi; hiçbir seçenek kullanıcı onayı olmadan kesinleştirilmez
- §9 kabul kriterleri ile test sonucu ayrıştırıldı: Testlerin kabul kriteri olması ile çalıştırılmış olması farklı konular; bu doküman güncellemesinde test ve CI çalıştırılmadı
- §15.1 değerlendirme güncellendi: "Teknik kararlar" maddesi "seçenekler analiz edildi, nihai karar bekleniyor" durumuna alındı
- Eski referanslar temizlendi: PR #37 → PR #38, alt bilgi sürümü 2.1.0 → 2.2.0, teslim bilgileri güncellendi

**Test ve CI durumu:** Bu doküman güncellemesinde çalıştırılmadı

---

## Değişiklik Özeti (v2.3.0)

### P1 Düzeltmeleri (Agent 2 nihai denetimi)
- Kimlik zinciri düzeltildi: `DataDocument.activeProfileId → synchronizeProfileContext() → ProfileContext` (§4.2, §10.1, §12.1); ProfileRef/revision yakalama ve `assertCurrent`/`assertWritable` kullanımı tanımlandı
- "default" teşhisi güncellendi: kalıcı belgeler `profile-default` kullanır; sorun açılış penceresiyle sınırlı ve ayrı teknik konu (§12); eski global veri kullanıcı kararıyla karıştırılmaz
- Seçenek A/B kararları uygulama adımları ve test kriterleriyle tutarlı hâle getirildi (§9.2, §11.1); global API yönlendirme testi önerisi kaldırıldı, "davranış değişmedi" regresyonu geldi (§9.1.2)
- Route tablosuna 8 `ensureInitialTasteBootstrap` ve 2 `upsertTasteMetadataInputs` çağrısı eklendi (§5.1)
- Gerçek kontaminasyon mekanizması açıklandı: bootstrap aktif profili seçip olayları global events dosyasına ekler; profil değişiminde olaylar birikir (§7.2 Risk 4); bootstrap Map'leri profil kapsamı açısından değerlendirildi
- Coordinator fonksiyon/Map satır referansları düzeltildi (§3.1, §5.3, §10.4, §13.5, §14.2)

### P2 Düzeltmeleri
- Eski satır numaraları güncellendi/fonksiyon adlarıyla desteklendi (§1.1, §5, §7.1, §13.5, §14)
- Kanıtsız test sayıları/puanları kaldırıldı; doğrulanmış sayımlar konuldu (§9.1.1, §15.1)
- Geçersiz TypeScript imza önerisi düzeltildi; 9 çağrı noktası listelendi (§10.3)
- POST /domain-event istemci profileId/sourceRevision sözleşmesi açıklandı (§4.3)
- `PROFILE_ID_PATTERN` tüketicileri ve Seçenek C etkileri belirtildi (§12.4)
- BackgroundManager handler'larının audit-only davranışı A3/A4 sınırında açıklandı (§3.2)

### P3 / Tutarlılık
- §13.6'ya "tüm satır numaraları güncellendi" iddiasının düzeltme notu eklendi
- §5.2/§6.2 manifest yazım boşluğu gerekçelendirildi
- PR #39 §8 hydration analiziyle hizalama sağlandı (ortak metadata cache, profil kapsamlı index yazımı)

**Test ve CI durumu:** Bu doküman güncellemesinde çalıştırılmadı

---

## Değişiklik Özeti (v2.4.0)

### Kullanıcı Kararları (uygulandı)
- Eski global Taste verisi: otomatik dağıtım yok, mevcut `data/taste/` verisi korunur, otomatik profil aktarımı yok, hedef profil açıkça belirlenmeden migration yok, legacy davranış/uyumluluk sınırları belgelenir (§12.4 Karar Durumu — B esası; §15.2/§15.3)
- POST /domain-event kimlik otoritesi: istemci `profileId` yetkili değildir; hedef profil her zaman `profileContext.getCurrent().profileId`; `sourceRevision` sunucuda doğrulanır; uyuşmazlıkta 409; istemci sunucu otoritesini geçersiz kılamaz (§4.3 Kritik Nokta 1, §15.2)

### P1 Düzeltmeleri (birleşik denetim)
- Map anahtar şeması düzeltildi: `activeRebuildChains`, `bootstrapPromises`, `bootstrapSignatures`, `activeHydrations` `${dataDir}:${profileId}`; `hydrationApiKeys` `dataDir` anahtarlı kalır — API anahtarı profil-agnostik süreç kimlik bilgisidir; profil anahtarlı yapılsaydı hidrasyon sessizce hiç çalışmazdı (§5.3, §7.2 Risk 3/5, §9.2 kriter 5, §10.3, §10.4, §11.1 adım 6, §14.2, §15.2)
- Router için `profileContext` zorunlu hâle getirildi; global fallback yok; profil-siz mevcut testler (`tests/taste/stock-and-live-profile.test.mjs:358`) açık ProfileContext ile güncellenecek; kriter "güncellenen testlerle geçer" (§11.1 adım 1, §9.2)
- Bootstrap hedef profil garantisi eklendi: yalnızca `profileId === doc.activeProfileId` iken yazım; `doc.profiles[0]` fallback'i ve `migrateExistingData` atfı belgelendi (§7.2 Risk 4, §11.1 adım 5)

### P2 Düzeltmeleri (birleşik denetim)
- Manifest gerçek davranışı: profil yazıcıları manifest'i kilit altında kendileri günceller (`writeManifestForPathsUnlocked` `taste-store.ts:198`; kullanım `:563`, `:588`); ayrı `writeTasteManifestForProfile` gerekmez (§6.2)
- Hatalı TypeScript gerekçesi kaldırıldı; `triggerTasteProfileRebuild(profileId, dataDir)` imzası PR #39 ile tekleştirildi (§10.3)
- Bootstrap okuma satırları düzeltildi: 533 events / 534 profile / 535 manifest / 536 metadata-cache; bootstrap'ta readTasteIndex/readTasteObjections yok (§5.3)
- Açılış penceresi tanımı genişletildi; `synchronizeProfileContext` kanonik doğrulama/reddetme kuralı zorunlu kriter yapıldı (§12.3, §9.2 kriter 8)
- Stale-write gerçek sınırı: yazıcılar revision kontrolü yapmaz; yazma sonrası yeniden `assertWritable` (adapter `:204-205`) veya revision damgalı yazım zorunlu (§10.1)
- Fallback adapter satır referansı 287-288 → 294-295; bootstrap okuma satırları düzeltildi (§11.1)

### Tutarlılık (PR #39 v1.2.0 ile)
- `seedProfileIndexFromCache(profileId, dataDir, contentIds)` tek ortak cache→index yardımcısı (bootstrap + hydration cache-hit) (§10.4, §11.1 adım 5)
- `computeBootstrapSignature` profil kapsamı eksikliği §14.2'ye doğrulanmış sorun olarak eklendi (P2-8)
- PR #39 açık konu referansı §11 → §8.5/§12.2 olarak düzeltildi (§15.3)

**Test ve CI durumu:** Bu doküman güncellemesinde çalıştırılmadı.
