# Cinethos MIA — Faz 1 ve Faz 2 Tek Uygulama Planı

> **Bu belge Faz 1 ve Content Intelligence Faz 2 için tek yetkili uygulama ve kabul planıdır.** Önceki tarihsel tamamlanma işaretleri başlangıç kabul edilmez. Aşağıdaki durumlar mevcut master kodunun yeniden incelenmesine dayanır.
>
> **Kod denetimi tabanı:** son kaynak kodu commit'i = 89fda58daf9be820e4ec88b171945e7b7bb9fb5b (16.11.2026); ardından gelen `218c426` ve `e64966d` commit'leri yalnızca bu plan belgesini günceller. Ajanın PR #19 çalışması `5a6b23d8c235ab0c806194c017f981394751de24` merge commit'iyle alındı. Bakım düzeltmeleri bu merge sonrasında master'a doğrudan işlendi. CI/test doğrulaması henüz ajanın tamamlaması gereken ayrı bir iş paketidir. Geri yüklenen kaynakların temel snapshot'ı = 1c135fea5136fc5039cc0303fa2a9ea9b929936c; silinen 123 dosya 44aabcd60b9736816c006c383ba8ec80488f2cc2 ile geri eklendi.
>
> **Kapsam ayrımı:** Ana MIA_TRANSFORMATION_PLAN.md içindeki mimari yol haritasının Faz 2'si Veri Yöneticisi / repository / adaptör / SQLite dönüşümüdür. Bu belge, konuşmada Faz 2 diye adlandırdığımız Content Intelligence ve ortak içerik veritabanı işlerini kapsar. İkisi karıştırılmayacaktır.

## 1. Denetim sonucu — mevcut gerçek durum

Durum etiketleri:
- **MEVCUT:** İlgili kaynak kodu veya test dosyası depoda var; tek başına çalışma zamanı entegrasyonu anlamına gelmez.
- **KISMİ:** Yapının bir bölümü var; uygulama bağlantısı, güvenlik veya hata davranışı eksik.
- **EKSİK:** Gerçek uygulama akışında bulunmuyor ya da gerekli bağlantı kanıtlanamadı.
- **BLOKE:** Test/CI altyapısı düzelmeden güvenilir doğrulama yapılamıyor.

### 1.1 Faz 1

| Alan | Denetim sonucu | Kanıt / eksik |
|---|---|---|
| Ortak sözleşmeler | MEVCUT | src/contracts altında event, data, profile, module ve service sözleşmeleri var. |
| ProfileContext | KISMİ | Sunucu açılışında ve `/api/data`, arşiv restore/rollback, hibrit birleştirme yazımlarında aktif profil + revision eşitleniyor. Tüm arka plan asenkron görevlerinin profile ref taşıması ve eski profil işlerinin iptali ayrıca doğrulanmalı. |
| Runtime ModuleRegistry | MEVCUT / KISMİ | PR #19 ile composition root ve start/stop yaşam döngüsü bağlandı. Modül rollback davranışı ve gerçek üretim açılış testi ajan tarafından doğrulanmalı. |
| AppEventBus | KISMİ | Abone hataları artık tüm handler'lar çalıştıktan sonra AggregateError olarak publish çağrısına dönüyor. Kritik ve best-effort aboneler henüz ayrı sınıflandırılmıyor; ajan test ve davranış uyumluluğunu doğrulamalı. |
| PrimaryDataRepository | KISMİ | Ana `/api/data` okuma/yazma ve MIA akışları repository üzerinden. Arşiv, rollback ve hibrit birleştirme yazımları da repository kullanıyor; tüm kalan düşük seviye storage erişimleri gerekçeleriyle taranmalı. |
| TasteStore ve profil güvenliği | MEVCUT / YENİDEN DOĞRULANACAK | Kurtarma/eşzamanlılık testleri geri yüklendi; güncel CI çalıştırılamadığı için yeniden çalıştırılmalı. |
| OfflineQueue profil referansı | MEVCUT / YENİDEN DOĞRULANACAK | Profil referansı ve çakışma testi var; gerçek tüm enqueue yollarının tek API kullanıp kullanmadığı denetlenmeli. |
| Gerçek uygulama kablolaması | MEVCUT / TEST BEKLİYOR | PR #19 ile registry, coordinator, event subscriber, initial indexer ve route mount uygulamaya bağlandı. Aynı commit üzerinde CI ve üretim smoke test bekliyor. |

### 1.2 Faz 2 — Content Intelligence

