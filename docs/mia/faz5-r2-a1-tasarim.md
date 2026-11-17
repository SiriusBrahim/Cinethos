# MIA Faz 5 — R2-A1 Uygulama Tasarımı

**Durum:** R2-A1 uygulama tasarımının **son hâli** ve uygulama kaydı. §1–§5 tasarım kararları bu turda kesinleştirilmiş; §6 kapsamındaki A1 altyapısı aynı PR'da uygulanmış ve PR #32 §3 kabul kriterleri kalıcı otomatik testlere dönüştürülmüştür (§7). A2–A5 kapsamı bu PR'a taşınmamıştır.  
**Tarih:** 2026-11-17  
**Git tabanı:** `origin/master` @ `2ffe4bf82a5d512c1dafd7754498554e443c9098`  
**Girdi belgeleri:** PR #29 `docs/mia/faz5-r2-a1-teknik-hazirlik.md` (`15884724`), PR #30 `docs/mia/faz5-r2-a1-bagimsiz-denetim.md` (`6918ae9e`, APPROVED WITH CONDITIONS), PR #32 `docs/mia/faz5-r2-a1-uygulama-kosullari.md` (`a0959e5`), PR #33 `docs/mia/faz5-r2-a1-uygulama-kosullari-denetim.md` (`15e7f2f3`, APPROVED WITH CONDITIONS).  

## 0. Sınırlar ve uyum

- **Yapılan (bu PR):** R2-A1 altyapısı — kanonik kimlik doğrulama, `p1-b64url` kodlama, eşleme manifesti, güvenli kapsam kilidi (lease/heartbeat, atomik stale devralma, sahiplik doğrulamalı bırakma) ve PR #32 §3 kabul kriterlerinin kalıcı testleri. Uygulama davranış koruyucudur: mevcut `TASTE_PATHS`/`resolveTastePaths` ve taste IO imzaları değişmez.
- **Yapılmayacak:** Veritabanı şeması/migration, veri taşıma, GitHub sync/backup/restore/Memory Manager/Taste algoritması değişikliği, `master`’a doğrudan push/merge, başka PR'ların merge edilmesi, kapsam dışı refaktör.
- **Ertelenen (proje sonu):** Windows/macOS dosya sistemlerinin büyük-küçük harf duyarsız (case-folding) davranışından doğan dizin çakışması riski. Gerekçe: kanonik kimlik sözleşmesi (`PROFILE_ID_PATTERN`) harf duyarlıdır ve `p1-b64url` kodlaması iki farklı kanonik kimliği (örn. `p1` / `P1`) tek dizine düşürebilir. Bu risk A1'de **kapsam dışı** bırakılmıştır; kimlik sözleşmesi değiştirilmez, çakışma tespiti/çözümü proje sonundaki ayrı karara bırakılır. A1 kodunda kanonik kimlik hiçbir zaman normalize edilmez (harf katlama yok).
- **A2–A5 kapsam dışı:** Profil partition IO’nun tam yayılımı ve imza kırılımları (A2), adapter/rebuild/routes profil bağlamı ve kalıcı idempotency akışı (A3), BackgroundManager hedef profil korunumu (A4), uçtan uca doğrulama/legacy geçiş uygulaması (A5), `LibraryItemRemoved` nötralizasyonu (ayrı teknik borç).
- **Uyum notu:** PR #30 ve PR #32/PR #33 koşulları (heartbeat/lease, kilit sırası ve birlikte-tutma semantiği, A1 kabul kriterleri/checklist, PR #29 P3 düzeltmeleri) bu tasarımın bağlayıcı girdisidir. `TASTE_PATHS/resolveTastePaths` ve taste IO imzalarına geniş bağımlılık nedeniyle A1 davranış koruyucu ve uyumluluk yüzeyli tasarlanır.

## 1. `profileIdSafe` kodlama yöntemi ve uzunluk sınırı

### 1.1 Kanonik `profileId` doğrulama (giriş)

R2-A1 path/manifest katmanı, kanonik `profileId`’yi ProfileContext’in gevşek normalize’inden daha sıkı doğrular (fail-fast):

