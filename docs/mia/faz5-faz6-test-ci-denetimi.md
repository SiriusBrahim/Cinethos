# MIA Faz 5–6 Test ve CI Denetimi

**Denetlenen kaynak:** `agent-2/phase-5-r2-a3-codlama-master`  
**Denetlenen HEAD:** `f4da5a24f016a59dbb2f35cdbc4f34f25bff4d3c`  
**Base:** `master` @ `49142ca8d552d59b11894a7aa574cce4588c16ce`  
**Kapsam:** Depodaki entegre Faz 0–6 test/CI hattı; özellikle Faz 5 A4/A5 ve Faz 6 öneri yöneticisi.

## 1. CI doğrulaması

### Faz 5 HEAD — önceki koşu

`7a6fdf0` için:
- `npm test`: 513/513 PASS
- `npm run test:taste`: 436/436 PASS
- ESLint, TypeScript, build ve production smoke: PASS
- Playwright E2E: PASS
- Maintenance Analysis: PASS

### Faz 6 HEAD — güncel koşu

GitHub Actions run:
https://github.com/SiriusBrahim/Cinethos/actions/runs/44376624617

- Lint + TypeScript: PASS
- Production dependency audit: PASS (0 critical, 0 high, 26 moderate)
- Playwright E2E: PASS
- Unit Tests: **FAIL — 520 testten 519'u geçti, 1 test dosyası başarısız**
- Taste, build ve production smoke adımları ana CI job'ında unit test hatası nedeniyle atlandı.

Hata `tests/mia-phase1-contracts.test.mjs` içindeki “Son Kabul P1” testinden sonra oluşan asenkron etkinliktir. Test tamamlandıktan sonra arka plandaki Taste rebuild'i geçici dizine lock dosyası oluşturmaya devam etmiş; testin dizini silmesi sonucu `ENOENT: link ... .tmp -> ... .lock` hatası oluşmuştur.

Aynı commit'in salt okunur Maintenance Analysis koşusu:
https://github.com/SiriusBrahim/Cinethos/actions/runs/44376624602

Bu koşu ayrı ortamda `npm test 519/519`, `test:taste 436/436`, lint/typecheck, build ve production audit adımlarını PASS raporlamıştır. Bu fark testte zamanlama/temizlik yarışı olduğunu gösteriyor; ilk başarısızlık göz ardı edilmemelidir. Aynı commit için ikinci CI denemesi (attempt 2) **PASS** oldu: `npm test 519/519`, `test:taste 436/436`, lint/typecheck, build, production smoke ve Playwright E2E başarılı. Kod değişmeden tekrarın geçmesi, ilk hatanın zamanlama kaynaklı flaky test olduğunu doğruluyor.

Faz 6 test dosyasındaki 6 testin tamamı ilk CI çıktısında PASS:
- önce/sonra puan, sıralama ve halka eşitliği
- deterministik tekrar koşumu
- manager ve alt yöneticiler
- eski çekirdek dosyasının kaldırılması ve App import sınırı
- film/dizi havuz ayrımı
- değerlendirme/sıralama yöneticisi sarmalayıcıları

## 2. Doğrulanmış uygulama bulguları

### P1 — A4: persist/subscribe aralığındaki profil değişimi Taste olayını kaybettirebilir

**Kanıt:**
- `src/app/app-event-bus.ts`: `publish()` önce `persistEvent` çağrısını bekler, ardından aboneleri çalıştırır.
- `src/modules/background/service.ts`: `acceptEvent()`, persist anında hedef profil aktifse `profileScoped` telafi görevi üretmez.
- Persist ile canlı abone çalışması arasındaki aralıkta profil değişirse `subscribeTasteAdapterToEventBus` olayı `profile-not-active` ile atlar. Olay için telafi görevi de bulunmadığından kalıcı Taste yazımı gerçekleşmeyebilir.

**Regresyon testi:** `tests/taste/taste-a4-background-compensation.test.mjs` içine profil değişim yarışı testi eklendi.

### P1 — A4: kanıt yazıldıktan sonra rebuild başarısızsa retry yeniden hesaplamayı atlıyor