| Alan | Denetim sonucu | Kanıt / eksik |
|---|---|---|
| SQLite içerik şeması | MEVCUT | content_intelligence, content_processing_queue ve content_processed_events tabloları ile indeksler tanımlı. |
| Film / dizi kanonik kimliği | MEVCUT / TEST EDİLECEK | movie:<id> ve tv:<id> ayrımı kod ve testlerde var. |
| Metadata normalizasyonu | MEVCUT | Metadata processor, feature extractor, mood ve semantic analyzer dosyaları var. |
| 48 boyutlu feature vector | MEVCUT / TEST EDİLECEK | Kod ve test beklentisi var; gerçek TMDB veri çeşitliliğiyle kabul testi gerekli. |
| Görsel / kişisel veri temizliği | KISMİ — P0 | PR #19 ile açık allowlist ve notes/note/user_note temizliği eklendi. Bakım düzeltmesi derinlik sınırı aşılınca ham alt ağacı döndürmek yerine atıyor. Test/CI doğrulaması ajanda; eski ortak SQLite kayıtları için migration/temizlik kararı da gerekli. |
| Event tekilleştirme ve enqueue | KISMİ — P0 | PR #19 event kabulini ve queue kaydını aynı SQLite transaction'a aldı. Bakım düzeltmesi processing durumundaki işin payload'ı değiştiğinde eski worker'ın yeni revizyonu tamamlandı saymasını engelliyor; güncel payload sonraki tur için pending'e döner. Test/CI doğrulaması ajanda. |
| Kalıcı kuyruk / retry / recovery | MEVCUT / TEST BEKLİYOR | Coordinator sunucu ModuleRegistry yaşam döngüsüne bağlandı. Worker yarış koşulu için completion/retry/failure güncellemeleri snapshot revision ile korunuyor. Restart, concurrency ve retry testleri ajan tarafından çalıştırılmalı. |
| Gerçek liste olayları | KISMİ | `/api/data` diff'i gerçek typed event üretiyor. Olaylar artık HTTP yanıtından önce await ediliyor; teslimat hatasında ilgili mediaKey key-only fallback kuyruğa alınıyor. FavoriteActorChanged gibi mediaKey'siz olayların hata telafisi ve uçtan uca doğrulaması bekliyor. |
| Metadata çözümleme | MEVCUT / TEST BEKLİYOR | Coordinator metadata source ve TMDB resolver ile bağlı. Film/TV gerçek yanıtları, cache, rate limit ve offline retry davranışı ajanın entegrasyon testlerinde doğrulanmalı. |
| Başlangıç indekslemesi | KISMİ | Açılış modülü beş liste kapsamını tarıyor. Reddedilen kayıt varsa durum artık `partial` olarak raporlanıyor; indeksin kaldığı yerden devam etmesi ve health endpoint sayımlarının doğrulanması bekliyor. |
| HTTP API | KISMİ | Router uygulamaya mount edilmiş. Auth/origin, yönetim endpoint'leri, pagination, rate limit ve veri sızıntısı kontrollerinin tam denetimi ajanın kabul testinde yapılmalı. |
| Arşiv / migration | YENİDEN TASARLANACAK | Ayrı Content Intelligence SQLite verisinin arşivlenmesi veya deterministik yeniden kurulması, migration ve kuyruk kurtarma politikası tek karara bağlanmalı. |
| Test paketi | BLOKE — AJAN SORUMLULUĞU | PR #19'un beş yeni testi `npm test` ana komutuna dahil edilmeli. Lockfile/npm ci, lint, test, taste, build, E2E ve smoke aynı SHA üzerinde ajan tarafından tamamlanmalı. |

### 1.3 CI / bağımlılık engeli

PR #19 ve bakım commit'leri sonrasında GitHub Actions çalıştırmaları tetiklenmiştir; şu an testlerin geçtiği söylenemez. Önceki PR CI loglarında Vite 8 / Rolldown / Rollup platform optional dependency kayıtlarının lockfile'da eksik olduğu için `npm ci` başarısız olmuştu. Güncel lockfile onarımı, temiz runner `npm ci`, lint, test ve build doğrulaması ajanın sorumluluğundadır. Ajan aynı son commit SHA üzerinde yeşil CI kanıtı sunmadan kabul kapısı kapatılmayacaktır.

---

## 2. Uygulama planı — sıfırdan kabul sırasıyla

Her adım tamamlandığında kod, test ve commit birlikte doğrulanır. Dosyanın depoda bulunması adımı tamamlamaz.

## FAZ 0 — Sağlam başlangıç ve test altyapısını açma

### 0.1 Bağımlılık / lockfile onarımı — P0
- [ ] Güncel package.json temel alınarak package-lock.json yeniden üretilsin; eski lockfile körlemesine geri kopyalanmasın.
- [ ] npm ci temiz GitHub runner üzerinde başarıyla tamamlansın.
- [ ] Vite / Rolldown / Rollup optional dependency kayıtlarının lockfile'da tam olduğu doğrulansın.
- [ ] package.json içinde kullanılan tüm test araçları doğrudan devDependency olarak tanımlı olsun; Playwright ve fake-indexeddb dahil.
- [ ] Node sürümü CI, package.json engines ve yerel geliştirme ortamında aynı desteklenen aralığa sabitlensin.
- [ ] npm ci sonrası npm run lint, npm test, npm run test:taste, npm run build komutları ayrı ayrı çalıştırılsın; ilk hata düzeltilmeden sonraki aşamaya geçilmesin.

