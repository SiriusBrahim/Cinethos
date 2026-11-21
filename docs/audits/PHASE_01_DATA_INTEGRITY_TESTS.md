# Aşama 1 — Test Kanıtları

**Tarih:** 21 Kasım 2026
**Dal:** `remediation/full-project-remediation` (PR #65)
**HEAD:** kabul düzeltme commit'leri (bu belge dâhil)

Bu belge Aşama 1'de eklenen/çalıştırılan testleri, komutları ve gerçek sonuçları
kaydeder. Çalıştırılmayan test başarı sayılmadı.

---

## 1. Komutlar ve sonuçlar

| Komut | Sonuç | Süre |
|---|---|---|
| `npm run lint` (eslint + `tsc --noEmit` + test tsconfig) | 0 hata, 0 uyarı (`--max-warnings 0`) | ~60 sn |
| `npm run cycles` | Bağımlılık döngüsü bulunmadı | ~3 sn |
| `npm test` | **708/708 geçti**, 67 dosya, 0 başarısız | ~99 sn |
| `npm run test:taste` | **440/440 geçti**, 27 dosya, 0 başarısız | ~16 sn |
| `npm run build` | Başarılı (`dist/sw.js`, workbox üretildi) | ~5 sn |
| `npx playwright test` (chromium, `--workers=1`) | **15/15 geçti** (9 + 6, iki grupta) | 21 sn + 13 sn |
| `data/` hash (her koşu öncesi/sonrası) | Değişmedi (`c2c163f1…`) | — |

Not: Kabul turunun ilk `test:taste` koşusunda, önceden var olan süre eşikli
`Farklı profil kapsamları eşzamanlı tutulabilir` testi yüklü makinede 466 ms
sürerek başarısız oldu; aynı test ve tüm suite ikinci koşuda **440/440** geçti.
Test zayıflatılmadı; bu, bilinen zamanlama hassasiyeti olarak kaydedildi.

`npm test` artık `scripts/run-tests.mjs` üzerinden çalışır:

1. `data/` dizininin hash manifestini alır.
2. `scripts/test-discovery.mjs` ile test dosyalarını glob'la bulur.
3. `--test-concurrency=1` ile koşar.
4. Hash manifestini yeniden alır; fark varsa test **başarısız** olur.

---

## 2. Yeni test dosyaları

| Dosya | Test | Kapsam |
|---|---|---|
| `tests/phase1-test-isolation.test.mjs` | 21 | Guard, `dataDir` zorunluluğu, gerçek `data/` reddi, symlink/iç içe symlink/TOCTOU, keşif |
| `tests/phase1-merge-lossless.test.mjs` | 12 | S1–S7 senaryoları iki yön; puan silme, durum geri alma, eşit/eksik damga |
| `tests/phase1-backup-roundtrip.test.mjs` | 15 | v1–v4 ayrıştırma, çoklu profil round-trip, v5 ret, bozuk JSON |
| `tests/phase1-restore-conflict.test.mjs` | 5 | 409 / 428 / 200, eşzamanlı restore, hata sonrası veri korunumu |
| `tests/phase1-data-loss-guard.test.mjs` | 27 | 60+11, 60+61, profil kapsamlı kayıt/tombstone/metaveri kaybı, onaylı silme, limit ve geçersiz kimlik reddi |
| `tests/phase1-atomic-token.test.mjs` | 14 | Atomiklik, 0600 izin, eşzamanlı yazma, rename/yazma hataları, geçici dosya temizliği, token sızıntısı, symlink, no-op |
| `tests/phase1-data-integrity-integration.test.mjs` | 6 | Senaryo A–G, gerçek HTTP uçları |

**Toplam yeni test:** 100 (708 unit içinde): 69 ilk tur + 31 kabul düzeltmesi.

Güncellenen mevcut testler:

- `tests/phases-all.test.mjs` — restore isteği artık `If-Match: "rev-3"` gönderir.
- `tests/core.test.mjs` — v4 belge `profileName` beklentisi `'Profilim'`.
- `tests/phase3-architecture.test.mjs` — yedek `version: 4`.
- `tests/phase1-restore-conflict.test.mjs` — ASCII token (HTTP header).

---

## 3. Senaryo → test eşlemesi

| Gereksinim | Test |
|---|---|
| Testler gerçek `data/` dizinine erişemez | `phase1-test-isolation` + `check-data-integrity.mjs` |
| Kullanıcı verisi sessizce silinemez/kırpılamaz | `phase1-data-loss-guard` (limit testleri) |
| Bilinmeyen yedek sürümü sessizce kabul edilmez | `phase1-backup-roundtrip` |
| Eski cihaz yeni veriyi sebepsiz ezemez | `phase1-merge-lossless`, integration A/B |
| Silinen kayıt geri gelemez | `phase1-merge-lossless` (tombstone), integration C |
| Restore eşzamanlı değişikliği ezemez | `phase1-restore-conflict`, integration E/F |
| Çoklu profil yedeği kayıpsız | `phase1-backup-roundtrip`, integration D |
| Token dosyası bozulmaz | `phase1-atomic-token` |
| Symlink üzerinden gerçek `data/`'ya yazılamaz | `phase1-test-isolation` (symlink, iç içe symlink, sonradan hedef değişimi, TOCTOU) |
| Profil bazlı kayıp global sayımla maskelenemez | `phase1-data-loss-guard` (iki profilde aynı içerik, profil kimliği değişimi, diğer profili etkilememe) |
| Boş profil metaverisi korunur | `phase1-data-loss-guard` (tercih, favori oyuncu, boş profil) |
| Tombstone sayısı sabitken farklı işaret kaybı | `phase1-data-loss-guard` (taşıma ve farklı anahtar kaybı) |
| Rename hatasında eski token korunur | `phase1-atomic-token` (`beforeRename` kancası + gerçek FS) |

---

## 4. Veri dizini kontrolü

Aşama 1 başlangıcından bu yana:

| Dosya | sha256 | Durum |
|---|---|---|
| `data/cinetrack-data.json` | `c2c163f15465363ae817f8f9e6947b92573223830eccd9b37a398ee5a001b7df` | Değişmedi |
| `data/profile.json` | `473316ce7bef647a7000f59ca1feb714b4a7358451d7c5ce5d40d0e3630caad8` | Değişmedi |
| `data/backups/` | 2 dosya | Değişmedi |

---

## 5. Doğrulanmayanlar

- **Canlı API entegrasyonları:** GitHub/TMDB/TVDB token ve API anahtarı yok;
  gerçek ağ çağrıları test edilmedi.
- **Çok süreçli eşzamanlı yazma:** Aynı makinede iki Node sürecinin aynı veri
  dizinine eşzamanlı yazması denenmedi ve **garanti edilmiyor**. Atomik yazım,
  `0600` izin ve revizyon kontrolü süreç içi kuyruk + dosya düzeyi rename ile
  korunuyor; dağıtık kilit Aşama 2 kapsamındadır.
- **Windows symlink davranışı:** Testler POSIX'te gerçek sembolik bağlantıyla
  koşar. Symlink oluşturulamayan platformlarda ilgili testler `skip` olarak
  raporlanır (sessiz başarı sayılmaz); Windows'ta harf duyarsız karşılaştırma
  kod düzeyinde uygulanır ancak bu ortamda E2E ile doğrulanmadı.
