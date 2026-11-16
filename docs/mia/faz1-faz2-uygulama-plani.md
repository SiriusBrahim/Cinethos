# MIA Faz 1 ve Faz 2 — Uygulama Adımları ve Kabul Listesi

> Bu belge, 16.11.2026 tarihinde Git geçmişinde bulunan Faz 1 uygulama kayıtları ve konuşmada kesinleştirilen Faz 2 Content Intelligence kapsamı esas alınarak yeniden oluşturulmuştur.
>
> **Durum uyarısı:** Faz 1'deki [x] işaretleri, son sağlam mimari commit olan `1c135fe` öncesindeki kodda doğrulanmış tarihsel tamamlanmayı gösterir. `17a12e8` commit'i bu modüllerin önemli bölümünü master'dan sildiği için bu adımlar mevcut HEAD'de yeniden uygulanmadan veya eski kod güvenli biçimde geri alınmadan güncel tamamlanmış sayılamaz. Faz 2 kodu da aynı commit'te silinmiştir; aşağıdaki maddeler uygulama/kabul kontrol listesidir, mevcut kodun var olduğunu iddia etmez.
>
> **Önemli kapsam ayrımı:** `MIA_TRANSFORMATION_PLAN.md` içindeki ana mimari yol haritasında Faz 2, Veri Yöneticisi / repository-adapter / SQLite çalışma modu işlerini ifade eder. Bu belgede ayrıca konuşmada “Faz 2” olarak adlandırılan **Content Intelligence ve ortak içerik veritabanı** uygulaması kayıt altına alınır. İki kapsam birbirinin yerine geçmez.

## 1. Faz 1 — Mimari sözleşmeler ve çalışma zamanı entegrasyonu

### 1A — Mimari sözleşmeler

- [x] Kanonik medya kimliği ve ortak medya tipleri: `src/core/keys.ts`, `src/core/media/types.ts`.
- [x] Modül sözleşmeleri: `src/contracts/` altında ortak tipler, modül yaşam döngüsü, profil, olay, veri ve servis sözleşmeleri.
- [x] `IApplicationModule` yaşam döngüsü: `initialize(context)`, `start()`, `stop()`, `healthCheck()`.
- [x] Merkezi modül kayıt ve çözümleme sözleşmesi.
- [x] `IProfileContext`, `ProfileRef`, `WriteProfileRef`; yazma işlemlerinde profil kimliği ve revision bağlamı.
- [x] Tip güvenli `AppEventMap` olay kataloğu: LibraryItemAdded, LibraryItemUpdated, LibraryStatusChanged, LibraryRatingChanged, LibraryItemRemoved, FavoriteActorChanged, ProfileSwitched, CatalogItemEnriched.
- [x] `IDataRepository` ve `PrimaryDataRepository` sözleşmeleri.
- [x] Profil izolasyon kuralları: `docs/mia/faz1a-profile-context.md`.

### 1B — Mevcut sistemlerle uyum ve gerçek çalışma zamanı bağlantısı

- [x] Runtime ModuleRegistry üzerinden modüllerin başlatılması ve yaşam döngüsü.
- [x] AppEventBus / EventBus bağlantısı ve uygulama olaylarının gerçek akışlardan yayınlanması.
- [x] PrimaryDataRepository'nin temel veri okuma/yazma akışlarına bağlanması.
- [x] ProfileContext'in asenkron işlemlerde profil/revision bağlamını koruması.
- [x] TasteStore için bozuk kayıt yedeği, kurtarma ve eşzamanlı yazma korumaları.
- [x] OfflineQueue yazımlarında profil referansı doğrulaması.
- [x] İlgili birim ve entegrasyon testlerinin eklenmesi.

### Faz 1 kapanış düzeltmeleri / yeniden doğrulama

- [ ] **EventBus kritik abone hatalarını görünür kıl:** Abone izolasyonu korunmalı; ancak kritik kalıcılık abonesi hata verdiğinde yayın işlemi sessizce başarılı görünmemeli. “Olay yayınlandı” ile “kritik aboneler kalıcı işlemi tamamladı” sonuçları ayrılmalı.
- [ ] **PrimaryDataRepository kullanım envanteri:** `src/server/app.ts` ve diğer sunucu yollarındaki doğrudan `storage.readDataAsync()` / `saveDataSerialized()` kullanımlarını tarayıp birincil veri erişiminin repository üzerinden geçmesi gereken yerleri tamamla. Yardımcı/arşiv işlemlerini gerekçeli olarak ayrı tut.
- [ ] **OfflineQueue API sadeleştirmesi:** Eski ve yeni enqueue giriş noktalarının davranışını belgeleyip mümkünse tek kanonik API'ye indir; geriye dönük uyumluluğu koru.
- [ ] **CI doğrulaması:** Son commit için GitHub Actions / status checks sonuçlarını doğrula. Yerel ajan raporunu GitHub CI sonucu gibi sunma.
- [ ] **Faz 1 regresyon testi:** Lint, TypeScript, birim testleri, taste testleri, E2E ve build'i yeniden çalıştır.

