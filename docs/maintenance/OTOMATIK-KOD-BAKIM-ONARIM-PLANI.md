# Cinethos — Otomatik Kod Bakım ve Onarım Modülü

> **Yerleşim:** MIA Faz 3'e başlamadan önce tamamlanacak bağımsız altyapı işi. MIA Faz 0–8 numaralandırması değiştirilmez; bu çalışma yeni bir MIA fazı değildir. Mevcut test/CI doğrulama planı da yalnızca test ve CI işlerini kapsayacak şekilde ayrı kalır.

## 1. Amaç ve sınırlar

GitHub deposunu düzenli olarak analiz eden, kod kalitesi/güvenlik/bağımlılık sorunlarını belirleyen, düşük riskli mekanik sorunları kontrollü biçimde düzelten ve her değişikliği mevcut test/CI hattından geçiren bağımsız bakım otomasyonu kurulur.

**Çalışma yeri:** Cinethos uygulamasının runtime'ı değil; GitHub Actions üzerinde çalışan depo otomasyonu. Uygulama çalışmasa veya build edilemese de bakım taraması çalışabilmelidir.

**Temel ilkeler**
- Bakım botu hiçbir zaman doğrudan `master` dalına yazmaz.
- Her değişiklik ayrı branch ve Pull Request üzerinden sunulur.
- Test/CI doğrulaması bakım modülünün yerine geçmez; bakım modülü de test/CI'ın yerine geçmez.
- Otomatik düzeltme yalnızca açıkça izin verilen düşük riskli kurallarda yapılır.
- Veri migrasyonu, kullanıcı verisi, veritabanı şeması, öneri/zevk algoritmaları, profil izolasyonu, modül sözleşmeleri ve mimari sınırlar otomatik olarak değiştirilmez.
- Başarısız doğrulama durumunda değişiklik PR'a hazır kabul edilmez; otomatik merge yapılmaz.
- Her tarama ve düzeltme denetlenebilir rapor üretir.

## 2. Mimari bileşenler

| Bileşen | Sorumluluk |
|---|---|
| Maintenance Orchestrator | Taramaları ve bakım adımlarını sıraya koyar; kapsam ve limitleri uygular. |
| Code Health Scanner | Lint, TypeScript, statik analiz, karmaşıklık, kullanılmayan kod ve tekrar sinyallerini toplar. |
| Dependency Auditor | Bağımlılık güncelliği, deprecated paketler, lisans ve güvenlik advisory sonuçlarını raporlar. |
| Architecture Guard | Katman/modül import sınırlarını ve yasak bağımlılıkları denetler; ilk sürümde yalnızca raporlar. |
| Safe Fixer | Allowlist içindeki deterministik, düşük riskli düzeltmeleri uygular. |
| Risk Classifier | Bulgu ve düzeltmeleri risk seviyesine ayırır; izin verilmeyen değişiklikleri bloke eder. |
| Validation Runner | İlgili testleri ve zorunlu CI komutlarını çalıştırır. |
| PR Reporter | Bulguları, diff'i, test sonuçlarını ve riskleri PR açıklamasında raporlar. |

## 3. Risk ve yetki modeli

### R0 — Otomatik düzeltilebilir
Yalnızca deterministik ve davranış değiştirmeyen işlemler:
- Formatter/linter tarafından güvenle otomatik düzeltilebilen biçim sorunları.
- Kanıtlanmış kullanılmayan importların temizlenmesi.
- Güvenli ve kapsamı net mekanik kod temizliği.
- Lockfile'ın mevcut manifestlerle deterministik biçimde yeniden üretilmesi (bağımlılık sürümü yükseltmeden).

R0 değişiklikleri bile ayrı branch/PR ve CI gerektirir.

### R1 — PR önerisi, otomatik merge yok
- Basit tip sorunları.
- Yinelenen kod azaltımı ve sınırlı refaktör.
- Performans iyileştirmeleri.
- Hata yönetimi/guard eklenmesi.
- Güvenlik advisory'si için uyumlu bağımlılık güncellemesi.

Bot çözüm önerisi ve test kanıtı sunabilir; geliştirici incelemesi gerekir.

### R2 — İnsan tasarımı ve onayı zorunlu
- SQLite/IndexedDB/JSON şeması ve migration.
- Kullanıcı/profil verisi, senkronizasyon ve yedekleme akışları.
- Zevk, hafıza, ilişki ve öneri algoritmaları.
- EventBus, Outbox, queue semantiği ve modül yaşam döngüsü.
- Modül/API sözleşmeleri, mimari taşıma ve büyük refaktör.
- Kimlik doğrulama, yetkilendirme veya güvenlik sınırlarını etkileyen değişiklikler.

Bu alanlarda bot yalnızca bulgu/etki analizi ve manuel görev taslağı oluşturur.

## 4. Uygulama aşamaları

### M0 — Güvenli temel ve gözlem modu
- [ ] Ayrı GitHub Actions workflow oluştur.
- [ ] Workflow yalnızca read-only analiz yapsın; repository write token kullanmasın.
- [ ] Lint, TypeScript, test/build sonuçlarını ve statik analiz bulgularını tek raporda birleştir.
- [ ] Bağımlılık güvenlik taraması ekle.
- [ ] Mimari import sınırları için mevcut yapıyı ölç; henüz otomatik düzeltme yapma.
- [ ] Çıktıları GitHub Actions özeti ve artifact olarak sakla.

**Kabul:** Workflow PR ve zamanlanmış çalışmada güvenilir rapor üretir; kaynak kodu veya branch değiştirmez.

