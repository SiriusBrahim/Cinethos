# Cinethos (CineTrack) — Uzman İnceleme Raporu

> İncelenen sürüm: `main` @ `eed392e` (v1.1.0) · İnceleme tarihi: 2026-11-13
> Kapsam: Güvenlik, mimari, kod kalitesi, test altyapısı, bağımlılıklar, UX/ürün eksikleri
> Yöntem: Tam klon üzerine `npm run lint`, `npm test`, `npm run test:taste`, `npm run build`, `npm audit` ve manuel kod incelemesi

---

## 0. Yönetici Özeti

Proje, kişisel bir film/dizi kataloğu için **olağanüstü olgun** bir mühendislik tabanına sahip: atomik JSON yazımı + 7 döner yedek, `ETag`/`If-Match` ile yarış koşulu koruması, sıkı CSP, origin guard, timing-safe token karşılaştırması, TMDB proxy'de yol/parametre allowlist'i, gizli bilgi redaksiyonu ve 735'i geçen birim testi yeşil.

Buna rağmen **CI şu anda kırmızı** (üretim bağımlılık ağacında 2 *high* güvenlik açığı) ve **dokümante edilen LAN/uzaktan erişim modu arayüz tarafından fiilen kullanılamıyor** (istemci hiçbir zaman token göndermiyor). Bu ikisi öncelikli düzeltme kalemidir.

| Alan | Durum |
| --- | --- |
| Birim testler (373) + Taste testleri (362) | ✅ Tümü yeşil |
| `npm run lint` (ESLint + tsc) | ✅ 0 hata / 63 uyarı |
| `npm run build` (Vite + PWA) | ✅ Başarılı |
| `npm audit --omit=dev --audit-level=high` (CI adımı) | ❌ **Exit 1 — 2 high** |
| LAN modu (token ile uzaktan erişim) | ❌ **İstemci tarafı eksik — kullanılamaz** |

---

## 1. 🔴 Kritik: Doğrulanmış Hatalar

### 1.1. CI güvenlik adımı kırmızı — zod *high* (GHSA-mrhx-c7xc-m3w5)

- Kanıt: `npm audit --omit=dev --audit-level=high` → **exit 1**, "28 vulnerabilities (26 moderate, 2 high)".
- Zincir: `zod <4.6.6` (*high*, bellek tükenmesi) ← `writer-sdk >=2.2.0-rc.1` ← `@respan/respan 2.5.0` — **production dependency** (`package.json`).
- `npm audit fix` kırılmayan bir düzeltme sunuyor (zod override).
- CHANGELOG'da daha önce aynı senaryo için `body-parser` yükseltmesi yapılmış; bu bir **regresyon** (yeni *high* sonradan girmiş).
- Öneri: `npm audit fix` + lock dosyasıcommiti; kalıcı çözüm için `overrides` ile `zod >= 4.6.6` sabitlemesi ve `@respan/respan`'in yeni sürüm takibi.

### 1.2. LAN/uzaktan modda tarayıcı kimlik doğrulaması tamamen eksik

- `src/server/security.ts` → `createTokenAuthMiddleware`: token yokken loopback dışı arayüzde tüm mutasyonlar `503 auth_required` döner; token varken `401` döner. Sunucu tarafı doğru ve güvenli.
- Ancak **istemci hiçbir yerde token göndermiyor**: `src/services/api.ts`, `offline-queue.ts`, `useOfflineSync.ts` içinde `Authorization` / `X-CineTrack-Token` başlığı yok (grep ile doğrulandı); `401`/`503 auth_required` için tek bir UI işleme dahi yok.
- Sonuç: README'nin vaat ettiği `CINETRACK_HOST=0.0.0.0` + `CINETRACK_TOKEN` senaryosunda **web arayüzünden hiçbir kayıt/ekleme/düzenleme yapılamaz**. Özellik dokümante edildiği hâliyle çalışmıyor.
- Öneri: LAN modunda tek seferlik token girişi (örn. küçük modal → `sessionStorage`), tüm `fetch` çağrılarına ortak başlık enjekte eden bir `apiFetch` sarmalayıcısı ve `401/503`'te token modalını yeniden açan merkezi hata işleme.