**Kabul:** npm ci temiz ortamda başarılı; lockfile güncel; test komutları gerçekten çalışmaya başlıyor.

**Sorumlu:** Bu bölümün uygulayıcısı AJAN'dır. Bakım kodu tamamlandıktan sonra ajan aşağıdaki işleri yapacak; kullanıcıya yalnızca yerel test beyanı değil, GitHub Actions run URL'leri ve commit SHA sunacaktır.

### 0.2 Test ve CI doğrulaması — AJAN SORUMLULUĞU
- [ ] PR #19 ile eklenen `content-event-outbox.test.mjs`, `content-privacy-allowlist.test.mjs`, `initial-indexing.test.mjs`, `library-events-e2e.test.mjs`, `server-lifecycle.test.mjs` testlerinin tamamını `npm test` ana komutuna dahil et.
- [ ] package.json ile package-lock.json bağımlılık ağacını yeniden üret; lockfile'a platform optional dependency kayıtlarını eksiksiz dahil et.
- [ ] Node sürümünü `engines`, CI workflow ve yerel test ortamında aynı desteklenen sürümde sabitle.
- [ ] Temiz runner/container ortamında `npm ci` çalıştır; kurulum tamamlanmadan test adımına geçildiğini varsayma.
- [ ] `npm run lint`, `npm test`, `npm run test:taste`, `npm run build`, ilgili E2E ve production smoke testlerini ayrı ayrı çalıştır.
- [ ] Başarısız testleri kodu düzelterek çöz; test silme, test kapsamını azaltma, assertion gevşetme veya CI adımını atlama.
- [ ] Bu bakım commit'lerindeki allowlist derinlik, opak event ID, worker/payload yarışı, EventBus hata yayılımı, ProfileContext senkronizasyonu ve indeksleme partial-state davranışları için regresyon testleri ekle.
- [ ] İki profil izolasyonu, event retry/idempotency, aynı mediaKey üzerinde processing sırasında yeni metadata gelmesi ve profil değişiminde stale write senaryolarını test et.
- [ ] Sonuçları aynı commit SHA için GitHub Actions linkleriyle raporla; yeşil olmayan adım varsa plan maddesini tamamlandı işaretleme.

**Kabul:** Temiz kurulum ve tüm zorunlu doğrulamalar aynı commit SHA üzerinde başarılı; test listesi ve CI run URL'leri belgelenmiş.

## FAZ 1 — Mimari sözleşmeler ve gerçek çalışma zamanı

### 1.1 Sözleşmelerin yeniden doğrulanması — P1
- [ ] src/contracts içindeki IApplicationModule, IModuleRegistry, IProfileContext, IEventPublisher, IEventSubscriber, IDataRepository ve PrimaryDataRepository imzaları tek tek denetlensin.
- [ ] Profil yazımlarında profileId ve revision zorunluluğu korunmalı; profil değişiminden önce başlatılmış asenkron iş yeni profile yazamamalı.
- [ ] Movie/TV media key tek kaynağı core/keys.ts olmalı; modüller kendi anahtar üretim kurallarını tanımlamamalı.
- [ ] Modüller arası bağımlılıklar sözleşme / servis arayüzlerinden geçmeli; React veya UI katmanı core ve repository içine sızmamalı.
- [ ] Faz 1 sözleşme testleri çalıştırılıp eksik durumlar tamamlanmalı.

### 1.2 Uygulama composition root ve modül yaşam döngüsü — P0
- [ ] server.ts içinde tek bir uygulama runtime/composition root oluştur.
- [ ] AppEventBus tek örnek olarak oluşturulsun ve modül context'ine publisher + subscriber olarak verilsin.
- [ ] ProfileContext uygulamanın aktif profileId ve revision bilgisiyle başlatılsın; profil değişimleri mevcut profil saklama akışına bağlansın.
- [ ] RuntimeModuleRegistry oluşturulsun; modüller bağımlılık sırasıyla register, initialize ve start edilsin.
- [ ] ContentProcessingCoordinator, Faz 2 adımına geçmeden önce registry'ye gerçek modül olarak kaydedilsin.
- [ ] Sunucu kapanışında modüller ters sırayla stop edilsin; SQLite bağlantıları, kuyruk timer'ları ve abonelikler kapatılsın.
- [ ] Başlatma sırasında modül hata verirse daha önce başlatılan modüller rollback/stop ile temizlensin.
- [ ] Health endpoint gerçek modül durumlarını, aktif storage driver'ı ve Content Intelligence kuyruk durumunu raporlasın.
- [ ] Başlatma ve kapatma akışları için integration test yazılsın.

