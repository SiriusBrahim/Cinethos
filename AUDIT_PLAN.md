# Cinethos — Denetim Planı (4. Tur, Güncellenmiş)

> Baz: `master` @ `9b2d2eb` (2026-11-15 üçüncü tur sonrası) · Önceki raporlar: `CODE_REVIEW_REPORT.md`, `DEEP_DIVE_REVIEW.md`
> Doğrulama: `npm ci` sonrası **405/405 birim + 362 taste testi yeşil**, `npm run lint` (`--max-warnings 0`) yeşil, `npm run build` başarılı, `npm audit --omit=dev --audit-level=high` **exit 0**.

---

## A. Tamamlanan Kalemler (plandan çıkarıldı)

Önceki iki raporun şu kalemleri **doğrulanmış biçimde tamamlandı** ve bu plandan silindi:

| Kalem | Kanıt |
| --- | --- |
| 🔴 zod *high* (GHSA-mrhx-c7xc-m3w5) | `package.json:33-34` override `^4.6.6`; audit exit 0; audit artık **bloklayıcı** CI job'ı (P0-05) |
| 🔴 LAN modu istemci auth eksik | `src/services/api-client.ts` (ApiError, `apiFetch`, sessionStorage token, `cinetrack:auth-required`), `AuthTokenModal.tsx`, `main.tsx:14` unhandledrejection → bildirim (SEC-02/03) |
| 🔴 `.env.example` yabancı depo | `CINETRACK_DATA_OWNER=` ve `CINETRACK_DATA_REPO=` boşaltıldı |
| 🟠 Offline kuyruk dayanıklılığı | 5 denemeli üstel backoff (2 sn → 5 dk) + "Yeniden dene" + IDB→localStorage→bellek katmanı + serializer (SEC-04, P0-03) |
| 🟠 Resim proxy bellek/limit | 64 MB bayt bütçeli LRU + `/api/tmdb-image` rate limiter + 8 MB akış sınırı + MIME allowlist + tek uçuş paylaşımı (SEC-05, P1-02) |
| 🟠 Rate limiter FIFO evict | LRU tahliyesine çevrildi (IP rotasyonu meşru istemciyi atamaz) |
| 🟠 `exhaustive-deps` uyarıları | 0 uyarı; lint `--max-warnings 0` kapısı (P1-08) |
| 🟡 66 sessiz `catch {}` | `no-empty` sıkılaştırıldı, hepsi gerekçelendirildi (grep: 0) |
| 🟡 Toast tek mesajlı | Kuyruklu + `ToastKind` (success/error/info) + elle kapatma (UX-01) |
| 🟡 Skeleton yok | `MediaGrid`/`DetailModal`/`PersonDrawer` + CSS |
| 🟡 Dependabot yok | `.github/dependabot.yml` eklendi |
| 🟡 CI tek job | `quality` / `Playwright E2E` / `security` ayrı joblar + üretim smoke testi + actions v5 |
| Ek (kendi planlarından) | SQLite restore prepare/commit/rollback + journal + finalize (P0-01 A-E), SIGTERM güvenli kapanış, `content-visibility: auto`, a11y lint kuralları, `prefers-reduced-motion`, `core/media/poster.ts`, güvenlik istisna kaydı (`docs/SECURITY-AUDIT.md`) |

---

## B. Kalan İşler — Yeni Plan

### 🟠 Y1. UI durum yönetimi: Context katmanı ve `App.tsx` bölünmesi *(en büyük borç — bu turda büyüdü)*