### 1.3. `.env.example` başkasının deposunu işaret ediyor

- `.env.example:9`: `CINETRACK_DATA_OWNER=6yildiz9-maker` — depo sahibi `SiriusBrahim` ile ilgisiz, kişisel bir kalıntı.
- Kullanıcı `cp .env.example .env` yapıp PAT eklerse uygulama **başka bir kişinin deposuna** senkron kurmaya çalışır (yetki yoksa hata; yanlışlıkla yazma yetkisi varsa o depoya yazar).
- Öneri: alanlar boşaltılmalı veya `SENIN_KULLANICI_ADIN` yer tutucusu + yorum kullanılmalı.

---

## 2. 🟠 Orta Önemli Sorunlar

### 2.1. TMDB resim proxy'si bellek riski ve rate limit dışı

- `src/server/tmdb-proxy.ts:857` — `imageCache` en fazla 300 kayıt, kayıt başına **8 MB'a kadar** buffer → teorik tepe **~2,4 GB RSS**. Uzun ömürlü sunucuda OOM riski.
- `/api/tmdb-image` rotası rate limiter'a bağlı değil (`app.ts:572`); yalnızca `/api/tmdb` sınırlanıyor. Loopback dışı açıksa sınırsız upstream fetch + bellek dolumu mümkün.
- Öneri: önbellek için toplam byte bütçesi (örn. 64 MB LRU), `/api/tmdb-image`'a da aynı limiter, cache'e girmeden önce `Content-Length` kontrolü.

### 2.2. `SlidingWindowRateLimiter` temizleme stratejisi zayıf

- `security.ts:292`: `hits.size > 2000` olduğunda **en eski anahtar** siliniyor (FIFO); süresi geçmiş ama haritada kalan girişler temizlenmiyor. IP döngüsü saldırısında saldırgan meşru IP'lerin kaydını evict edebilir.
- Öneri: silmeden önce süresi geçmiş girişleri süpüren periyodik/tembel temizlik.

### 2.3. `react-hooks/exhaustive-deps` uyarıları — bayat veri (stale) riski

