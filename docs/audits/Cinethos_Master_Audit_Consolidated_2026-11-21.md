# Cinethos — Birleştirilmiş Teknik İnceleme Raporu

**Rapor tarihi:** 21 Kasım 2026  
**İncelenen depo:** `SiriusBrahim/Cinethos`  
**Hedef dal:** `master`  
**Rapor durumu:** İki bağımsız AI incelemesinin birleştirilmiş değerlendirmesi; üçüncü inceleme bekleniyor.  
**Önemli not:** Bu belge, kaynak kod üzerinde yeniden çalıştırılmış bir doğrulama raporu değildir. Aşağıdaki bulgular Qwen ve Mistral raporlarından derlenmiş, tekrarlar birleştirilmiş ve önceliklendirilmiştir. Kod düzeyinde doğrulama ve güncellik kontrolü gerektirir.

---

## 1. Yönetici özeti

İki raporda ortaklaşan genel değerlendirme, Cinethos'un temel mimari katmanlarının ve veri/senkronizasyon altyapısının önemli ölçüde oluşturulmuş olduğudur. Öne çıkan risk, normal çalışma akışından çok **çatışma, eşzamanlılık, hata kurtarma ve veri kaybı senaryolarındaki davranışlardır**.

Birleştirme sonucunda:

| Öncelik | Bulgu sayısı | Anlamı |
|---|---:|---|
| P1 | 6 | Veri kaybı, güvenlik veya kullanıcı güveni açısından önce doğrulanması gereken kritik konular |
| P2 | 11 | Mimari sağlamlık, güvenlik sertleştirmesi, tutarlılık ve performans konuları |
| P3 | 3 | Düşük öncelikli bakım ve kullanılabilirlik konuları |
| **Toplam** | **20** | Yinelenen bulgular birleştirilmiştir |

Bu sayılar, raporların birleştirilmesi sırasında verilen önceliklendirmedir; henüz bağımsız testlerle doğrulanmış hata sayısı değildir.

### En kritik alanlar

1. Senkronizasyon çatışmalarında yerel veya uzak verinin geri döndürülemez biçimde ezilmesi.
2. Eşzamanlı cihaz değişikliklerinde koleksiyon ve alanların yerel-otoriter son-yazan-kazan yaklaşımıyla kaybolabilmesi.
3. Profil birleştirme sırasında geçersiz profil kimliğinin sessizce elenmesi.
4. GitHub token yenileme sürecinde çalışma zamanında `.env` dosyasına yazılması.
5. Profil çakışması ve çevrimdışı kuyruk işlemlerinde kullanıcıya başarı/başarısızlık durumunun yanlış yansıtılabilmesi.

---

## 2. İnceleme kapsamı ve sürüm farklılığı

İki AI raporunun aynı kaynak kod sürümünü incelediği doğrulanamamıştır:

| Rapor | İncelediği commit |
|---|---|
| Qwen | `14a2466` |
| Mistral | `11824de3f283ec9662e6d9a3feea9cbbaf864a4f` |

Mistral raporundaki commit, PR #63'ün birleştirme commit'i olarak kaydedilmiştir. İnceleme sırasında `master` dalının görülen commit'i de:

`11824de3f283ec9662e6d9a3feea9cbbaf864a4f`

Bu nedenle Qwen bulgularının bir kısmı PR #63 öncesi koda ait olabilir. Üçüncü incelemede ilk iş, güncel `master` SHA'sını sabitlemek ve her bulguyu bu sürüm üzerinde yeniden kontrol etmek olmalıdır.

**Kanıt seviyesi:** Bu rapor, kaynak raporlarda belirtilen dosya ve davranışları aktarır. Kaynak kodda ilgili satırların güncel durumda hâlâ mevcut olduğunu tek başına kanıtlamaz.

---

## 3. P1 — Kritik öncelikli bulgular

### P1-01 — GitHub token yenileme sırasında çalışma zamanında `.env` dosyasına yazılması

