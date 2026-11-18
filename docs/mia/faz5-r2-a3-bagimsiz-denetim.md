# MIA Faz 5 — R2-A3 Bağımsız Denetimi (PR #41)

- **Denetleyici:** Agent-1 (test ve CI doğrulama sorumlusu; bağımsız denetim yetkisi)
- **Tarih:** 2026-11-17
- **İncelenen:** PR #41 `agent-2/phase-5-r2-a3-codlama-master` @ `563cd42` (base: master @ `49142ca`)
- **Yöntem:** Salt okunur; geçici worktree + dal-temelli yerel doğrulama; hiçbir uygulama dosyası değiştirilmedi.
- **Karar:** **APPROVED** — 1 P2 (R-3 hatırlatması) + 3 P3 notuyla. Aşağıdaki koşulların unutulmaması şartıyla merge kararı kullanıcıdadır.

## 1. Kapsam

Diff `49142ca..563cd42`: 11 dosya, +1351/−168.
`src/server/`: taste-routes.ts (profil bağlamı + 13 uç), taste-service-adapter.ts (kimlik otoritesi + fence), taste-rebuild-coordinator.ts (profil kapsamlı rebuild/bootstrap/hidrasyon), app.ts (tek ProfileContext paylaşımı + skip/error ayrımı), content-intelligence-repository.ts (kuyruk profil metaverisi), package.json (test scripti).
Testler: `tests/taste/taste-a3-profile-isolation.test.mjs` (yeni, 11 test), `tests/taste/taste-a3-rebuild-hydration.test.mjs` (yeni, 12 test), `tests/mia-phase1-contracts.test.mjs` (+71), `tests/mia-phase2-content-intelligence.test.mjs` (+53), `stock-and-live-profile.test.mjs` (uyarlama).

## 2. Tasarım S1–S7 Uygulama Doğrulaması

| Adım | İddia | Sonuç | Kanıt |
| --- | --- | --- | --- |
| S1 | `profileContext` zorunlu; global fallback YOK | ✅ | `createTasteRouter` açık hata fırlatır (taste-routes.ts:317-321); `requireProfileRef` yalnız `ProfileContext.getCurrent()` kaynaklı (taste-routes.ts:292-295); `app.ts:506-515` tek context üretir, adapter + router + fallback adapter aynı örneği alır |
| S2 | Bootstrap yalnız belgenin aktif profiliyle eşleşirse yazar | ✅ | `profiles[0]` sessiz fallback kaldırıldı (taste-rebuild-coordinator.ts:688-695); eşleşmezlike uyarı + return; `migrateExistingData` yalnız eşleşen profilde |
| S3 | Profil kapsamlı rebuild + imza | ✅ | `computeBootstrapSignature(profileId, dataDir)` global kaynaklar + profilin event/index/profile dosyalarını imzalar (taste-rebuild-coordinator.ts:312-345); `triggerTasteProfileRebuild(profileId, ...)` (:623-632) ve `performRebuildOnce` tüm okuma/yazmaları `*ForProfile` API'lerine geçirilmiş |
| S4 | Sunucu kimlik otoritesi + fence | ✅ | `processEvent`: `event.profileId` kanonikleştirmesi → aktif profille eşleşme doğrulaması (adapter:225-234); idempotency anahtarı `${profileId}:${eventId}` (:246); yazma sonrası ikinci `assertWritable`; eski `sourceRevision` → `ProfileConflictError` (non-retryable; HTTP tarafında 409) |
| S5 | 13 uç profil kapsamlı; 409 | ✅ | Tüm uçlar `requireProfileRef` + `assertCurrent` + `ensureInitialTasteBootstrap(profileId)` deseni kullanıyor (taste-routes.ts:336-474 aralığı); davranışsal testler gerçek Express uygulaması üzerinden 409 u doğruluyor (taste-a3-profile-isolation.test.mjs:118, 271, 290, 316, 326) |
| S6 | Hidrasyon/shared cache izolasyonu | ✅ | `hydrationApiKeys` profil-agnostik (anahtar `dataDir` — kimlik bilgisi), `activeHydrations` `${dataDir}:${profileId}`; `seedProfileIndexFromCache` tek yardımcı; `no-api-key` / `fetch-failed` / `cache-only` ayrımı (taste-a3-rebuild-hydration.test.mjs:190, 277); eşzamanlı iki profil hidrasyonu testi (:246) |
| S7 | Legacy uyum | ✅ | Global store API davranışı korunur; profil uçları global veriye yazmıyor (taste-a3-profile-isolation.test.mjs:364); `stock-and-live-profile.test.mjs` ölçülü uyarlanmış (+/−10) |