**Faz 1 kabul şartı:** Sözleşmeler yalnızca tanımlı değil, gerçek uygulama akışlarında kullanılıyor olmalı; profil izolasyonu ve veri sahipliği korunmalı; kritik olay kalıcılık hataları sessizce yutulmamalı; testler ve CI doğrulanmalı.

## 2. Faz 2 — Content Intelligence ve ortak içerik veritabanı

### Hedef

Kullanıcıların izledim, izleyeceğim, izliyorum, ilgilenmiyorum ve gizlenen listelerinde bulunan film/dizilerin **poster ve diğer görsel dosyaları hariç edinilmiş metadata verilerini** ortak, kullanıcıdan bağımsız bir içerik deposunda işlemek.

Bu depo gelecekte çok kullanıcılı üründe ortak içerik bilgisini geliştirebilir. Kullanıcı profili, izleme durumu, kişisel puan, not ve tercihleri ortak içerik tablosuna kesinlikle yazılmaz.

### 2.1 — Ortak SQLite içerik deposu

- [ ] Ayrı Content Intelligence tablolarını oluştur / mevcut şemayı doğrula.
- [ ] Kanonik anahtar kullan: `movie:<tmdb_id>` ve `tv:<tmdb_id>`.
- [ ] Film ve diziyi ayrı kayıt olarak tut; aynı sayısal TMDB ID çakışmaya yol açmamalı.
- [ ] Temel alanlar: `media_key`, `media_type`, `tmdb_id`, `imdb_id`, `source_revision`, `metadata_json`, `normalized_metadata_json`, `feature_vector_json`, `mood_vector_json`, `semantic_data_json`, `data_hash`, `acquired_at`, `processed_at`, `created_at`, `updated_at`, `processing_version`, `processing_status`, `processing_error`.
- [ ] `media_key` üzerinde UNIQUE kısıtı ve gerekli sorgu indeksleri.
- [ ] Poster, backdrop, logo, profil fotoğrafı ve görsel blob'larını bu depoya kopyalama.

### 2.2 — Metadata edinme ve güvenli temizleme

- [ ] Mevcut TMDB istemcisi, katalog ve cache kaynaklarını kullan.
- [ ] Yalnızca gerçekten edinilmiş veriyi işle; eksik alanları uydurma.
- [ ] Film ve TV kaynak cevaplarını ayrı normalize et.
- [ ] Kaynak adı, kaynak revizyonu ve edinilme zamanını kaydet.
- [ ] API rate limit, cache ve mevcut katalog indirme politikalarını koru.
- [ ] Ortak depoya yazmadan önce açık alan allowlist'i uygula; yasaklı alan listesi tek başına yeterli değildir.
- [ ] Profil/user ID, kişisel puan, liste/durum, notlar, izleme ilerlemesi, favoriler, tercih ve kullanıcıya ait tüm alanları kökten temizle.
- [ ] Temizleme hem iç içe nesne/dizilerde hem repository girişinde zorunlu olsun.
- [ ] Bilinmeyen alanlar varsayılan olarak ortak tabloya yazılmasın.

### 2.3 — Content Intelligence analiz hattı

- [ ] Metadata doğrulama ve eksik/geçersiz alan tespiti.
- [ ] Normalize edilmiş içerik modeli.
- [ ] 48 boyutlu içerik feature vector.
- [ ] Mood / atmosfer vektörü.
- [ ] Semantik kavram çıkarımı.
- [ ] Benzerlik, karşıtlık ve içerik ilişkileri.
- [ ] Film ve diziye özgü alanları destekle.
- [ ] Eksik metadata durumunda confidence değerini düşür; çıkarımı doğrulanmış gerçek gibi sunma.
- [ ] İşleme sürümü ve metadata hash'i sakla.
- [ ] Hash değişmemiş ve processing version güncelse gereksiz tekrar işleme yapma.

### 2.4 — EventBus entegrasyonu

- [ ] `LibraryItemAdded`, `LibraryItemUpdated`, `LibraryItemRemoved`, `LibraryStatusChanged`, `LibraryRatingChanged`, `FavoriteActorChanged` olaylarını değerlendir.
- [ ] Kullanıcı listesine ekleme, güncelleme, puanlama, durum değişikliği, ilgilenmiyorum ve gizleme akışlarını gerçek uygulamaya bağla.
- [ ] Olay sadece mediaKey taşıyorsa metadata'nın yerel kayıt/cache/TMDB kaynak zincirinden nasıl alınacağını tamamla.
- [ ] Aynı olay tekrar geldiğinde idempotent davran.
- [ ] Bir kullanıcının listeden kaldırması ortak içerik kaydını silmesin.
- [ ] Puan, durum ve kişisel tercihleri Content Intelligence yerine Taste Engine / profil katmanında tut.

### 2.5 — Kalıcı arka plan kuyruğu