- **Kaynak raporlar:** Qwen F01, Mistral B7
- **İlgili dosyalar:** `server.ts`, `src/server/github-token-refresh.ts`
- **Risk:** Uygulama çalışırken `.env` dosyasının değiştirilmesi salt okunur dağıtımlarda `EACCES` hatasına, eşzamanlı yazımlarda yarış durumuna veya dosya bozulmasına yol açabilir. Token'ın düz metin olarak dosyada tutulması ayrıca gizlilik riski yaratır.
- **Önerilen doğrulama/çözüm:**
  1. Çalışma zamanında `.env` yazma ihtiyacını kaldırın.
  2. Token yenileme bilgisini uygun bir secret store veya güvenli, izinleri sınırlandırılmış depolama katmanında tutun.
  3. Yenileme işlemini kilitleyin; eşzamanlı yenileme isteklerinin birbirini ezmesini engelleyin.
  4. Zorunlu dosya yazımlarında atomik güncelleme ve kurtarma yaklaşımı kullanın.
  5. Loglarda token ve hassas başlıkların maskelendiğini test edin.
- **Önerilen testler:** Salt okunur dosya sistemi, eşzamanlı token yenileme, yarım kalan yazma, süreç yeniden başlatma ve log sızıntısı testleri.

### P1-02 — Profil çatışmasının arayüzde sessiz veya yetersiz ele alınması

- **Kaynak rapor:** Qwen F02
- **İlgili dosyalar:** `src/server/storage.ts`, `App.tsx`
- **Risk:** Sunucu `profile_conflict` döndürdüğünde arayüzün bu sonucu açıkça göstermemesi, kullanıcının kaydetme işleminin başarılı olduğunu sanmasına neden olabilir.
- **Önerilen doğrulama/çözüm:**
  1. Çakışma durumunu başarı durumundan kesin olarak ayırın.
  2. Kullanıcıya hangi profilin/işlemin çakıştığını ve verinin kaydedilip kaydedilmediğini açıkça gösterin.
  3. Yeniden deneme öncesi sunucu durumunu tekrar okuyun.
  4. Başarısız kayıtları başarılı kayıt gibi işaretlemeyin.
- **Önerilen testler:** API'nin `profile_conflict` döndürdüğü durumda UI mesajı, kayıt durumu, tekrar deneme ve veri tutarlılığı.

### P1-03 — Profil birleştirmede geçersiz profil kimliğinin sessizce elenmesi

- **Kaynak rapor:** Mistral B1
- **İlgili dosya:** `src/core/user-data-merge.ts`
- **Risk:** `normalizeProfiles` içindeki `flatMap` yaklaşımının geçersiz profil ID'lerini sessizce atması, o profile bağlı verilerin de fark edilmeden kaybolmasına yol açabilir.
- **Önerilen doğrulama/çözüm:**
  1. Geçersiz profil kayıtlarını sessizce silmek yerine hata/uyarı raporuna alın.
  2. Mümkünse güvenli bir normalizasyon veya kurtarma stratejisi uygulayın.
  3. Otomatik düzeltilemeyen kayıtları karantinaya alarak ham veriyi koruyun.
  4. Kullanıcıya hangi kayıtların içe alınamadığını bildirin.
- **Önerilen testler:** Boş, hatalı biçimli, yinelenen ve referansları bozuk profil ID'leriyle merge testleri.

### P1-04 — “Sunucu verisini kullan” seçeneğinin yerel veriyi geri döndürülemez biçimde ezebilmesi

- **Kaynak rapor:** Mistral B2
- **İlgili dosya:** `src/hooks/useServerSyncCoordinator.ts`
- **İlgili akış:** `handleUseServerOnConflict` → `applyDataDocumentToState(serverConflict.serverDocument)`
- **Risk:** Sunucu belgesinin doğrudan duruma uygulanması, yalnızca yerelde bulunan kayıtların kaybolmasına neden olabilir.
- **Önerilen doğrulama/çözüm:**
  1. İşlem öncesi yerel veri anlık görüntüsünü alın.
  2. Etkilenecek kayıtları ve silinecek/ezilecek öğeleri kullanıcıya gösterin.
  3. Geri alma (undo) veya önceki anlık görüntüye dönme olanağı sağlayın.
  4. İşlemi denetim günlüğüne yazın.
  5. Seçeneğin gerçekten “sunucuyu olduğu gibi uygula” anlamına geldiğini açıkça belirtin.
- **Önerilen testler:** Yalnızca yerelde bulunan kayıtların işlem öncesi/sonrası karşılaştırılması ve geri yükleme.

### P1-05 — “Yereli koru” seçeneğinin uzak veriyi merge etmeden ezebilmesi

