# MIA Faz 5 — R2-A1 Bağımsız Denetim Raporu (Agent 1)

**Denetçi:** Agent 1 (bağımsız test/CI doğrulama sorumlusu)
**Denetim tabanı:** `origin/master` @ `2ffe4bf82a5d512c1dafd7754498554e443c9098`
**Denetlenen rapor:** `docs/mia/faz5-r2-a1-teknik-hazirlik.md` — **PR #29**, dal `agent-2/phase-5-r2-a1-inventory-report` @ `1588472418f42c90c118b9e1e0889c42d22bec3e` (tek commit, tek dosya, +243 satır, docs-only)
**Denetim tarihi:** 2026-11-17

---

## 1. Denetim girdisinin bulunması (güncelleme)

İlk denetim turunda rapor hiçbir konumda bulunamamıştı (engel raporu bu PR'ın ilk commit'inde kayıtlı). Rapor sonradan **PR #29** olarak iletildi ve bu denetim tam metin üzerinden tamamlandı.

| Kontrol | Sonuç |
|---|---|
| PR #29 head SHA | `1588472418f42c90c118b9e1e0889c42d22bec3e` ✓ |
| Taban | `master` @ `2ffe4bf8` ✓ (değişmemiş) |
| Diff kapsamı | Yalnızca `docs/mia/faz5-r2-a1-teknik-hazirlik.md` (+243/-0) — kod/test/şema değişikliği **yok** ✓ |
| PR #29 CI | Cinethos CI run `44065217785` ✅ (Lint/Test/Build/Smoke + Playwright E2E); Maintenance Analysis run `44065217354` ✅ |
| Bu PR (#30) CI | Cinethos CI `44081127330` ✅; Maintenance Analysis `44081127317` ✅ |

## 2. Raporun teknik tespitlerinin kod doğrulaması

Raporun §1–§3 envanter tespitleri tek tek gerçek kodla karşılaştırıldı:

| Rapor iddiası | Etiket | Kanıt / not |
|---|---|---|
| §1 Git tabanı (master `2ffe4bf8`, R1 `3f256a7`, R1 merge edilmemiş) | **DOĞRU** | Bağımsız doğrulandı |
| §2.1 `TASTE_PATHS` export (~61) | **DOĞRU** | `taste-store.ts:61` birebir |
| §2.1 Store fonksiyon envanteri ve kilit parametreleri (10s timeout, 15s stale, `pid:ts:uuid` token, finally token eşleşirse unlink) | **DOĞRU** | `taste-store.ts:106,126,150-153,163-168` |
| §2.1 "profileId parametresi yok; partition yok" | **DOĞRU** | `resolveTastePaths` (taste-store.ts:38-58) profil parametresiz |
| §2.2 Coordinator fonksiyon envanteri (adlar/görevler) | **DOĞRU** | Tüm fonksiyonlar mevcut ve sorumluluk tanımları doğru |
| §2.2 Satır referansları (configureTasteHydration ~189, scheduleTasteMetadataHydration ~248, performRebuildOnce ~410, triggerTasteProfileRebuild ~471, ensureInitialTasteBootstrap ~490+) | **EKSİK** (P3) | Gerçek satırlar: 144, 172, 431, 494, 519 — 25–75 satır sapma; işaretler "~" olduğundan kritik değil ama A1 öncesi düzeltilmeli |
| §2.2 Bootstrap imzasında hardcoded global yollar; dataDir-anahtarlı map'ler | **DOĞRU** | `rebuild-coordinator.ts:208,218` (hardcoded `cinetrack-taste-profile.json`); `activeRebuildChains.get(dataDir)` (:495-496) |
| §2.3 Hydrator envanteri; "kendi lock'u yok" | **DOĞRU** | `hydrator.ts:44-76`; `writeTasteMetadataCache` doğrudan `writeJsonFileAtomicAsync` (:68-76) |
| §2.4 Routes; "x-cinetrack-profile-id veya ProfileContext okuması yok" | **DOĞRU** | `grep x-cinetrack\|profileContext\|profile-id src/server/taste-routes.ts` → sıfır eşleşme |
| §2.5 Adapter davranışı (assertCurrent/assertWritable, processedEventIds, kalıcı idempotency) | **DOĞRU** | `taste-service-adapter.ts:220-262` |
| §2.6 app.ts wiring satırları (~498 adapter, ~2664 router) | **DOĞRU** | Gerçek: 497-502, 2666 |
| §2.7 `normalizeProfileId` yalnızca trim+boş kontrolü; format kısıtlamaz | **DOĞRU** | `ProfileContext.ts:20-22` |
| §2.8 atomic-json envanteri (FileWriteSerializer, cleanupStaleTempFiles, quarantine, CorruptJsonFileError) | **DOĞRU** | `atomic-json.ts:20,59,82,270,343,412` |
| §3 `PROFILE_ID_PATTERN = /^(?:profile-[A-Za-z0-9_-]{1,60}\|p\d{1,10})$/` (~717) | **DOĞRU** | `cinetrack-core.ts:717` birebir; `profile-storage.ts:95` istemci deseni de birebir |
| §3 localStorage anahtarları (PROFILES_STORAGE vb.) | **DOĞRU** | `profile-storage.ts:15-17` |
| §3 Türetilmiş cache anahtarları (`cinetrack_taste_map_<profileId>`, `cinetrack_pool_*`) | **DOĞRU** | `cinetrack-core.ts:1973, 5435, 5471, 5532` |
| §3 Kullanım noktası listesinde `src/services/taste-api.ts` | **EKSİK** (P3) | `taste-api.ts`'de `TASTE_PATHS`/taste dosya yolu kullanımı yok; yalnızca BroadcastChannel adı `cinetrack-taste-profile-sync` (:22) — dosya yolu kullanımı sayılmamalı |
| §2.1/§8.3 "Bozuk events testi beklentisi ile readTasteEvents davranışı uyumsuz" | **KISMEN — düzeltilmeli** (P3) | Test fiilen **9/9 geçiyor** (bağımsız çalıştırma: `npx tsx --test tests/taste/taste-store.test.mjs` → 9 pass, 0 fail). Neden: `readTasteEvents` backup-recovery kullanıyor (taste-store.ts:241-246) ve testteki önceki `writeTasteEvents([])` çağrısı `.bak` bırakıyor → bozuk dosya "recovered" statüsüyle boş diziye döner. Gerçek durum: **uyumsuzluk değil, gizli `.bak` bağımlılığı** — backup yokluğunda test `CorruptJsonFileError` alırdı. Test kırılgan; açıkça belgelenmeli |

**Özet:** Raporda **yanlış iddia yok**; 2 küçük düzeltme (satır sapmaları, taste-api kullanım notu) ve 1 netleştirme (bozuk-events gözlemi) dışında envanter kodla birebir uyumlu.

## 3. Tasarım kararlarının değerlendirmesi

| Tasarım (rapor bölümü) | Etiket | Gerekçe |
|---|---|---|
| §4.1 Reversible Base64URL token + "sanitize/replace tek başına kullanılmamalı" | **DOĞRU** | Çakışma riskini doğru reddediyor; kanonik kimlik ↔ dizin adı ayrımı korunuyor; FS sınırı politikası açık karar olarak işaretlenmiş (§8.2-1) |
| §4.2 Manifest formatı (`_profile-id-map.json`, `entries`/`byDir` birebir, tek yazar, fail-fast, atomik, bozuk manifestte izolasyon) | **DOĞRU** | Önceki bağımsız denetimimdeki tüm zorunlu kriterleri karşılıyor; "otomatik onarım yok" ilkesi doğru |
| §5.2 Kilit mimarisi + sıra (manifest → profil → shared cache; ters sıra yok; aynı anda tek profil kilidi) | **DOĞRU** (2 netleşme şart) | Sıra hiyerarşik ve tutarlı; ancak (a) manifest kilidinin profil kilidiyle **birlikte tutulup tutulmayacağı**, (b) "profil kilidi altından cache kilidi alınmaz" kuralı açıkça yazılmalı |
| §5.3 Stale lock gereksinimleri (lockId/pid/hostname/lease/ownerToken/scope; "zorla çalma yok"; "bozuk lock stale sayılmaz") | **DOĞRU** | Mevcut kodun PID+yaş zayıflığını (taste-store.ts:150-153 — canlı sürecin kilidi 15 sn'de çalınabilir) doğru teşhis ediyor; fail-closed tercihi benim önceki önerimle birebir |
| §5.3 Heartbeat/lease yenileme | **EKSİK** (P2) | `expiresAt` alanı tanımlı ama **kim, ne zaman yeniliyor** tanımsız; uzun task (worker + TMDB hidrasyonu) lease'i aşarsa "zorla çalma yok" ilkesiyle bekleyenler timeout hatası alır — davranış kabul edilebilir ama heartbeat olup olmayacağı A1'de kesinleşmeli |
| §6.1-6.3 A1 dosya planı; "imza kırılmaması hedefi; kırıcı geçiş A2'ye" | **DOĞRU** | Uyumluluk yüzeyi yaklaşımı `resolveTastePaths`/`TASTE_PATHS`'in geniş kullanımı (taste-store:61, sync-manifest:65,71, hydrator:44-47, tests) nedeniyle zorunlu ve gerçekçi |
| §6.4 Kalıcı test planı (A1: deterministik/reversible token, traversal reddi, entries↔byDir birebirliği, fail-fast, yarışsız ilk oluşturma, kök sınırı, bozuk manifest, legacy yazım tetiklenmez) | **DOĞRU** | Kapsamlı; A1 kabul kriteri olarak yazılı hâle getirilmeli |
| §6.5 Dokunulmaması gerekenler | **DOĞRU** | Kapsam disiplini doğru |
| §6.6 "A1 koşullu uygulanabilir; imza geçişi A2'ye" | **DOĞRU** | Benim değerlendirimle örtüşüyor |
| §7 A1–A5 bağımlılık zinciri ve kapsam dışı listesi | **DOĞRU** | `LibraryItemRemoved` nötralizasyonunun ayrı teknik borç olarak kaydı — önceki P1 talebim karşılandı |
| §8.1 Riskler + §8.2 açık kararlar ("uygulama varsayımına dönüştürülmeyecek") | **DOĞRU** | Raporun en güçlü yanı: açık kararları karardan ayrıştırması |

## 4. Bulgu özeti (bu denetim)

| Seviye | Bulgu |
|---|---|
| P0 | Yok |
| P1 | Yok — önceki P1'ler (rapor eksikliği, LibraryItemRemoved kaydı) rapor tarafından giderildi/karşılandı |
| P2 | (1) Heartbeat/lease yenileme davranışı tanımsız — A1'de kesinleşmeli; (2) kilit "birlikte tutma" semantiği + "profil kilidi altından cache kilidi alınmaz" kuralı A1 tasarımına yazılmalı; (3) A1 kabul kriterleri §6.4 planından yazılı kriter dosyasına dönüşmeli |
| P3 | (1) Coordinator satır referansları 25–75 satır sapmış; (2) `taste-api.ts` kullanım listesinden çıkarılmalı; (3) bozuk-events test gözlemi "uyumsuzluk" değil "gizli `.bak` bağımlılığı" olarak yeniden ifade edilmeli; (4) `byDir`'in türetilmiş indeks (entries'ten hesaplanır) olduğu A1'de açıkça belirtilmeli |

## 5. Nihai karar

# APPROVED WITH CONDITIONS

**Gerekçe:** Agent 2'nin raporu gerçek master koduyla **bütünüyle uyumlu** (yanlış iddia yok; 2 küçük düzeltme + 1 netleştirme), mevcut mimariyi çoğaltmıyor ve önceki bağımsız denetimlerin tüm zorunlu kriterlerini karşılıyor (reversible eşleme + manifest otoritesi, fail-fast, kilit sırası, stale lock güvenliği, salt-okunur legacy, kapsam dışı bırakmalar). Raporun açık kararları uygulama varsayımına dönüştürmeden kullanıcı onayına bırakması doğru süreç disiplini.

**Koşullar (R2-A1 uygulamasına başlamadan yazılı olarak kesinleşmeli):**
1. Heartbeat/lease yenileme davranışı (kim/ne zaman yeniler; lease dolarsa bekleyen davranışı).
2. Kilit edinim "birlikte tutma" semantiği + "profil kilidi altından shared-cache kilidi alınmaz" kuralı.
3. A1 kabul kriterlerinin §6.4 test planından yazılı kriter listesine dönüşmesi.
4. P3 düzeltmeleri rapora işlenmeli (satır referansları, taste-api notu, bozuk-events yeniden ifade, byDir türetilmişlik).

**Süreç ön koşulu:** R1 (`agent-2/phase-5-r1-eventbus-boundaries` @ `3f256a7`) **hâlâ merge edilmedi ve PR'ı hâlâ açılmamış** — R2-A1'e başlamadan önce R1'in PR'ının açılıp birleştirilmesi önerilir.

**Kullanıcıdan hâlâ gereken kararlar (rapor §8.2 ile uyumlu):** profileIdSafe şeması/uzunluk politikası, manifest kesin konumu/şema sürümü, lock timeout/lease parametreleri, S1 canlı veri kanıtı ve onaylı kopya kararı, S3 sunum politikası, A1 PR kesimi.

---
*Bu denetim salt-okunur yapılmıştır; hiçbir uygulama kodu, test veya şema değiştirilmemiştir. İlk turun engel kaydı (kaynak rapor bulunamadı) bu PR'ın commit geçmişinde korunmaktadır.*
