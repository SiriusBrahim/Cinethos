# MIA Faz 5 — R2-A1 Kodlama Öncesi Uygulama Koşulları

**Durum:** Kodlama öncesi kesinleştirme belgesi. Bu belge uygulama izni, kod/test değişikliği veya veri taşıma talimatı değildir.  
**Tarih:** 2026-11-17  
**Git tabanı:** `origin/master` @ `2ffe4bf82a5d512c1dafd7754498554e443c9098` (değiştirilmez)  
**Girdi belgeleri:** PR #29 — `docs/mia/faz5-r2-a1-teknik-hazirlik.md` (Ajan 2, `1588472418f42c90c118b9e1e0889c42d22bec3e`) ve PR #30 — `docs/mia/faz5-r2-a1-bagimsiz-denetim.md` (Ajan 1, `6918ae9e16391aebd0766d6307d941553451da82`, “APPROVED WITH CONDITIONS”).

## 0. Kapsam ve sınırlar

- **Bu turda yapılmaz:** Uygulama kodu, test, migration, şema, DB/API/yedekleme/senkronizasyon davranışı değişikliği; R2-A1 kodlamasının başlatılması; `master`’a doğrudan push veya PR merge.
- **Kapsam:** R2-A1 kodlamasına başlamadan önce açık bırakılan koşulların yazılı kesinleştirilmesi ve Ajan 1’in PR #30 denetiminde işaretlenen rapor düzeltmelerinin bu belgede yansıtılması.
- **Kapsam dışı (ayrı karar/onay):** `LibraryItemRemoved` nötralizasyonu (ayrı teknik borç), GitHub sync/backup/restore/Memory Manager/Taste algoritması değişiklikleri, Faz 6, legacy migration/veri taşıma/otomatik profil ataması.

## 1. Heartbeat / lease yenileme davranışı (R2-A1 tasarım koşulu)

Bu bölüm, PR #29 §5.3 ve PR #30 P2 bulgusuna dayanır: kilit meta verisinde `expiresAt` (lease) tanımlı olmalıdır; ancak **kim yeniler, ne zaman yeniler ve lease dolarsa ne olur** A1 tasarımında yazılı olarak kesinleşmeden kodlamaya geçilmemelidir.

| Konu | Kesinleştirilen koşul |
|---|---|
| Kilit meta verisi (zorunlu alanlar) | `lockId`, `pid`, `hostname`, `createdAt`, `expiresAt` (lease), `ownerToken`, `scope`. PID tek başına yeterli değildir; `ownerToken` sahiplik kanıtının bir parçasıdır. |
| Lease sahibi ve yenileme sorumlusu | Lease’i **yalnızca kilidi tutan kritik bölümün sahibi** (aynı proses + aynı `lockId/ownerToken` ile doğrulanan sahip) yenileyebilir. Başka bir bekleyen/proses lease uzatamaz. |
| Yenileme zamanı (heartbeat) | Kritik bölüm, kilit timeout/lease süresine yaklaşabilecek kadar uzun sürebiliyorsa (örn. worker akışı, IO zinciri, uzun metadata/hydration-adjacent senaryolar) sahip, **lease süresi dolmadan önce** periyodik heartbeat ile `expiresAt`’i ileri taşır. Öneri: yenileme aralığı lease süresinin güvenli bir oranı (ör. ≤ lease/3) olacak şekilde seçilmeli ve sabit aralıkla denenmelidir; kesin sayısal değerler PR #29 §8.2-3 kararıyla A1 uygulamasında sabitlenir. |
| Heartbeat atomikliği/koşulu | Yenileme yalnızca dosyadaki mevcut `lockId` ve `ownerToken` (ve scope) hâlâ sahibinkilerle eşleşiyorsa uygulanır. Eşleşme yoksa yenileme yapılmaz ve sahip kritik bölümü güvenli biçimde sonlandırmalı/başarısız saymalıdır (sessiz sahiplik devri yok). |
| Lease dolumu ve bekleyen davranışı | Lease dolduğunda bekleyenler kilidi **otomatik/zorla çalamaz**. Bekleyen, tanımlı timeout/backoff süresince yeniden denemeyi sürdürür; süre dolarsa **teşhis edilebilir hata** ile başarısız olur. “Zorla çalma/silme yok” ilkesi korunur. |
| Uzun görev ve kabul edilebilir başarısızlık | Heartbeat’a rağmen lease uzatılamazsa veya sahip kritik bölüm lease’i aşacak şekilde ilerleyemezse, bekleyenlerin timeout hatası alması **kabul edilebilir** (fail-safe) davranıştır. Bu durumda sessiz veri yazımı, çifte sahiplik veya otomatik onarım yapılmaz. |
| Stale tespiti ve yeniden sahiplenme | Stale kararı yalnızca **kanıtlanabilir** koşullarda verilir: lease dolumu **ve** sahiplik doğrulanamaması (host/ownerToken/PID sinyalleri birlikte değerlendirilir; PID reuse dikkate alınır). Yalnız bu durumda atomik yeniden sahiplenme denenebilir. |
| Bozuk/okunamaz lock dosyası | Bozuk lock dosyası **stale sayılmaz**. Fail-closed: teşhis edilebilir hata üretilir; otomatik silme/onarım yok. |
| Kilit serbest bırakma | Sahip, iş bitiminde (başarı/hata/finally) kilidi yalnızca `lockId/ownerToken` hâlâ kendisine aitse bırakır. |

