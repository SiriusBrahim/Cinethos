# Cinethos — Kontrollü Marka Geçişi Kaydı

**Tarih:** 2026-11-16
**Kaynak dal / SHA:** `master` / `b7775d90f9042ad0d480a316bc500328b5cb351f`
**Çalışma dalı:** `agent-2/cinethos-brand-migration`
**Yöntem:** Körlemesine global replace yok. Her eşleşme sınıflandırıldı; yalnızca marka kimliği taşıyan görünür yüzeyler değiştirildi, sözleşme ve kullanıcı verisi taşıyan tanımlayıcılar korundu.

Tam satır envanteri: [`cinethos-marka-envanteri.csv`](cinethos-marka-envanteri.csv) (849 satır, 155 dosya; başlangıç anı `b7775d9`).

---

## 1. Başlangıç durumu

- `master` üzerinde çalışıldı; çalışma ağacı temizdi.
- Faz 3 (`agent-2/phase-3`), Faz 4 (`agent-2/phase-4-background-manager`) ve bakım botu (`agent-2/maintenance-bot`) dallarına dokunulmadı; bu dal onların commit'lerini içermez.
- Başlangıçta 849 eski marka eşleşmesi / 155 metin dosyası bulundu. `data/` Git tarafından izlenmiyor; kullanıcı verisine dokunulmadı.

## 2. Sınıflandırma özeti

| Sınıf | Satır | Karar |
|---|---:|---|
| Test sözleşmesi (`tests/`, `e2e/`) | 247 | **Korundu** — Agent 1 sahipliğinde; marka beklentisi değiştirilmedi |
| Kalıcı veri (`data/cinetrack-data.json`, `cinetrack.db`, yedek/taste yolları) | 142 | **Korundu** — kullanıcı verisi ve GitHub senkron yolu |
| Ortam sözleşmesi (`CINETRACK_*`) | 120 | **Korundu** — `.env`, CI ve mevcut kurulumlar |
| Modül yolu (`cinetrack-core`) | 91 | **Korundu** — 133 import; Faz 3/4 dallarıyla çakışma |
| Tarihsel kayıt (`phase-0-findings`, `CHANGELOG`, denetim, arşiv spec) | 80 | **Korundu** — tarihsel doğruluk |
| API sözleşmesi (`X-CineTrack-*`, `x-cinetrack-*`) | 53 | **Korundu** — istemci/sunucu ve test sözleşmesi |
| İstemci depolaması (localStorage/sessionStorage) | 44 | **Korundu** — mevcut profil/tercih anahtarları |
| IndexedDB / CacheStorage adları | 25 | **Korundu** — kullanıcı verisi ve yetim önbellek riski |
| Veri/format sözleşmesi (`#CINETRACK-PROFILE`, ICS `@cinetrack.local`, `detectedFormat`) | 9 | **Korundu** — içe/dışa aktarma uyumluluğu |
| Modül API’si (`createCineTrackApp`, `CineTrackAppOptions`) | 5 | **Korundu** — 56+ çağrı |
| Uyumluluk anahtarı (depolama/olay adı, yedek dosya deseni) | 22 | **Korundu** — çift okuma katmanı olmadan veri kaybı |
| **Görünür marka / metadata / indirme adı** | **11** | **DEĞİŞTİRİLDİ** |

> Satır sayıları başlangıç anına aittir ve sınıflar arasında örtüşme yoktur; toplam 849.

## 3. Değiştirilenler

| Dosya | Değişiklik | Gerekçe |
|---|---|---|
| `metadata.json` | `name`: `CineTrack` → `Cinethos` | Uygulama metadata’sı |
| `src/components/TvdbStockModal.tsx` | Stok dışa aktarma açıklaması | Kullanıcıya görünen metin |
| `src/services/api-client.ts` | “Yerel CineTrack sunucusuna…” → Cinethos | Kullanıcıya görünen hata |
| `src/services/tvdb-service.ts` | Kod yorumu + TVDB stok dosya adı | Marka tutarlılığı |
| `src/services/stock-import-export.ts` | Stok dosya adı `cinethos-stock-*` | İndirilen artifact adı |
| `src/services/api.ts` | Yedek dosya adı fallback’i `cinethos-archive-*` | İndirilen artifact adı |
| `src/server/app.ts` | SQLite arşiv dosya adı `cinethos-archive-*` | İndirilen artifact adı |
| `src/App.tsx` | Yerel JSON yedeği `cinethos-local-backup-*` | İndirilen artifact adı |
| `src/styles/design-system.css` | Başlık yorumu | Marka tutarlılığı |
| `package.json` / `package-lock.json` | Paket adı `cinetrack` → `cinethos` | Özel uygulama kimliği; yayınlanan paket yok |
| `README.md` | “Eski ad: CineTrack” uyumluluk notu | Geçiş açıklaması |

Dosya veya klasör **yeniden adlandırılmadı**; import/build yolu değişikliği yok.

## 4. Korunanlar ve gerekçeleri

### 4.1 Ortam değişkenleri — `CINETRACK_*`

Mevcut `.env`/`.env.local`, CI ve kurulum dokümantasyonu bu adları kullanıyor. Yeniden adlandırma, kimlik doğrulama (`CINETRACK_TOKEN`), GitHub yedekleme (`CINETRACK_GITHUB_PAT`, `CINETRACK_DATA_*`) ve host/port ayarlarını sessizce devre dışı bırakırdı. Yeni `CINETHOS_*` adları **eklenmedi**: iki adlı bir yüzey, hangi değerin kazandığı belirsizliğini ve test matrisini büyütür. Gelecekte takma ad katmanı istenirse tek merkezden (`src/server/config.ts`) yapılmalıdır.