**Kabul:** Modüller yalnızca testte instantiate edilmiyor; normal Cinethos sunucu açılışında başlıyor ve kapanışta kontrollü duruyor.

### 1.3 EventBus hata ve teslimat semantiği — P0
- [ ] Abone hatalarını birbirinden izole etme özelliği korunsun.
- [ ] Kritik kalıcılık aboneleri ile best-effort aboneler ayrıştırılsın.
- [ ] Kritik abone başarısızsa publish sonucu başarısız / retry edilebilir teslimat olarak çağırana dönsün; yalnızca console.warn yazıp başarılı resolve etmesin.
- [ ] Bir abonenin hatası diğer bağımsız abonelerin çalışmasını engellemesin.
- [ ] EventId, eventType, profileId, sourceRevision ve schemaVersion doğrulansın.
- [ ] Olayın kalıcı kaydı ile abone işleme durumu birbirinden ayrıştırılsın.
- [ ] Başarılı, başarısız, tekrar denenecek ve dead-letter durumları test edilsin.

### 1.4 Gerçek veri yollarının PrimaryDataRepository'ye taşınması — P1
- [ ] src/server/app.ts ve diğer sunucu dosyalarındaki storage.readDataAsync() / saveDataSerialized() kullanımları envanterlensin.
- [ ] Ana kullanıcı verisini okuyan/yazan API uçları PrimaryDataRepository üzerinden çalışsın.
- [ ] Arşiv, yedek, kurtarma veya düşük seviye storage işlemleri repository dışındaysa gerekçesi kod yorumunda ve mimari belgede açıklansın.
- [ ] Revision/optimistic concurrency, stale write ve profile mismatch kontrolleri her yazma yolunda korunsun.
- [ ] API /api/data, profil, dışa aktarma, geri yükleme ve senkron yolları için regresyon testleri yazılsın.
- [ ] Tek bir veri kaynağı kuralı bozulmasın; JSON ve SQLite aynı anda bağımsız birincil kaynak hâline gelmesin.

### 1.5 ProfileContext, TasteStore ve OfflineQueue — P1
- [ ] ProfileContext aktif profil değişimiyle gerçek uygulama state'inden güncellensin.
- [ ] Her asenkron görev başlangıç profileId + revision referansını taşısın; sonuç yazılmadan önce yeniden doğrulansın.
- [ ] TasteStore atomik yazım, bozuk kayıt karantinası, recovery ve eşzamanlı yazma testleri yeniden çalıştırılsın.
- [ ] OfflineQueue eski/yeni enqueue API'leri envanterlensin; tek kanonik giriş noktası belirlensin.
- [ ] OfflineQueue profil çakışmasında yazımı durdursun, işi kaybetmesin ve doğru profil/revision geldiğinde güvenle devam etsin.
- [ ] TasteEvent / TasteStore / TasteEventProjector akışında çift olay ve çift kanıt oluşmadığı doğrulansın.

### 1.6 Bakım düzeltmeleri — KOD DEĞİŞİKLİKLERİ YAPILDI, AJAN TESTİ BEKLİYOR
- [x] Allowlist derinlik sınırında ham nesnenin olduğu gibi döndürülmesi kaldırıldı; derinlik limiti aşılınca alt ağaç düşürülüyor.
- [x] Liste olay kimliklerinden profileId, mediaKey ve favori oyuncu ID listesi çıkarıldı; eventId opak UUID.
- [x] Eski `lib-<profileId>-...` eventId değerleri ile queue trigger_event_id referansları açılış migration'ında rastgele opak kimliklerle değiştiriliyor; mevcut idempotency satırları korunuyor.
- [x] Content queue, çalışan iş sırasında gelen yeni metadata payload'ını daha ileri timestamp ile saklıyor; eski worker tamamlandığında yeni revizyonu pending'e geri bırakıyor.
- [x] Completion, retry ve failure güncellemeleri çalışan worker'ın aldığı updated_at snapshot'ına koşullandı.
- [x] Aynı mediaKey için ikinci in-flight claim'in mevcut işi yanlışlıkla completed işaretlemesi engellendi.
- [x] AppEventBus tüm aboneleri çalıştırıp handler hatalarını AggregateError olarak çağırana iletiyor.
- [x] `/api/data` domain event teslimatını HTTP yanıtından önce bekliyor; ilgili mediaKey için key-only fallback eklendi.
- [x] ProfileContext sunucu açılışında ve ana veri, archive restore/rollback, hibrit merge yazımlarında aktif profileId/revision ile senkronize ediliyor.
- [x] Başlangıç indekslemesi reddedilen kayıt varsa `partial` durumunu raporluyor.
- [ ] Ajan bu kod değişiklikleri için regresyon testlerini ekleyip CI'da doğrulasın.

