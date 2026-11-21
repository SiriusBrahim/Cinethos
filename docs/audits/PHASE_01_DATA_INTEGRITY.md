# Aşama 1 — Veri Güvenliği, Bütünlüğü ve Kayıpsız Veri İşleme

**Tarih:** 21 Kasım 2026
**Dal:** `remediation/full-project-remediation` (PR #65)
**Taban:** `master` @ `c58ec49` (değişmedi)
**Kapsam:** B-01, B-02, B-04, B-05, B-06, B-07, B-08, B-09, B-14, B-31, N-02, N-04

---

## 1. Özet

Aşama 1'de kullanıcı verisinin sessizce silinmesine, kırpılmasına veya eski bir
cihaz tarafından geri diriltilmesine yol açan yollar kapatıldı. Testler artık
gerçek `data/` dizinine yazamıyor; her test koşusu öncesi/sonrası veri hash'i
karşılaştırılıyor.

| Bulgu | Konu | Durum | Commit |
|---|---|---|---|
| B-14, N-02, N-04 | Test izolasyonu, test keşfi, concurrency, `data/` hash kapısı | **FIXED** | `3b2df4e` |
| B-01, B-02 | Alan düzeyinde kayıpsız birleştirme ve eylem zamanı | **FIXED** | `3945592` |
| B-05, B-06, B-07 | Yedek şeması v4, çoklu profil, sessiz düşürme yok | **FIXED** | `be36d94` |
| B-08 | Restore revizyon koruması (409/412/428) | **FIXED** | `5e54f7b` |
| B-09, B-04 | Tombstone duyarlı veri kaybı koruması, sessiz kırpma | **FIXED** | `30eb3cb` |
| B-31 | Token dosyasının atomik ve güvenli yazımı | **FIXED** | `f4cac57` |
| A–G | Uçtan uca entegrasyon kapsamı | **FIXED** | `83ce55f` |
| B-14, B-09, B-04, B-31 | Kabul düzeltmeleri: symlink/TOCTOU, profil kapsamlı kayıp, atomik yazma hata güvenliği | **FIXED** | bu turdaki commit'ler |

Doğrulama (kabul düzeltmeleri dâhil): `npm run lint` 0, `npm run cycles` 0,
`npm test` **708/708**, `npm run test:taste` **440/440**, `npm run build`
başarılı, Playwright E2E **15/15**, `data/` hash'i değişmedi.

---

## 2. Bulgu bazında çözüm

### 2.1 B-14 / N-02 / N-04 — Testlerin gerçek veriye erişimi

**Sorun:** Testler varsayılan `data/` dizinine yazabiliyordu; `package.json`
test dosyaları elle sayıyordu; paralel koşumda çakışma ve gizli veri değişimi
mümkündü.

**Çözüm:**

- `src/server/test-data-guard.ts`: `isTestEnvironment`, `resolveDefaultDataDir`,
  `assertSafeDataDir`, `isRealUserDataPath`. Test modunda `dataDir` zorunlu;
  `<repo>/data` yolu reddedilir.
- `createDataStorage` tek nesne parametresi bekler (eski iki argümanlı çağrı
  açık hatayla reddedilir).
- `scripts/test-discovery.mjs` glob tabanlı keşif; `scripts/run-tests.mjs`
  `--test-concurrency=1` ile koşar.
- `scripts/check-data-integrity.mjs` her koşudan önce/sonra `data/` hash
  manifesti alır; değişiklik olursa test başarısız olur. CI'da da çalışır.

Kabul düzeltmesinde (bkz. 2.8) `path.resolve()` yeterli sayılmadı: sembolik
bağlantılar bileşen bileşen çözümleniyor, gerçek hedef üzerinden karşılaştırma
yapılıyor ve her yazmadan hemen önce yol yeniden doğrulanıyor.

**Kanıt:** `tests/phase1-test-isolation.test.mjs` (21 test); gerçek `data/`
sha256 `c2c163f1…` ve `473316ce…` Aşama 1 başından beri değişmedi.

### 2.2 B-01 / B-02 — Alan düzeyinde kayıpsız birleştirme

**Sorun:** Kayıt birleştirme tek bir "en yeni belge" seçimine dayanıyordu;
`addedAt` kullanıcı eyleminin güncelliğini temsil etmediği için puan silme ve
durum geri alma eski değer tarafından eziliyordu.

**Çözüm:**

- `SavedItem`'a `status_changed_at` ve `rating_changed_at` eklendi.
- `resolveItemActionTimestamps` her alan için eylem zamanını çözer:
  alan damgası → eski alan zamanı (`ratedAt`/`completedAt`/`watchedAt`) →
  `updatedAt`/`addedAt` fallback zinciri.
- `mergeTwoSavedItemsLossless` artık durum, puan, tarihler, etiketler ve
  tombstone'ları **alan bazında** birleştirir; boş puan "görüş yok" sayılır,
  açık temizleme (`personal_rating_cleared`) korunur.
- Eşit damgada deterministik ve simetrik kural: iki yön de aynı sonucu üretir.
- `operations.ts` yeni damgaları üretir; `buildLibraryItem` puan + watchlist
  isteğini `completed`'a yükseltir.

**Kanıt:** `tests/phase1-merge-lossless.test.mjs` (12 test, S1–S7 iki yön),
`docs/architecture/DATA_MERGE_POLICY.md`.

### 2.3 B-05 / B-06 / B-07 — Yedek şeması eksiksizliği

**Sorun:** Yedek yalnızca aktif profili taşıyordu; tombstone'lar ve revizyon
kayboluyordu; bilinmeyen sürüm sessizce kabul edilebiliyordu.

**Çözüm:**

- `LocalBackupDocument` v4: `profiles[]`, `activeProfileId`, profil başına
  `deleted_keys`, `revision`; eski üst düzey alanlar geriye dönük uyum için
  korunur (Seçenek A: tam belge).
- `parseBackupText` v1–v4 destekler; v4'te `profiles` zorunlu; **v5+ açık
  hatayla reddedilir** (sessiz düşürme yok); bozuk JSON `SyntaxError`.
- `useProfileBackupCoordinator` tam belgeyi reconcile/overwrite eder; tek
  profilli içe aktarma diğer profilleri silmez.
- `App.tsx` coordinator'a `profiles`, `deletedKeys`, `activeProfileId`,
  `setActiveProfileId`, `setDeletedKeys`, `setProfileName`, `persistProfiles`,
  `revision` geçirir.

**Kanıt:** `tests/phase1-backup-roundtrip.test.mjs` (15 test),
`docs/architecture/BACKUP_RESTORE_DESIGN.md`.

### 2.4 B-08 — Restore revizyon koruması

**Sorun:** `POST /api/data/restore` istemcinin dayandığı revizyonu yok sayıyor,
eşzamanlı yeni veriyi sessizce eziyordu.

**Çözüm:**

- `restoreBackupGuardedAsync` / `restoreBackupGuarded`:
  - `If-Match`, `X-Cinetrack-Base-Revision` veya `expectedRevision` ile
    doğrulama; uyuşmazlıkta **409** (rev 0'da **412**).
  - Ön koşulsuz restore mevcut veri varken **428**.
  - `forceOverwrite` yalnızca açık onayla.
- Yedek yazımdan önce doğrulanır ve mevcut belgenin güvenlik snapshot'ı alınır;
  yazım atomiktir. Hata hâlinde veri bozulmaz.
- Bozuk/eksik yedek **404** döner; hiçbir şey yazılmaz.
- Restore işlemleri serileştirilir: eşzamanlı iki restore'dan yalnızca biri
  başarılı olur.

**Kanıt:** `tests/phase1-restore-conflict.test.mjs` (5 test: depolama + HTTP).

### 2.5 B-09 — Tombstone duyarlı veri kaybı koruması

**Sorun:** Koruma yalnızca toplam kayıt sayısını karşılaştırıyordu. 60 kayıt
silen ve 61 kayıt ekleyen bir belge "normal güncelleme" gibi görünüyordu.
Tombstone kaybı, profil kaybı ve yarım belge hiç denetlenmiyordu.

**Çözüm (`src/server/storage.ts`):**

- `collectDocumentLossStats` ile benzersiz kayıt anahtarları, tombstone sayısı
  ve profil başına kayıt sayısı hesaplanır.
- Onay (`confirmBulkDelete` / `X-CineTrack-Confirm-Drop: 1`) yoksa reddedilir:
  - **`profile_drop`** — içinde kayıt olan bir profil gelen belgede yok.
  - **`tombstone_drop`** — ≥3 tombstone varken hepsi kaybolmuş (silmeler geri
    dirilebilir).
  - **`sudden_item_drop`** — benzersiz kayıtların ≥%50'si silinmiş (eklenen
    kayıtlar toplamı dengeleyip sayıyı sabit tutsa bile).
  - Eski net-sayı sezgiseli ek tetikleyici olarak korunur.
- Bilinçli toplu silme onayla geçer; onaysız silme diskteki veriyi değiştirmez.

**Kanıt:** `tests/phase1-data-loss-guard.test.mjs` (27 test: 60+11, 60+61,
profil kaybı, tombstone kaybı, boş belge, revizyon geri dönüşü, onaylı silme ve
kabul düzeltmesindeki profil kapsamlı senaryolar).

### 2.6 B-04 — Sessiz kırpmanın kaldırılması

**Sorun:** Profil/kayıt limiti aşılınca normalize `slice` ile kayıt atıyor,
geçersiz profil kimliği tüm profili düşürüyor, okunan belge bir sonraki yazımda
kırpılmış hâliyle kalıcılaşıyordu.

**Çözüm:**

- `collectDataLimitViolations` (core) ham belgeyi düşürmeden denetler: profil
  sayısı, profil başına kayıt sayısı, geçersiz profil kimliği, dizi olmayan
  kayıtlar.
- Yazma yolu ihlalde **409 `limits_exceeded`** döner ve hiçbir şey yazmaz.
- Diskten okunan belge limitleri aşıyorsa **kırpılmadan** normalize edilir
  (yüksek etkin limit) ve `limitViolations()` ile raporlanır; ihlal giderilene
  kadar yazma engellenir — böylece kırpılmış belge asla diske yazılmaz.
- Hata mesajı hangi profilin/kaydın neden reddedildiğini söyler.

**Kanıt:** `tests/phase1-data-loss-guard.test.mjs` (limit ve geçersiz kimlik
testleri).

### 2.7 B-31 — Token dosyasının atomik yazımı

**Sorun:** PAT yenileme `.env` dosyasını yerinde yeniden yazıyordu; çökme veya
eşzamanlı yenileme yarım dosya ve geniş izin bırakabiliyordu.

**Çözüm (`src/server/atomic-env-file.ts`):**

- Aynı dizinde geçici dosya → `0o600` → `fsync` → atomik `rename` → dizin
  `fsync`; hata hâlinde geçici dosya silinir, eski dosya korunur.
- Mevcut izin daha kısıtlayıcıysa (ör. `0400`) genişletilmez; symlink hedefi
  yazma reddedilir.
- Aynı yol için eşzamanlı yazmalar sıraya alınır.
- `refreshEnvGitHubPat` yazma başarısızsa `null` döner, eski token kalır; token
  hiçbir yerde loglanmaz.

**Kanıt:** `tests/phase1-atomic-token.test.mjs` (14 test: atomiklik, izinler,
eşzamanlı yazma, hata sonrası korunum, symlink, kalıcı token no-op ve kabul
düzeltmesindeki rename/yazma hata senaryoları).

### 2.8 Aşama 1 kabul düzeltmeleri (B-14, B-09/B-04, B-31)

#### 2.8.1 Sembolik bağlantı ve TOCTOU koruması (`src/server/test-data-guard.ts`)

- `canonicalizePath` yolu **bileşen bileşen** çözer (`resolveSymlinks`);
  `realpath` çağrısına bağımlı değildir, iç içe bağlantıları ve bağlantı
  hedefinin kalan bileşenlerini de çözer. 40 atlamalık sınır aşılırsa
  (döngüsel zincir) sessizce geçilmez, açık hata verilir.
- Hedef henüz yoksa en yakın **var olan üst dizin** çözümlenir; kalan bileşenler
  sözlüksel olarak eklenir. Böylece henüz oluşturulmamış bir dizin de güvenli
  doğrulanır.
- `assertSafeDataDir` önce sözlüksel yolu, sonra kanonik gerçek hedefi gerçek
  `data/` ağacıyla karşılaştırır. Windows'ta karşılaştırma büyük/küçük harf
  duyarsızdır.
- `assertSafeWritePath` her `persistDocument*` / `writeDiskSnapshot*`
  çağrısından hemen önce üst dizini yeniden doğrular; doğrulamadan sonra bir
  dizin bağlantıya çevrilirse yazma reddedilir (TOCTOU).
- `createDataStorage` ve `taste-store` aynı `assertSafeDataDir` yolunu kullanır.
- Koruma test ortamında etkindir; üretimde no-op'tur (davranış değişmez).

#### 2.8.2 Profil kapsamlı kayıp ve tombstone karşılaştırması (`src/server/storage.ts`)

- `collectDocumentLossStats` artık `profileId` bazlı `items` ve `tombstones`
  haritaları üretir; her kayıt için en yeni etkileşim zamanı, her tombstone için
  silme zamanı saklanır.
- Aynı içerik başka profilde dursa bile bir profilden silinen kayıt **o profil
  için** kayıp sayılır; global `Set` maskesi kaldırıldı.
- Tombstone'lar profil bazında anahtar anahtar karşılaştırılır. Sayı sabit kalsa
  bile farklı bir işaret kaybolursa `tombstone_drop`; başka profile taşınan işaret
  de kayıp sayılır.
- Profil tamamen yoksa: kaydı varsa `profile_drop`, kaydı yok ama ad/tercih/
  favori oyuncu/CinemaKünye/ayar metaverisi varsa `profile_metadata_drop`.
- Meşru silme korunur: kaldırılan kaydın tombstone'u varsa veya kayıt silme
  zamanından yeni bir etkileşimle yeniden eklendiyse kayıp sayılmaz. Tek kayıplık
  profil boşalması yalnızca profil ≥2 kayıtla boşaldıysa ya da aynı içerik başka
  profilde durup kaybı maskeliyorsa reddedilir; tek kaydın bilinçli silinmesi
  engellenmez.
- Yeni kodlar (`item_drop`, `profile_metadata_drop`) istemci ve repository
  çakışma listelerine eklendi; şüpheli kayıpta belge **değiştirilmez**.

#### 2.8.3 Atomik token yazımında hata güvenliği (`src/server/atomic-env-file.ts`)

- `writeFileAtomicSecure(target, contents, hooks?)` yalnızca test/denetim için
  `hooks.beforeRename` kancası alır; üretim yolu değişmez.
- Geçici dosya yazılıp `fsync` edildikten sonra rename başarısız olursa hedef
  dosya eski hâliyle kalır, geçici dosya `finally` bloğunda silinir.
- Hedef yokken oluşan hata yarım/bozuk dosya bırakmaz; hata mesajı token
  değerini içermez; başarısız yazmadan sonra kuyruk kilitlenmez.
- `0600` izni korunur, mevcut daha kısıtlayıcı izin genişletilmez, symlink
  hedefi yazılmaz.

#### 2.8.4 Kanıt

| Konu | Test dosyası | Test |
|---|---|---|
| Symlink, iç içe symlink, TOCTOU, keşif | `tests/phase1-test-isolation.test.mjs` | 21 (11 yeni) |
| Profil kapsamlı kayıt/tombstone/metaveri kaybı | `tests/phase1-data-loss-guard.test.mjs` | 27 (14 yeni) |
| Rename/yazma hataları, geçici dosya temizliği, sızıntı | `tests/phase1-atomic-token.test.mjs` | 14 (6 yeni) |

---

## 3. Uçtan uca entegrasyon (Senaryo A–G)

`tests/phase1-data-integrity-integration.test.mjs` gerçek Express uygulaması ve
HTTP uçları üzerinden çalışır:

| Senaryo | Doğrulanan |
|---|---|
| A | İki cihaz aynı revizyondan farklı alanları yazar; puan ve durum birlikte korunur |
| B | Bir cihazın sildiği puan eski cihazdan geri gelmez |
| C | Tombstone'lu silinen kayıt eski cihazdan geri dirilmez |
| D | İki profilli yedek dışa aktarılır, ayrıştırılır ve yeni dizine kayıpsız yüklenir |
| E/F | Eski revizyonla restore 409, eksik yedek 404; veri değişmez |
| G | Tüm akış geçici dizinde kalır; gerçek `data/` kullanılmaz |

---

## 4. Bilinen sınırlar

- Playwright E2E, kabul düzeltmesi turunda çalıştırıldı (15/15). Koşum için
  Chromium sistem kütüphaneleri `/tmp` altına çıkarıldı; bu kurulum depoya dâhil
  değildir ve yeni bir ortamda yeniden yapılmalıdır.
- Çok süreçli atomik yazma ve dağıtık kilit **garanti edilmez**: atomiklik ve
  yazma kuyruğu tek süreç içindedir. İki Node sürecinin aynı veri dizinine
  eşzamanlı yazması Aşama 2 kapsamındadır.
- Tombstone yazmayan bir istemcide tek kayıplık profil boşalması, meşru
  silmeden ayırt edilemez; bu durum bilinçli olarak meşru kabul edilir.
- Canlı GitHub/TMDB/TVDB entegrasyon testleri token/API anahtarı gerektirdiği
  için koşulmadı.
- Restore çakışmasında UI'ın 409 durumunu nasıl gösterdiği (B-08 kabul
  kriterinin UI kısmı) Aşama 4'te ele alınacak; sunucu tarafı ve istemci
  `If-Match` gönderimi tamamlandı.
- `v5+` yedekler bilinçli olarak reddedilir; ileri sürüm desteği yeni şema
  eklendiğinde gelecek.