### M1 — Kontrollü R0 otomatik düzeltmeler
- [ ] R0 allowlist ve dosya kapsamını kod/config olarak tanımla.
- [ ] Formatter/linter safe-fix ve kanıtlanmış kullanılmayan import temizliğini uygula.
- [ ] Değişiklik yoksa PR açma.
- [ ] Değişiklik varsa sabit isimlendirme kuralıyla bot branch'i aç ve PR oluştur.
- [ ] PR açıklamasına değişen dosyaları, uygulanan fixer'ları ve diff özetini yaz.
- [ ] Aynı bulgu için tekrar tekrar PR açılmasını engelle (idempotent branch/PR kontrolü).

**Kabul:** Yalnızca R0 allowlist kapsamı değişir; master'a doğrudan yazım ve otomatik merge yoktur.

### M2 — R1 öneri ve bağımlılık bakımı
- [ ] Tip, karmaşıklık, kod tekrarı ve performans bulgularını raporla.
- [ ] Güvenlik advisory'lerini önem ve erişilebilirlik düzeyine göre sınıflandır.
- [ ] Bağımlılık yükseltmelerini ayrı PR'lara böl; major sürümleri otomatik yükseltme.
- [ ] R1 düzeltmelerini öneri olarak PR'a ekle; otomatik merge etme.
- [ ] Breaking change, migration ve lockfile etkisini raporla.

**Kabul:** Her öneri etki alanı, risk, test kanıtı ve geri alma notu içerir.

### M3 — Mimari koruma ve bakım raporu
- [ ] MIA modül sınırları ve yasak import kurallarını otomatik denetle.
- [ ] Döngüsel bağımlılıkları ve katman ihlallerini raporla.
- [ ] Büyük dosya/sorumluluk yoğunluğu eğilimlerini zaman içinde izle.
- [ ] Haftalık bakım raporu üret; açık bulguları önceki raporla karşılaştır.
- [ ] Bakım otomasyonunun kendi workflow ve scriptleri için test ekle.

**Kabul:** Mimari ihlaller sessizce değiştirilmez; raporlanır ve insan kararıyla giderilir.

## 5. Çalıştırma tetikleyicileri

- Her Pull Request: read-only hızlı tarama ve ilgili doğrulama.
- Her gece: bağımlılık/güvenlik ve statik analiz taraması.
- Haftalık: kapsamlı mimari ve kod sağlığı raporu.
- Elle tetikleme: R0 safe-fix PR üretimi.

Zamanlanmış işler kaynak kodu doğrudan değiştirmez; R0 onarım PR'ı ayrı, denetlenebilir bir işlem olarak çalışır.

## 6. Güvenlik ve operasyonel korumalar

- En az yetki ilkesi: analiz workflow'unda read-only izinler.
- PR açma workflow'unda gereken en dar GitHub izinleri.
- Fork PR'larında secrets ve write token kullanılmaz.
- Bot kendi PR'ını otomatik onaylayamaz veya merge edemez.
- Dosya allowlist'i dışındaki değişiklikler reddedilir.
- Değişiklik boyutu/satır limiti aşılırsa işlem durur.
- Lockfile/manifest değişiklikleri bağımlılık denetimi olmadan kabul edilmez.
- Test başarısızlığında PR başarısız/blocked olarak raporlanır; başarısız testler silinmez veya gevşetilmez.
- Her PR'da önceki commit'e dönüş ve düzeltme gerekçesi bulunur.

## 7. Zorunlu doğrulama

- [ ] Workflow YAML lint/doğrulaması.
- [ ] R0 fixer'ları için fixture tabanlı testler.
- [ ] Allowlist dışı dosyaya dokunmama testi.
- [ ] Aynı girdide idempotent çıktı testi.
- [ ] Test başarısızlığında PR'ın başarılı/merge edilebilir gösterilmediği testi.
- [ ] Fork PR güvenlik ve izin testi.
- [ ] Bot branch/PR tekrar çalıştırma testi.
- [ ] `npm run lint`, `npm test`, `npm run test:taste`, `npm run build` ve uygun E2E doğrulaması.

## 8. Faz 3 öncesi kabul kapısı

MIA Faz 3'e ancak aşağıdakiler sağlandığında geçilir:

- [ ] MIA Faz 1/Faz 2 için mevcut test ve CI doğrulama planı yeşil.
- [ ] M0 gözlem workflow'u tamamlanmış ve CI'da başarılı.
- [ ] M1 R0 kontrollü onarım PR akışı test edilmiş.
- [ ] R0 allowlist, R1/R2 sınırları ve insan onayı kuralları belgelenmiş.
- [ ] Bakım otomasyonu master'a doğrudan yazmıyor ve otomatik merge yapmıyor.
- [ ] Bakım modülünün kendisi test edilmiş ve sonuçları aynı commit SHA üzerinde CI'da yeşil.

M2 ve M3, Faz 3 öncesi zorunlu kapı değildir; Faz 3 devam ederken ayrı PR'larla geliştirilebilir. Ancak R2 alanlarında otomatik onarım hiçbir aşamada yetkilendirilmez.

## 9. Ajan teslim raporu

1. Workflow ve script dosyalarının listesi.
2. Her aşamanın tamamlanma durumu.
3. R0 allowlist ve R1/R2 yasak/izin sınırları.
4. Örnek tarama raporu ve oluşturulan PR bağlantıları.
5. Güvenlik/izin modeli ve fork PR davranışı.
6. Test komutları, sonuçları, Actions bağlantıları ve doğrulanan commit SHA.
7. Bilinen sınırlamalar ve Faz 3 öncesi kabul kapısındaki açık maddeler.