**Kod commit'leri:** `e91f10d`, `42e0d75`, `d23067a`, `d12fd94`, `40875a1`, `7b41244`, `65da513`, `62b381b`, `1028a6c`, `f677d51`, `85e4557`, `57bcb52`, `89fda58`.

### Faz 1 kabul kapısı
- [ ] npm run lint başarılı.
- [ ] Faz 1 sözleşme, modül registry, ProfileContext, PrimaryDataRepository, TasteStore ve OfflineQueue testleri başarılı.
- [ ] Gerçek sunucu başlangıç/kapanış entegrasyon testi başarılı.
- [ ] AppEventBus kritik abone hata testi başarılı.
- [ ] Kullanıcı verisi ve öneri davranışı için önce/sonra regresyon testleri başarılı.
- [ ] GitHub Actions aynı commit SHA için yeşil.

---

## FAZ 2 — Content Intelligence ve ortak içerik veritabanı

### 2.1 Ortak içerik veri sınırı ve gizlilik — P0, ilk iş
- [ ] Ortak içerik deposuna girebilecek alanlar açık allowlist ile tanımlansın; bilinmeyen alan varsayılan olarak atılsın.
- [ ] Allowlist yalnızca TMDB / lisanslı kaynaklardan gelen ortak içerik metaverisini kapsasın: medya kimliği, başlık, özgün başlık, özet, türler, tarih, süre, ülke, dil, keyword, içerik kredileri, sezon/bölüm sayıları, kaynak ve kaynak revizyonu gibi doğrulanmış alanlar.
- [ ] profileId, profile_id, userId, kullanıcı adı, liste adı, status, personal_rating, rating, notes, note, user_note, yorum, izleme ilerlemesi, bölüm ilerlemesi, favoriler, kullanıcı tercihleri, gizleme/ilgilenmiyorum sinyalleri ve kullanıcıya özgü tarih alanları ortak içerik kaydına giremesin.
- [ ] Kullanıcı alanları yalnızca üst seviyede değil, iç içe nesneler ve diziler içinde de temizlensin.
- [ ] Alan adı farklı yazımla / büyük-küçük harfle / nested biçimde gönderilse de güvenlik sınırı aşılamasın.
- [ ] ContentMetadataProcessor ve ContentIntelligenceRepository aynı allowlist'i uygulasın; doğrudan repository çağrısı sanitizer'ı atlayamasın.
- [ ] Feature, mood ve semantic analiz girdileri de temizlenmiş ortak metadata üzerinden üretilecek; kullanıcı puanı veya listesi vektöre karışmayacak.
- [ ] Test fixture içinde özel not, puan, profileId, userId, status, gizli liste sinyali ve izleme ilerlemesi bulunsun.
- [ ] Testler content_intelligence, queue payload, normalized metadata, feature/mood/semantic JSON ve hata kayıtlarının hiçbirinde kişisel alan/değer kalmadığını doğrulasın.
- [ ] Testteki 'Özel kişisel notum' değeri dahil tüm kişisel sızıntı kontrolleri çalıştırılsın.

**Kabul:** Bilinmeyen alanlar ortak tabloya yazılamaz; kişisel veri sızıntısı allowlist tasarımıyla engellenir. Bu adım tamamlanmadan ortak veritabanı çok kullanıcılı kullanım için açılmaz.

### 2.2 SQLite şeması, kimlik ve veri bütünlüğü — P1
- [ ] content_intelligence, content_processing_queue ve event/outbox tablolarının şeması sürümlendirilsin.
- [ ] Kanonik anahtar movie:<tmdb_id> ve tv:<tmdb_id> olsun; film ve dizi aynı sayısal ID'yi kullansa bile çakışmasın.
- [ ] media_key UNIQUE; media_type, tmdb_id, processing_status, data_hash ve queue status/retry alanları için gerekli indeksler olsun.
- [ ] Alanlar nullability, check constraint, foreign key ve veri türleri açısından denetlensin.
- [ ] Poster, backdrop, still, logo, profil fotoğrafı, görsel blob veya base64 data URL ortak içerik deposuna yazılmasın.
- [ ] Kaynak, source_revision, acquired_at, processed_at, processing_version ve data_hash alanları tutarlı şekilde saklansın.
- [ ] Bozuk / eksik metadata kaydı tüm kuyruğu durdurmasın; hata durumu ve güvenli hata mesajı kaydedilsin.