- **Durum:** `App.tsx` 4.466 → **4.570 satıra** büyüdü; `createContext` grep'i hâlâ **0** sonuç. 39+ `useState` prop drilling ile 15+ bileşene akıyor. `cinetrack-core.ts` (4.690), `github-bidirectional-sync.ts` (4.753), `persistent-store.ts` (4.229) değişmedi.
- **Plan (3 PR'lık kademeli geçiş):**
  1. `src/stores/ui-context.tsx` — toast/modal/tab state'i App'ten çıkarılır (en düşük risk, ~0,5 gün).
  2. `src/stores/profile-context.tsx` — aktif profil + items + `detailItem`; App'teki 21 `detailItem` referansı tek provider'a iner (~1 gün).
  3. Sekmeler `src/features/{discover,list,stock}` altına `React.lazy` ile taşınır; `App.tsx` ~500 satırlık kabuğa iner (~2-3 gün).
- **Kabul kriteri:** `App.tsx` < 1.000 satır; her sekmenin kendi state dosyası; mevcut 405 test + 5 E2E spec'i değişmeden yeşil.

### 🟠 Y2. Yazma yolu delta'ya geçirilecek (tam belge PUT kaldırılacak)

- **Durum:** `PUT /api/data` hâlâ tüm `DataDocument`'ı gönderiyor (~2 KB/öğe × tüm profiller; 25 MiB tavan ≈ 12 bin öğe). `GET /api/isolated/profile` var ama yazma karşılığı yok (`PUT /api/profiles/:profileId` grep: 0).
- **Plan:** `app.ts`'e `PUT /api/profiles/:profileId` (mevcut `validateAndPrepareSave` + `If-Match` sözleşmesiyle); istemciye `pushProfileDelta()`; `PUT /api/data` yalnızca geri yükleme/migrasyon için kalır. Mobil veri/batarya yükü O(profiller×öğeler) → O(delta).
- **Kabul kriteri:** Tek öğe ekleme isteği gövdesi < 10 KB; 409/428 akışı değişmeden korunur; çift yönlü GitHub senkron testleri yeşil.

### 🟡 Y3. Depo hijyeni

- `phase-0-findings.md` (36 KB iç denetim raporu) hâlâ kökte → `docs/phase-0-findings.md` taşı + README'deki referansları güncelle (~10 dk).
- Marka/repo uyumu: repo `cinetrack` ↔ marka `Cinethos` ↔ paket `cinetrack`; README başlığına tek satırlık "eski ad: CineTrack" notu ekle; README üstüne CI badge (`quality` + `security` jobları için) ekle (~15 dk).

### 🟡 Y4. E2E tarayıcı kapsamı

- **Durum:** `playwright.config.ts` hâlâ yalnızca `chromium` projesi. CI'da E2E job'ı var ama tek motor.
- **Plan:** `firefox` + `webkit` projeleri eklenir (CI'da `workers: 2` ile paralel); responsive spec'i mobil viewport'lu üçüncü proje olarak çalışır. WebKit, Safari/PWA kullanıcıları için tek gerçek doğrulama yolu. (~0,5 gün + CI süresi.)

### 🟡 Y5. Çok dillilik (EN)

- **Durum:** `i18n/index.ts` hâlâ `SupportedLocale = 'tr'`. Tip-güvenli sözlük yapısı hazır.
- **Plan:** `tr.ts` + `en.ts` sözlüklerine böl, `getLocale()`'i `navigator.language`'dan türet, `tr` fallback. ~200 string kataloğu; çeviri dış iş ~1 gün.

### 🟢 Y6. Ürün yenilikleri (önceki Bölüm 2 §5'ten — hiçbiri başlanmadı)

| # | Özellik | Durum | Maliyet | Değer |
| --- | --- | --- | --- | --- |
| 6.1 | **Zevk Anlatıcısı** — `evidence-ledger` + `profile-explainer` kanıtlarını `/api/taste/narrative` ile LLM'e verip doğal dil özeti (deterministik motor dokunulmaz, LLM yalnız sunum) | Başlanmadı | ~2 gün | ⭐⭐⭐ |
| 6.2 | **Prediktif detay ısınması** — `idle-enrichment-service`'e IntersectionObserver ön-çekme; `DetailModal`'ın 3 fetch'i önbellekten | Başlanmadı | ~1 gün | ⭐⭐ |
| 6.3 | **Ortak izleme listesi** — `data/shared/watch-party.json` + `proposedBy`/`votes`; `hybrid-merge.ts`'e oy birliği stratejisi; `.ics` zaten var | Başlanmadı | ~1 hafta | ⭐⭐⭐ |
| 6.4 | **Semantik arama** — `encoding.worker` + `mood-affinity` ile cihaz üstü indeks; Cmd+K paletinde "hüzünlü ama umut veren bilim kurgu" serbest form sorgu | Başlanmadı | ~1 hafta | ⭐⭐⭐ |
| 6.5 | **Zevk İkizi** — hash'lenmiş kanıt-ağırlık özeti paylaşımı; gizlilik korumalı benzerlik karşılaştırması | Başlanmadı | ~3-4 gün | ⭐⭐ |

### 🟢 Y7. Küçük kalıntılar (önceki raporlardan, yarım kalan)

- **İzleme süresi doğruluğu:** profil istatistiği hâlâ 110 dk/45 dk varsayımıyla hesaplanıyor; TMDB `runtime` + `episode_run_time` (`append_to_response` allowlist'te) ile gerçek veriye geçiş (~0,5 gün).
- **Fragman:** `videos` allowlist'te ama detay penceresinde gösterilmiyor; `DetailModal`'a YouTube embed (CSP'ye `https://www.youtube-nocookie.com` frame-src eklenerek) (~0,5 gün).

---

## C. Önerilen Sıra

1. **Hızlı kazanım:** Y3 (depo hijyeni, 30 dk) + Y7 (~1 gün)
2. **Y1** (UI state — en büyük borç, 3 PR)
3. **Y2** (delta yazma yolu — Y1'in 3. adımıyla aynı feature dalında olabilir)
4. **Y4 + Y5** (kapsam/dil — paralel yürütülebilir)
5. **Y6.1 → Y6.3 → Y6.4 → Y6.2 → Y6.5** (değer/iş oranına göre)

## D. Doğrulama Notu

İlk kurulumda eski `package-lock` ile `npm install` yapıldığından `fake-indexeddb` (yeni dev bağımlılığı) eksikti ve `offline-queue-durability.test.mjs` 2 test `ERR_MODULE_NOT_FOUND` ile düşüyordu; `npm ci` sonrası 405/405 yeşil. **Depo tarafında hata yok**; CI zaten `npm ci` kullandığı için etkilenmez.