## 3. Süreç/Yapısal İyileştirmeler (5 fix commit'i)

- `fa1d718` + `e349f3ae` + `98962c88`: kuyruğa profil/metaveri taşınması ve metadata hint'in olay iletmeden önce başlatılması — çapraz profil kuyruk sızıntısı kalıbı kapatıldı (ileti izolasyon testi :188 "override yalnızca aktif profilin store'una yazılır").
- `e5f44762`: "skip" ile "hata" ayrımı sıkılaştırıldı — aktif olmayan profil olayları bilinçli skip (onSkipped, log) olarak işleniyor; `tasteErrorCount` yalnız gerçek hatada artıyor (app.ts:591-606). Bu, `LibraryItemAdded` kitle dağıtımında sağlıklı davranış.
- `563cd42`: profil uyuşmazlığı assert'i scoped adapter ile hizalandı.

## 4. Yerel + CI Doğrulama

Geçici worktree @ `563cd42`, dal kilidine uygun `npm install` ile:

| Kontrol | Sonuç |
| --- | --- |
| `npm test` | **512/512 PASS** (0 fail) |
| `npm run test:taste` | **428/428 PASS** (23 dosya, A3'ün 15 yeni testi dahil) |
| `npm run lint` (eslint `--max-warnings 0` + tsc ×2) | **temiz** |
| `npm run build` | **başarılı** |
| GitHub CI (pr #41 @ `563cd42`) | 3/3 pass: lint/test/build smoke + Playwright E2E + salt okunur bakım |

**Ortam notu:** Ana workspace `node_modules` bayat (kilit güncel değil); koddan bağımsız sahte başarısızlık üretir (fake-indexeddb ERR_MODULE_NOT_FOUND). Worktree'de dal-temelli `npm install` şart. Bu, gelecekteki denetimlerde doğrulama metodolojisinin bir parçası olarak kayda alındı.

## 5. Bulgular

- **P2 (bloklayıcı değil, A5 öncesi şart):** R-3 — case-insensitive FS'te b64url dizin çakışması (`profile-AAA` ↔ `profile-AAG` ↔ `profile-AAH`). Bu dalda `taste-profile-scope.ts` R-3 için hiçbir düzeltme içermiyor (`PROFILE_ID_PATTERN` + `toLowerCase` yaklaşımı değişmedi; kanıtlı çakışma: PR #34 §1, fixture: `agent-2/phase-5-r2-a1-tasarim` §7.1). A3 artık HTTP uçları üzerinden gerçek profil verisi yazıyor; macOS/Windows dağıtımında veri karışması üretim riskidir. **Kalan Faz 5 işleri (A4/A5), R-3 kapanmadan yazılacaksa bu konu her denetimde tekrar raporlanacaktır.** (Kullanıcı kararı bekliyor — iki senaryoda da R-3 kapanıklık şartı korunmalı.)
- **P3:** `processedEventIds` süre-içi bellek Set'idir; süreç yeniden başlatıldığında boşalır. Kalıcı idempotency tek doğrulayıcı olarak persistent katmanda kalır (`appendTasteEventIdempotentForProfile` + persistent eventId kontrolü) — kabul edilebilir; kalıcı koruma testlerin bir kısmında zaten birebir doğrulanıyor.
- **P3:** `computeBootstrapSignature` global dosya listesini dataDir'e göre elle kopyalar (taste-rebuild-coordinator.ts:317-328) — R2-A1 P3'ünün (`resolveTasteRoot` literal tekrarı) aynı hava. Tek kaynağa bağlanmalı.
- **P3:** A3 primitive hâlâ archive kapsamı dışı — `TASTE_ARCHIVE_DIR` (taste-store.ts:80) dead constant kalıyor; A4/A5'te kapsama alınmalı.

## 6. Karar

**APPROVED.** S1–S7 tümü doğrulandı; testler davranışsal ve izole; CI 3/3 ve yerel doğrulamanın tamamı yeşil. Merge kararı kullanıcıya aittir; R-3 (P2) kapanmadan A4/A5 sonrası macOS/Windows dağıtım denetimi şart olarak muhafaza edilmiştir.