- **Kaynak rapor:** Mistral B3
- **İlgili dosya:** `src/hooks/useServerSyncCoordinator.ts`
- **İlgili akış:** `handleKeepLocalOnConflict`; `forceOverwrite: true`, `confirmBulkDelete: true`
- **Risk:** Yerel verinin zorla uzak sunucuya yazılması, diğer cihazda yapılmış değişiklikleri kaybettirebilir.
- **Önerilen doğrulama/çözüm:**
  1. Ortak temel revizyon üzerinden üç yönlü merge (three-way merge) uygulayın.
  2. Yerel eklemeleri, uzak eklemeleri ve silmeleri ayrı değerlendirin.
  3. Gerçek çakışmaları kullanıcıya alan/kayıt bazında çözdürün.
  4. Toplu ezme işlemi öncesi yedek ve geri alma mekanizması sağlayın.
- **Önerilen testler:** İki cihazın aynı anda farklı kayıt eklemesi, aynı kaydı değiştirmesi ve farklı kayıtları silmesi.

### P1-06 — Eşzamanlı değişikliklerde alan/koleksiyonların yerel-otoriter LWW ile kaybolması

- **Kaynak rapor:** Mistral B4
- **İlgili dosya:** `src/core/user-data-merge.ts`
- **Raporda belirtilen alanlar:** `disliked`, `hidden`, `providers`, `mood`, `reminders`, `favoriteActors`, profil adı, `isDemo`
- **Risk:** Farklı cihazlarda eşzamanlı yapılan değişiklikler, yerel-otoriter son-yazan-kazan (LWW) davranışı nedeniyle diğer cihazın değişikliğini silebilir. Örneğin bir cihazda favoriye eklenen oyuncu, diğer cihazın eski koleksiyonuyla değiştirilebilir.
- **Önerilen doğrulama/çözüm:**
  1. Alan türüne göre merge semantiği tanımlayın.
  2. Koleksiyonlarda ekleme ve çıkarma işlemlerini ayrı izleyin.
  3. Gerekli alanlarda revizyon/zaman damgası veya operasyon tabanlı değişiklik kaydı kullanın.
  4. Silme ve ekleme çakışmalarının önceliğini açıkça belirleyin.
- **Önerilen testler:** İki cihazda farklı favori ekleme/silme, farklı gizleme/engelleme değişiklikleri ve eşzamanlı profil alanı düzenlemeleri.

---

## 4. P2 — Orta öncelikli bulgular

### P2-01 — Core katmanında saflık ve mimari sınır ihlalleri

- **Kaynak raporlar:** Qwen F03, Mistral B12
- **İlgili dosyalar:** `src/core/cinetrack-core.ts`, `src/core/keys.ts`, `tests/architecture-boundaries.test.mjs`
- **Raporlanan durum:** Core katmanında `idb-keyval` ve `api-client.ts` bağımlılıkları, beş allowlist sınır istisnası ve 16'dan fazla core dosyasında `any` kullanımı.
- **Risk:** İş kurallarının depolama/ağ bağımlılıklarıyla iç içe geçmesi test edilebilirliği ve taşınabilirliği azaltır.
- **Öneri:** IO işlemlerini servis/adaptör katmanına taşıyın; core'da arayüz/port kullanın; `any` kullanımını `unknown`, açık tipler ve generic yapılarla kademeli azaltın; allowlist'i küçültün.
- **Test:** Mimari sınır testleri ve core'un tarayıcı/IO bağımlılıkları olmadan çalıştırılabilmesi.

### P2-02 — Silme tombstone kayıtlarının 30 gün tutulması

- **Kaynak rapor:** Qwen F04
- **İlgili alan:** `deleted_keys`
- **Risk:** Senkronizasyon için gerekli silme işaretleri, kullanıcı tarafından verinin tamamen silindiği şeklinde anlaşılabilir.
- **Öneri:** Soft delete ile senkronizasyon tombstone'unu kavramsal olarak ayırın; saklama süresini ve temizleme davranışını açıklayın; gerekiyorsa yapılandırılabilir tutma süresi ve kalıcı silme akışı sağlayın.
- **Test:** Tombstone'un diğer cihazlara yayılması, süre sonunda temizlenmesi ve silinen içeriğin geri gelmemesi.

### P2-03 — Tarih alanlarında `updatedAt` / `watchedAt` karışıklığının eski veriye etkisi

