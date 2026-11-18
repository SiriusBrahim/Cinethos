# Ajan 2 Uygulama Görevi — TMDB Kanonik İçerik Kimliği Standardı

**Öncelik:** P1 — veri bütünlüğü / mimari standart  
**Sorumlu:** Yalnızca Ajan 2 (uygulama ve gerekli testler)  
**Takip yeri:** PR #43 — Faz 5–6 bağımsız denetim PR'ı  
**Kural:** Bu belge uygulama talimatıdır; Ajan 1 yalnızca bağımsız denetim yapar. Ajan 1 uygulama kodunu yazmaz. Hiçbir ajan master'a doğrudan push/merge yapmaz.

## 1. Amaç ve karar

Cinethos'ta TMDB kaynaklı her film veya dizi, uygulamanın tüm modüllerinde aynı TMDB kimliğiyle tanınmalıdır. TMDB'den alınan id değeri kanonik kaynak kimliğidir; uygulama modülleri aynı içeriğe yeni/bağımsız kimlikler üretmemeli veya başlık, yıl, slug gibi alanlardan kimlik türetmemelidir.

Kanonik kimlik iki bileşenden oluşur:

- tmdbId: number — TMDB'nin içerik için döndürdüğü pozitif tam sayı ID.
- mediaType: "movie" | "tv" — TMDB medya türü.

Uygulama genelinde karşılaştırma, indeksleme, cache ve modüller arası referans için birleşik anahtar:

- Film: tmdb:movie:<tmdbId>
- Dizi: tmdb:tv:<tmdbId>

Örnek:
- { tmdbId: 343611, mediaType: "movie" } → tmdb:movie:343611
- { tmdbId: 1396, mediaType: "tv" } → tmdb:tv:1396

**Önemli:** Tek başına sayısal ID'yi uygulama genelinde benzersiz kabul etmeyin. mediaType anahtarın parçası olmalıdır. Ham TMDB ID de kayıtta korunmalıdır; contentKey onun yerine geçmez, onu tür bilgisiyle adlandırır.

## 2. Merkezi sözleşme ve tek üretim noktası

Mevcut mimari/isimlendirmeye uygun tek bir ortak domain modülü oluşturun veya var olan eşdeğer modülü genişletin. Önerilen sorumluluk: src/modules/content-identity/ (projedeki mevcut katman kuralları farklıysa uygun ortak domain konumunu seçin; aynı mantığı birden fazla yere kopyalamayın).

Asgari sözleşme:

    export type MediaType = "movie" | "tv";

    export interface TmdbContentIdentity {
      tmdbId: number;
      mediaType: MediaType;
      contentKey: string;
    }

    export function createContentKey(
      tmdbId: number,
      mediaType: MediaType
    ): string {
      if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) {
        throw new Error("Invalid TMDB content id");
      }
      if (mediaType !== "movie" && mediaType !== "tv") {
        throw new Error("Invalid TMDB media type");
      }
      return `tmdb:${mediaType}:${tmdbId}`;
    }

Bu örnek davranış sözleşmesidir; mevcut TypeScript standartlarına göre branded type, Result/guard veya hata modeli kullanılabilir. Ancak:
- Anahtar formatı tek ve deterministik olmalı.
- Aynı girdiler daima aynı anahtarı üretmeli.
- Geçersiz ID veya medya türü sessizce kabul edilmemeli.
- Modüller kendi contentKey üretim fonksiyonlarını yazmamalı.
- contentKey mümkünse türetilmiş alan olarak hesaplanmalı; birbirinden bağımsız iki kaynakta farklı değerler saklanıp drift yaratılmamalı.

## 3. Kapsam: hangi veriler aynı kimliği kullanacak?

Önce mevcut kod tabanında içerik kimliği alanlarını ve içerik referanslarını envanterleyin. Ardından aşağıdaki TMDB film/dizi kayıtlarını aynı sözleşmeye bağlayın:

1. TMDB katalog kayıtları ve indirilmiş katalog havuzları.
2. Film/dizi detayları, arama sonuçları ve içerik zenginleştirme verileri.
3. İzledim, izleyeceğim, izliyorum, ilgilenmiyorum/gizle listeleri.
4. Favoriler ve kullanıcı koleksiyonları.
5. Öneri adayları, öneri sonuçları, öneri geçmişi ve öneri gizleme/tekrar gösterilmeme kayıtları.
6. Taste/zevk profili olayları, içerik bazlı metrikler ve geçmiş referansları.
7. İlişki/keşif grafiğindeki film/dizi düğümleri ve içerik bağlantıları.
8. Arka plan görevleri, kuyruk payload'ları ve içerik güncelleme görevleri.
9. Cache anahtarları, deduplikasyon kümeleri, indirme/işleme manifestleri.
10. JSON yedekleme, geri yükleme, GitHub senkronizasyonu ve varsa Excel/rapor dışa aktarma eşleştirmeleri.

Bir modülün kendi teknik kayıt ID'si (ör. event ID, job ID, kullanıcı ID, graph edge ID) varsa onu silmeyin. Bu kimlikler kendi nesnelerini tanımlar; ancak içlerinde bir film/diziye referans varsa referans mutlaka tmdbId + mediaType veya contentKey taşımalıdır.

Kişi/oyuncu kimlikleri film/dizi kimlikleriyle karıştırılmamalıdır. TMDB person ID ayrı bir kimlik alanı/türü olarak kalmalıdır. IMDb ID, TVDB ID veya diğer harici kimlikler de ayrı externalIds alanında tutulmalı; hiçbiri TMDB ID'nin yerine yazılmamalıdır.

## 4. TMDB API entegrasyon kuralları

