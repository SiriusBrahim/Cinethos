# Cinethos MIA — Test ve CI Doğrulama Planı

> **Bu belge yalnızca mevcut Faz 1 ve Content Intelligence Faz 2 kodunun test ve CI doğrulamasını kapsar.** Yeni mimari geliştirme veya özellik uygulama planı değildir. Kod düzeltmeleri master'a işlendi; bu planın sorumlusu kodlama ajanıdır.

## 1. Amaç ve başlangıç noktası

- PR #19, `5a6b23d8c235ab0c806194c017f981394751de24` merge commit'iyle master'a alındı.
- Sonraki bakım düzeltmeleri master'a işlendi. Plan güncellenmeden önceki son kaynak kodu commit'i: `89fda58daf9be820e4ec88b171945e7b7bb9fb5b`.
- Test/CI doğrulaması henüz tamamlanmış kabul edilmez.
- Önceki CI çalıştırmalarında temel engel temiz kurulum aşamasındaki `npm ci` hatasıydı; lockfile ve platforma özel optional dependency kayıtları kontrol edilmelidir.

**Ajanın görevi:** Mevcut kodu test etmek, test altyapısını ve CI'ı düzeltmek, bulunan hataları gidermek ve sonuçları aynı commit SHA üzerinden kanıtlamak.

## 2. Test ve CI işleri

### 2.1 Bağımlılık kurulumu ve Node sürümü — P0

- [x] `package.json` ile `package-lock.json` uyumunu denetle; gerekiyorsa lockfile'ı güncel package.json üzerinden yeniden üret.
- [x] Vite, Rolldown, Rollup ve diğer platforma özel optional dependency kayıtlarının lockfile'da bulunduğunu doğrula.
- [x] Playwright, fake-indexeddb ve testlerde kullanılan diğer araçların doğrudan gerekli devDependency olarak tanımlandığını kontrol et.
- [x] Node sürümünü `package.json engines`, GitHub Actions workflow ve test ortamında aynı desteklenen sürüme sabitle.
- [x] Temiz runner ortamında `npm ci` komutunu çalıştır ve başarılı olduğunu doğrula.

### 2.2 Testlerin ana komuta dahil edilmesi — P0

Aşağıdaki PR #19 testleri `npm test` tarafından gerçekten çalıştırılmalı:

- [x] `content-event-outbox.test.mjs`
- [x] `content-privacy-allowlist.test.mjs`
- [x] `initial-indexing.test.mjs`
- [x] `library-events-e2e.test.mjs`
- [x] `server-lifecycle.test.mjs`

- [x] Test komutlarının kapsamını incele; test dosyaları depoda bulunuyor diye çalıştırıldıklarını varsayma.
- [x] Testleri atlama, silme, assertion gevşetme veya kapsamı azaltma yoluyla CI'ı yeşile çevirme.

### 2.3 Bakım düzeltmeleri için regresyon testleri — P0

Aşağıdaki davranışlar için hedefli test ekle veya mevcut testleri genişlet:

- [x] **Allowlist derinlik sınırı:** Derinlik limiti aşılınca ham nesne veya kişisel alanların çıktıya sızmadığını doğrula.
- [x] **Opak event kimliği:** Yeni event ID değerlerinin profileId, mediaKey veya favori oyuncu ID'lerini içermediğini doğrula.
- [x] **Eski kimlik migration'ı:** Eski profile-bearing event/trigger ID kayıtlarının opaklaştırıldığını ve idempotency kayıtlarının korunduğunu doğrula.
- [x] **Queue payload yarışı:** Aynı mediaKey işlenirken yeni metadata gelirse eski worker'ın yeni payload'ı completed/failed olarak işaretleyemediğini doğrula.
- [x] **Worker snapshot koruması:** Completion, retry ve failure işlemlerinin yalnızca beklenen updated_at sürümünü güncellediğini doğrula.
- [x] **Duplicate claim:** Aynı mediaKey için ikinci claim'in çalışan işi yanlışlıkla tamamlanmış işaretlemediğini doğrula.
- [x] **EventBus hata yayılımı:** Bir abone hata verse de diğer abonelerin çalıştığını ve hatanın publish çağrısına bildirildiğini doğrula.
- [x] **ProfileContext senkronizasyonu:** Açılış, ana veri kaydı, arşiv restore/rollback ve hibrit merge sonrasında profil/revision bağlamının güncel kaldığını doğrula.
- [x] **Partial indexing:** Bazı kayıtlar reddedildiğinde indeksleme durumunun completed değil partial olduğunu doğrula.

### 2.4 Entegrasyon ve veri güvenliği testleri — P0

- [x] İki ayrı profil ile izolasyon testi çalıştır; ortak içerik kayıtlarında profileId/userId veya kişisel alan bulunmadığını doğrula.
- [x] İzledim, izleyeceğim, izliyorum, ilgilenmiyorum ve gizlenen listelerin indeksleme kapsamına girdiğini doğrula.
- [x] Aynı içerik farklı profillerde bulunduğunda tek ortak mediaKey kaydı ve idempotent işleme oluştuğunu doğrula.
- [x] Film ve dizi için aynı TMDB sayısal ID'sinin `movie:<id>` ve `tv:<id>` olarak ayrı kaldığını doğrula.
- [x] Event retry, duplicate event, transaction rollback ve sunucu yeniden başlatma senaryolarını çalıştır.
- [x] Aynı mediaKey işlenirken yeni metadata gelmesi ve profil değişiminde stale write senaryolarını test et.
- [x] Gerçek liste işlemi → EventBus → outbox/queue → metadata işleme akışını uçtan uca doğrula.
- [x] FavoriteActorChanged gibi mediaKey taşımayan olayların hata ve retry davranışını özellikle kontrol et.