**A1 kabul koşulu (yazılı):** A1 tasarım/uygulama PR’ı, yukarıdaki “kim/nezaman/lease dolunca ne olur” sorularını parametre adları ve beklenen hata davranışıyla netleştirmeden tamamlanmış sayılmaz.

## 2. Kilitlerin birlikte tutulma ve edinilme kuralları (R2-A1 tasarım koşulu)

Bu bölüm, PR #29 §5.2 ve PR #30 P2 bulgusuna dayanır: kilit hiyerarşisi ve “birlikte tutma” semantiği açık yazılmalıdır.

### 2.1 Kilit kapsamları

| Kilit | Kapsam | Amaç |
|---|---|---|
| Global mapping-manifest kilidi | `(dataDir, "__profile-id-map__")` | Manifest ilk oluşturma/güncelleme ve eşleme çözümleme yarışını önlemek; tek yazar garantisi |
| Profil veri kilidi | `(dataDir, profileIdSafe)` | Aynı profil taste IO ve rebuild-kritik tutarlılık (A2’de tam uygulanır; A1 sıralama/altyapı ile uyumlu olmalı) |
| Shared metadata cache kilidi | `(dataDir, "shared-metadata-cache")` | Ham TMDB metadata cache eşzamanlı erişim (A2) — global/shared kaynak |

### 2.2 Edinim sırası (deadlock önleme, zorunlu)

1. **Global mapping-manifest kilidi**
2. **Hedef profil kilidi**
3. **Shared metadata cache kilidi**

- Ters sıra **yasaktır**.
- Aynı anda **birden fazla farklı profil kilidi** tutulmaz.
- Kritik bölüm minimum tutulur.

### 2.3 Birlikte tutma (holding) semantiği

| Kural | Açıklama |
|---|---|
| Manifest → profil geçişi | Manifest okuma/doğrulama/oluşturma/güncelleme ve bu manifest kaydına bağlı profil yolunun çözümlemesi, **mapping-manifest kilidi tutulurken** yapılmalıdır. Profil IO’ya geçilecekse, çözümleme sonucu sabitlenene kadar gerekli kilitler tutarlı sırayla elde edilir. |
| Manifest kilidinin profil kilidiyle ilişkisi | Manifest, profil eşlemesinin otoritesidir. Aynı operasyon manifest kaydını değiştiriyor **ve** o profile IO yapıyorsa, manifest kilidi eşleme tutarlılığı bozulmayacak şekilde tutulmalı; eşleme değişmiyorsa manifest kilidi, çözümleme/ doğrulama tamamlandıktan sonra mümkün olan en erken noktada bırakılabilir. Hangi işlemlerin “manifest+profil birlikte” gerektirdiği A1/A2 tasarımında operasyon bazında açıkça listelenmelidir. |
| **Profil kilidi altından shared-cache kilidi alınmaz** | Shared metadata cache kilidi, profil kilidi tutan bir bağlamın **içinden/nested** edinilmez. Gerekirse cache erişimi, profil kilidi bırakıldıktan sonra (sıra kuralını ihlal etmeyecek ayrı kritik bölümde) veya tasarımca açıkça tanımlanmış, deadlock içermeyen ayrı bir fazda yapılır. Bu kural A1 tasarımına yazılı olarak işlenmelidir. |
| Manifest ve cache | Manifest operasyonları shared metadata cache içeriğini değiştirmez; bu iki kilit aynı kritik bölümde birleştirilmez (gereksiz tutma yok). |

