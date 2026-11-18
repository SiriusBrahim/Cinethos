# MIA Faz 5–6 Test ve CI Denetimi

**Denetlenen kaynak:** `agent-2/phase-5-r2-a3-codlama-master`  
**Denetlenen HEAD:** `7a6fdf0e3e3b1445c8a93f5e0d8707581dd9d75f`  
**Base:** `master` @ `49142ca8d552d59b11894a7aa574cce4588c16ce`  
**Kapsam notu:** Faz 6 kodu bu denetim sırasında GitHub'a gönderilmiş bir branch/PR olarak bulunamadı. Bu nedenle Faz 6 için kod ve puan-paritesi doğrulaması yapılamadı; Faz 5'e kadar mevcut kaynak incelendi.

## 1. CI sonucu — Faz 5 HEAD

GitHub Actions, `7a6fdf0` üzerinde:

- `npm ci`: PASS
- ESLint + TypeScript uygulama/test typecheck: PASS
- `npm test`: **513/513 PASS**
- `npm run test:taste`: **436/436 PASS**
- `npm run build`: PASS
- Production dependency audit: **0 critical, 0 high, 26 moderate**
- Production startup smoke test: PASS
- Playwright E2E: PASS
- Salt okunur Maintenance Analysis: PASS

Run'lar:
- Cinethos CI: https://github.com/SiriusBrahim/Cinethos/actions/runs/44366093277
- Maintenance Analysis: https://github.com/SiriusBrahim/Cinethos/actions/runs/44366093116

Bu sonuçlar mevcut Faz 5 HEAD'inin CI doğrulamasıdır; aşağıdaki yeni regresyon testleri henüz bu CI koşusuna dahil değildir.

## 2. Doğrulanmış bulgular

### P1 — A4: profil değişimi yarışı telafi olayını kaybettirebilir

**Kanıt:**
- `src/app/app-event-bus.ts`: `publish()` önce `persistEvent` çağrısını bekler, ardından aboneleri çalıştırır.
- `src/modules/background/service.ts`: `acceptEvent()`, olayın persist edildiği anda hedef profil aktifse `profileScoped` telafi işleyicisi için görev üretmez.
- Aynı persist/subscribe aralığında profil değişirse `subscribeTasteAdapterToEventBus` olayı `profile-not-active` ile atlar. Bu noktada telafi görevi daha önce üretilmediği için olay kayıpsız biçimde kuyruğa alınmış değildir.

**Etkisi:** Profil değişiminin zamanlamasına bağlı olarak Taste olayı kalıcı taste deposuna hiç yazılmayabilir.

**Regresyon testi:** `tests/taste/taste-a4-background-compensation.test.mjs` içine persist ile subscriber arasındaki profil değişimini canlandıran test eklendi.

### P2 — A5: profil dizinleri varsa bozuk mapping manifesti gizleniyor

**Kanıt:** `src/server/taste-legacy-status.ts` içindeki `countProfilePartitions()`, `taste/profiles` altında en az bir dizin bulduğunda mapping manifestini okumadan erken dönüyor. Bu nedenle bozuk `_profile-id-map.json`, `mappingUnreadable: false` olarak raporlanabiliyor.

**Etkisi:** A1 tasarımındaki fail-fast mapping-manifest kuralı sağlık/legacy sınıflandırmasında görünmez hâle geliyor.

**Regresyon testi:** `tests/taste/taste-a5-legacy-transition.test.mjs` içine profil partition dizinleri mevcutken bozuk manifestin de raporlanmasını zorunlu kılan test eklendi.

## 3. Faz 5 kapsam eksikleri

Ana plan `MIA_TRANSFORMATION_PLAN.md` §1 Yönetici 5 ve §7 ile karşılaştırıldığında, denetlenen HEAD'de:

- `src/modules/intelligence/{taste,memory,relationships}` yapısı bulunmuyor.
- Bağımsız MemoryRepository / LearningState / decay katmanı görünmüyor.
- `IRelationshipService` için bir uygulama bulunmuyor; mevcut adapter `ITasteService` ve `IMemoryService` uyguluyor.
- Legacy sınıflandırma kodu `S1` ve `S3` döndürüyor; tasarım §5'te tanımlı `S2` senaryosu uygulanmamış.

Bu maddeler CI başarısızlığı değil, plan kabul kriteri eksikleridir. Faz 5'in tamamlandı olarak kapatılmasından önce ele alınmalıdır.

## 4. Faz 6 doğrulama engeli

GitHub'daki branch ve açık PR listesinde Faz 6 uygulama branch'i/PR'ı bulunamadı. Mevcut Faz 5 branch'inde `src/modules/recommendations/` ve Faz 6 önce/sonra aynı veri seti puan karşılaştırma testleri de bulunmuyor.

Ajan 2 Faz 6 değişikliklerini aynı branch'e push ettiğinde:
1. Aynı denetim PR'ında Faz 6 için ek test ve bulgular eklenecek.
2. Mevcut öneri motorunun sabit veri kümesindeki skorları baseline alınacak.
3. Eski/yeni motor sonuçları içerik kimliği, sıralama ve skor toleransı açısından karşılaştırılacak.
4. Faz 6 CI ve E2E tekrar doğrulanacak.

## 5. Denetim sınırı

Bu PR uygulama kodunu değiştirmez. Yalnızca iki yeni regresyon testi ve bu denetim raporunu içerir. Yeni testler bu PR'ın açıldığı anda uzaktan çalıştırılmış değildir; Ajan 2 düzeltmelerinden sonra aynı PR/branch üzerinde CI ile doğrulanmalıdır.
