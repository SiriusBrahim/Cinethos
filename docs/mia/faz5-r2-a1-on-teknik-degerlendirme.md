# MIA Faz 5 — R2-A1 Öncesi Bağımsız Teknik Değerlendirme (Master Kod Temelli)

**Denetçi:** Ajan 1 (bağımsız test/CI doğrulama sorumlusu)
**Tarih:** 2026-11-17
**Denetim tabanı:** `origin/master` @ `2ffe4bf82a5d512c1dafd7754498554e443c9098`
**Doğası:** Ajan 2'nin tasarımı beklemeden, yalnızca gerçek master koduna dayalı bağımsız ön inceleme. Bu belge kodlama izni değildir; Ajan 2'nin tasarımı geldiğinde madde madde karşılaştırılabilir bağımsız referans çerçevesidir. Kod/test değişikliği yapılmamıştır.

---

## 1. A1 kapsamındaki dosya ve fonksiyon envanteri

### 1.1 Doğrudan değişecek/uzatılacak dosyalar

| Dosya | İlgili öğe | Konum | A1'deki rol |
|---|---|---|---|
| `src/server/taste-store.ts` | `TasteStorePaths` | :30-37 | Profil bazlı yol şemasının temeli |
| `src/server/taste-store.ts` | `resolveTastePaths(dataDir)` | :39-58 | Profil parametresi genişletilecek (PR #29 §3; uyumluluk yüzeyi korunmalı) |
| `src/server/taste-store.ts` | `TASTE_PATHS` (global sabit) | :61 | Legacy kalacak; yeni yazım buna yapılmamalı |
| `src/server/taste-store.ts` | `withCrossProcessTasteLock(dataDir, task)` | :118-172 | Scoped lock + lease/heartbeat altyapısına genişletilecek |
| `src/server/taste-store.ts` | `serializeTasteWrite(dataDir, task)` | :184-190 | Profil bazlı serileştirme anahtarına genişletilecek |
| `src/core/cinetrack-core.ts` | `PROFILE_ID_PATTERN` | :717 | Kanonik profil kimliği sözleşmesi (A1 girdi doğrulamasının otoritesi) |
| `src/server/atomic-json.ts` | `writeJsonFileAtomicAsync` | :270 | Manifest atomik yazımı için mevcut primitif |
| `src/server/atomic-json.ts` | `CorruptJsonFileError` | :20 | Manifest bozulma hatası sözleşmesi |
| `src/server/taste-metadata-hydrator.ts` | `resolveTasteMetadataCachePath` | :44-47 | Shared cache kilit kapsamı (A1'de yalnızca kapsam tanımı; davranış A2) |

### 1.2 Uyumluluk yüzeyi (kırılmaması gerekenler)

- **`resolveTastePaths`/`TASTE_PATHS` üretimde taste-store.ts DIŞINDA kullanılmıyor** (bağımsız grep doğrulaması: `taste-routes.ts`, `taste-rebuild-coordinator.ts`, `taste-service-adapter.ts`, `app.ts` içinde sıfır eşleşme; `taste-api.ts` içinde yalnızca BroadcastChannel adı :22). Uyumluluk riski **yalnızca testlere** odaklı: `tests/taste/taste-store.test.mjs` (:15, :30-31, :134, :189, :198) ve `tests/taste/taste-store-integration.test.mjs` (:19, :164-198) `TASTE_PATHS`'i doğrudan kullanıyor.
- Taste store'un üretim tüketicileri: `taste-rebuild-coordinator.ts`, `taste-routes.ts`, `taste-service-adapter.ts`, `app.ts` — hepsi store'un public fonksiyonlarını çağırıyor; imza kırılmaması hedefi (PR #29 §6) bu 4 dosyada doğrulanmalı.
- Mevcut kilit: `.taste.lock`, token `pid:ts:uuid` (:135), timeout 10s (:109), stale 15s (:108), `wx` atomik oluşturma (:137), token eşleşmeli bırakma (:163-168).

## 2. Bağımsız uygulama riskleri

### R-1 — P1: Mevcut stale-lock mantığında canlı kilit çalma penceresi var
- **Kanıt:** `taste-store.ts:152-156` — `ageMs > 15_000` **veya** holder PID ölü ise `unlink` + `continue`. Yaş kriteri tek başına, heartbeat/lease olmadan, 15 saniyeden uzun süren meşru bir işlemin kilidini **çalabilir**.
- **Etki:** A1'in "zorla çalma yok" (PR #32 §1) koşulu, mevcut davranışla çelişir; A1 scoped lock'u bu davranışı devralırsa koşul baştan ihlal edilir.
- **Önerilen çözüm:** A1 scoped lock'unda `expiresAt` (lease) + ownerToken doğrulamalı stale tespiti; yaş bazlı tek kriterli unlink kaldırılmalı. Legacy `.taste.lock` davranışı A1'de dokunulmadan bırakılabilir (kapsam ayrımı net tanımlanmalı).

### R-2 — P1: Stale unlink → yeniden sahiplenme yarışı çifte sahiplik üretebilir
- **Kanıt:** `taste-store.ts:150-157` — iki bekleyen süreç aynı anda stale görüp `unlink` çağırabilir; `unlink` hatası sessizce yutulur (`catch(() => undefined)`) ve her ikisi `continue` ile `wx` oluşturmaya gider. A süreci silip B süreci yeni kilit oluşturduktan sonra A'nın `open(wx)`'ı EEXIST alır — bu senaryoda güvenli; ancak A'nın unlink'i B'nin **henüz token yazmamış** yeni kilidine denk gelirse `readFile` boş döner, `holderPid=NaN` olur ve yaş kriteriyle B'nin kilidi silinebilir (:149-156 + :163'teki `!current` koşulu).
- **Etki:** Çifte sahiplik → Taste dosyalarında yarış yazımı.
- **Önerilen çözüm:** A1'de atomik sahiplenme: unlink yerine `rename`-tabanlı takeover (stale kilidi benzersiz adla taşındıktan sonra token doğrulayarak) veya token-koşullu silme; "boş içerik = stale" çıkarımı kaldırılmalı.

### R-3 — P1 (YENİ, önceki raporlarda yok): Base64URL büyük/küçük harf duyarlılığı case-insensitive dosya sistemlerinde dizin çakışması üretir
- **Kanıt:** `PROFILE_ID_PATTERN` (:717) hem büyük hem küçük harfe izin verir (`profile-[A-Za-z0-9_-]{1,60}`); Base64URL çıktısı büyük/küçük harf duyarlıdır. macOS (APFS varsayılan) ve Windows dosya sistemleri case-insensitive'dır. `profile-Abc` ve `profile-abc` farklı Base64URL dizin adları üretir ama aynı fiziksel dizine düşebilir.
- **Etki:** Profil izolasyonunun sessiz bozulması — iki farklı profil aynı dizini paylaşır; manifest `byDir` doğrulaması bunu ancak **çakışma oluştuğunda** yakalar, önlemez.
- **Önerilen çözüm:** Dizin adına case-duyarlılığı koruyan bileşen eklenmeli (ör. içerik-hash soneki) veya manifest ilk oluşturmada case-normalize edilmiş dizin adı benzersizliği zorunlu tutulmalı; bu, PR #32 §3.2'deki çakışma kriterinin ötesinde **proaktif** bir gerekliliktir. Karar Ajan 2'nin tasarımına bırakılır; ancak risk mutlaka tasarımın gündeminde olmalıdır.

### R-4 — P2: `resolveTastePaths`'in `dataDir === "data"` özel durumu ve kilit yolu türetmenin çift tanımı
- **Kanıt:** `taste-store.ts:40` (özel durum) ve :120-122 (kilit `tasteDir`'i ayrı hesaplanıyor). İki ayrı yol türetme mantığı profil bazlı genişlemede sapma riski taşır.
- **Önerilen çözüm:** A1'de tek bir yol çözümleme fonksiyonuna indirgenmeli; kilit yolu da aynı çözümlayıcıdan türetilmeli.

### R-5 — P2: `serializeTasteWrite` anahtarı dataDir bazlı; profil bazlı yazımda uyarlanmalı
- **Kanıt:** `taste-store.ts:184-190` — `path.resolve(dataDir)` anahtarlı süreç içi FIFO. Profil bazlı yazımda (a) tek dataDir anahtarı farklı profilleri gereksiz seri hale getirir, (b) `tasteWriteChains` Map'i hiç temizlenmez (uzun ömürlü süreçte büyür).
- **Önerilen çözüm:** A1 altyapısı anahtar şemasını `(dataDir, profileIdSafe)` bazına hazırlamalı; Map temizleme (completed-chain silme) eklenmeli.

### R-6 — P2: Mevcut taste testleri gerçek `data/` dizinine yazıyor
- **Kanıt:** `tests/taste/taste-store.test.mjs:30-31,134,189,198` — `TASTE_PATHS` üzerinden gerçek repo `data/` yoluna yazım; ayrıca bilinen gizli `.bak` bağımlılığı (PR #30/PR #32 §4.3).
- **Etki:** A1 testleri bu deseni kopyalarsa profil dizinleri gerçek `data/` altında birikir; izolasyon bozulur.
- **Önerilen çözüm:** A1 testleri geçici `dataDir` kullanmalı; mevcut testlerin gerçek-yol yazımı ayrı teknik borç olarak raporlanmalı (davranış A1'de değiştirilmemeli).

### R-7 — P2: Manifest bozulması tüm Taste işlemlerini durdurur — izolasyon sözleşmesi test edilmeli
- **Kanıt:** Tasarım kararı (PR #32 §3.4) fail-fast öngörüyor; mevcut izolasyon deseni `CorruptJsonFileError` (:20) + Taste dışı akışların etkilenmemesi.
- **Önerilen çözüm:** A1 kabul kriterine "manifest bozukken Taste dışı özelliklerin (kütüphane, sync, arka plan) çalışmaya devam ettiği" negatif testi eklenmeli.

### R-8 — P3: Kilit oluşturma ile token yazımı arasında boş dosya penceresi
- **Kanıt:** `taste-store.ts:137-142` — `open(wx)` sonrası token yazımı ayrı adım; bu pencerede diğer süreç boş içerik okur.
- **Önerilen çözüm:** A1'de tek yazımda oluşturma (içeriği open anında yazma) veya boş içerik için bekleme/kısa yeniden deneme.

### R-9 — P3: `TASTE_PATHS` kullanan testlerde sabit dosya adı iddiaları
- **Kanıt:** `taste-store-integration.test.mjs:184-198` — `cinetrack-taste-*.json` adları sabit doğrulanıyor. A2'de profil bazlı yollara geçişte bu testler güncellenecek; A1'de imza korunması bu testlerin yeşil kalmasıyla kanıtlanmalı.

## 3. Gerekli otomatik testler ve kabul kriterleri (öneri — Ajan 2 tasarımıyla karşılaştırılacak)

Aşağıdaki liste A1 uygulama PR'ının test planında yer almalıdır; bu denetimde kod yazılmamıştır.

### TC-1 Kimlik kodlama (Base64URL)
- Geçerli tüm `PROFILE_ID_PATTERN` kimlikleri için `decode(encode(x)) === x` roundtrip.
- Padding'siz Base64URL; `+`, `/`, `=` karakterlerinin çıktıda bulunmaması.
- Sabit `scheme` alanının encode çıktısında/manifestte taşınması.

### TC-2 Fail-fast kimlik reddi
- `""`, `"   "`, `"."`, `".."`, `"a/b"`, `"a\\b"`, null/undefined, kontrol karakterleri, desen dışı kimlikler, maksimum uzunluk aşımı → tekdüze, teyis edilebilir hata; sanitize/replace ile kimlik **üretilmemeli**.

### TC-3 Yol sınırlaması
- Çözümlenen dizin her zaman `<dataDir>/taste/profiles/` kökü içinde (`path.resolve` + prefix kontrolü); escape yok.

### TC-4 Manifest bütünlüğü
- `entries` ↔ `byDir` birebir eşleme; bozuk/eksik/uyumsuz sürüm manifest → fail-fast, otomatik onarım/yeniden eşleme yok.
- Çakışma: aynı canonical id → farklı dizin; aynı dizin → farklı id; **aynı dizin adının case-duyarlı çakışması (R-3)** → proaktif reddedilmeli.

### TC-5 Eşzamanlılık
- Manifest yokken N eşzamanlı çözümleme → tek manifest, tek dizin eşlemesi, yarışsız ilk oluşturma (global mapping-manifest kilidi altında).
- İki profilin eşzamanlı işlenmesi → global kilidin gereksiz kilitlenme yaratmadığının kanıtı.

### TC-6 Scoped lock davranışı
- Karşılıklı dışlama, timeout'da teyis edilebilir hata, backoff ile yeniden deneme.
- Lease: yalnızca sahibin (`lockId/ownerToken` eşleşmesiyle) yenilemesi; eşleşmezken yenileme reddi; lease dolunca **zorla çalma yok**, bekleyen timeout/backoff hatası alır (R-1 düzeltmesi kanıtı).
- Bozuk/okunamaz lock dosyası → stale sayılmaz, fail-closed (R-2 düzeltmesi kanıtı).
- Bırakma: yalnızca token hâlâ sahibe aitse; token değişmişse bırakma yok.

### TC-7 Legacy davranış korunumu
- `resolveTastePaths(dataDir)` profil parametresiz → mevcut legacy yollar; `TASTE_PATHS` değişmez.
- A1 dalında `npm test` 511/511, `npm run test:taste` 355/355, `tests/taste/taste-store.test.mjs` tekil 9/9.
- A1'in legacy global taste dosyalarına **yazmadığının** byte-düzeyi kanıtı (test öncesi/sonrası checksum).

### TC-8 İzolasyon ve kilit sırası
- Manifest bozukken Taste dışı akışlar çalışmaya devam eder (R-7).
- Edinim sırası manifest → profil → cache; profil kilidi altından shared-cache kilidi **alınmaz** (PR #32 §2.3 kuralının davranışsal/statik kanıtı).
- Manifest+profil birlikte tutma gerektiren operasyon listesi A1 tasarımında yazılı ve testle eşleşir.

### Kabul kriterleri (özet)
1. TC-1…TC-8'in tamamı kalıcı `tsx --test` testleri olarak `npm test` kapsamında.
2. Mevcut tüm test sayıları korunur; gevşetme/atlama yok.
3. PR #32 §3 checklist'inin her maddesi bir TC maddesiyle eşlenir (izlenebilirlik tablosu PR açıklamasında).
4. Üretim davranış değişikliği yok: legacy yollar, mevcut `.taste.lock` davranışı ve 4 üretici tüketici imzaları korunur.

## 4. Bağımsız değerlendirme özeti

| Konu | Değerlendirme |
|---|---|
| A1'in teknik olarak uygulanabilirliği | **Uygulanabilir** — gerekli primitifler mevcut (`wx` atomik oluşturma, `writeJsonFileAtomicAsync`, FIFO serileştirme, PROFILE_ID_PATTERN) |
| Uyumluluk yüzeyi | **Dar ve yönetilebilir** — `TASTE_PATHS`/`resolveTastePaths` üretimde taste-store dışında kullanılmıyor; risk testlerde |
| En kritik bağımsız riskler | R-1 (canlı kilit çalma), R-2 (unlink yarışı), R-3 (case-insensitive FS çakışması — yeni bulgu) |
| Ajan 2 tasarımıyla karşılaştırma | Bu rapor §2'deki 9 risk ve §3'teki test envanteri, Ajan 2'nin A1 tasarımı geldiğinde madde madde karşılaştırılacak; tasarım bu riskleri kapsamıyorsa eksik olarak işaretlenecek |
| Kodlamaya geçiş | Bu rapor tek başına izin değildir; R2-A1 geçiş kararı PR #30/PR #33 zincirindeki koşullarla birlikte değerlendirilmelidir (PR #31 merge ön koşulu hâlâ açık) |

## 5. Sınırlar

Bu denetim salt okunur inceleme ve raporlamadır: kod, test, şema veya CI değişikliği yapılmamış; tasarım kararı Ajan 2 adına verilmemiş; master'a push veya merge yapılmamıştır.

---

## 6. EK DENETİM — PR #35 Tasarımının Bu İncelemeyle Karşılaştırılması (2026-11-17)

**Denetlenen tasarım:** PR #35 — `docs/mia/faz5-r2-a1-tasarim.md` (Ajan 2, dal `agent-2/phase-5-r2-a1-tasarim`, HEAD `3cfc009e837b4f3e1e26b7bf4aebf58b6d530e0d`, base master, OPEN, docs-only, düz Markdown ✓).

### 6.1 Dokuz riskin tasarımda karşılanma durumu

| Risk | Tasarımdaki karşılık | Durum |
|---|---|---|
| **R-1 (P1)** canlı kilit çalma | §3.1: stale kararı yalnızca "lease dolumu + sahiplik doğrulanamaması" ile; `staleMtimeFallbackMs=15000` açıkça "yalnızca geri-uyumluluk/teşhis sinyali; stale kararı tek başına mtime'a dayanmaz" olarak indirgenmiş | **KARŞILANDI** (kural düzeyi) — tek eksik: legacy `.taste.lock`'un yaş-bazlı çalma davranışının A1'de dokunulmadan bırakılıp bırakılmadığı açıkça yazılmamış (P3) |
| **R-2 (P1)** unlink yarışı / çifte sahiplik | §3.1: "yalnız bu durumda atomik yeniden sahiplenme denenebilir" + bozuk lock fail-closed | **KISMEN** — atomik sahiplenme **mekanizması** belirtilmemiş (rename-tabanlı mı, token-koşullu silme mi?); boş-token penceresi (R-8) ayrıca ele alınmamış (P2) |
| **R-3 (P1)** case-insensitive FS çakışması | Tasarımda **hiç geçmiyor** (§1.2 yalnızca manifest otoritesi + aynı id/dir çakışma kuralı) | **KARŞILANMADI** — aşağıda somut karşı örnek kanıtlandı (§6.2). Tasarımın gidermesi zorunludur (P1) |
| **R-4 (P2)** çift yol türetme | §2.1 manifest yolu her iki dataDir durumu için tanımlı; §6.2 `resolveTasteProfileMapPath` | **KISMEN** — `resolveTastePaths` özel durumu (:40) ile kilit `tasteDir` türetmesinin (:120-122) tek fonksiyonda birleştirileceği açıkça yazılmamış (P3) |
| **R-5 (P2)** serileştirme anahtarı + Map büyümesi | §6.2 scope anahtarları tanımlı (`__profile-id-map__`, `profile:<dir>`, `shared-metadata-cache`) | **KISMEN** — süreç içi FIFO anahtar şemasının profil bazına uyarlanması ve `tasteWriteChains` temizliği adreslenmemiş (P3, A2 hazırlığı) |
| **R-6 (P2)** testlerin gerçek `data/`'ya yazması | §6.4: bu turda test değişikliği yok; checklist A1'de testlere dönüşecek | **KISMEN** — A1 test planında **geçici dataDir zorunluluğu** açıkça ifade edilmemiş (P3) |
| **R-7 (P2)** manifest bozukluğu izolasyonu | §2.3: fail-fast + "Taste dışı akışlar etkilenmez" | **KARŞILANDI** (tasarım düzeyi) — kalıcı izolasyon testi A1'de zorunlu |
| **R-8 (P3)** boş-token penceresi | Adreslenmemiş | **KARŞILANMADI** (P3) — A1 uygulama detayı olarak netleştirilmeli |
| **R-9 (P3)** sabit dosya adı testleri | §6.3: `TASTE_PATHS` legacy kalır, kaldırma A2+ | **KARŞILANDI** — mevcut integration testleri yeşil kalmaya devam eder |

### 6.2 R-3 doğrulaması: somut çakışma kanıtı (tasarımın en önemli eksiği)

Tasarım §1.2, Base64URL kodlamasının uzunluk sınırını doğru hesaplar (bağımsız doğrulama: 128 karakterlik kanonik id → padding'siz Base64URL 171 karakter + `p1-b64url-` öneki = 181 < 255 FS segment sınırı ✓; roundtrip + yeniden §1.1 doğrulaması kuralı ✓). Ancak **büyük/küçük harf duyarsız dosya sistemlerindeki çakışma riski tasarımda hiç ele alınmamıştır** ve risk teorik değildir — somut karşı örnek:

```
profile-AAA  →  p1-b64url-cHJvZmlsZS1BQUE
profile-AAG  →  p1-b64url-cHJvZmlsZS1BQUe

toLowerCase karşılaştırma: "chjvzmlszs1bque" == "chjvzmlszs1bque"  → AYNI DİZİN
```

Her iki kimlik de `PROFILE_ID_PATTERN` (cinetrack-core.ts:717) ile geçerlidir. macOS (APFS varsayılan) veya Windows üzerinde bu iki **farklı profil** aynı fiziksel dizine düşer → profil izolasyonu sessizce bozulur. Brute-force tarama, `profile-AA?` uzayında birden fazla çakışan çift üretti (ör. `profile-AAB` ↔ `profile-AAH`, `profile-AAa` ↔ `profile-AAg`); 300.000 rastgele id taramasında genel çakışma çıkmadı ancak desen-geçerli çiftler **deterministik olarak mevcut**.

- **Etki:** P1 — iki profilin Taste verisi aynı dizinde birleşir; manifest `byDir` doğrulaması bunu ancak çakışma **gerçekleştikten sonra** yakalar, önlemez.
- **Önerilen çözüm (tasarım §1.2/§2.2'ye eklenmeli):** Manifest ilk oluşturmada `byDir` benzersizliğini **case-normalize edilmiş** anahtar üzerinde de denetlemek (case-insensitive çakışmayı proaktif reddetmek) veya dizin adına case-duyarlılığı koruyan bileşen (ör. içerik-hash soneki) eklemek. Karar Ajan 2'nindir; ancak boşluk tasarımın giderilmeden A1 kodlamasına geçilmemelidir.
- **Zorunlu test:** Yukarıdaki `profile-AAA`/`profile-AAG` çifti fixture olarak kullanılmalı; case-insensitive çakışmada fail-fast kanıtlanmalı.

### 6.3 R-1 ve R-2 kilit güvenliği değerlendirmesi

- **R-1:** Tasarım, PR #32 §1 ile bağlayıcı heartbeat/lease kurallarını (sahiplik doğrulamalı yenileme, koşullu atomik heartbeat, lease dolumunda zorla çalma yasağı, kanıta dayalı stale, bozuk lock fail-closed, token eşleşmeli bırakma) eksiksiz devralıyor; sayısal değerler (`lockAcquireTimeoutMs=10000`, `leaseDurationMs=30000`, `heartbeatIntervalMs=10000=lease/3`) mevcut kilit timeout'u (:109) ve PR #32 §1 önerisiyle uyumlu. Kural düzeyinde **çözülmüş**; A1 uygulamasında bu kuralların gerçek koda dönüşümü testle kanıtlanmalı.
- **R-2:** "Atomik yeniden sahiplenme" taahhüdü var ama mekanizma belirsiz. Mevcut kodda unlink-sonrası-`wx` deseni (:150-157) iki bekleyenin yarışına açıktır. A1 tasarım/uygulamada mekanizmanın (ör. `rename`-tabanlı takeover veya token-koşullu silme + yeniden doğrulama) açıkça seçilmesi ve yarış testiyle kanıtlanması zorunludur. Boş-token penceresi (R-8) de aynı başlıkta ele alınmalı.

### 6.4 Tasarımda eksik kalan kararlar ve gerekli testler

1. **(P1)** R-3 case-insensitive çakışma çözümü (§6.2) + fixture tabanlı fail-fast test.
2. **(P2)** R-2 atomik sahiplenme mekanizmasının seçimi ve eşzamanlı takeover yarış testi; R-8 boş-token penceresi davranışı.
3. **(P2)** A1 test planının bu rapor §3'teki TC-1…TC-8 envanteri ve PR #32 §3 checklist'iyle **madde madde eşlendiği izlenebilirlik tablosu**; geçici dataDir zorunluluğu (R-6).
4. **(P3)** Legacy `.taste.lock` yaş-bazlı çalma davranışının A1 kapsamındaki statüsünün açıkça yazılması (dokunulmadan bırakma + A2'de lease tabanına geçiş planı).
5. **(P3)** `tasteWriteChains` profil-bazlı anahtar şeması ve temizliği (R-5, A2 hazırlığı).
6. **(Kullanıcı kararı — tasarımca doğru biçimde açık bırakılmış)** S1 canlı veri kanıtı/onaylı kopya ve S3 nihai sunum tercihi (§5/§6.5).

### 6.5 Tasarımın güçlü yönleri (bağımsız değerlendirme)

- §1.1 kanonik doğrulama, `PROFILE_ID_PATTERN` ile uyumlu sıkı alt küme; sanitize/replace yasağı doğru.
- §2.2 manifest şeması (`version/scheme/entries/byDir`, birebir türetilmiş bütünlük, fail-fast) PR #30/PR #32 koşullarıyla birebir uyumlu.
- §4 operasyon bazlı kilit tablosu, PR #32 §2.3'teki "operasyon listesi yazılmalı" koşulunu (PR #33 B3) karşılıyor; nested cache kilidi yasağı korunuyor.
- §6.3/§6.4 kapsam ayrımı (A1 davranış koruyucu, imza kırılmıyor; A2–A5 ayrımı) önceki denetimlerle tutarlı.
- PR #32 §5 açık kararlarından (1),(2),(3),(6) bu belgede kesinleştirilmiş; (4),(5) kullanıcı kararı olarak açık — doğru yaklaşım.

### 6.6 Güncellenmiş nihai karar

**APPROVED WITH CONDITIONS — R2-A1 kodlamasına geçilebilir; ancak aşağıdaki koşullar A1 uygulama PR'ında (ve R-3 için tasarım revizyonunda) karşılanmalıdır:**

1. **(P1, tasarım revizyonu)** R-3 case-insensitive çakışma çözümü PR #35 tasarımına eklenmelidir; mevcut hâliyle bu boşlukla kodlamaya başlanmamalıdır.
2. **(P2, A1 PR)** R-2 atomik sahiplenme mekanizması + R-8 boş-token penceresi netleştirilip yarış testiyle kanıtlanmalı.
3. **(P2, A1 PR)** Test planı TC-1…TC-8 + PR #32 §3 eşleme tablosuyla sunulmalı; geçici dataDir zorunlu.
4. **(P3)** Legacy lock statüsü ve FIFO anahtar şeması notları işlenmeli.
5. **(Süreç ön koşulu)** PR #31 (R1) merge edilmeli; S1/S3 kullanıcı kararları açık.

Bu ek denetim salt okunur incelemedir; PR #35 değiştirilmemiş, merge yapılmamış, master'a push yapılmamıştır.
