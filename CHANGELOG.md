## [Unreleased — 2026-11-15 üçüncü tur]

### P0 — Geri yükleme güvenliği (P0-01 tamamlandı)
- **P0-01-A:** Geri alma anlık görüntüsü artık RAM'de değil, `data/restore-journal/`
  altında atomik yazılan ve sha256 ile doğrulanan kayıtlarda tutuluyor. Sunucu yarıda
  kalırsa açılışta `recoverInterruptedRestores()` çalışır: `server_committed` kaydı
  önceki belgeye geri döner, `rollback_required` snapshot'tan geri alınır,
  `client_committed` yalnızca kapatılır. Yarım kalan restore bir sonraki açılışta
  sessizce "başarılı" sayılmaz.
- **P0-01-B:** İstemci commit'ten önce stok deposunu okuyamıyorsa sunucu hiç commit
  etmez. Commit sonrası zevk haritaları `flushCoreIdbWrites()` ile diske indirilir ve
  `verifyPersistentTasteMap` ile geri okunarak doğrulanır; stok yazımı da sayılarak
  geri okunur. Arşivde bulunmayan profillerin yerel zevk haritaları silinir ve silme
  doğrulanır.
- **P0-01-C:** `prepare` sırasında alınan `beforeDocumentHash`/`beforeRevision`
  commit'te karşılaştırılır; araya giren başka bir yazma varsa `409
  archive_source_changed` döner ve veri ezilmez.
- **P0-01-D:** `POST /api/archive/sqlite/restore` artık dosya kabul etmiyor; yalnızca
  `restoreId` ile çalışır, kimliksiz istek `428 archive_prepare_required` alır.
  `restoreId` tek kullanımlıktır; başarılı commit'ten sonra aynı kimlikle ikinci commit
  reddedilir.
- **P0-01-E:** Yeni `POST /api/archive/sqlite/finalize` ucu, istemci tüm depoları
  doğruladıktan sonra journal kaydını `finalized` yapar. Finalize başarısız olursa
  kullanıcıya "sunucu yeniden başlarsa önceki veriye dönebilir" uyarısı gösterilir.
  Kısmi başarısızlıkta hangi depoların kurtarılamadığı ayrı ayrı raporlanır.

### P1 — Sertleştirme ve kalite
- **P1-02:** Görsel proxy için regresyon testleri eklendi: 8 MB üstü `Content-Length`
  gövde okunmadan reddediliyor, `Content-Length` yoksa akış sırasında sınır uygulanıp
  upstream iptal ediliyor, allowlist dışı MIME reddediliyor, aynı URL için eşzamanlı
  istekler tek upstream çağrısına iniyor, 9. eşzamanlı indirme `429` alıyor ve cache
  byte muhasebesi bozulmuyor.
- **P1-01:** Sinema KünYESİ API çağrıları artık `null` yerine ayrıştırılmış sonuç
  (`ok | offline | auth | conflict | validation | server | unexpected`) döner ve sunucu
  `code`'unu korur. Beklenen çevrimdışı durumu gerçek sunucu arızasından ayrılır; arıza
  sessizce yutulmaz, `useCinemaKunye` bunu `serverSyncIssue` olarak yayınlar ve App aynı
  sorunu bir kez toast ile gösterir. Log satırı yalnızca durum/kod içerir (içerik/anahtar yok).
- **P1-03:** Arşiv geri yükleme ön izleme modalında ilk odak artık yıkıcı "Üzerine yaz"
  değil "Vazgeç".
- **P1-08:** Lint uyarıları **91 → 0** (`--max-warnings 0`, CI'daki `npm run lint` bu kapıyı
  uygular). 61 kullanılmayan import/değişken/parametre temizlendi; testlerdeki kullanılmayan
  argümanlar `_` önekiyle işaretlendi. 37 jsx-a11y uyarısı yalnızca `eslint-disable` ile
  değil gerçek semantikle çözüldü: dekoratif tıklama kapsayıcıları `role="presentation"`,
  tıklanabilir kartlar `role="button"` + `onKeyDown` (yeni `src/utils/a11y.ts`
  `activateOnKeyDown`, Enter/Space) + `tabIndex`, etiketsiz kontrollere `aria-label`,
  EvidenceModal arka planı ayrı dekoratif katmana taşındı. 4 `exhaustive-deps` uyarısı
  stale closure riskiyle incelendi; `DetailModal` alan bazlı bağımlılığa çevrildi,
  `useCinemaKunye`'de raporlama callback'i bağımlılıklara eklendi, App'te profil kimliği
  öneri anahtarına dahil edildi. Extra: `framer-motion`, `lucide-react`/`cmdk` ve `exceljs`
  ayrı vendor chunk'larına alındı: ana chunk 509,27 kB → **461,84 kB**
  (gzip 150,94 → 134,49 kB) ve 500 kB uyarısı kalktı.

### Düzeltme — SQLite arşivi oluşturma
- **Tanı:** Arşiv yazımı doğru çalışıyordu (geçerli `SQLite format 3`, 69 KB, `X-Archive-Stats`
  doğru). Hata, önizleme sunucusunun `0.0.0.0` üzerinde `CINETHOS_TOKEN` olmadan
  başlatılmasıydı: bu modda sunucu tüm mutasyonları `503 auth_required` ile reddediyor, bu
  yüzden "SQLite arşivi oluştur" da düşüyordu.
- **Düzeltme:** Yerel önizleme için `.env.local` içine `CINETHOS_TOKEN` eklendi (dosya
  gitignore'lu). Sunucu artık anahtarla başlıyor; istemci anahtarı oturum deposunda tutuyor.
- **Regresyon testi:** `SEC: SQLite arşivi oluşturma uzaktan erişim modunda anahtar ister` —
  anahtarsız `503 auth_required`, anahtar tanımlıyken headersız `401`, doğru anahtarla `200`
  ve gerçek SQLite imzası + profil/kayıt sayıları doğrulanıyor.
- **UX:** Arşiv oluşturma hatası artık `error` türünde toast ile gösteriliyor (önceden nötr).

### Testler
- `tests/archive-restore-consistency.test.mjs`: çökme kurtarma (aynı dataDir ile yeniden
  açılış), `409 archive_source_changed` yarışı, finalize sonrası rollback reddi ve
  geçerli başlıklı/bozuk sayfalı arşivin `quick_check` ile reddi.
- `tests/image-proxy-hardening.test.mjs`: yukarıdaki P1-02 senaryoları.
- `tests/api-error-policy.test.mjs`: 409/401/5xx/geçersiz gövde/ağ kesintisi sınıflandırması.
- Toplam: `npm test` **404/404**, `npm run test:taste` **362/362**, `npm run lint`
  0 hata/0 uyarı, `npm run build` uyarısız.

## [Unreleased — 2026-11-15 ikinci tur]

### P0 — Yayın öncesi güvenilirlik
- **P0-01:** SQLite geri yükleme artık `prepare → commit → rollback` akışıyla çalışıyor.
  `prepare` dosyayı okur, profil/kayıt/stok/poster sayılarını ve kanonik içerik özetini
  (sha256) döner, hiçbir veriyi değiştirmez; hazırlık 10 dakika ve tek kullanımlıktır.
  `commit` yalnızca sayılar **ve** içerik özeti eşleşirse başarı döner, aksi hâlde
  sunucudaki önceki belge otomatik geri yüklenir. İstemci yan verileri (stok, zevk
  haritası) yazamazsa `rollback` uç noktası sunucuyu da eski hâline döndürür. Poster
  `written/skipped` sayıları ayrı raporlanır; `PRAGMA quick_check` ile bütünlük doğrulanır.
- **P0-02:** `taste-api` ve `stock-import-export` ortak `apiFetch`'e taşındı; stok
  aktarımı artık sunucu hatasını yutmuyor, `serverSynced` alanıyla raporluyor.
  `core/actor-recommendations` içindeki doğrudan `fetch` de ortak istemciye geçti.
  Yeni mimari testi, `src/` içinde `/api` adresine giden doğrudan `fetch` kullanımını yakalar.
- **P0-03:** Kalıcılık doğrulaması olmayan eski senkron `enqueueOfflineSyncSnapshot`
  kaldırıldı; tüm çağrılar (testler dahil) dayanıklı sürümü kullanıyor. Kuyruk yazma ve
  silme işlemleri tek bir serializer'da sıralanıyor. `fake-indexeddb` ile IDB başarı,
  kota hatası, iki depolamanın da başarısız olması, yeniden yükleme ve enqueue/clear
  yarışı test ediliyor.
- **P0-04:** Gövde akışı `aborted`, `close` ve `error` olaylarını birlikte yönetiyor;
  yarıda kesilen yükleme promise'i asılı bırakmıyor, geçici dosya siliniyor ve restore
  kilidi `finally` ile serbest kalıyor. Boyut aşımında yanıt 413 olarak gönderildikten
  sonra soket kapatılıyor (erken `destroy` yok). Eski `restore-*`/`prepare-*` dosyaları
  için başlangıç temizliği eklendi.
- **P0-05:** Güvenlik işi artık **bloklayıcı**: `npm audit --omit=dev --audit-level=high`.
  Orta/düşük bulgular ayrı, bloklamayan `audit-report` işinde raporlanıyor; kabul edilen
  istisnalar `docs/SECURITY-AUDIT.md` içinde kök neden ve hedef çözümle kayıtlı. GitHub
  Actions adımları Node 20 uyarısını kapatacak şekilde v5'e yükseltildi.
- **P0-06:** CI'a üretim smoke testi geri geldi: build → `npm prune --omit=dev` →
  `NODE_ENV=production npm start`, health/`tmdb-status`/SPA deep link/SQLite yeteneği
  kontrolü ve SIGTERM ile temiz kapanış doğrulaması.

### P1 — Güvenlik ve UX sertleştirmesi
- **P1-02:** Görsel proxy'si upstream yanıtı artık akış sırasında 8 MB ile sınırlıyor
  (`Content-Length` varsa okumadan reddediyor), MIME allowlist uyguluyor, aynı URL için
  uçuştaki isteği paylaşıyor ve eşzamanlı indirmeleri 8 ile sınırlıyor.
- **P1-03:** `AuthTokenModal` ortak `useDialogAccessibility` kancasını kullanıyor: odak
  tuzağı, Escape, kapanışta odak geri yükleme. Anahtar kaydedilmeden önce doğrulanıyor;
  reddedilirse alan yanında `role="alert"` hatası gösteriliyor (anahtar loglanmıyor).
- **P1-04:** `ProfileBackupTab` dosya seçiminde artık veri değiştirmiyor: arşiv ön izleme
  modalı profil/kayıt/stok/zevk haritası/poster sayılarını, arşiv tarihini, şema sürümünü,
  mevcut veriyle farkı ve içerik özetini gösteriyor; geri yükleme yalnızca açık onaydan
  sonra başlıyor.

## [Unreleased]

### Güvenlik ve veri bütünlüğü
- **SEC-01:** `/api` mutasyonları gövde ayrıştırılmadan önce origin + token doğrulamasından geçiyor; SQLite arşivi geri yüklemesi artık 256 MB gövdeyi belleğe almıyor, diske akıtılıyor (sınır 256 MB, tek eşzamanlı geri yükleme).
- **DATA-01:** Çevrimdışı kuyruk yazımı IndexedDB → localStorage (geri okuma doğrulamalı) → bellek sırasıyla yapılıyor; yazma tamamlanmadan `persisted: true` dönmüyor.
- **DATA-02:** SQLite geri yükleme aşamalı: sunucu tarafında profil/kayıt sayısı doğrulanıyor, istemcide zevk haritaları ve stok kalıcılığı kontrol ediliyor; kısmi başarı artık "tam geri yükleme" olarak gösterilmiyor.
- **SEC-04:** Offline kuyrukta 5 denemeli üstel geri çekilme (2 sn → 5 dk) ve `OfflineIndicator` üzerinde "Yeniden dene" düğmesi.
- **SEC-05:** `/api/tmdb-image` artık rate limiter'a dahil; görsel önbelleği 64 MB bayt bütçeli LRU.
- **SEC-02 / SEC-03:** `ApiError` + `apiFetch` (sessionStorage token, `cinethos:auth-required`), LAN modu için erişim anahtarı istemi, yakalanmamış söz redlerinin bildirime dönüşmesi.
- Rate limiter tahliyesi LRU'ya çevrildi (IP rotasyonu meşru istemciyi atamaz).
- Graf: `no-empty` kuralı sıkılaştırıldı (66 boş catch gerekçelendirildi), zod `^4.6.6` override'ı ve Dependabot eklendi.

### Erişilebilirlik, UX ve performans
- **UX-01:** Toast kuyruğu: mesajlar birbirini ezmiyor, hatalar `role="alert"` ve elle kapatılabilir.
- **A11Y-01/02:** `label-has-associated-control`, `click-events-have-key-events`, `no-noninteractive-tabindex`, `heading-has-content`, `control-has-associated-label` kuralları açıldı; `prefers-reduced-motion` desteği eklendi.
- **PERF-01:** Kartlarda `content-visibility: auto` ile ekran dışı boyama erteleniyor.
- **ARCH-03:** Poster çözümü tek modülde (`src/core/media/poster.ts`).
- **OPS-01:** SIGTERM/SIGINT için güvenli kapanış (zamanlayıcı temizliği, eşitleme bitişi, 10 sn zorla çıkış).
- **CI-01:** Kalite (lint/test/build), E2E ve güvenlik denetimi ayrı işler olarak `.github/workflows/ci.yml` içinde.

# Changelog

Tüm önemli değişiklikler bu dosyada tutulur. Sürümleme [Semantic Versioning](https://semver.org/) esas alır.

## [Unreleased]

### Güvenlik
- `body-parser` 2.4.0'a yükseltildi (GHSA-27r3-jxmh-p828, high DoS); CI üretim audit adımı yeniden yeşil.

### Değişen
- Monolit bölme ikinci dilim: `cinethos-core.ts` 5539 → 4691 satır; aktör öneri motoru `actor-recommendations.ts`, puan matematiği `rating-math.ts` ve tür eşleştirme `genre-matching.ts` modüllerine taşındı. Çekirdek, geriye dönük uyumluluk için yeniden dışa aktarır.

## [1.1.0] - 2026-11-09

### Güvenlik
- Üretim CSP'si sıkılaştırıldı: `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`; dev modunda Vite HMR için ayrı politika.
- Uzak (loopback dışı) bağlanmalarda kişisel GET uçları `CINETHOS_TOKEN` ile korunuyor.
- Faz 0 bulgularındaki kişisel veriler ve `.bolt/` yapılandırması kaldırıldı.

### Değişen
- Stil sistemi tek girişe toplandı: `src/index.css` + `src/styles/*`; kök `style.css` ve ölü `tailwind.config.js` kaldırıldı.
- Film greni ve font yüklemesi tekilleştirildi.
- `--text-3` kontrastı WCAG AA'ya yükseltildi (`#7b808b`); `jsx-a11y/alt-text` kuralı hata seviyesine alındı.
- Çekirdek, aday havuzu kalıcılığından port/adaptör ile ayrıldı; halka yaşam döngüsü `ring-lifecycle.ts` modülüne taşındı.
- Kompakt kullanıcı listesi artık başlık, poster ve çıkış tarihi taşıyor; profil değişimi sırasında async sonuçlar profil kimliğiyle doğrulanıyor.
- Marka adı tek kaynağa taşındı (`src/shared/brand.ts`): PWA manifesti, HTML başlıkları, dışa aktarma dosya adları ve sunucu User-Agent değerleri buradan türetiliyor.
- ≤480px üst çubukta profil adı, Ekle etiketi ve kaynak rozeti daraltılarak yatay taşma giderildi.

### Eklenen
- Çevrimdışı değerlendirme raporuna Save@K, NDCG@K, novelty ve diversity metrikleri; deterministik `now` parametresi.
- `npm run test:taste` CI hattına eklendi.
- Playwright E2E altyapısı: çevrimdışı yeniden yükleme, sunucu çakışması, hızlı profil değişimi ve 6 çözünürlüklü responsive testleri; CI'da ayrı `e2e` işi.
- Docker imajı (`Dockerfile`) ve `.dockerignore`.
- Öneri değerlendirme raporları için etiketli (ground truth) testler.

## [1.0.0] - 2026-11-09

### Eklenen
- Taste Engine v1.0: 37 metrikli taksonomi, kanıt defteri ve güven hesaplayıcıları.
- TMDB destekli keşif, kişisel kütüphane, GitHub yedekleme ve çoklu profil desteği.
