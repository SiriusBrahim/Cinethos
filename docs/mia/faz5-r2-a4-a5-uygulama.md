# MIA Faz 5 — R2-A4 / R2-A5 Uygulama Kaydı

**Tarih:** 2026-11-18
**Dal:** `agent-2/phase-5-r2-a3-codlama-master` (PR #41)
**Girdi:** `docs/mia/faz5-r2-a1-tasarim.md` §5 (S1/S2/S3), Faz 5 bağımsız denetimi (A4/A5 eksikleri)

Bu belge R2-A1 tasarımında **A4** (BackgroundManager hedef profil korunumu) ve
**A5** (uçtan uca doğrulama / legacy geçiş) olarak ayrılan işlerin uygulama
kaydıdır. A1–A3 kodu değiştirilmedi; yalnızca eksik parçalar eklendi.

## 1. R2-A4 — Hedef profil korunumu ve kaçırılan olay telafisi

### 1.1 Doğrulanan sorun

`PUT /api/data` gibi akışlar **tüm profillerin** kütüphane farklarını
yayınlayabiliyor. Taste canlı aboneliği yalnızca sunucudaki aktif profile
yazabildiği için diğer profillerin olayları atlanıyordu. Atlama yalnızca
`console.info` ile loglanıyor, sayaç tutulmuyor ve olay hiçbir yerde telafi
edilmiyordu (olay kaybı). Ayrıca atlama kararı Türkçe hata metni önekiyle
(`startsWith("Profil uyuşmazlığı: olay '")`) veriliyordu.

### 1.2 Uygulanan çözüm

| Bileşen | Değişiklik |
|---|---|
| `src/contracts/common.ts` | `OperationOutcome` hata dalına yapısal `code` eklendi (`OperationErrorCode`). Geriye uyumlu; metin ayrıştırması artık gerekmiyor. |
| `src/contracts/services.ts` | `IMemoryService.processDeferredEvent?` — geçmiş olayın telafisi için opsiyonel yöntem. |
| `src/server/taste-service-adapter.ts` | Profil uyuşmazlığı `code: 'profile-not-active'` döner; hata sınıfları tek yardımcıda (`toAdapterOutcome`) yapısal koda çevrilir. Yeni `processDeferredEvent`: yalnızca **profil kimliğini** doğrular (geçmiş `sourceRevision` eşitliği aranmaz), yazma `eventId` ile idempotenttir. |
| `src/server/taste-service-adapter.ts` (abonelik) | Atlama kararı `outcome.code === 'profile-not-active'` ile verilir; metin öneki bağımlılığı kaldırıldı. |
| `src/contracts/background.ts` | `BackgroundTaskHandler.profileScoped`, `claimNextTask(..., profileId?)`, `deferTask(...)`. |
| `src/server/background-task-repository.ts` | `claimNextTask` isteğe bağlı profil filtresi; `deferTask` görevi `pending`'e alır ve tüketilen deneme hakkını iade eder. |
| `src/modules/background/service.ts` | Pompa yalnızca **aktif profile** ait görevleri kiralar; `profileScoped` işleyiciler için aktif profilin olayında görev üretilmez (canlı abonelik işler); profil değişiminde `onProfileChange` ile pompa uyanır; kiralama ile işleyici arasında profil değişirse görev bekletilir (çapraz yazma yok, deneme tüketilmez). |
| `src/modules/background/taste-handlers.ts` (yeni) | `intelligence.taste-event-sync`: atlanan olayı hedef profil aktif olduğunda `processDeferredEvent` ile kendi profiline yazar. Hata sınıfları `ProfileConflictError` / `RetryableBackgroundError` / `PermanentBackgroundError` ile eşlenir. |
| `src/server/app.ts` | Telafi işleyicisi adapter oluşturulduktan sonra kaydedilir; atlanan olay sayacı (`tasteSkippedCount`) sağlık raporuna eklenir. |

### 1.3 Davranış garantileri

- Hedef profili aktif olmayan görev **kiralanmaz**; `pending` kalır, `attempts`
  artmaz, `failed` olmaz. Profil aktif olunca tek denemede tamamlanır.
- Canlı abonelik sırasında aktif profilin olayı işlendiği için telafi görevi
  üretilmez → çift iş yok (yine de `eventId` idempotency'si korunur).
- Başka profile yazma yolu yoktur: hem işleyici hem adapter profil kimliğini
  doğrular.
- Faz 4'ün audit işleyicileri ve görev semantiği korunur; kapsam yalnızca
  hazır-görev seçimidir.

## 2. R2-A5 — Legacy veri geçiş politikası (salt okunur)

`src/server/taste-legacy-status.ts` eklendi:

| Durum | Sınıflandırma |
|---|---|
| Legacy dosya yok | `present:false`, `scenario:null` |
| Yalnızca global legacy dosyalar | `S1` — atanmamış legacy adayı; otomatik atama yok |
| Legacy + profil partition birlikte | `S3` — çakışan/belirsiz; hiçbir profile bağlanmaz |

- Modül **hiçbir dosyayı değiştirmez, taşımaz, silmez**; yalnızca raporlar.
- Bozuk eşleme manifesti hata fırlatmaz, `mappingUnreadable:true` ile raporlanır
  ve onarılmaz (A1 fail-fast politikasıyla uyumlu).
- Sınıflandırma `taste-engine` sağlık raporunda görünür (`legacy=S1|S3|none`).
- S1 kopyası/taşıması, tasarım §5 gereği **açık kullanıcı onayı ve canlı veri
  kanıtı** gerektiren ayrı bir adım olarak bırakılmıştır; bu PR otomatik
  migration yapmaz.

## 3. Doğrulama

| Kontrol | Sonuç |
|---|---|
| `npm run lint` (eslint + tsc + tsconfig.tests) | 0 hata |
| `npm test` | 513/513 (iki ardışık çalıştırma) |
| `npm run test:taste` | 436/436 (yeni A4: 4 test, A5: 4 test) |
| `npm run build` | aşağıdaki doğrulama bölümünde |
| Faz 4 regresyon testleri | 22/22 (A3/A3b yeni profil-bekletme semantiğine güncellendi) |

**Güncellenen eski testler:** `tests/phase4-background-manager.test.mjs` F4-A3 ve
F4-A3b, A4 kararıyla değişen davranışı (hedef profil aktif değilken `pending`,
deneme tüketilmez; aktif olunca `completed`) doğrular. Diğer Faz 4 testleri
değişmedi.

**Kapsam dışı bırakılanlar:** S1 legacy kopyası (kullanıcı onayı), gerçek TMDB
hidrasyonlu telafi, çok profilli `PUT /api/data` tarayıcı E2E'si.