- **Kaynak rapor:** Qwen F05
- **İlgili test:** `phase3-item-dates.test.mjs`
- **Risk:** Geçmişte `updatedAt` değerinin izlenme tarihi gibi kullanılmış olması, eski kayıtlarda ve Taste Engine'in zamansal ağırlıklandırmasında hatalı sonuç oluşturabilir.
- **Öneri:** `addedAt`, `updatedAt` ve `watchedAt` alanlarını kesin biçimde ayırın; eski veriler için kontrollü migration/validasyon yapın.
- **Test:** Eski şema örnekleri, eksik tarih, zaman dilimi ve migration sonrası Taste Engine ağırlıkları.

### P2-04 — Eski çevrimdışı kuyruk API'sinin yarış durumunu yeniden açabilmesi

- **Kaynak rapor:** Mistral B5
- **İlgili dosya:** `src/services/offline-queue.ts`
- **Risk:** Yeni `enqueueOfflineSyncForProfile` seri yazım yaklaşımını kullanırken eski `enqueueOfflineSyncSnapshot` doğrudan IndexedDB yazıyorsa ortak kilit/seri işlem garantisi bozulabilir.
- **Öneri:** Eski API'yi kaldırın veya yeni seri kuyruk katmanına delege edin.
- **Test:** İki API üzerinden eşzamanlı enqueue, aynı profil için sıralama ve veri kaybı.

### P2-05 — IndexedDB yazımı tamamlanmadan başarı raporlanması ihtimali

- **Kaynak rapor:** Mistral B6
- **İlgili dosya:** `src/services/offline-queue.ts`
- **Risk:** `enqueueOfflineSyncSnapshot` asenkron IndexedDB yazımı bitmeden `persisted: true` döndürebilir; uygulama kapanırsa kuyruk kaybolabilir.
- **Öneri:** Yazım işlemini await edin; gerçek kalıcılık sonucunu doğrulayın; IndexedDB hatasında localStorage fallback ve doğru durum raporlaması sağlayın.
- **Test:** IndexedDB gecikmesi, quota/izin hatası, kapanma ve fallback senaryoları.

### P2-06 — Personal Access Token'ın düz metin depolanması

- **Kaynak rapor:** Mistral B7
- **İlgili dosyalar:** `server.ts`, `src/server/github-token-refresh.ts`
- **Risk:** Token'ın dosyada düz metin tutulması, dosya erişimi veya yedekleme üzerinden sızma riski doğurabilir. P1-01 ile ilişkili ancak ayrı bir gizli bilgi yönetimi konusudur.
- **Öneri:** Güvenli secret yönetimi, dosya izinleri, yedeklerden hariç tutma, token rotasyonu ve log maskeleme.
- **Test:** Token'ın loglara, istemci yanıtlarına veya yedeklere sızmadığının doğrulanması.

### P2-07 — Büyük ve monolitik dosyalar

- **Kaynak rapor:** Mistral B8
- **Raporlanan dosya boyutları:**
  - `src/core/cinetrack-core.ts` yaklaşık 222 KB
  - `src/server/github-bidirectional-sync.ts` yaklaşık 183 KB
  - `src/server/persistent-store.ts` yaklaşık 148 KB
  - `src/server/excel-profile-backup.ts` yaklaşık 124 KB
  - `src/server/app.ts` yaklaşık 108 KB
  - `App.tsx` yaklaşık 88 KB
- **Risk:** Bakım, test kapsamı, kod incelemesi ve değişikliklerin yan etkilerini izleme zorlaşır.
- **Öneri:** Dosyaları satır sayısına göre değil sorumluluk sınırlarına göre modüllere ayırın. Her bölme sonrası test ve bağımlılık yönünü doğrulayın.

### P2-08 — Public GitHub veri deposunda kişisel veri sızıntısına karşı fail-closed davranışın tam doğrulanmamış olması

- **Kaynak rapor:** Mistral B9
- **İlgili dosyalar:** `src/server/config.ts`, `server.ts`, `src/server/sync-manifest.ts`, `src/server/app.ts`
- **Raporlanan durum:** `CINETRACK_DATA_REPO_IS_PUBLIC=false` varsayılanı görülmüş; ancak rapor `app.ts` tarafındaki tüm engelleme davranışını kesin doğrulayamamış.
- **Risk:** Public depoya kişisel profil/veri yazılması.
- **Öneri:** Sunucu tarafında zorunlu fail-closed kontrolü uygulayın; istemci beyanına güvenmeyin; public repo durumunda hassas veri yazımını kesin engelleyin.
- **Test:** Public repo konfigürasyonunda yazma, manifest üretimi, yedekleme ve sync uç noktalarının negatif testleri.