### 2.4 Güvenlik ve izolasyon

- Manifest/lock hataları Taste scope’unda **fail-fast** ve teşhis edilebilir olmalıdır; Taste dışı özellikler etkilenmemelidir.
- Otomatik onarım, sessiz yeniden eşleme, zorla kilit çalma yoktur.

## 3. R2-A1 test kabul kriterleri (yazılı checklist)

R2-A1 kodlaması/PR’ı, aşağıdaki kabul kriterleri için test planı ve (uygulama aşamasında) kalıcı otomatik testler tanımlanmadan “tamamlandı” sayılamaz. Bu belge testleri çalıştırmaz; kriterleri ön koşul olarak sabitler.

### 3.1 Kimlik ve path güvenliği
- [ ] Kanonik `profileId` doğrulaması: boş değer, trim-sonrası boş, `.`/`..`, yol ayıracı (`/` `\`), null/control karakterler ve traversal riski taşıyan girdiler **fail-fast** reddedilir.
- [ ] Reversible token (Base64URL, padding’siz, sabit `scheme`) kayıpsız encode/decode sağlar; sanitize/replace tek başına kimlik üretmez.
- [ ] Çözümlenen profil yolu taste kökü içinde kalır (kök sınırı/escape yok).

### 3.2 Mapping manifest doğruluğu ve bütünlüğü
- [ ] Manifest formatı sürümlü ve alanları tutarlıdır (`version`, `scheme`, `entries`, `byDir`); `entries` ↔ `byDir` **birebir** eşleşir.
- [ ] Çakışma (aynı canonical id farklı dir / aynı dir farklı id), tutarsızlık veya şema/sürüm uyumsuzluğu **fail-fast** hata üretir; otomatik onarım/yeniden eşleme/sessiz fallback yoktur.
- [ ] Güncelleme kilit altında doğrula → güncelle → atomik yazım sırasıyla yapılır; kısmi/tutarsız kayıt bırakılmaz.

### 3.3 Eşzamanlılık ve ilk oluşturma
- [ ] Manifest yokken eşzamanlı ilk erişimde yarışsız, tek yazar, kilitli ve doğrulamalı oluşturma sağlanır.
- [ ] Global mapping-manifest kilidi ayrı scope’tur ve §2.2 edinim sırasına uyumludur.

### 3.4 Bozuk veri ve hata davranışı
- [ ] Bozuk/uyumsuz manifest (parse/doğrulama hatası, `corrupt_unrecoverable` senaryosu) Taste işlemlerini güvenli biçimde durdurur ve teşhis edilebilir hata üretir.
- [ ] Bozuk/okunamaz lock dosyası stale sayılmaz (fail-closed).
- [ ] Otomatik onarım yok; Taste dışı akışlar etkilenmez.

### 3.5 Uyumluluk ve regresyon
- [ ] R2-A1 değişiklikleri mevcut `TASTE_PATHS`/IO çağıranlarının beklenen davranışını kırmaz veya uyumluluk yüzeyi açıkça tanımlanır; gereksiz imza kırılımı A2+’ya ertelenir.
- [ ] Legacy taste yazımı/taşıması bu adımda tetiklenmez; A1 tek başına izolasyon altyapısıdır (davranış koruyucu).

### 3.6 Denetim/rapor koşulları (P2/P3 kapatılmadan kodlama yok)
- [ ] Heartbeat/lease yenileme davranışı (§1) ve kilit birlikte-tutma/edinim kuralları (§2) tasarımda yazılıdır.
- [ ] PR #30 P3 rapor düzeltmeleri (§4) ilgili raporlarda veya bu koşul belgesiyle izlenebilir biçimde netleştirilmiştir.

## 4. Ajan 1 (PR #30) rapor düzeltmelerinin uygulanması

PR #30 denetimi, PR #29 raporunun gerçek master koduyla **büyük ölçüde tutarlı** olduğunu; **yanlış iddia** bulunmadığını, ancak aşağıdaki düzeltme/netleştirmelerin A1 öncesi işlenmesi gerektiğini belirtmiştir. Bu koşul belgesi bu maddeleri kesinleştirir:

| # | P | PR #29’daki ifade | Düzeltilmiş/netleştirilmiş ifade |
|---|---|---|---|
| 1 | P3 | §2.2 satır referansları: `configureTasteHydration ~189`, `scheduleTasteMetadataHydration ~248`, `performRebuildOnce ~410`, `triggerTasteProfileRebuild ~471`, `ensureInitialTasteBootstrap ~490+` | **Düzeltilmiş referanslar (master@2ffe4bf):** `configureTasteHydration` **144**, `scheduleTasteMetadataHydration` **172**, `performRebuildOnce` **431**, `triggerTasteProfileRebuild` **494**, `ensureInitialTasteBootstrap` **519** (~25–75 satır sapması; A1 öncesi düzeltilmelidir). |
| 2 | P3 | §3 kullanım noktası listesinde `src/services/taste-api.ts` | **Düzeltme:** `src/services/taste-api.ts` içinde `TASTE_PATHS`/taste dosya yolu kullanımı yoktur; yalnızca BroadcastChannel adı `cinetrack-taste-profile-sync` (:22) bulunur. Bu bir **dosya yolu kullanım noktası sayılmamalıdır**. |
| 3 | P3 | §2.1/§8.3 “Bozuk events testi beklentisi ile `readTasteEvents` davranışı uyumsuz” | **Netleştirme:** İlgili test bağımsız çalıştırmada geçer (`npx tsx --test tests/taste/taste-store.test.mjs` → 9 pass, 0 fail). `readTasteEvents` backup-recovery kullanır (taste-store.ts:241-246) ve testteki önceki `writeTasteEvents([])` çağrısı `.bak` bırakır; bu nedenle bozuk dosya “recovered” statüsüyle boş diziye döner. Durum **uyumsuzluk değil, gizli `.bak` bağımlılığı/kırılgan test**tir: backup yokluğunda test `CorruptJsonFileError` alırdı. R2-A1 kapsamında davranış kazara değiştirilmemeli; test kırılganlığı açıkça belgelenmeli. |
| 4 | P3 | §4.2 manifestte `entries`/`byDir` ilişkisi | **Netleştirme:** `entries` ve `byDir` **birebir ve türetilmiş/tutarlı** tutulmalıdır; biri diğerinden bağımsız “serbest” veri olamaz. Eşleşme bozulursa bu tutarsızlık sayılır ve fail-fast uygulanır. |

**Ek denetim notu:** PR #30, raporun §5.2 kilit hiyerarşisini doğru bulmuş; ancak manifest-profil birlikte tutma semantiği ve “profil kilidi altından shared-cache kilidi alınmaz” kuralının A1 tasarımına yazılması gerektiğini P2 olarak işaretlemiştir — bu belge §2 ile bu koşulu karşılar.

## 5. R2-A1 öncesi açık kararlar (uygulama varsayımına dönüştürülmez)

Aşağıdakiler PR #29 §8.2 ve PR #30 bulgularıyla uyumlu biçimde, kodlamadan önce yazılı karar/onay gerektirir:

1. Nihai `profileIdSafe` şeması/kodlama parametreleri ve kabul edilen maksimum kanonik uzunluk.
2. Manifest kesin konumu, alan adları ve sürüm/şema geçiş politikası.
3. Lock timeout/backoff/lease süreleri ve stale meta veri alanlarının kesin değerleri (bu belgede tanımlanan davranış kurallarıyla uyumlu).
4. S1/S2/S3 canlı veri kanıtı ve S1 onaylı kopya kararı.
5. S3/belirsiz legacy verinin kullanıcıya sunum politikası (yanlış atfetme yok).
6. R2-A1 PR kesimi ve `TASTE_PATHS/resolveTastePaths` uyumluluk stratejisi.

## 6. Sonuç

R2-A1 kodlaması, bu belgede tanımlanan **heartbeat/lease yenileme davranışı**, **kilit edinim sırası ve birlikte tutma kuralları** ve **test kabul kriterleri** yazılı tasarımın parçası haline getirilmeden ve PR #30 P3 düzeltmeleri izlenebilir biçimde karşılanmadan başlatılmamalıdır. Bu belge, PR #29 ve PR #30’u temel alır; uygulama, doğrulama çalıştırması veya davranış değişikliği içermez.

---
*Kaynaklar: `docs/mia/faz5-r2-a1-teknik-hazirlik.md` (PR #29), `docs/mia/faz5-r2-a1-bagimsiz-denetim.md` (PR #30). Doğrulanamayan bilgiler varsayım olarak ele alınmamalı; gerekli kararlar açıkça netleştirilmelidir.*