**Kanıt:** `src/server/taste-service-adapter.ts` içindeki `processDeferredEvent()`:
1. TasteEvent'i kalıcı depoya ekliyor.
2. `processedEventIds` kümesine ekliyor.
3. Rebuild tetikliyor.
4. Rebuild hata verirse kuyruk retry alıyor; fakat tekrar denemede `processedEventIds` veya mevcut event kontrolü nedeniyle erken `ok:true` dönüyor ve rebuild yeniden tetiklenmiyor.

**Etkisi:** Kuyruk görevi tamamlandı görünebilir, ancak türetilmiş Taste profili eski kalabilir.

**Regresyon testi:** Aynı A4 test dosyasına, ilk rebuild başarısızlığından sonra aynı olayın yeniden işlenmesiyle profilin gerçekten oluşturulmasını bekleyen test eklendi.

### P2 — A5: profil dizinleri varsa bozuk mapping manifesti gizleniyor

**Kanıt:** `src/server/taste-legacy-status.ts` içindeki `countProfilePartitions()`, `taste/profiles` altında en az bir dizin bulduğunda mapping manifestini okumadan erken dönüyor. Bozuk `_profile-id-map.json`, `mappingUnreadable: false` olarak raporlanabiliyor.

**Regresyon testi:** `tests/taste/taste-a5-legacy-transition.test.mjs` içine profil dizinleri mevcutken bozuk manifestin de raporlanmasını zorunlu kılan test eklendi.

### P2 — A5: S2 legacy senaryosu uygulanmamış

Tasarım `docs/mia/faz5-r2-a1-tasarim.md` §5, S1/S2/S3 davranışlarını tanımlıyor. `TasteLegacyScenario` tipi S2'yi içeriyor; ancak `describeTasteLegacyState()` yalnızca S1 veya S3 döndürüyor. S2 için sınıflandırma/kanıt kuralı eksik.

## 3. Faz 5 plan eksikleri

Ana plan `MIA_TRANSFORMATION_PLAN.md` §1 Yönetici 5 ve §7 ile karşılaştırıldığında:

- `src/modules/intelligence/{taste,memory,relationships}` yapısı bulunmuyor.
- Bağımsız MemoryRepository / LearningState / decay katmanı görünmüyor.
- `IRelationshipService` için uygulama bulunmuyor; mevcut Taste adapter yalnızca `ITasteService` ve `IMemoryService` uyguluyor.
- Mevcut `src/modules/relationships` dizini UI bileşenini içeriyor; planlanan intelligence relationship service yerine geçmiyor.

Bunlar test başarısızlığı değil, Faz 5'in plan kabul kriteri eksikleridir. Faz 5 tamamlandı olarak kapatılmamalıdır.

## 4. Faz 6 plan eksikleri

Faz 6 puan-paritesi testi başarılı; ancak ana plan §1 Yönetici 6 ile uygulama kaydı arasında iki açık fark var:

- Ana plan `App.tsx` içindeki `forYou*` / `catalog*` durumlarının `src/modules/discover/state.ts` altına taşınmasını Faz 6'ya koyuyor. `docs/mia/faz6-oneri-yoneticisi.md` bu işi Faz 7'ye erteliyor. Bu, plan değişikliği olarak onaylanmalı veya Faz 6 kapsamında tamamlanmalı.
- `IRecommendationService` sözleşmesindeki `getRecommendations(ref, limit)` ve `refresh(ref)` metotları uygulanmamış; Faz 6 raporu bunu açıkça erteliyor.
- Genel mimari kuralındaki `manifest.ts` + `service.ts` giriş noktaları `src/modules/recommendations/` altında yok; yalnızca `index.ts` facade'ı ve alt yöneticiler var.
- `src/modules/discover/state.ts` bulunmuyor; `forYou*` / `catalog*` state hâlâ `App.tsx` içinde. Faz 6 kaydı bu işi Faz 7'ye ertelemiş.

## 5. Test/CI PR'ında yapılanlar

Bu PR uygulama koduna dokunmaz. Şunları içerir:
- A4 profil değişim yarışı regresyon testi.
- A4 append-sonrası rebuild retry regresyon testi.
- A5 bozuk mapping manifesti regresyon testi.
- `tests/mia-phase1-contracts.test.mjs` içindeki geçici dizin temizliği öncesi aynı profil rebuild kuyruğunu bekleyen test düzeltmesi. Bu, CI'da görülen fire-and-forget rebuild kaynaklı `ENOENT` yarışını gidermeyi hedefler.
- Bu rapor.