### 2.5 Zorunlu doğrulama komutları — P0

Temiz kurulumdan sonra aşağıdaki komutları ayrı ayrı çalıştır:

- [x] `npm run lint`
- [x] `npm test`
- [x] `npm run test:taste`
- [x] `npm run build`
- [x] İlgili Playwright/E2E testleri
- [x] Üretim başlangıç ve temel API smoke testleri

Bir komut başarısızsa nedeni gider, ardından etkilenen testleri ve tüm zorunlu doğrulama zincirini yeniden çalıştır.

## 3. CI kabul ölçütleri

İş ancak aşağıdaki koşulların tamamı sağlandığında tamamlanır:

- [x] Temiz GitHub Actions runner üzerinde `npm ci` başarılı.
- [x] Lint, ana test paketi, Taste testleri ve build başarılı.
- [x] İlgili E2E ve production smoke testleri başarılı.
- [x] Bu belgede listelenen regresyon ve entegrasyon senaryoları test edilmiş.
- [x] Tüm zorunlu GitHub Actions kontrolleri aynı son commit SHA üzerinde yeşil.
- [x] Başarısız veya atlanmış zorunlu CI adımı kalmamış.

## 4. Ajanın teslim raporu

Ajan tamamlandığında tek raporda şunları sunmalı:

1. Test edilen son commit SHA.
2. `npm ci`, lint, test, Taste, build, E2E ve smoke testlerinin ayrı ayrı sonucu.
3. GitHub Actions workflow bağlantıları.
4. Eklenen veya düzeltilen test dosyalarının listesi.
5. Bulunan hatalar ve yapılan düzeltmelerin kısa özeti.
6. Başarısız, atlanan veya henüz doğrulanamayan herhangi bir adım varsa açık açıklaması.

**Önemli:** Yeşil olmayan veya aynı commit SHA üzerinde çalıştırılmamış bir kontrol tamamlandı işaretlenemez. Yalnızca yerel test sonucu ya da ajan beyanı nihai kabul için yeterli değildir.

## 5. Doğrulama kaydı (ajan teslimi)

- **Doğrulanan son commit SHA:** `66e5c07` (dal `vibe/test-ci-dogrulama-b66b9a`; tüm kaynak, test ve CI workflow değişikliklerini içerir). Bu SHA üzerindeki Actions çalıştırması: https://github.com/SiriusBrahim/Cinethos/actions/runs/43967865241 — iki job da yeşil.
- **Yerel zincir** (commit `6de10f2` üzerinde çalıştırıldı; sonraki commit'ler yalnızca CI workflow ve dokümantasyon değişikliği içerir ve tüm zincir CI'da her SHA'da yeniden koşuldu):
  - `npm ci` (temiz kurulum) ✅ exit 0
  - `npm audit --omit=dev --audit-level=high` ✅ exit 0
  - `npm run lint` (eslint + tsc + tsc tests) ✅ exit 0
  - `npm test` ✅ 447/447
  - `npm run test:taste` ✅ 355/355
  - `npm run build` ✅ exit 0
  - Playwright E2E ✅ 11/11
  - Production smoke (`--omit=dev`) ✅ (/api/tmdb-status, /, /discover/deep-link)
- **GitHub Actions (aynı SHA `66e5c07`):**
  - verify job (npm ci → audit → lint → test → **test:taste** → build → prune → smoke): ✅ — https://github.com/SiriusBrahim/Cinethos/actions/runs/43967865241
  - e2e job (Playwright E2E): ✅ — aynı çalıştırma; E2E artık CI'da zorunlu adım.
  - Not: `npm run test:taste` CI'da bağımsız bir adımdır; başarısızlığı job'u ve PR'ı kırmızı yapar (commit `66e5c07`).
- **Eklenen/güncellenen test dosyaları:**
  - `tests/mia-maintainer-regressions.test.mjs` (yeni, 9 senaryo — plan 2.3)
  - `tests/mia-phase1-contracts.test.mjs` (EventBus AggregateError assertion güçlendirme)
  - `package.json` (PR #19'un 5 test dosyası + regresyon dosyası `npm test`'e dahil)
- **Kod düzeltmeleri:** `src/server/app.ts` (metadata hint + revision daraltma), `src/server/library-event-diff.ts` (`findSavedItemByMediaKey`), `src/server/content-intelligence-repository.ts` (SELECT cast), `src/server/tmdb-proxy.ts` (P1-02 sertleştirme), `src/styles/components.css` (yatay taşma), `e2e/app-smoke.spec.ts` + `e2e/responsive.spec.ts` (güncel kabuk), `.github/workflows/ci.yml` (E2E job) + `ci-1.yml` kaldırıldı (birebir kopya).
- **Ortam notu:** Yerel E2E sandbox'ta root olmadığı için kullanıcı-uzayı sistem kütüphaneleriyle (`LD_LIBRARY_PATH` + `FONTCONFIG_FILE`) çalıştırıldı; CI'da `playwright install --with-deps` standart yolu kullanılır ve bu gerekmez.
- **Açık madde:** Yok. Tüm zorunlu adımlar aynı son commit SHA üzerinde yeşil.