### 2.3 Event kaydı + enqueue atomikliği / Outbox — P0
- [ ] Mevcut markEventProcessed() → queue.enqueue() sırası kaldırılmalı; şu an event önce işlendi olarak kaydediliyor, enqueue sonucu kontrol edilmiyor.
- [ ] Event kabul kaydı ve queue/outbox kaydı tek SQLite transaction içinde oluşturulsun veya eşdeğer transactional outbox deseni uygulansın.
- [ ] Event ancak iş kalıcı olarak kuyruğa alındıktan sonra accepted/queued kabul edilsin.
- [ ] Enqueue başarısızsa event tekrar denenebilir durumda kalsın; kalıcı olarak processed işaretlenmesin.
- [ ] Queue.enqueue() dönüş değeri kontrol edilsin; accepted=false durumunda abone başarısızlığı çağırana bildirilsin.
- [ ] Event tekrar geldiğinde aynı eventId ikinci iş üretmesin.
- [ ] Eski profile-bearing eventId ve queue trigger_event_id kayıtları anonimleştirilsin; yeni eventId opak UUID olsun.
- [ ] Aynı media_key için farklı eventId geldiğinde metadata revizyonu ve güncel payload kaybolmasın.
- [ ] Transaction rollback, disk dolu, SQLite kilidi, process crash ve yeniden başlatma senaryoları test edilsin.
- [ ] Event durumları received → queued → completed / retrying / failed / dead-letter şeklinde izlenebilsin.

### 2.4 Metadata edinme ve kaynak çözümleme — P1
- [ ] ContentMetadataSource mevcut TMDB istemcisi, mevcut katalog ve cache katmanlarıyla gerçek çalışma zamanında bağlansın.
- [ ] Event yalnızca movie:<id> veya tv:<id> taşıdığında metadata resolver doğru medya türüyle TMDB/cache kaynağına ulaşsın.
- [ ] Film ve dizi endpoint'leri ayrı işlensin; film alanları TV kaydına veya tersi yönde karışmasın.
- [ ] credits, keywords ve gerekiyorsa external_ids gibi ek TMDB kaynakları mevcut rate limit / cache politikasıyla alınsın.
- [ ] Yalnızca gerçekten edinilmiş alanlar kaydedilsin; eksik değerler uydurulmasın.
- [ ] TMDB 429, 5xx, timeout ve offline durumları retryable olarak sınıflandırılsın.
- [ ] Kalıcı 4xx / bozuk veri hataları sınırsız retry üretmesin.
- [ ] acquired_at ve source_revision gerçek kaynak yanıtına bağlansın; her çalıştırmada rastgele revizyon üretilmesin.

### 2.5 Gerçek kullanıcı listesi olayları — P0
- [ ] Listeye ekleme, liste içi güncelleme, durum değişikliği, kişisel puan değişimi, ilgilenmiyorum, gizleme ve favori oyuncu akışları envanterlensin.
- [ ] Ortak içerik metadata gerektiren her gerçek işlem AppEventBus üzerinden uygun typed event yayınlasın.
- [ ] LibraryItemAdded, LibraryItemUpdated, LibraryStatusChanged, LibraryRatingChanged, LibraryItemRemoved, FavoriteActorChanged ve CatalogItemEnriched olaylarının tetikleyicileri tek tek doğrulansın.
- [ ] Olay payload'ı ortak metadata deposuna kullanıcıya ait alan taşımamalı; yalnızca mediaKey ve gerekli kaynak ipuçları kullanılmalı.
- [ ] RatingChanged olayı kişisel puanı ortak metadata'ya yazmamalı; yalnızca içerik henüz yoksa metadata indekslemeyi tetikleyebilmeli.
- [ ] Remove olayı kullanıcı listesinden kaldırmalı ancak ortak içerik kaydını silmemeli.
- [ ] İlgilenmiyorum ve gizlenen içerikler de içerik metadata işleme kapsamına dahil edilmeli.
- [ ] Yalnızca izleme ilerlemesi değiştiğinde gereksiz metadata yeniden işleme yapılmamalı.
- [ ] Gerçek UI/API işleminden başlayıp EventBus → Outbox → Queue → Repository sonucuna kadar uçtan uca test yazılmalı.

### 2.6 Kalıcı kuyruk, retry ve recovery — P1
- [ ] Kuyruk sunucu açılışında ContentProcessingCoordinator tarafından başlatılsın.
- [ ] Pending / processing / retrying işler yeniden başlatma sonrası kurtarılsın.
- [ ] Aynı media_key için eşzamanlı işlemler tek bir işlemde birleştirilsin.
- [ ] Lease / processing timeout veya eşdeğer kilit mekanizmasıyla yarım kalmış işler güvenle serbest bırakılsın.
- [ ] Exponential backoff, maksimum deneme sayısı ve jitter politikası tanımlansın.
- [ ] Retry bekleyen işlerin zamanlayıcısı sunucu kapanışında temizlensin.
- [ ] Kalıcı hata alan işler görünür olsun; elle veya kontrollü API ile yeniden kuyruğa alınabilsin.
- [ ] Büyük batch işleri sayfalanarak işlensin; HTTP yanıtı veya UI uzun süre bloke edilmesin.
- [ ] Kuyruk istatistikleri pending, processing, retrying, completed, failed ve dead-letter olarak raporlansın.