### 4.2 HTTP başlıkları — `X-CineTrack-*`

`X-CineTrack-Token`, `X-CineTrack-Source`, `X-CineTrack-Profile-Id`, `X-CineTrack-Merge` vb. istemci-sunucu arasındaki gerçek API sözleşmesidir; testler ve olası harici istemciler bunlara bağlıdır. Yeni başlık eklemek çift sözleşme ve belirsiz öncelik yaratır; bu nedenle korundu.

### 4.3 Kalıcı veri

- `data/cinetrack-data.json`: kullanıcı profilleri, izleme listeleri, puanlar ve ayarlar.
- `data/cinetrack.db` (+ WAL/SHM): SQLite birincil depo.
- `data/taste/cinetrack-taste-*.json`, `data/backups/cinetrack-*.json`: zevk profili ve döner yedekler.
- GitHub senkron hedefi `cinetrack-private-data` ve `data/cinetrack-data.json` yolu.

Bunlar yeniden adlandırılırsa mevcut kurulumlar verisiz açılır; migration + geri dönüş planı olmadan değiştirilmedi.

### 4.4 İstemci depolaması

`cinetrack.profiles.v1`, `cinetrack.activeProfile.v1`, `cinetrack.profile.*`, `cinetrack_fav_actors_*`, `cinetrack_disliked_cache`, `cinetrack_offline_sync_queue_v1` ve IndexedDB adları (`cinetrack-profile-db`, `cinetrack-relationship-cache`, `cinetrack-surfaced-db` vb.) kullanıcı verisidir. Çift okuma/yazma katmanı eklenmeden değiştirilmedi.

### 4.5 Format ve artifact sözleşmeleri

- `#CINETRACK-PROFILE` CSV yönergesi ve `detectedFormat: 'cinetrack'` içe aktarma kimliği: eski yedeklerin okunabilmesi için korundu.
- `Cinethos_Profile_*.xlsx` üretilirken yükleme doğrulaması hâlâ `CineTrack_Profile_*` dosyalarını kabul eder (geriye dönük uyumluluk).
- ICS `@cinetrack.local` UID’leri: takvim istemcilerinde yinelenen etkinlik oluşmaması için korundu.
- Tarayıcı önbellek adları (`cinetrack-tmdb-posters`, `cinetrack-google-fonts`): yeniden adlandırma eski önbelleği yetim bırakır.

### 4.6 Tarihsel kayıtlar

`phase-0-findings.md`, `docs/mia/faz0-envanter.md`, `CHANGELOG.md`, `AUDIT_PLAN.md`, `docs/SECURITY-AUDIT.md` ve `public/assets/aistudio/*` geçmiş kararları/denetimleri belgelendirir; tarihsel doğruluk için değiştirilmedi.

### 4.7 Harici servisler

TMDB, TVDB, IMDb, GitHub, Google Fonts ve bunların parametreleri marka dönüşümü kapsamı dışındadır; hiçbirine dokunulmadı.

## 5. Uyumluluk ve migration

- **Migration gerekmedi:** kalıcı dosya adı, DB tablo/kolon adı, depolama anahtarı, API başlığı veya yedek formatı değişmedi.
- **Veri kaybı riski yok:** yalnızca görünen metinler, indirme dosya adları, paket adı ve metadata değişti.
- **Geri dönüş:** değişiklikler metin/config düzeyindedir; commit geri alınabilir, kullanıcı verisi etkilenmez.
- Paket adı değişikliği yalnızca yerel npm kimliğini etkiler (paket `private: true`, yayınlanmıyor).

## 6. Doğrulama

| Kontrol | Sonuç |
|---|---|
| `npm run lint` (eslint + iki tsc) | ✅ |
| `npm test` (architecture-boundaries dahil) | ✅ 451/451 |
| `npm run test:taste` | ✅ 355/355 |
| `npm run build` | ✅ |
| `npm run test:e2e` | ⛔ Çalıştırılamadı — ortamda `libnspr4.so` yok (Chromium başlatılamıyor, 11 test) |
| Son tarama | 839 eşleşme; görünür marka kullanımı kalmadı, tümü korunan sınıflarda |

## 7. Açık riskler / onay bekleyenler

1. **İç tanımlayıcıların yeniden adlandırılması** (env `CINETRACK_*`, `X-CineTrack-*`, `createCineTrackApp`, `cinetrack-core.ts`, veri dosyaları, depolama anahtarları) yapılmadı. Her biri ya sözleşme ya kullanıcı verisi ya da aktif dallarla çakışan geniş bir refactor gerektirir; ayrı onay ve migration planı ister.
2. **Dosya adı değişikliği** (`cinetrack-core.ts` → `cinethos-core.ts`) Faz 3/4 dallarındaki import’larla çakışır; koordineli merge penceresi gerekir.
3. **E2E ve gerçek GitHub Actions** bu ortamda çalıştırılamadı (eksik sistem kütüphanesi / kimlik doğrulama yok). CI’da doğrulanmalı.
4. İndirme dosya adları (`cinethos-*`) kullanıcı otomasyonlarında sabit ad bekliyorsa etkilenebilir; içerik/uzantı değişmedi.