- [ ] Bekleyen işleri SQLite'ta kalıcı tut.
- [ ] Sunucu yeniden başladığında bekleyen işleri kurtar.
- [ ] Aynı media_key için eşzamanlı işlemleri tekilleştir / kilitle.
- [ ] Retry ve exponential backoff uygula.
- [ ] Geçici ve kalıcı hataları ayır.
- [ ] Başarısız işler görünür ve yeniden denenebilir olsun.
- [ ] Kuyruk işlemleri UI veya HTTP yanıtını uzun süre bloke etmesin.
- [ ] Event kaydı ile kuyruğa ekleme arasında kayıp/çift işleme penceresi bırakma; kalıcı kabul ve enqueue atomik veya güvenli outbox düzeninde olsun.

### 2.6 — Başlangıç indekslemesi ve çok kullanıcılı hazırlık

- [ ] Mevcut profillerin tüm listelerini tarayarak eksik ortak içerik kayıtlarını kuyruğa al.
- [ ] İlgilenmiyorum ve gizlenen içerikleri de dahil et.
- [ ] Birden fazla profilde aynı içerik varsa tek ortak kayıt üret.
- [ ] Başlangıç indekslemesini parça parça ve arka planda yap.
- [ ] Katalog stoklarının tamamını sınırsız şekilde işleme; kapsam ve önceliği tanımla.
- [ ] Kullanıcı verileri ortak içerik deposundan fiziksel ve mantıksal olarak ayrı kalsın.
- [ ] Gelecekte anonim toplu istatistik eklenebilmesi için ayrı bir genişleme noktası bırak; şu aşamada kişisel veriyi toplama.

### 2.7 — Arşiv, migration ve API

- [ ] Content Intelligence şema sürümü ve güvenli migration.
- [ ] Arşivleme politikasını belirle: türetilmiş kayıtları arşivle veya geri yükleme sonrası deterministik yeniden indeksle.
- [ ] Yarım kalmış kuyruk işlerinin arşiv/geri yükleme sonrasında kaybolmamasını sağla.
- [ ] Status, stats, item lookup, related, compare, ingest, drain ve event API uçlarını doğrula.
- [ ] Limit/offset, mediaKey, body boyutu ve erişim kontrollerini uygula.
- [ ] API yanıtlarında kişisel veri, API anahtarı veya hassas hata ayrıntısı gösterme.

### 2.8 — Zorunlu testler ve kabul

- [ ] Film/TV ID çakışması.
- [ ] Aynı içeriğin çok profilden gelmesi.
- [ ] İlgilenmiyorum/gizlenen içeriklerin işlenmesi.
- [ ] Listeden silmenin ortak kaydı silmemesi.
- [ ] Kişisel alanların hiçbir ortak tabloda bulunmaması.
- [ ] Poster/görsel verisinin işlenmemesi.
- [ ] Hash aynıyken atlama, değişince yeniden işleme.
- [ ] Olay tekrarında tek iş oluşması.
- [ ] Event kaydı / enqueue hata senaryosu.
- [ ] Aynı media_key için eşzamanlı işleme.
- [ ] TMDB 429/5xx retry ve sunucu yeniden başlatma kurtarması.
- [ ] Bozuk/eksik metadata.
- [ ] Çok kullanıcılı ortak içerik ve veri izolasyonu.
- [ ] API güvenliği, arşiv ve migration testleri.
- [ ] `npm ci`, `npm run lint`, `npm test`, `npm run test:taste`, `npm run test:e2e`, `npm run build`.

**Faz 2 kabul şartı:** Ortak içerik deposu kullanıcıdan bağımsız olmalı; kişisel veri sızıntısı imkânsızlaştırılmalı; tüm ilgili liste akışları kuyruğa bağlanmalı; kuyruk kayıpsız ve kurtarılabilir olmalı; analizler sürümlü/idempotent olmalı; testler geçmeli.

## 3. Uygulama sırası

1. Faz 1 kapanış düzeltmeleri ve CI doğrulaması.
2. Faz 2 güvenlik allowlist'i ve kişisel veri testleri.
3. Event/outbox atomikliği ve kalıcı kuyruk.
4. Gerçek liste akışları ve metadata edinme entegrasyonu.
5. Başlangıç indekslemesi.
6. Feature / mood / semantic analiz doğrulaması.
7. Migration, arşiv ve API güvenliği.
8. Tam test paketi ve Faz 2 kabul.

## 4. Çalışma kuralları

- Önce mevcut `master` kodunu incele; önceki mimariyi körlemesine geri kopyalama.
- Faz 1 ve Faz 2'nin çalışan kodunu silme veya yeniden adlandırma.
- Eski uygulama davranışını, kullanıcı verisini ve öneri sonuçlarını koru.
- Yeni paralel repository, EventBus veya queue oluşturma.
- Her adımı gerçek entegrasyon ve test ile tamamla.
- Testleri geçmek için test kapsamını silme veya daraltma.
- Yerel test raporunu GitHub Actions sonucu gibi sunma.
- Her committe değişiklik kapsamını ve silinen dosyaları ayrıca kontrol et.