### P2-09 — Origin/Referer başlıkları bulunmayan isteklerin mutasyon yapabilmesi ihtimali

- **Kaynak rapor:** Mistral B10
- **İlgili dosya:** `src/server/security.ts`
- **Risk:** Origin/Referer olmayan isteklerin nasıl ele alındığına bağlı olarak harici istemcilerden yetkisiz mutasyon mümkün olabilir.
- **Öneri:** Origin/Referer yokluğu için açık politika tanımlayın; harici erişim bağlamında token/CSRF doğrulaması uygulayın; proxy güven sınırlarını netleştirin.
- **Test:** Başlıksız istek, sahte Origin, geçerli/geçersiz token ve yerel/harici bağlanma senaryoları.

### P2-10 — `/api/data` yazma uç noktasında özel rate limit eksikliği

- **Kaynak rapor:** Mistral B11
- **İlgili dosyalar:** `src/server/security.ts`, `server.ts`
- **Risk:** TMDB proxy için sliding-window limiter bulunmasına rağmen veri yazma uç noktalarının aynı düzeyde sınırlandırılmaması kötüye kullanım veya kaynak tüketimi oluşturabilir.
- **Öneri:** Profil/istemci bazlı yazma limiti, payload boyutu ve eşzamanlılık sınırı ekleyin.
- **Test:** Limit aşımı, pencere sıfırlanması, farklı profiller ve meşru toplu işlemler.

### P2-11 — Relationship Graph önbelleğinin güncel olmayan veri sunabilmesi

- **Kaynak rapor:** Qwen Zevk Haritası bulguları
- **İlgili alan:** `relationship-v3`, IndexedDB cache
- **Risk:** Sunucu verisi değiştiğinde istemci önbelleği otomatik geçersizleşmiyorsa grafik eski ilişki verisini gösterebilir.
- **Öneri:** Veri revizyonu/cache anahtarı kullanın; değişiklikte invalidation yapın; çevrimdışı eski veriyi kullanıcıya belirtin.
- **Test:** Sunucu revizyonu değişimi, yeniden açılış, çevrimdışı kullanım ve cache invalidation.

---

## 5. P3 — Düşük öncelikli bulgular

### P3-01 — Mobil ve masaüstü gezinme etiketlerinin tutarsızlığı

- **Kaynak rapor:** Qwen F06
- **Durum:** Mobilde “Kütüphane”, masaüstünde “Kütüphanem” etiketleri kullanılıyor.
- **Öneri:** Aynı alan için tutarlı adlandırma sağlayın; gerekirse erişilebilirlik açıklaması/tooltip kullanın.

### P3-02 — UUID tabanlı testlerde kararsızlık

- **Kaynak rapor:** Qwen F07
- **İlgili test:** `manual-maintainer-regressions.test.mjs`
- **Risk:** Rastgele UUID'nin yalnızca rakamlardan oluşması gibi nadir durumlar yanlış pozitif/negatif sonuç üretebilir.
- **Öneri:** Rastgele değerler yerine deterministik test fixture'ları kullanın.

### P3-03 — `any` kullanımı ve mimari allowlist teknik borcu

- **Kaynak rapor:** Mistral B12
- **İlgili alan:** Core katmanındaki `any` kullanımı ve mimari sınır istisnaları.
- **Not:** P2-01 ile örtüşür; ayrı bir hata olarak sayılmamalı, mimari iyileştirme işinin takip alt maddesi olmalıdır.
- **Öneri:** Kademeli tip güvenliği planı ve allowlist azaltma hedefi belirleyin.

---

## 6. Raporlarda olumlu değerlendirilen mevcut mimari unsurlar

Aşağıdaki noktalar raporlarda olumlu veya mevcut altyapı olarak belirtilmiştir. Bunlar tüm hata senaryolarının başarıyla test edildiği anlamına gelmez.