- `src/App.tsx:1370` — `setDetailItem` bağımlılığı eksik.
- `src/App.tsx:2748` — `activeProfileId` eksik: **profil değişiminde eski profilin verisiyle çalışan effect** olabilir (changelog'da benzer hata daha önce düzeltilmiş).
- `src/components/DetailModal.tsx:168` — `item` eksik: modal açıkken liste verisi güncellenirse bayat detay gösterilir.
- `src/components/RelationshipExplorer.tsx:383` — `selectedNode` eksik.
- Bunlar şu an sessiz bug üretiyor olabilir; en azından her biri tek tek incelenip ya düzeltilmeli ya da gerekçesiyle `// eslint-disable-next-line` + açıklamaya alınmalı.

---

## 3. 🟡 Kod Kalitesi ve Bakım

1. **Monolitler**: `src/App.tsx` **4466 satır**, `src/core/cinetrack-core.ts` **4690 satır**, `src/server/github-bidirectional-sync.ts` **4753 satır**, `src/server/persistent-store.ts` **4216 satır**. Changelog'da başlatılan monolit bölme çalışması devam ettirilmeli; `App.tsx` için sayfa/panel bazlı bölme + `React.lazy` önerilir (ana paket 495 kB / gzip 146 kB).
2. **63 lint uyarısı**: ağırlıkla kullanılmayan dışa aktarımlar (örn. `Header.tsx:7` `computeActivityStreak`, `relationship-explorer.ts:15,29` `ENCODING_LAYOUT_VERSION`/`STOP_WORDS`, `evidence-ledger.ts:122` `weight`). Ölü kod temizliği tek PR'lık iş.
3. **`phase-0-findings.md` (36 KB iç denetim raporu) repo kökünde** duruyor; `docs/` altına taşınması kökü temizler.
4. **Marka/repo adı uyumsuzluğu**: repo `cinetrack`, marka `Cinethos` (`src/shared/brand.ts`), paket `cinetrack`, veri dosyası `cinetrack-data.json`. Tek marka kaynağı mevcutken repo README'si ve depo adı ayrışıyor; en azından README'de "eski ad: CineTrack" notu + tutarlı terminoloji önerilir.
5. **E2E tek tarayıcı**: `playwright.config.ts` yalnızca `chromium` projesi tanımlıyor. Firefox/WebKit projeleri eklenmeli; responsive testler var ama tek motorla doğrulanıyor.
6. **Dependabot yok**: `.github/dependabot.yml` bulunmuyor. 1.1'deki regresyonun tekrarını önlemek için haftalık `npm` + `actions` güncellemeleri şiddetle önerilir.
7. **CI adımı sırası**: `npm audit` adımı lint/test'ten önce; kırmızı olduğunda diğer sinyaller kayboluyor. Audit'i ayrı bir job'a almak (continue-on-error raporlamasıyla) sinyal netliğini artırır.

---

## 4. ✅ Güçlü Yönler (Korunmalı)

- **Veri güvenilirliği**: `.tmp` + `fsync` + `rename` atomik yazım, 7 döner yedek, bozuk dosyada sessiz ezme yok, 30 günlük silme mezar taşları, `verifiedEqual` ile geri okuma doğrulaması.
- **Eşzamanlılık**: `ETag`/`If-Match` → `428 Precondition Required` / `409 Conflict` akışı ve istemcide çakışma birleştirme UI'ı.
- **Güvenlik duruşu**: sıkı CSP (üretimde `script-src 'self'`), origin guard + CSRF, timing-safe token, TMDB path/query allowlist, upstream 10 MB sınırı, gizli bilgi `[REDACTED]` redaksiyonu, `X-Content-Type-Options`, `frame-ancestors 'none'`, loopback dışında fail-closed auth.
- **Test kültürü**: 373 + 362 yeşil test; uçtan uca GitHub senkron, atomik depolama, SQLite arşiv, Excel yedek senaryoları; üretim smoke testi içeren kapsamlı CI.
- **Ürün derinliği**: deterministik öneri motoru (15 sinyal + Bayesyen düzeltme + şeffaf "Neden önerildi?"), zevk DNA'sı, ilişki grafiği, sezon takvimi + `.ics`, PWA çevrimdışı kuyruk, çoklu profil, Excel/SQLite yedekleme.

---

## 5. 💡 Yenilik ve Eksik Önerileri (öncelik sırasıyla)

| # | Öneri | Gerekçe |
| --- | --- | --- |
| 1 | **İstemci token auth akışı** (bkz. 1.2) | LAN modunu gerçekten kullanılabilir yapar |
| 2 | **Dependabot + `npm audit fix`** | Kırmızı CI'ı yeşile çevirir, regresyonu kalıcı önler |
| 3 | **Çok dillilik (EN/TR)** | `src/i18n/index.ts` altyapısı hazır; tek dil kitleyi sınırlıyor |
| 4 | **Firefox/WebKit E2E + görsel regresyon** | Arayüz ağırlıklı üründe tarayıcı kapsamı kritik |
| 5 | **`App.tsx` bölünmesi + route/lazy bölümleme** | 495 kB ana paket, 4.4k satırlık bileşen bakım maliyeti |
| 6 | **İzleme süresi gerçek runtime verisi** | README'deki 110 dk/45 dk varsayımı yerine TMDB `runtime` + `append_to_response` ile doğruluk |
| 7 | **Trailer/fragman entegrasyonu** (`append_to_response=videos` zaten allowlist'te) | Detay penceresinde doğal tamamlayıcı |
| 8 | **Paylaşılan liste/ortak izleme (read-only link)** | "Birlikte Ne İzlesek?" özelliğinin doğal uzantısı |
| 9 | **Telemetri panosu** (Respan izleri için basit /api/health detayı) | Mevcut entegrasyonun gözlemlenebilirliği |
| 10 | **README'ye CI badge + ekran görüntüleri** | İlk izlenim ve durum görünürlüğü |

---

## 6. Doğrulama Komutları (yeniden çalıştırmak için)

```bash
npm ci
npm run lint          # 0 hata / 63 uyarı
npm test              # 373/373 yeşil
npm run test:taste    # 362/362 yeşil
npm run build         # başarılı
npm audit --omit=dev --audit-level=high   # ❌ exit 1 — 2 high (zod GHSA-mrhx-c7xc-m3w5)
```