| Kural | Değer |
|---|---|
| Boşluk temizleme | Baştan/sondan boşluk trim edilir ve kanonik değer trim sonucudur; trim sonrası boş değer reddedilir. |
| Kontrol karakterleri | Kontrol karakterleri (NUL, `\n`, `\t`, DEL vb.) **trim öncesi ham değerde** reddedilir; gizli kontrol karakteri taşıyan kimlik sessizce normalize edilmez. |
| Karakter/biçim | Tek segment güvenli değerler; `.` / `..` segmentleri ve yol ayıracı (`/`, `\`) reddedilir. Nihai karakter otoritesi mevcut `PROFILE_ID_PATTERN`'dir. |
| Mevcut sözleşme uyumu | `src/core/cinetrack-core.ts` içindeki mevcut `PROFILE_ID_PATTERN` (`profile-[A-Za-z0-9_-]{1,60}` / `p\d{1,10}`) **aynen** kullanılır; kopyalanmaz, değiştirilmez, gevşetilmez. A1 doğrulaması bu sözleşmenin üzerine yalnızca trim/kontrol karakteri/uzunluk/kök sınırı korumaları ekler. |
| Maksimum kanonik uzunluk | **128 karakter** (trim sonrası). Bu üst sınır mevcut pratik kimlikleri kapsar; daha uzun değerler fail-fast reddedilir (sessiz kırpma yok). |
| Davranış | Geçersiz kimlikte otomatik sanitize/replace/yeniden adlandırma yok; teşhis edilebilir hata üretilir. |

### 1.2 Reversible token şeması

| Öğe | Karar |
|---|---|
| Yöntem | Kayıpsız reversible kodlama: kanonik `profileId` UTF-8 bayt dizisine çevrilir ve **Base64URL** (RFC 4648 §5, `-` ve `_`, **padding `=` yok**) ile kodlanır. |
| Şema kimliği | `scheme = "p1-b64url"` (manifestte sabit; çözümleme bu şemayı doğrular). |
| Dizin adı (`profileIdSafe` / `dir`) | `<scheme>-<b64url>` biçimi (örn. `p1-b64url-cHJvZmlsZS1kZWZhdWx0`). Bu ad **yalnızca dizin/manifest temsili**dir; kanonik `profileId` iş mantığında korunur (`x-cinetrack-profile-id`, ProfileContext, primary data). |
| Decode/doğrulama | `dir` → `scheme` ayrıştırılır, Base64URL decode edilir, UTF-8 string elde edilir ve §1.1 kurallarından tekrar geçirilir; encode(decode(dir)) == dir ve decode sonucu kanonik kimlikle birebir eşleşmelidir. |
| Çakışma | Reversible token tek başına yeterli değildir; eşleme otoritesi mapping manifesttir (§2). Aynı kanonik id farklı `dir` veya aynı `dir` farklı kanonik id ile eşleşemez. |
| FS sınırı | 128 karakter kanonik giriş için Base64URL çıktısı ≤ 172 karakter; şema öneki ile tek path segmenti Linux/Windows segment sınırları içinde kalır. Şema dışı/uyumsuz uzunlukta `dir` fail-fast reddedilir. |

## 2. Manifest dosyasının konumu ve şeması

### 2.1 Konum ve sahiplik

| Öğe | Karar |
|---|---|
| Kesin yol (varsayılan) | `data/taste/profiles/_profile-id-map.json` |
| `resolveTastePaths`/`dataDir` ile ilişkisi | `dataDir === "data"` ise `<repo>/data/taste/profiles/_profile-id-map.json`; aksi halde `path.join(dataDir, "taste", "profiles", "_profile-id-map.json")`. Profil partition kökü: aynı dizin altında `<taste-root>/profiles/<dir>/...` |
| Sahiplik | Taste partition erişim katmanı (store/profile-scope resolver) **tek yazar**dır. Rebuild/adapter/routes/hydrator/coordinator manifesti doğrudan yazmaz. |
| Salt-okunur ilke | Eşleme çözümleme işlemi manifesti değiştirmez; yalnızca “ilk oluşturma” veya tanımlı manifest güncelleme operasyonu (A2’deki profil-partition yaşam döngüsü kararına bağlı, A1’de API/altyapı hazır) kilitli ve atomik yazım yapabilir. |

### 2.2 Şema

```json
{
  "version": 1,
  "scheme": "p1-b64url",
  "entries": {
    "<canonicalProfileId>": {
      "dir": "<scheme>-<b64url>",
      "createdAt": "<ISO-8601>"
    }
  },
  "byDir": {
    "<scheme>-<b64url>": "<canonicalProfileId>"
  }
}
```

| Alan | Kural |
|---|---|
| `version` | Tam sayı, başlangıç `1`. Bilinmeyen/uyumsuz sürüm fail-fast (otomatik migrasyon yok). |
| `scheme` | `p1-b64url` ile birebir eşleşmeli; uyumsuz şema fail-fast. |
| `entries` | Kanonik id → eşleme nesnesi. `dir` decode edildiğinde kanonik id ile birebir eşleşmeli; `createdAt` ISO-8601 string. |
| `byDir` | `dir` → kanonik id ters indeksi. **`entries` ile birebir ve türetilmiş/tutarlı** tutulur; bağımsız serbest veri değildir. |
| Bütünlük | `entries` ve `byDir` kardinalite ve çift yönlü eşleşme kontrolünden geçer. Çakışma, eksik/fazla kayıt, şema uyumsuzluğu, kök dışı yol veya decode/doğrulama hatası fail-fast hata üretir. |

### 2.3 Atomik güncelleme, bozukluk ve sürüm politikası

- **Oluşturma/güncelleme:** Global mapping-manifest kilidi altında `oku → doğrula → değişikliği hesapla → entries/byDir’ı birlikte üret → atomik yazım` (`writeJsonFileAtomicAsync` + doğrulama) yapılır; kısmi/tutarsız kayıt bırakılmaz.
- **İlk oluşturma:** Manifest yoksa eşzamanlı erişimde yarışsız, kilitli ve doğrulamalı tek oluşturma yapılır.
- **Bozuk JSON / uyumsuz şema / `corrupt_unrecoverable`:** Taste scope’unda fail-fast ve teşhis edilebilir hata; otomatik onarım, yeniden eşleme, sessiz fallback yok. Taste dışı akışlar etkilenmez.
- **Sürüm/şema geçiş politikası:** A1 yalnızca `version=1, scheme=p1-b64url` üretir/okur. Gelecek geçiş (ör. yeni şema) ayrı, açık onaylı tasarım/migration kararı gerektirir; A1 kodu bilinmeyen sürümü sessizce dönüştürmez.

## 3. Lock ve lease süreleri (sayısal parametreler)

Parametreler taste scope’lu kilit altyapısında sabit/adlandırılmış yapılandırma olarak tasarlanır (A1’de değerler kesinleştirilir; uygulama detayı A2’ye yayılabilir). Amaç: PR #32 §1 davranış kurallarıyla uyumlu, test edilebilir ve teşhis edilebilir zamanlama.

| Parametre | Değer | Açıklama |
|---|---:|---|
| `lockAcquireTimeoutMs` | `10000` | Bekleyen prosesin kilit edinme toplam süresi (mevcut taste lock ile uyumlu). Süre dolarsa teşhis edilebilir hata; zorla çalma yok. |
| `lockBackoffInitialMs` | `50` | İlk yeniden deneme beklemesi. |
| `lockBackoffMaxMs` | `500` | Üstel/jitter’lı backoff üst sınırı. |
| `leaseDurationMs` | `30000` | Kilit `expiresAt = createdAt/heartbeat + leaseDurationMs`. |
| `heartbeatIntervalMs` | `10000` | Sahip yenileme aralığı (`≤ leaseDurationMs/3`, 30s/3=10s). Kritik bölüm kısa ise heartbeat gerekmez; uzun sürecek işlemlerde lease dolmadan yenilenir. |
| `staleMtimeFallbackMs` | `15000` | Yalnızca tanımlı geri-uyumluluk/teşhis sinyali olarak değerlendirilebilir; stale kararı tek başına mtime’a dayanmaz. |

### 3.1 Heartbeat/lease davranışı (PR #32 §1 ile bağlayıcı)

| Konu | Kural |
|---|---|
| Zorunlu lock meta alanları | `lockId`, `pid`, `hostname`, `createdAt`, `expiresAt`, `ownerToken`, `scope`. PID tek başına yeterli değildir. |
| Yenileme yetkisi | Lease’i yalnızca kilidi tutan sahip (aynı proses + dosyadaki `lockId/ownerToken/scope` eşleşmesi) yeniler. Bekleyenler uzatamaz. |
| Koşullu/atomik heartbeat | Yenileme yalnızca mevcut `lockId` ve `ownerToken` (ve scope) hâlâ sahibinkilerle eşleşiyorsa `expiresAt`’i ileri taşır. Eşleşme yoksa yenileme yapılmaz; sahip kritik bölümü güvenli biçimde sonlandırır/başarısız sayar (sessiz sahiplik devri yok). |
| Lease dolumu | Lease dolduğunda otomatik/zorla çalma yok. Bekleyen `lockAcquireTimeoutMs` + backoff ile dener; süre dolarsa teşhis edilebilir hata. Heartbeat başarısızsa bu fail-safe kabul edilebilir (sessiz yazım/çifte sahiplik yok). |
| Stale tespiti | Yalnızca kanıtlanabilir koşul: **lease dolumu** ve **sahiplik doğrulanamaması** (host/ownerToken/PID sinyalleri birlikte; PID reuse dikkate alınır). Yalnız bu durumda atomik yeniden sahiplenme denenebilir. |
| Bozuk lock | Bozuk/okunamaz lock dosyası stale sayılmaz; fail-closed, teşhis edilebilir hata, otomatik silme/onarım yok. |
| Serbest bırakma | Finally aşamasında yalnızca `lockId/ownerToken` hâlâ sahibinse bırakılır. |

### 3.2 Uygulanan kilit mekaniği (canlı kilit çalınması ve stale unlink yarışı kapalı)

| Konu | Uygulama kararı |
|---|---|
| Kilit dosyaları | Legacy/global taste yazımı geri uyumluluk için `<taste-root>/.taste.lock`; diğer kapsamlar `<taste-root>/.locks/<sanitize(scope)>-<sha256(scope)[0:12]>.lock`. Kapsam adı dosya adına güvenli biçimde çevrilir, çakışma hash ile engellenir. |
| Atomik sahiplenme | Kilit kaydı önce benzersiz bir geçici dosyaya tam olarak yazılır ve `fsync` edilir; ardından `link(temp, lock)` ile atomik olarak yayınlanır (`EEXIST` → kilit dolu). Böylece kilit dosyası hiçbir an yarım/boş içerikle görünmez ve `wx` + sonradan yazma yarışı ortadan kalkar. |
| Canlı kilidin çalınmaması | Stale kararı **yalnızca** `isTasteLockProvablyStale` ile verilir: `expiresAt <= now` **ve** sahiplik doğrulanamıyor (aynı host'ta PID ölü veya PID bu süreç). Lease dolmamışsa PID ölü görünse bile kilit **canlıdır**, çalınmaz; bekleyen `lockAcquireTimeoutMs` sonunda teşhis edilebilir `taste_lock_timeout` alır (hata mesajı kapsam, dosya, mevcut sahip pid/host/expiresAt içerir). |
| Stale unlink yarışı | Koşulsuz `unlink` kaldırıldı. Devralma **rename-then-verify** ile yapılır: kilit dosyası benzersiz karantina adına atomik `rename` edilir (tek kazanan), taşınan kaydın `lockId`'si beklenen stale kayıtla eşleşirse karantina silinir ve yeni kilit normal yolla alınır. `lockId` farklıysa (araya canlı bir sahip girmişse) kayıt geri konur ve **devralma yapılmaz**; sahiplik sessizce devredilmez. |
| Bırakma yarışı | `release()` de oku-ve-sil yerine `rename` + sahiplik (`lockId`/`ownerToken`/`scope`) doğrulaması kullanır: taşınan kayıt bize aitse silinir, değilse geri konur. Canlı bir sahibin kaydı asla silinmez. |
| Heartbeat atomikliği | Yenileme öncesi diskteki kayıt `lockId`/`ownerToken`/`scope` ile karşılaştırılır; eşleşmezse yenileme yapılmaz, `lost` işaretlenir ve `withScopedTasteLock` görev başarılı görünse bile `taste_lock_lost` fırlatır (sessiz çifte sahiplik/başarı yok). |
| Bozuk kilit | Parse/şema hatası `taste_lock_corrupt` ile fail-closed; dosya silinmez/onarılmaz. Boş (0 bayt) kilit dosyası da bozuk sayılır — yarım yayın penceresi stale olarak yorumlanmaz (R-8). |
| Süreç içi FIFO | Aynı `(dataDir, scope)` için süreç içi kuyruk korunur; iş bitince zincir `Map`'ten silinir (R-5). Farklı kapsamlar (manifest / profil / shared cache / legacy) birbirini kilitlemez; iki farklı `profile:` kapsamı eşzamanlı tutulabilir. |
| Legacy `.taste.lock` statüsü | Eski sürümün yaş bazlı (`>15s` veya ölü PID → koşulsuz `unlink`) çalma mantığı **kaldırıldı**; aynı dosya adı yeni kayıt biçimiyle kullanılır. Eski sürümden kalan `pid:ts:uuid` token'ı okunabilir kalır (geri uyumluluk): bu kayıtta lease yoktur, sahte bir lease uydurulmaz ve **yaş asla stale kanıtı değildir**; devralma yalnızca PID ölüyse (aynı host varsayımı) yapılır. A2'de legacy kapsam da tamamen lease tabanına taşınacaktır. |
| Kapsam sırası | Zorunlu sıra manifest → profil → shared cache. A1'de profil kilidi alındığında shared-cache kilidi örtük olarak alınmaz; ters yönde (cache altında profil) edinim yasaktır. |

## 4. Manifest ve profil kilitlerinin birlikte tutulacağı operasyonlar

PR #32 §2.3 gereği operasyon bazında liste:

| # | Operasyon | Gerekli kilit(ler) | Birlikte tutma / sıra notu |
|---|---|---|---|
| 1 | Mevcut mapping’i çözümleme (salt okuma, manifest değişmiyor) | **Manifest kilidi** (okuma-kritik bölüm) | Manifest okunur/doğrulanır ve hedef `dir`/profil kökü sabitlenir. Aynı operasyonda profil IO yapılacaksa profil kilidine geçişte eşleme tutarlılığı korunur; manifest eşlemesi değişmeyecekse manifest kilidi, çözümleme tamamlandıktan sonra mümkün olan en erken noktada bırakılabilir. |
| 2 | İlk mapping oluşturma (manifest yok veya kayıt yok, yeni `entries/byDir` ekleme) | **Manifest kilidi** (ve gerekiyorsa hedef profil dizini hazırlığı aynı operasyonun parçasıysa **Manifest + Profil** geçişi) | `oku → doğrula → yoksa oluştur/güncelle → atomik yazım` manifest kilidi altında tamamlanır. Bu, eşlemeyi değiştiren operasyondur; profil partition’ın ilk dosya yazımı bu eşlemeye bağlıysa çözümleme sonucu manifest kilidi altındayken sabitlenmeli ve profil IO’su profil kilidiyle ayrı, sabit sırada yürütülmelidir. |
| 3 | Mapping doğrulama hatası / uyumsuzluk tespiti | **Manifest kilidi** (tutulana kadar) | Herhangi bir düzeltici yazım yok; fail-fast hata döndürülür, kilit kurallı bırakılır. |
| 4 | Profil-scope taste IO (events/profile/index/manifest/objections okuma-yazma, A2) | **Profil veri kilidi**; öncesinde eşleme çözümleme gerekiyorsa **Manifest kilidi** | Eşleme değişmiyorsa manifest kilidi IO’dan önce bırakılabilir; eşleme/partition kurulumu değişiyorsa §2.3 geçiş kuralı uygulanır. Aynı anda tek profil kilidi. |
| 5 | Profil-scope rebuild/bootstrap’un profil artefaktlarına yazımı (A2/A3) | **Profil veri kilidi** (+ çözümleme için gerektiğinde manifest) | Rebuild zinciri aynı hedef profil scope’u içinde serileştirilir; farklı profil kilitleri eşzamanlı tutulmaz. |
| 6 | Shared metadata cache okuma/yazma | **Shared metadata cache kilidi** | Global/shared kaynaktır. **Profil kilidi altından nested alınmaz** (PR #32 §2.3). Profil bağlamlı akışta cache erişimi, profil kilidi bırakıldıktan sonra ayrı kritik bölümde veya deadlock içermeyen ayrı fazda yapılır. |
| 7 | Manifest kilidi ve cache kilidi | Birlikte tutulmaz | Manifest operasyonları cache içeriğini değiştirmez; gereksiz tutma yok. |

**Genel sıra (zorunlu):** 1) Global mapping-manifest kilidi → 2) Hedef profil kilidi → 3) Shared metadata cache kilidi. Ters sıra yasaktır.

## 5. Legacy veriler için S1/S2/S3 davranışları

R2-A1 izolasyon altyapısı legacy veriyi sessizce taşımadan/mutate etmeden çalışmalıdır. Davranışlar yanlış atfetmeyi önler (fail-safe).

| Senaryo | Tanım | R2-A1/A2 tasarım davranışı | Not / karar |
|---|---|---|---|
| **S1 — Legacy tek/kanıtlanabilir sahip** | Mevcut global taste verisinin tek bir profile ait olduğu **canlı veri kanıtı** ile gösterilebiliyor ve kullanıcı onayı/kararı mevcut. | Kanıt ve onay kararı verilmişse, bu veri yalnızca açık, izlenebilir ve geri döndürülebilir şekilde ele alınacak ayrı adıma (A2/A5 planı) adaydır. **A1’de otomatik sahiplik ataması, kopyalama veya taşıma yoktur.** Kanıt/onay yoksa S1 verisi “atanmamış legacy” olarak değerlendirilir. | Canlı veri kanıtı ve onaylı kopya kararı bu tasarım turunda üretilemez; A1 öncesi/uygulama öncesi kullanıcı kararı olarak açık kalır (otomatik varsayım yok). |
| **S2 — Çakışmayan ayrı legacy veri** | Farklı profillere ait olabileceği ayrışan ancak çakışmayan legacy izleri. | **Salt-okunur** kabul edilir; mevcut global dosyalar hedef profil partition yazımlarıyla karıştırılmaz. Otomatik birleştirme, bölme veya profil ataması yapılmaz. Açık migration kararı (ayrı adım, onaylı) olmadan profil partition’a aktarılmaz. | Eski/global artefaktlar A1/A2’de yazım hedefi yapılmaz. |
| **S3 — Çakışan/belirsiz legacy veri** | Sahipliği belirsiz, çakışan veya güvenle atfedilemeyen veri. | **Yanlış atfetme yasaktır.** Veri hiçbir profile sessizce bağlanmaz; profil-bazlı görünümde “belirsiz/eski (legacy) veri” olarak ayrı ve açık biçimde sunulmalı veya profil görünümünden dışlanmalıdır (hangisi uygulanacaksa UI/okuma politikası olarak net seçilmelidir). Otomatik seçim/heuristic atama yok. | Sunum politikası: belirsizlik açıkça etiketlenir ve kullanıcıyı yanlış yönlendirmez; profil-özel metriklere karıştırılmaz. Nihai sunum tercihi (etiketli ayrı gösterim vs. dışlama) A1 uygulama arayüzü/okuma katmanı kararıyla kesinleşir; bu tasarım “yanlış atfetme yok + belirsizlik görünür” ilkesini zorunlu kılar. |

## 6. A1 dosya ve fonksiyon kapsamı (uygulama kaydı)

### 6.1 Amaç ve kapsam özeti

R2-A1, profil kimliği güvenliği, reversible eşleme, mapping manifesti, güvenli profil-scope path çözümleme ve global manifest kilidi/lock altyapısı için **tasarım ve uygulama sınırını** tanımlar. Hedef: mevcut davranışı bozmadan A2’nin üzerine inşa edebileceği uyumluluk yüzeyi sağlamak.

### 6.2 Dahil (tasarım/uygulama adayı dosya ve sorumluluklar)

| Dosya / yüzey | A1’de dahil sorumluluk | Olası fonksiyon/sorumluluk birimleri (tasarım) |
|---|---|---|
| `src/server/taste-profile-scope.ts` (uygulandı) | A1 altyapısının tek üretim noktası: kanonik id doğrulama, `p1-b64url` encode/decode, manifest yolu + okuma/doğrulama/atomik yazma, ilk-oluşturma akışı, kapsam kilidi (lease/heartbeat/atomik devralma/sahipliği bırakma), profil-scope yol çözümleme ve kök sınırı denetimi. | `validateCanonicalProfileId`, `encodeProfileIdSafe`, `decodeProfileIdSafe`, `resolveTasteProfileIdMapPath`, `parseTasteProfileIdMap`, `readTasteProfileIdMap`, `readTasteProfileIdMapEntry`, `writeTasteProfileIdMap`, `ensureTasteProfileIdMapEntry`, `resolveTastePathsForProfile`, `acquireTasteLock`, `withScopedTasteLock`, `readTasteLockState`, `resolveTasteLockPath`. |
| `src/server/taste-store.ts` (uygulandı) | Davranış koruyucu entegrasyon: legacy yazım kilidi `taste-data` kapsamına devredilir (dosya adı `.taste.lock` korunur) ve A1 yüzeyi buradan yeniden dışa aktarılır. Mevcut fonksiyon imzaları/veri yolları değişmez. | `serializeTasteWrite` → `withScopedTasteLock({ scope: TASTE_LOCK_DATA_SCOPE })`; profile-scope API re-export. |
| Kapsam anahtarları | `__profile-id-map__` (global manifest), `profile:<profileIdSafe>` (A2), `shared-metadata-cache` (A2), `taste-data` (legacy global yazım). Ters sıra yasak; profil kilidi altından shared-cache kilidi alınmaz. | Sabitler: `TASTE_PROFILE_ID_MAP_SCOPE`, `TASTE_SHARED_METADATA_CACHE_SCOPE`, `TASTE_LOCK_DATA_SCOPE`. |
| `src/server/app.ts` | **Yalnız zorunluysa** minimal, davranış koruyucu resolver/başlatma uyumu (imza kırmayan). | Gerekmedikçe değişiklik yok. |

### 6.3 Uyumlu tutulacak / A1’de imza kırılmayacak yüzeyler

| Yüzey | A1 stratejisi |
|---|---|
| `resolveTastePaths(dataDir)` | Mevcut çağıranlar için global/legacy davranış korunur. Profil-scope çözümleme eklenirse ayrı, uyumlu API (örn. ek parametre veya yeni yardımcı) ile sunulur; A1’de geniş çağıran kırılımı yapılmaz. |
| `TASTE_PATHS` | Legacy/uyumluluk sabiti olarak kalır; profil-bazlı tek otorite yapılmaz. Kaldırma/değiştirme A2+ geçiş stratejisine bırakılır. |
| `append/read/writeTaste*` imzaları | Tam profil parametresi yayılımı ve partition IO A2 kapsamındadır; A1 gereksiz imza patlaması yapmaz. |

### 6.4 Dokunulmayacak / A2–A5’e bırakılacaklar

| Dosya / alan | Neden A1 dışı |
|---|---|
| `src/server/taste-rebuild-coordinator.ts` | Profil-scope chain/bootstrap/imza/hydration ve hardcoded imza yollarının uyumu A2/A3. |
| `src/server/taste-routes.ts` | Profil bağlamı aktarımı/API entegrasyonu A3; A1’de route davranışı değişmez. |
| `src/server/taste-service-adapter.ts` | Profil-bazlı dedupe/kalıcı idempotency ve hedef profil iletimi A3 (ve A4 etkileşimleri). |
| `src/server/taste-metadata-hydrator.ts` | Global shared cache path kararı korunur; shared cache kilidinin IO entegrasyonu A2, profil-bazlı hydration uyumu A3. |
| `src/core/taste/*`, `src/app/app-event-bus.ts`, `src/app/shell-events.ts`, `src/modules/background/*` | Domain/algoritma/event bus/background sözleşmeleri A1 kapsamı dışı. |
| `src/server/github-bidirectional-sync.ts`, `src/server/excel-profile-backup.ts`, `src/server/restore-journal.ts`, `src/contracts/*` | Kapsam dışı entegrasyon/sözleşme alanları. |
| `tests/**` | A1'de yalnızca R2-A1 kabul kriterlerinin kalıcı testleri eklenir (`tests/taste/taste-profile-scope.test.mjs`, `tests/taste/taste-lock.test.mjs`); mevcut taste testleri değiştirilmez. Diğer alanların testleri A2–A5 kapsamındadır. |

### 6.5 A1 kabul/denetim ön koşulları (tasarım çıktısı)

- §1–§4 kararları A1 tasarımının parçası olarak izlenebilir olmalı; PR #32 §5 açık kararlarından (1) `profileIdSafe` şema/uzunluk, (2) manifest konum/şema/sürüm politikası, (3) lock timeout/backoff/lease/değerleri, (6) `TASTE_PATHS/resolveTastePaths` uyumluluk stratejisi bu belgede kesinleştirilmiştir.
- (4) S1 canlı veri kanıtı/onaylı kopya ve (5) S3 nihai sunum tercihinin ürün/UI seçimi, yanlış atfetme yasağı korunarak kullanıcı kararıyla ayrıca sabitlenmelidir.
- R1 süreci ve PR #31 merge durumu süreç ön koşulu olarak takip edilir (PR #33 B4).

## 7. PR #32 §3 kabul kriterleri → kalıcı otomatik test eşlemesi

Kriterler iki kalıcı test dosyasına dönüştürüldü (mevcut `tests/taste/*` düzenine uygun, `--test-concurrency=1` ile uyumlu, geçici dizin kullanır):

| PR #32 kriteri | Test dosyası | Test başlığı |
|---|---|---|
| §3.1 Kanonik id: boş/trim/`.`/`..`/ayraç/kontrol/traversal reddi | `taste-profile-scope.test.mjs` | `R2-A1 — §3.1 Kanonik profil kimliği` (6 test) |
| §3.1 Reversible token kayıpsız encode/decode, sanitize değil | `taste-profile-scope.test.mjs` | `R2-A1 — §3.1 p1-b64url kodlama` (4 test; desen-geçerli kimlik uzayı taraması dahil) |
| §3.1 Çözümlenen yolun taste kökü içinde kalması | `taste-profile-scope.test.mjs` | `R2-A1 — §3.1 Profil yolu kök sınırı` (2 test) |
| §3.2 `version/scheme/entries/byDir` birebir tutarlılık | `taste-profile-scope.test.mjs` | `R2-A1 — §3.2 Manifest şeması ve bütünlüğü` (4 test) |
| §3.2 Çakışma/şema/sürüm uyumsuzluğunda fail-fast, otomatik onarım yok | `taste-profile-scope.test.mjs` | `§3.2 Manifest şeması ve bütünlüğü` + `§3.4 Bozuk manifest davranışı` |
| §3.2 Güncellemenin kilit altında doğrula→güncelle→atomik yazımı | `taste-profile-scope.test.mjs` | `R2-A1 — §3.3 Manifest ilk oluşturma ve eşzamanlılık` |
| §3.3 Manifest yokken yarışsız/tek yazar/doğrulamalı ilk oluşturma | `taste-profile-scope.test.mjs` | `§3.3 ...` (3 test, eşzamanlı 6 kimlik) |
| §3.3 Manifest kilidinin ayrı kapsam olması | `taste-lock.test.mjs` | `Legacy kapsam .taste.lock yolunu korur...`, `Farklı kapsamlar birbirini kilitlemez` |
| §3.4 Bozuk/uyumsuz manifestin teşhis edilebilir hata üretmesi | `taste-profile-scope.test.mjs` | `R2-A1 — §3.4 Bozuk manifest davranışı` (2 test) |
| §3.4 Bozuk lock dosyasının stale sayılmaması (fail-closed) | `taste-lock.test.mjs` | `R2-A1 — Bozuk kilit fail-closed` (3 test; boş dosya/yarım yayın dahil) |
| §3.4/§2.3 Bozuk manifestin Taste dışı akışları durdurmaması + yazım kapsamı | `taste-profile-scope.test.mjs` | `R2-A1 — §2.3 Bozuk manifest izolasyonu ve yazım kapsamı` (2 test) |
| §1 Eski `.taste.lock` kaydıyla geri uyum, yaş bazlı çalmama | `taste-lock.test.mjs` | `R2-A1 — Legacy .taste.lock kaydı` (2 test) |
| §3.5 `TASTE_PATHS`/IO çağıranlarının kırılmaması, legacy tetiklenmemesi | `taste-profile-scope.test.mjs` | `R2-A1 — §3.5 TASTE_PATHS / Taste API uyumluluğu` (3 test) |
| §1 Heartbeat/lease yenileme, sahiplik kaybında fail-safe sonuç | `taste-lock.test.mjs` | `R2-A1 — Lease ve heartbeat` (2 test) |
| Canlı kilidin çalınmaması (lease dolmamış) | `taste-lock.test.mjs` | `R2-A1 — Canlı kilit çalınmaz` (2 test) |
| Stale unlink yarışının kapanması / tek sahiplik | `taste-lock.test.mjs` | `R2-A1 — Stale devralma yarışsız` (3 test) |
| Kilit meta alanları ve sahiplik doğrulamalı bırakma | `taste-lock.test.mjs` | `Kilit edinilir, zorunlu meta alanlarıyla yazılır...`, `Bırakma yalnızca sahibindeyse dosyayı siler` |
| Yalnızca sahibin lease yenileyebilmesi | `taste-lock.test.mjs` | `Yenileme yalnızca sahibin kaydı üzerinde kabul edilir` |
| Kapsam izolasyonu/paralellik ve kilit sırası | `taste-lock.test.mjs` | `Farklı profil kapsamları eşzamanlı tutulabilir...`, `Profil kilidi altından shared-cache kilidi alınmaz...` |

Testler `package.json` içindeki `test:taste` komutuna eklendi.

### 7.1 PR #34 (Ajan 1) risklerinin karşılanma durumu

| Risk | Öncelik | Bu PR'daki karşılık | Durum |
|---|---|---|---|
| R-1 Canlı kilidin yaş bazlı çalınması | P1 | Yaş kriteri tamamen kaldırıldı: stale = lease dolumu **ve** sahiplik doğrulanamaması; legacy kapsamda yaş hiç kullanılmaz | Karşılandı + test |
| R-2 Stale unlink → çifte sahiplik | P1 | `link()` ile atomik yayınlama + `rename`/`lockId` doğrulamalı devralma; eşzamanlı devralmada tek kazanan testi | Karşılandı + test |
| R-3 Case-insensitive FS dizin çakışması | P1 | **Kullanıcı kararıyla proje sonuna ertelendi** (bkz. §0) — kanonik kimlik harf katlanmaz, `PROFILE_ID_PATTERN` değişmedi; ertelenen düzeltme için fixture çifti: `profile-AAA` / `profile-AAG` | Ertelendi (bilinçli) |
| R-4 Çift yol türetme | P2 | Tek `resolveTasteRoot` üzerinden çözümleme; kilit yolu da aynı kökten türetilir | Karşılandı |
| R-5 FIFO anahtarı + Map büyümesi | P2 | Anahtar `(dataDir, scope)`; iş bitince zincir `Map`'ten silinir | Karşılandı |
| R-6 Testlerin gerçek `data/`'ya yazması | P2 | Yeni testlerin tamamı geçici `dataDir` kullanır; ek olarak repo `data/` dizininin değişmediğini kanıtlayan test | Karşılandı + test |
| R-7 Manifest bozulunca izolasyon | P2 | Fail-fast; bozuk manifestte legacy store yazımının sürdüğünü kanıtlayan test | Karşılandı + test |
| R-8 Boş dosya / yarım yayın penceresi | P3 | Geçici dosya + `link` ile yayın (pencere yok); boş/bozuk dosya fail-closed | Karşılandı + test |
| R-9 Sabit dosya adı testleri | P3 | `TASTE_PATHS`/legacy yollar ve integration testleri değişmedi, yeşil | Karşılandı |

### 7.2 PR #34 §3 test envanteri (TC-1…TC-8) eşlemesi

| TC | Kapsanan test(ler) |
|---|---|
| TC-1 Kimlik kodlama | `p1-b64url kodlama` (round-trip, alfabe/padding, desen-geçerli uzay taraması) |
| TC-2 Fail-fast kimlik reddi | `§3.1 Kanonik profil kimliği` (6 test) |
| TC-3 Yol sınırlaması | `§3.1 Profil yolu kök sınırı` |
| TC-4 Manifest bütünlüğü | `§3.2 Manifest şeması ve bütünlüğü` (case çakışması R-3 kapsamı dışı — ertelendi) |
| TC-5 Eşzamanlılık | `§3.3 Manifest ilk oluşturma ve eşzamanlılık`, `Farklı profil kapsamları eşzamanlı tutulabilir` |
| TC-6 Scoped lock davranışı | `Kapsam kilidi edinme/bırakma`, `Canlı kilit çalınmaz`, `Stale devralma yarışsız`, `Lease ve heartbeat`, `Bozuk kilit fail-closed` |
| TC-7 Legacy davranış korunumu | `§3.5 TASTE_PATHS / Taste API uyumluluğu`, `Legacy .taste.lock kaydı`, repo `data/` değişmezlik testi |
| TC-8 İzolasyon ve kilit sırası | `§2.3 Bozuk manifest izolasyonu ve yazım kapsamı`, `Profil kilidi altından shared-cache kilidi alınmaz` |

## 8. Uygulama kaydı ve doğrulama (bu PR)

| Değişiklik | Ayrıntı |
|---|---|
| Yeni | `src/server/taste-profile-scope.ts`: A1 kimlik/kodlama/manifest/kilit altyapısı |
| Güncellenen | `src/server/taste-store.ts`: legacy yazım kilidi kapsam kilidine devredildi (`.taste.lock` adı ve tüm IO imzaları korunur), A1 yüzeyi re-export edildi |
| Yeni testler | `tests/taste/taste-profile-scope.test.mjs` (26 test), `tests/taste/taste-lock.test.mjs` (19 test) |
| Dokunulmayan | `taste-rebuild-coordinator.ts`, `taste-routes.ts`, `taste-service-adapter.ts`, `taste-metadata-hydrator.ts`, `src/core/taste/*`, sync/backup/restore, öneri davranışı |

**Doğrulama:** `npm run test:taste` → 400 test, 0 fail (yeni 45 R2-A1 testi dahil). `npm run lint` (eslint + `tsc --noEmit` + `tsc -p tsconfig.tests.json`) temiz. Yeni testler tekil çalıştırmada `45/45` geçer.

**Bilinçli olarak yapılmayanlar:**

- Windows/macOS case-folding çakışma tespiti/çözümü **proje sonuna ertelendi**; kanonik kimlik `PROFILE_ID_PATTERN` sözleşmesi değiştirilmedi ve hiçbir yerde harf katlanmadı.
- Profil partition IO'sunun gerçek okuma/yazma çağıranlarına bağlanması (A2), rebuild/routes/adapter bağlamı (A3), BackgroundManager (A4), uçtan uca legacy geçişi (A5) bu PR'da yapılmadı; yalnızca üzerine inşa edilecek altyapı ve uyumluluk yüzeyi sağlandı.
- S1 canlı veri kanıtı/onaylı kopya ve S3 sunum politikası (§5) kullanıcı kararı olarak açık kalır.

---
*Bu tasarım belgesi, belirtilen PR ve master kod envanteri girdilerine dayanır. Kapsam dışı kararlar varsayım yapılmadan açık bırakılmıştır.*