Yeni regresyon testleri ve test-temizlik düzeltmesi henüz GitHub CI'da çalıştırılmadı. PR #43'ün hedefi Ajan 2 geliştirme branch'idir; mevcut workflow PR base filtreleri bu branch için otomatik CI başlatmıyor. Ajan 2 bu test değişikliklerini kendi branch'ine aldıktan sonra PR #41 CI yeniden çalıştırılmalıdır.

## 6. Nihai durum

- Faz 5: **REQUEST_CHANGES** — A4 veri kaybı/retry riskleri ve Memory/Relationships modül eksikleri var.
- Faz 6: **REQUEST_CHANGES** — skor-paritesi testi geçiyor; ancak IRecommendationService ve planlanan discover state taşıması eksik.
- CI: **PASS (attempt 2)** — ilk denemede 520 testten 519 PASS / 1 flaky test dosyası hatası görüldü; aynı commit'in ikinci denemesinde 519/519 PASS, taste 436/436 PASS, build/smoke ve E2E PASS. Faz 5/6 kapsamı yine de mimari eksikler nedeniyle REQUEST_CHANGES.


## 7. Faz 6 bağımsız doğrulama — commit `f4da5a24`

**Kaynak karşılaştırması:** `7a6fdf0..f4da5a2` aralığı tek Faz 6 commit'inden oluşuyor. 17 dosyada değişiklik var; eski `src/core/recommendation-orchestrator.ts` kaldırılmış, `src/modules/recommendations/` altında beş alt yönetici ve bir dış yüz oluşturulmuş. `src/App.tsx` ve önceki import tüketicileri yeni modül yoluna geçirilmiş.

### 7.1 GitHub Actions — attempt 2 doğrulandı

Run: https://github.com/SiriusBrahim/Cinethos/actions/runs/44376624617

Aynı commit için:
- **Attempt 1:** Unit Tests adımı başarısız; diğer Playwright E2E işi başarılı. Ana doğrulama job'ında sonraki Taste / build / production smoke adımları bu nedenle atlandı.
- **Attempt 2:** iki CI işi de başarılı.
  - `npm run lint`: ESLint + uygulama TypeScript + test TypeScript PASS.
  - `npm test`: **519/519 PASS**.
  - `npm run test:taste`: **436/436 PASS**.
  - `npm run build`: PASS.
  - Production dependency audit: **0 critical / 0 high / 26 moderate**; high eşikli CI adımı PASS.
  - Production smoke (`npm prune --omit=dev` sonrası sunucu açılışı, API ve deep-link): PASS.
  - Playwright E2E: **11/11 PASS**.
- Ayrı salt okunur Maintenance Analysis run #44376624602: npm test 519/519, Taste 436/436, lint/typecheck/build ve production audit PASS. Mimari analiz 578 kenar, 5 ihlal, 0 döngü raporladı; ihlaller mevcut mimari allowlist/baseline kapsamında değerlendirilmelidir.

**Flaky test notu:** Attempt 1'de görülen `tests/mia-phase1-contracts.test.mjs` geçici dizin / arka plan Taste rebuild temizliği yarışı gerçek bir test kararsızlığıdır. Attempt 2'nin aynı commit'te geçmesi ilk başarısızlığı geçersiz kılmaz. PR #43'teki rebuild tamamlanmasını bekleme düzeltmesi hedefe alınmalı; Agent 2 dalına taşındıktan sonra yeni CI koşusunda doğrulanmalıdır.

### 7.2 Faz 6 kod incelemesi

**Olumlu doğrulamalar**
- Öneri orkestrasyonu tek modül sınırına taşınmış; eski çekirdek dosyası silinmiş.
- `App.tsx` yeni `src/modules/recommendations/index.ts` giriş noktasını kullanıyor.
- `CandidatePoolManager` ve `ExplanationManager` önceki dosyadaki davranışları koruyor; eski ve yeni havuz filtresi karşılaştırıldığında belirsiz medya türünü eleme ve movie/tv/all davranışı aynı.
- `enrichCatalogItemsWithTaste` için eklenen isteğe bağlı `now` parametresi testte sabit referans zamanını sağlıyor; parametre verilmediğinde güncel zaman varsayılanı korunuyor.
- Faz 6 testleri 6/6 PASS: sabit veri seti ile önce/sonra skor ve sıra karşılaştırması, tekrar koşum determinizmi, yönetici kurulumu, import sınırı, film/dizi havuz ayrımı, değerlendirme/sıralama facade kontrolleri.
- Puanlama matematiği `src/core/cinetrack-core.ts` içinde bırakılmış; bu commit'te puanlama formüllerini yeniden uygulayan bir değişiklik tespit edilmedi.