- TMDB arama/keşif yanıtlarından gelen id ve media_type (veya endpoint'in bağlamından kesin bilinen movie / tv) alınarak kanonik kimlik oluşturulmalı.
- Film detayları /movie/{tmdbId}, dizi detayları /tv/{tmdbId} üzerinden çağrılmalı. Yanlış medya türü endpoint'i denenmemeli.
- Bir içerik için yeniden veri gerektiğinde önce contentKey ayrıştırılarak tmdbId ve mediaType bulunmalı; başlıkla yeniden arama yapılmamalı.
- Arama sonuçlarında medya türü belirsizse kayıt kesin film/dizi olarak sınıflandırılmadan kalıcı katalog/listelere alınmamalı.
- TMDB'den gelen ID string biçiminde geliyorsa sınırda güvenli biçimde pozitif tam sayıya dönüştürülmeli; iç domain modelinde tek tip sayısal değer kullanılmalı.
- TMDB yanıtındaki id hiçbir koşulda yerel sıralama indeksi, dizi index'i veya başka bir alanla ezilmemeli.
- Harici ID çözümleme (ör. IMDb ID ile TMDB kaydını bulma) ayrı bir eşleme akışı olmalı; bulunan TMDB kimliği kanonik kimlik olarak saklanmalı.

## 5. Depolama, cache ve deduplikasyon

- İçerik benzersizliği için bütün sorgu/indeks/Map/Set anahtarlarında türü içeren contentKey kullanın.
- Aynı tmdbId + aynı mediaType ikinci kez geldiğinde yeni içerik oluşturmak yerine mevcut kayıt güncellenmeli/birleştirilmelidir.
- Aynı sayısal ID farklı medya türüyle gelirse otomatik olarak aynı kayıt sayılmamalıdır.
- Cache anahtarları medya türünü içermelidir; movie:123 ve tv:123 cache çakışması yaşamamalıdır.
- Katalog sayacı, indirme eşiği, film/dizi havuzu ve öneri filtreleri mevcut davranışlarını korumalıdır.
- İçerik verisinin farklı modüllerde kopyalanması gerekiyorsa kopyalar aynı kimliği taşımalı; modüller arası senkronizasyon kimlik üzerinden yapılmalıdır.

## 6. Mevcut veriye geçiş — veri kaybı yasak

Bu iş yalnızca yeni kayıtlar için uygulanıp bırakılmamalı. Mevcut kayıtlar, yedekler ve geçmiş veriler incelenmelidir.

1. Mevcut film/dizi kayıtlarında kullanılan id, tmdbId, mediaType, type, source ve benzeri alanların anlamını kod ve gerçek veri örneklerinden belirleyin. Alan adını görerek TMDB ID olduğunu varsaymayın.
2. Her kaydı güvenilir TMDB kimliğine bağlayabiliyorsanız tmdbId + mediaType biçimine normalize edin.
3. TMDB ID'si olmayan yerel/legacy kayıtları tahminle eşleştirmeyin. Bunları açıkça legacy/unresolved olarak işaretleyin ve kontrollü çözümleme yolu bırakın.
4. Aynı kanonik kimliğe çıkan yinelenen kayıtları birleştirirken izleme durumu, kullanıcı notu, puan, tarih, favori, gizleme, öneri geçmişi ve Taste olaylarını kaybetmeyin. Çakışan alanlar için deterministik ve belgelenmiş bir öncelik kuralı belirleyin.
5. Eski ID'lere referans veren event, list, cache, graph edge ve yedek kayıtlarını geçişte güncelleyin veya geriye dönük çözümleme tablosu sağlayın.
6. Migration idempotent olmalı: ikinci kez çalıştırıldığında kayıtları çoğaltmamalı veya kullanıcı verisini değiştirmemelidir.
7. Migration öncesi/sonrası kayıt sayıları ve kritik kullanıcı verisi sayıları raporlanmalı; başarısızlıkta güvenli rollback/backup yolu bulunmalıdır.
8. JSON backup şemasında geriye uyumluluk gerekiyorsa eski alanları okuma desteği korunmalı; yeni yazımlar kanonik kimlik standardını kullanmalıdır. Şema sürümü gerekiyorsa artırın.

**Asla:** başlık + yıl üzerinden otomatik ve kesin eşleştirme yapmayın; TMDB ID'si bilinmeyen kayda rastgele/yerel bir TMDB ID üretmeyin; kullanıcı listelerini veya geçmişini silip yeniden indirmeyin.

## 7. Geriye uyumluluk ve API sınırları

- Mevcut public/internal fonksiyonların çağrı imzalarını gereksiz yere kırmayın.
- Eski id alanı geçiş süresince başka sistemler tarafından tüketiliyorsa kullanımını tespit edin; güvenli adaptör/deprecation ile geçiş yapın.
- UI'da görünen ID'yi kullanıcıya göstermek zorunlu değildir. Bu standart öncelikle domain, persistence ve servis sözleşmesidir.
- TMDB dışı içerik sağlayıcıları gelecekte eklenecekse bu görevde genel sağlayıcı soyutlaması icat etmeyin. Önce TMDB kanonik kimliğini doğru uygulayın; genişletme ihtiyacını ayrı tasarım olarak raporlayın.

## 8. Test ve kabul kriterleri

Aşağıdaki testler eklenmeli veya mevcut testlere açıkça dahil edilmelidir:

### Kimlik fonksiyonu
- Pozitif güvenli tam sayı + movie → beklenen film anahtarı.
- Pozitif güvenli tam sayı + tv → beklenen dizi anahtarı.
- Aynı sayısal ID, movie ve tv için farklı anahtar üretir.
- 0, negatif, kesirli, NaN, Infinity, güvenli tam sayı aralığı dışı ID reddedilir.
- Geçersiz medya türü reddedilir.
- Aynı girdiler deterministik sonuç verir.

### API / veri alımı
- Movie arama/detay yanıtı aynı TMDB ID ve movie türüyle saklanır.
- TV arama/detay yanıtı aynı TMDB ID ve tv türüyle saklanır.
- Detay çağrısı doğru endpoint'i kullanır.
- Eksik/belirsiz medya türü yanlış sınıflandırılarak kalıcılaştırılmaz.
- ID dönüşümü ve hata durumları test edilir.

### Modüller arası tutarlılık
- Aynı film katalog, watchlist, recommendation, Taste ve backup akışlarında aynı contentKey ile temsil edilir.
- Aynı TMDB kimliği tekrar ingest edildiğinde duplicate kayıt oluşmaz.
- Film/dizi havuz ayrımı ve öneri sayıları bozulmaz.
- Aynı sayısal ID'li movie/tv kayıtları birbirini ezmez.
- Cache, dedupe ve background task kimlikleri medya türünü korur.

### Migration / yedekleme
- Eski kayıtlar veri kaybı olmadan normalize edilir.
- Yinelenen kayıt birleştirme kullanıcı verisini korur.
- TMDB ID'si olmayan legacy kayıtlar yanlış eşleştirilmez.
- Migration ikinci çalıştırmada idempotenttir.
- Backup export/import ve GitHub sync round-trip aynı kanonik kimlikleri korur.
- Eski yedek formatı okunabiliyorsa geriye uyumluluk testi bulunur.

### Tamamlanma koşulu
- TypeScript, lint, ilgili unit/integration testleri, tüm test paketi, build ve CI başarılı olmalı.
- Mevcut film/dizi öneri puanları, sıralama, film/dizi filtreleri ve kullanıcı listeleri için regresyon olmadığını kanıtlayın.
- Değişen tüm modülleri ve eski kimlik alanlarının nasıl ele alındığını raporlayın.
- Migration gerekiyorsa önce dry-run özeti ve veri koruma kanıtı sunun.
- Kapsam çok genişse sessizce yarım bırakmayın: tamamlananları, ertelenenleri ve nedenlerini açıkça yazın; bu standardı tamamlandı olarak işaretlemeyin.

## 9. Uygulama sırası

1. Kod tabanında tüm içerik ID üretim/taşıma/eşleştirme noktalarını tarayın; dosya ve alan bazlı envanter çıkarın.
2. Mevcut veri modelini ve gerçek backup örneklerini inceleyerek hangi ID'lerin gerçekten TMDB ID olduğunu kanıtlayın.
3. Ortak kimlik sözleşmesini ve tek üretim fonksiyonunu ekleyin.
4. TMDB ingest ve detail-fetch sınırlarını bu sözleşmeye bağlayın.
5. Katalog, listeler, öneriler, Taste, ilişkiler, cache ve background task referanslarını aşamalı olarak standarda taşıyın.
6. Migration ve backup uyumluluğunu uygulayın.
7. Birim, entegrasyon, migration ve regresyon testlerini ekleyin.
8. Tam CI çalıştırın; sonuçları ve açık kalan kapsamı raporlayın.

## 10. Ajan 2 için kesin sınırlar

- Bu görev Ajan 2'nin uygulama işidir; Ajan 1 yalnızca PR #43'teki test/denetim sorumluluğunu sürdürür.
- PR #43'teki mevcut A4/A5 test bulgularını ve Faz 5–6 denetim kapsamını silmeyin veya değiştirmeyin.
- Bu işi PR #44'teki Sinema Kimliği panelleri / runtime diagnostics değişiklikleriyle karıştırmayın.
- Master'a push veya merge yapmayın. Geliştirme branch'inde çalışın ve mevcut Agent 2 geliştirme PR'ına/planına uygun şekilde raporlayın.
- Önce mevcut mimariyi okuyun; dosya yapısını körlemesine bu belgedeki örneğe zorlamayın.
- Bu standardı uygularken puanlama formüllerini, öneri davranışını, UI tasarımını veya kullanıcı özelliklerini ilgisiz biçimde değiştirmeyin.

**Nihai çıktı:** Değişen dosyaların listesi, kanonik kimlik veri sözleşmesi, migration özeti ve dry-run kanıtı (gerekiyorsa), test/CI sonuçları, geriye uyumluluk notları ve tamamlanmayan maddeler.
