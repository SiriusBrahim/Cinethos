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

- [ ] `package.json` ile `package-lock.json` uyumunu denetle; gerekiyorsa lockfile'ı güncel package.json üzerinden yeniden üret.
- [ ] Vite, Rolldown, Rollup ve diğer platforma özel optional dependency kayıtlarının lockfile'da bulunduğunu doğrula.
- [ ] Playwright, fake-indexeddb ve testlerde kullanılan diğer araçların doğrudan gerekli devDependency olarak tanımlandığını kontrol et.
- [ ] Node sürümünü `package.json engines`, GitHub Actions workflow ve test ortamında aynı desteklenen sürüme sabitle.
- [ ] Temiz runner ortamında `npm ci` komutunu çalıştır ve başarılı olduğunu doğrula.

### 2.2 Testlerin ana komuta dahil edilmesi — P0

Aşağıdaki PR #19 testleri `npm test` tarafından gerçekten çalıştırılmalı:

- [ ] `content-event-outbox.test.mjs`
- [ ] `content-privacy-allowlist.test.mjs`
- [ ] `initial-indexing.test.mjs`
- [ ] `library-events-e2e.test.mjs`
- [ ] `server-lifecycle.test.mjs`

- [ ] Test komutlarının kapsamını incele; test dosyaları depoda bulunuyor diye çalıştırıldıklarını varsayma.
- [ ] Testleri atlama, silme, assertion gevşetme veya kapsamı azaltma yoluyla CI'ı yeşile çevirme.

### 2.3 Bakım düzeltmeleri için regresyon testleri — P0

Aşağıdaki davranışlar için hedefli test ekle veya mevcut testleri genişlet:

- [ ] **Allowlist derinlik sınırı:** Derinlik limiti aşılınca ham nesne veya kişisel alanların çıktıya sızmadığını doğrula.
- [ ] **Opak event kimliği:** Yeni event ID değerlerinin profileId, mediaKey veya favori oyuncu ID'lerini içermediğini doğrula.
- [ ] **Eski kimlik migration'ı:** Eski profile-bearing event/trigger ID kayıtlarının opaklaştırıldığını ve idempotency kayıtlarının korunduğunu doğrula.
- [ ] **Queue payload yarışı:** Aynı mediaKey işlenirken yeni metadata gelirse eski worker'ın yeni payload'ı completed/failed olarak işaretleyemediğini doğrula.
- [ ] **Worker snapshot koruması:** Completion, retry ve failure işlemlerinin yalnızca beklenen updated_at sürümünü güncellediğini doğrula.
- [ ] **Duplicate claim:** Aynı mediaKey için ikinci claim'in çalışan işi yanlışlıkla tamamlanmış işaretlemediğini doğrula.
- [ ] **EventBus hata yayılımı:** Bir abone hata verse de diğer abonelerin çalıştığını ve hatanın publish çağrısına bildirildiğini doğrula.
- [ ] **ProfileContext senkronizasyonu:** Açılış, ana veri kaydı, arşiv restore/rollback ve hibrit merge sonrasında profil/revision bağlamının güncel kaldığını doğrula.
- [ ] **Partial indexing:** Bazı kayıtlar reddedildiğinde indeksleme durumunun completed değil partial olduğunu doğrula.

### 2.4 Entegrasyon ve veri güvenliği testleri — P0

- [ ] İki ayrı profil ile izolasyon testi çalıştır; ortak içerik kayıtlarında profileId/userId veya kişisel alan bulunmadığını doğrula.
- [ ] İzledim, izleyeceğim, izliyorum, ilgilenmiyorum ve gizlenen listelerin indeksleme kapsamına girdiğini doğrula.
- [ ] Aynı içerik farklı profillerde bulunduğunda tek ortak mediaKey kaydı ve idempotent işleme oluştuğunu doğrula.
- [ ] Film ve dizi için aynı TMDB sayısal ID'sinin `movie:<id>` ve `tv:<id>` olarak ayrı kaldığını doğrula.
- [ ] Event retry, duplicate event, transaction rollback ve sunucu yeniden başlatma senaryolarını çalıştır.
- [ ] Aynı mediaKey işlenirken yeni metadata gelmesi ve profil değişiminde stale write senaryolarını test et.
- [ ] Gerçek liste işlemi → EventBus → outbox/queue → metadata işleme akışını uçtan uca doğrula.
- [ ] FavoriteActorChanged gibi mediaKey taşımayan olayların hata ve retry davranışını özellikle kontrol et.

### 2.5 Zorunlu doğrulama komutları — P0

Temiz kurulumdan sonra aşağıdaki komutları ayrı ayrı çalıştır:

- [ ] `npm run lint`
- [ ] `npm test`
- [ ] `npm run test:taste`
- [ ] `npm run build`
- [ ] İlgili Playwright/E2E testleri
- [ ] Üretim başlangıç ve temel API smoke testleri

Bir komut başarısızsa nedeni gider, ardından etkilenen testleri ve tüm zorunlu doğrulama zincirini yeniden çalıştır.

## 3. CI kabul ölçütleri

İş ancak aşağıdaki koşulların tamamı sağlandığında tamamlanır:

- [ ] Temiz GitHub Actions runner üzerinde `npm ci` başarılı.
- [ ] Lint, ana test paketi, Taste testleri ve build başarılı.
- [ ] İlgili E2E ve production smoke testleri başarılı.
- [ ] Bu belgede listelenen regresyon ve entegrasyon senaryoları test edilmiş.
- [ ] Tüm zorunlu GitHub Actions kontrolleri aynı son commit SHA üzerinde yeşil.
- [ ] Başarısız veya atlanmış zorunlu CI adımı kalmamış.

## 4. Ajanın teslim raporu

Ajan tamamlandığında tek raporda şunları sunmalı:

1. Test edilen son commit SHA.
2. `npm ci`, lint, test, Taste, build, E2E ve smoke testlerinin ayrı ayrı sonucu.
3. GitHub Actions workflow bağlantıları.
4. Eklenen veya düzeltilen test dosyalarının listesi.
5. Bulunan hatalar ve yapılan düzeltmelerin kısa özeti.
6. Başarısız, atlanan veya henüz doğrulanamayan herhangi bir adım varsa açık açıklaması.

**Önemli:** Yeşil olmayan veya aynı commit SHA üzerinde çalıştırılmamış bir kontrol tamamlandı işaretlenemez. Yalnızca yerel test sonucu ya da ajan beyanı nihai kabul için yeterli değildir.