### 2.7 Başlangıç indekslemesi ve eksik kayıtların tamamlanması — P1
- [ ] Sunucu açılışında PrimaryDataRepository üzerinden bütün profillerin kayıtları okunmalı.
- [ ] İzledim, izleyeceğim, izliyorum, ilgilenmiyorum ve gizlenen tüm film/dizi kayıtları kapsama alınmalı.
- [ ] Mevcut veri modelinde listeler ayrı tutuluyorsa her liste ayrı taranmalı; yalnızca p.items varsayımıyla kapsam daraltılmamalı.
- [ ] Profil verisi ortak kuyruğa gönderilmeden önce allowlist ile temizlenmeli.
- [ ] Aynı içerik birden fazla profilde varsa tek ortak media_key kaydı ve tek iş oluşturulmalı.
- [ ] Başlangıç taraması sayfalı, durdurulabilir ve kaldığı yerden devam edebilir olmalı.
- [ ] Tüm TMDB kataloğu sınırsız işlenmemeli; yalnızca kullanıcı listelerinde bulunan içerikler ve açıkça belirlenmiş öncelikli kapsam kuyruğa alınmalı.
- [ ] Başlangıç indekslemesi ile normal kullanıcı event'leri çakışırsa idempotent biçimde birleşmeli.
- [ ] İlk indeksleme tamamlandı / bekliyor / başarısız sayıları sağlık API'sinde görünmeli.

### 2.8 Analiz hattı, hash ve sürümleme — P1
- [ ] Validation, normalized metadata, feature extraction, mood vector ve semantic analysis adımları açık bir pipeline sırasıyla çalışmalı.
- [ ] 48 boyutlu feature vector alan sırası ve anlamı sabit şema olarak dokümante edilmeli.
- [ ] Mood/atmosphere vector değer aralıkları ve confidence hesapları doğrulanmalı.
- [ ] Semantik kavramlar, benzerlik, karşıtlık ve ilişki türleri doğrulanmış metadata'ya dayanmalı.
- [ ] Film ve TV'ye özel alanlar doğru normalize edilmeli.
- [ ] Eksik metadata confidence değerini düşürmeli; tahmin gerçek gibi kaydedilmemeli.
- [ ] data_hash yalnızca temizlenmiş içerik metaverisinden üretilmeli; kullanıcı alanları hash'e dahil edilmemeli.
- [ ] Hash aynı ve processing_version güncelse işlem atlanmalı.
- [ ] Metadata veya processing_version değişirse yeniden işleme yapılmalı.
- [ ] Eski processing_version kayıtlarının yeniden işlenmesi için kontrollü backfill mekanizması olmalı.

### 2.9 API, güvenlik, arşiv ve migration — P1
- [ ] content-intelligence-routes.ts gerçek Express uygulamasına güvenli şekilde mount edilsin.
- [ ] Status, stats, item lookup, related, compare, ingest, drain ve event uçlarının erişim politikaları netleştirilsin.
- [ ] Route'lar authentication/token/origin kontrollerini mevcut API standardından alsın; açık yönetim endpoint'i bırakılmasın.
- [ ] Body boyutu, batch limiti, pagination, mediaKey doğrulaması ve rate limit uygulansın.
- [ ] API yanıtları kişisel veri, gizli token, ham kullanıcı payload'ı veya iç sistem hata ayrıntısı döndürmesin.
- [ ] Content Intelligence verisinin ana veri arşivine dahil edilip edilmeyeceği karara bağlansın.
- [ ] Arşive dahil edilmiyorsa geri yükleme sonrası deterministik yeniden indeksleme ve kuyruk yeniden oluşturma prosedürü yazılsın.
- [ ] Arşive dahil ediliyorsa SQLite snapshot/transaction tutarlılığı ve schema version uyumu sağlansın.
- [ ] Migration yarıda kesilirse güvenli rollback / resume davranışı test edilsin.
- [ ] Eski uygulama sürümünden gelen veriler için geriye dönük uyumluluk korunsun.