**P2 — Önce/sonra parity testinin kapsamı kısmi**
- `tests/phase6-recommendation-manager.test.mjs` altın fixture karşılaştırmasını `enrichCatalogItemsWithTaste` ve `mapRecommendationBatchToDisplayItems` çıktıları için yapıyor.
- Aynı commit ile taşınan `hydrateTasteMapWithDerivedCache` ve `buildDerivedProfilePayloadFromTasteMap` için önce/sonra altın çıktı karşılaştırması bulunmuyor.
- Mevcut testler bu fonksiyonların çeşitli davranışlarını kapsasa da taşınma öncesi/sonrası tam çıktı eşitliği kanıtı değiller. Bu nedenle rapordaki “tüm öneri motoru çıktıları birebir aynı” ifadesi yalnızca test edilen puanlama/gösterim akışıyla sınırlandırılmalı veya iki yardımcı için de parity fixture eklenmeli.

**P2 — Üretim bundle uyarısı**
- Vite build başarılı; ancak ana JS chunk yaklaşık **810 kB** (minify sonrası) ve 500 kB uyarısı veriyor.
- `TasteProfileDashboard.tsx`, `App.tsx` tarafından dynamic import edilirken `ProfileStatsTab.tsx` tarafından static import edildiğinden `INEFFECTIVE_DYNAMIC_IMPORT` uyarısı çıkıyor. Lazy-load hedefleniyorsa statik import zinciri ayrıca ele alınmalı. Bu build hatası değil, performans/bundle bölme iyileştirmesidir.

### 7.3 Faz 6 kabul kriteri / açık işler

Ajan 2'nin kendi raporundaki iki eksik, ana plan §1 Yönetici 6 ile tutarlı:
- `App.tsx` içindeki `forYou*` / `catalog*` state hâlâ App içinde; `src/modules/discover/state.ts`, `useForYou`, `useCatalog` oluşturulmamış.
- `IRecommendationService` sözleşmesinin `getRecommendations(ref, limit)` ve `refresh(ref)` uçları uygulanmamış.

Bunlar Faz 6'nın tüm kabul kriterleri tamamlandı denmesini engeller. Ajan 2 bunları Faz 7'ye ertelediğini açıkça kaydetmiş; plan sahibi bu kapsam değişikliğini onaylamalı veya eksikler tamamlanmalı.

### 7.4 Faz 6 sonucu

- **Kod taşıma / skor paritesi:** doğrulanan kapsamda PASS.
- **GitHub CI:** attempt 2 PASS; attempt 1 flaky test hatası ayrıca açık risk.
- **Tam Faz 6 kabulü:** REQUEST_CHANGES / INCOMPLETE — discover state ve IRecommendationService açık işleri nedeniyle.
- **Ek test önerisi:** hydrate + payload yardımcıları için önce/sonra fixture/parity testi; recommendation-specific browser E2E ise henüz yok.
- Bu denetim uygulama kaynak kodunu değiştirmez. PR #43'teki A4/A5 regresyon testleri de Agent 2 dalına henüz alınmadığı için bu CI koşusu onları çalıştırmamıştır.


## 8. PR #41 değişikliklerini ayırma ve A3 bağımsız CI denetimi (2026-11-19)

### 8.1 Kabul kapsamı

PR #41'in gerçek HEAD'i `5f87a42d19d6fc469f8702f9f8abe357e3fff9a3`, base'i `master` @ `49142ca8` olarak doğrulandı. Dokuz commit içeriyor: A3, A4/A5 uygulama değişiklikleri, Faz 6 ve Faz 7. Bu nedenle PR #41'in tamamı tek bir kabul birimi olarak merge edilmemelidir.