- Contracts / core / server / services / UI katmanlarına ayrılmış yapı.
- Dairesel import sayısının sıfır olarak raporlanması ve mimari sınır testleri.
- `.tmp + fsync + rename` yaklaşımıyla atomik yazım.
- Yedi dönen yedek ve 25 MB payload sınırı.
- `expectedProfileId`, `strictProfileMatch`, revizyon ve profil koruma kontrolleri.
- Film/dizi anahtarlarının `movie:123`, `tv:456` biçiminde ayrılması.
- Profil ID migration mekanizması.
- Silme yayılımı için tombstone yaklaşımı.
- GitHub retry, `Retry-After`, rate-limit davranışı; 401/404/409 yanıtlarının körlemesine tekrar denenmemesi.
- Revizyon kontrolleri, IndexedDB/localStorage/memory fallback içeren çevrimdışı kuyruk yaklaşımı.
- Restore journal ve SHA-256 bütünlük kontrolü.
- Taste Engine tarafında 15 ağırlıklı sinyal, Bayesian shrinkage, zamansal ağırlık, negatif sinyaller ve ring0/ring1/ring2 öneri yaşam döngüsü.
- Relationship v3: universe/person/semantic/atmosphere/contrast ilişkileri, IndexedDB cache ve deduplikasyon.
- TMDB anahtarının sunucu tarafında tutulması, proxy, timeout/retry.
- SHA-256 ve `timingSafeEqual` token doğrulaması, CSP, CSRF, log maskeleme ve varsayılan `127.0.0.1` bind.

---

## 7. Test kapsamı ve kanıt sınırlamaları

Mistral raporunda aşağıdaki test envanteri belirtilmiştir:

- 57 kök test dosyası.
- 26 Taste Engine test modülü.
- 6 Playwright E2E senaryosu.

Ancak rapor, testlerin tamamını çalıştırdığını belirtmemiştir. Qwen de gerçek tarayıcı E2E doğrulaması yapmamış ve canlı TMDB çağrılarını mock kullanarak değerlendirmiştir. Bu nedenle test envanteri, testlerin güncel master üzerinde geçtiğinin kanıtı olarak kabul edilmemelidir.

### Eklenmesi/çalıştırılması önerilen testler

1. Geçersiz profil ID'si ile merge ve veri kurtarma.
2. İki cihazda eşzamanlı favori ekleme/silme ve disliked değişiklikleri.
3. Sunucu verisini kullanmadan önce yerel snapshot ve undo.
4. Yereli koru akışında uzak kayıtların korunması.
5. Eski/yeni offline queue API'lerinin eşzamanlı kullanımı.
6. IndexedDB asenkron yazım hatası ve localStorage fallback.
7. Public repo'ya kişisel veri yazımının engellenmesi.
8. Origin/Referer olmadan mutasyon davranışı.
9. `/api/data` yazma rate limit'i.
10. Tüm yedeklerin bozulduğu durumda kurtarma.
11. İki eşzamanlı GitHub sync işlemi.
12. 10.000 öğelik import/sync performansı.
13. Büyük Relationship Graph performansı.

---

## 8. Henüz yeterince doğrulanmamış inceleme alanları

İki raporun mevcut kapsamı aşağıdaki alanlarda kesin sonuca varmak için yeterli değildir:

- Taste Engine film/dizi filtrelerinin uçtan uca doğruluğu.
- Hidden Gems tarafında farklı içerik kümeleri için sabit Bayesian prior değerlerinin etkisi.
- Relationship Graph matematiksel doğruluğu ve büyük veri ölçeğindeki performansı.
- TMDB proxy retry davranışı ve istemci kuyruk etkileşimi.
- IMDb entegrasyonunun erişim/lisans varsayımları.
- 1.000 / 5.000 / 10.000 profil öğesinde performans.
- `mergeSavedItemListsLossless` içindeki O(n*m) maliyet.
- Sync sırasında tam JSON serileştirme ve SHA hesaplama maliyeti.
- Gerçek tarayıcıda responsive tasarım ve erişilebilirlik.
- Runtime SQLite yedekleme/geri yükleme.
- Gerçek GitHub davranışının mock'lardan bağımsız doğrulanması.

Bu başlıklar üçüncü incelemede açıkça ele alınmalıdır.

---

## 9. Önerilen doğrulama ve düzeltme sırası

Bu sıra, bulguların doğrulanma ve risk azaltma önceliğidir; doğrudan kod değişikliği talimatı değildir.

### Aşama A — Önce güncellik ve yeniden üretilebilirlik

1. İnceleme anındaki `master` SHA'sını kaydedin.
2. Her bulgunun ilgili dosya/fonksiyonunun hâlâ mevcut olup olmadığını kontrol edin.
3. PR #63 sonrasında çözülmüş bulguları “zaten giderilmiş” olarak işaretleyin.
4. Her bulgu için dosya, fonksiyon, kod kanıtı, test kanıtı ve etki senaryosu ekleyin.