### 2.10 Çok kullanıcılı ortak veri güvenliği — P0
- [ ] Ortak içerik tablosunda profileId veya userId tutulmasın.
- [ ] Kullanıcı listesi, kişisel puan, not, gizleme, beğeni, izleme zamanı ve tercih sinyalleri ayrı profil/taste katmanında kalsın.
- [ ] Bir profilin içerik kaydını silmesi veya güncellemesi başka profillerin ortak metadata kaydını bozmasın.
- [ ] Aynı içerik farklı profillerden geldiğinde yalnızca ortak, doğrulanmış metadata birleştirilsin.
- [ ] Gelecekte anonim toplu istatistik eklenirse ayrı tablo, ayrı izin ve açık veri minimizasyonu tasarımıyla ele alınsın; bu fazda kişisel sinyal havuzu oluşturulmasın.
- [ ] İki farklı profil ile gerçek entegrasyon testi yapılıp ortak tablo ve API çıktısında profil kimliği / kişisel alan bulunmadığı doğrulansın.

### Faz 2 kabul kapısı
- [ ] Privacy allowlist ve sızıntı testleri başarılı.
- [ ] Event/outbox transaction ve idempotency testleri başarılı.
- [ ] Gerçek liste olayları uygulamadan kuyruğa ulaşıyor.
- [ ] TMDB metadata resolver film/TV için çalışıyor.
- [ ] Restart, retry, eşzamanlılık ve dead-letter testleri başarılı.
- [ ] Başlangıç indekslemesi tüm beş liste kapsamını içeriyor.
- [ ] Hash/version ve 48 boyutlu feature pipeline testleri başarılı.
- [ ] API güvenlik, migration ve arşiv/restore testleri başarılı.
- [ ] İki profil veri izolasyonu testi başarılı.
- [ ] npm ci, lint, ana testler, taste testleri, E2E, build ve production smoke aynı commit SHA üzerinde yeşil.

---

## 3. Sıralı uygulama dilimleri

1. **Dilim A — CI ve bağımlılıklar:** lockfile onarımı, npm ci, test altyapısını çalışır hâle getirme.
2. **Dilim B — Faz 1 runtime:** composition root, AppEventBus, ProfileContext, ModuleRegistry, modül start/stop.
3. **Dilim C — Faz 1 veri bütünlüğü:** PrimaryDataRepository kullanımını tamamlama, TasteStore ve OfflineQueue doğrulaması.
4. **Dilim D — Faz 2 gizlilik:** allowlist, notes dahil kişisel veri sızıntı testleri; ortak tablo sınırını kilitleme.
5. **Dilim E — Faz 2 güvenilir event:** transactional outbox, idempotency, queue enqueue hata yönetimi.
6. **Dilim F — Gerçek uygulama entegrasyonu:** liste olayları, metadata resolver, route mount ve server startup.
7. **Dilim G — Backfill ve analiz:** beş listeyi kapsayan başlangıç indekslemesi, metadata pipeline, hash/version.
8. **Dilim H — operasyonel güvence:** retry/recovery, migration, archive/restore, API güvenliği, çoklu profil testleri.
9. **Dilim I — son kabul:** tam CI, E2E, build ve production smoke; test sonuçları raporlanmadan Faz 2 kapatılmaz.

## 4. Değişmez uygulama kuralları

- Mevcut Cinethos UI, öneri motoru, Taste Engine, Zevk Haritası, profil verisi ve senkronizasyon davranışı korunacak.
- Yeni bir EventBus, repository veya queue paralel sistemi oluşturulmayacak; geri yüklenen MIA modülleri kullanılacak ve eksikleri tamamlanacak.
- Faz 1 ve Faz 2 dosyaları silinmeyecek veya başka mimariye taşınmayacak; taşıma gerekiyorsa önce uyumluluk katmanı ve test yazılacak.
- Ortak içerik deposuna hiçbir kişisel alan veya kullanıcı sinyali girmeyecek.
- Film ve TV kimliği hiçbir katmanda yalnızca sayısal TMDB ID ile temsil edilmeyecek.
- Kullanıcının listeden kaldırması ortak metadata kaydını silmeyecek.
- Testleri yeşile çevirmek için test, kapsam veya CI adımı kaldırılmayacak.
- Her PR/commit öncesi changed files incelenecek; beklenmeyen silme varsa merge durdurulacak.
- Tamamlandı denilen her madde için kod yolu, test adı ve CI commit SHA gösterilecek.
- Bu plan dışındaki eski Faz 1/Faz 2 kontrol listeleri tarihsel referans olarak kalabilir; uygulama takibi bu dosyada tutulacak.

## 5. Nihai bitiş ölçütü

Faz 1, gerçek sunucu başlangıç akışında sözleşme tabanlı modüller, profil bağlamı, olay sistemi ve birincil repository kullanıldığında; Faz 2 ise tüm ilgili liste olayları kişisel veriden arındırılmış ortak içerik deposuna güvenilir ve kurtarılabilir şekilde işlendiğinde tamamlanır. Yalnızca dosya varlığı, test dosyası varlığı veya yerel ajan beyanı tamamlanma kanıtı değildir.