- **R2-A3:** işlevsel kapsam bağımsız PR'a ayrıldı (#47); ancak A3 commit'inin kendi CI'si tam geçmediği için henüz merge kabulü yok.
- **R2-A4/A5:** uygulama ve regresyon testleri birlikte değerlendirilmeli; #43 CI'sinde A4/A5 testlerinin üçü de yeşil değil. A4 retry testi ayrıca hatalı test düzeneği içeriyor.
- **Faz 6:** manager'a taşıma ve test edilen skor paritesi PASS; discover-state ve IRecommendationService eksikleri nedeniyle INCOMPLETE.
- **Faz 7:** PR #41 HEAD'inde mevcut; bağımsız CI #44404537286 ve Maintenance Analysis #44404537423 başarılı (524/524, Taste 436/436, build, smoke, Playwright 11/11). Faz 7 kabul edildi; Faz 6'dan bağımsız olarak master'a alınması için bağımlılık ayrıştırması gerekir.

### 8.2 A3'ün izole CI sonucu

A3 commit'i `33f26141cafd1e305e2ab768e279f41320335128`, master'ın doğrudan çocuğudur. Bu commit'i tek başına taşıyan Draft PR #47 oluşturuldu:
https://github.com/SiriusBrahim/Cinethos/pull/47

Aynı SHA için mevcut GitHub Actions kayıtları:
- Cinethos CI #44196505461: **FAIL** — Lint/TypeScript PASS, Playwright PASS; Unit Tests 511 testten 507 PASS / 4 FAIL. Taste/build/smoke adımları unit test hatası nedeniyle atlandı.
- Maintenance Analysis #44196505403: **FAIL**.

Dört başarısız test:
1. `tests/mia-phase1-contracts.test.mjs:419` — TasteServiceAdapter idempotent olay / eventWatermark beklentisi (beklenen 1, gerçekleşen 0).
2. `tests/mia-phase1-contracts.test.mjs:546` — useItemActions + adapter + shell bridge testi; status_changed/rating_changed olayları beklenen 2, gerçekleşen 0.
3. `tests/mia-phase1-contracts.test.mjs:682` — app/taste uçları entegrasyonunda beklenen 2 olay, gerçekleşen 0.
4. `tests/mia-phase2-content-intelligence.test.mjs:634` — Content Intelligence HTTP uç testi 200 beklerken 404 alıyor.

Bu nedenle A3'ün kendi başına CI kabulü **BLOCKED**. PR #41'in daha ileri HEAD'inde bu testlerin yeşil olması, A3'ün tek başına merge edilebilir olduğunu kanıtlamaz; sonraki commit'lerin sağladığı uyumluluk/değişiklikler ayrıca ayrıştırılmalıdır. PR #47 Draft tutulmalı, bu dört testin neden yalnızca A3 commit'inde kırıldığını çözmeden merge edilmemelidir.

### 8.3 PR #43'ün rolü ve A4/A5 regresyonları

PR #43, Agent 2 geliştirme tabanı `f4da5a24` üzerine bağımsız denetim testleri ve rapor taşır; master'a doğrudan merge hedefi değildir. PR #43 CI denetiminde:
- `npm test`: 519/519 PASS.
- `test:taste`: 439 testten 436 PASS / 3 FAIL.
- Playwright: 11/11 PASS.
- A4 profil değişimi sırasında atlanan olay telafisi testi başarısız; uygulama telafi görevini üretmiyor.
- A4 retry testi `rebuildOnEvent: false` ile kurulduğu için gerçek rebuild hatasını sınamıyor; test düzeneği düzeltilmeli. Statik incelemede mevcut olay için erken dönüşün retry'de rebuild'i atlayabilme riski ayrıca incelenmeli.
- A5 bozuk manifestin partition dizinleri varken görünür kalması testi başarısız.

Sonuç: A4 telafi ve A5 manifest davranışı düzeltilmeli; A4 retry testi geçerli bir hata enjeksiyonu ile yeniden yazılmalı. PR #43 bu işler için tek denetim/kanıt PR'ı olarak Draft kalmalıdır.

### 8.4 Merge kararı

- A3 (#47): **MERGE ETME — CI BLOCKED**.
- A4/A5 (#43): **REQUEST CHANGES**.
- Faz 6: **REQUEST CHANGES / INCOMPLETE**.
- Faz 7: **KABUL — CI PASS**, ancak master'a taşımadan önce Faz 6/A4-A5 bağımlılıklarından güvenli ayrıştırma gerekir.
- Bu işlem sırasında master'a push veya merge yapılmadı.