### Aşama B — Veri kaybı ve senkronizasyon

1. P1-04 ve P1-05 çatışma çözüm akışlarını inceleyin.
2. P1-06 alan/koleksiyon merge semantiğini doğrulayın.
3. P1-03 geçersiz profil kimliği davranışını doğrulayın.
4. P1-02 UI hata/çatışma görünürlüğünü doğrulayın.
5. İki cihazlı eşzamanlılık ve geri alma testlerini çalıştırın.

### Aşama C — Kimlik bilgileri ve API güvenliği

1. P1-01 token yenileme ve `.env` yazımını inceleyin.
2. P2-06 token saklama ve log maskelemesini doğrulayın.
3. P2-08 public repo fail-closed davranışını test edin.
4. P2-09 Origin/Referer ve CSRF politikasını doğrulayın.
5. P2-10 veri yazma rate limit'ini doğrulayın.

### Aşama D — Çevrimdışı kuyruk ve veri tutarlılığı

1. P2-04 eski/yeni queue API uyumunu inceleyin.
2. P2-05 IndexedDB yazımının gerçek tamamlanma durumunu doğrulayın.
3. Tombstone ve tarih migration davranışını test edin.
4. Cache invalidation ve yedekten kurtarma senaryolarını çalıştırın.

### Aşama E — Mimari, performans ve UX

1. Core IO sınırlarını ve tip güvenliğini iyileştirin.
2. Büyük dosyaları sorumluluklarına göre modülerleştirin.
3. Büyük veri setleriyle performans ölçün.
4. Responsive, erişilebilirlik ve etiket tutarlılığını doğrulayın.

---

## 10. Üçüncü AI incelemesi geldiğinde güncelleme protokolü

Bu dosya yaşayan ana inceleme belgesi olarak kullanılacaktır. Üçüncü rapor geldiğinde mevcut bulgular silinmeden aşağıdaki sınıflandırma ile güncellenecektir:

1. **Üç raporda ortak:** Üç bağımsız incelemede de bulunan ve güncel kodda doğrulanan bulgular.
2. **İki raporda ortak:** En az iki raporun işaretlediği bulgular.
3. **Tek raporda bulunan:** Yalnızca bir raporda geçen, ancak kaynak kodla doğrulanması gereken bulgular.
4. **Çelişkili değerlendirmeler:** Raporların aynı konu hakkında farklı sonuca vardığı durumlar.
5. **Güncel master'da giderilmiş:** Önceki raporda bulunan ancak güncel kodda artık bulunmayan sorunlar.
6. **Doğrulanamayan/kanıt yetersiz:** Kaynak kod, test veya çalışma zamanı kanıtı bulunmayan iddialar.
7. **Yeni bulgular:** Üçüncü incelemenin eklediği ve önceki raporlarda yer almayan konular.

Her bulgu için şu alanlar korunmalıdır:

- Bulgu ID
- Başlık ve öncelik
- Kaynak rapor(lar)
- İncelenen commit SHA
- İlgili dosya/fonksiyon
- Kod kanıtı
- Yeniden üretim adımları
- Etki ve olasılık
- Güncel durum: doğrulandı / giderildi / kısmen giderildi / doğrulanamadı
- Önerilen çözüm
- Gerekli regresyon testleri

**Önemli:** Yeni raporun bulguları otomatik olarak doğru kabul edilmemeli; her bulgu güncel `master` üzerinde kontrol edilmelidir. Aynı soruna işaret eden maddeler tek bulgu altında birleştirilmeli, ancak kaynak rapor referansları kaybedilmemelidir.

---

## 11. Sonuç

İki raporun ortak işaret ettiği en önemli konu, Cinethos'un ana mimarisinden ziyade **veri bütünlüğünün çatışma ve hata koşullarında korunmasıdır**. Öncelik, yeni özellik eklemekten önce P1 bulgularını güncel master üzerinde doğrulamak ve özellikle iki cihazlı senkronizasyon sırasında veri kaybı yaşanmadığını kanıtlamaktır.

Bu belge, üçüncü inceleme eklendiğinde aynı yapı üzerinden genişletilecek ana birleştirilmiş rapordur.

---

## Kaynak rapor

- `Cinethos_2AI_Inceleme_Raporu_21_Kasım_2026.pdf` — Qwen ve Mistral incelemelerini içeren, kullanıcı tarafından sağlanan 91 sayfalık rapor.
