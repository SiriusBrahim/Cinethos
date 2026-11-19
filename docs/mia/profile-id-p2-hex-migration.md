# Profil kimliği normalizasyonu ve p2-hex geçişi

**Uygulama kaydı:** 2026-11-19

## Kanonik kimlik

- Profil kimliği trim edilir ve büyük harfli İngilizce ASCII biçimine çevrilir.
- `Ç/ç → C`, `Ğ/ğ → G`, `İ/i/I/ı → I`, `Ö/ö → O`, `Ş/ş → S`, `Ü/ü → U`.
- Latin aksanları temel Latin harfine indirgenir; `ß`, `æ`, `œ`, `ø`, `ł`, `đ`, `ð`, `þ` gibi Latin harfleri açık transliterasyonla dönüştürülür.
- Cyrillic, Arabic, CJK ve desteklenmeyen diğer alfabeler sessizce silinmez; kimlik reddedilir.
- Örnek: `profile-aaa`, `Profile-Aaa`, `PROFILE-AAA` aynı `PROFILE-AAA` kimliğidir.

## Yeni dizin şeması

Yeni profil partition dizini `p2-hex-<lowercase-hex-UTF8>` biçimindedir. Hex girdisi kanonik büyük harfli kimliğin UTF-8 baytlarıdır. Dizin adında yalnızca küçük harfli hex bulunduğundan büyük/küçük harfe duyarsız dosya sistemlerinde harf çakışması oluşmaz.

## Eski p1-b64url geçişi

- `p1-b64url` dizinleri ve `version: 1` manifestleri okunmaya devam eder.
- Eski manifestteki profil anahtarları ve ters eşlemeler kanonik kimliğe normalize edilir. İki eski kimlik aynı kanonik kimliğe dönüşürse geçiş durur; kayıtlar birleştirilmez.
- Geçiş sırası: profil kilidi al → p1 kaynağını p2 geçici dizinine kopyala → dosya türlerini ve SHA-256 içeriklerini doğrula → atomik rename ile p2 dizinini yayımla → `version: 2, scheme: p2-hex` manifestini atomik yaz → p1 kaynağını kaldır.
- p2 hedefi zaten varsa p1 ve p2 içerikleri birebir karşılaştırılır. Farklı içerik varsa çakışma olarak durdurulur; hiçbir kaynak veya hedef veri silinmez.
- Kesinti geçici dizin veya eş içerikli p1+p2 dizinleri bırakırsa sonraki çağrı geçişi güvenle tamamlayabilir.
- Profil store okumaları da manifest/dizin geçişini tamamlayarak p2 yolunu kullanır.
- Manifesti olmayan bir profilde yalnızca tek bir eşleşen p1 dizini bulunursa aynı doğrulama sırasıyla taşınır. Birden fazla eşleşen p1 dizini otomatik birleştirilmez.
- Global, profile atanmamış legacy taste dosyaları (A5/S1) otomatik olarak herhangi bir profile bağlanmaz; bu veri için açık kullanıcı onayı ve sahiplik kanıtı gerekliliği korunur.

## Kapsam ve doğrulama

Merkezi normalizer `src/core/profile-id.ts` içinde tanımlıdır; core belge normalizasyonu, ProfileContext, event bus, offline queue, recommendation service, server repository ve backup endpoint girişlerinde kullanılır. Taste store ve manifest bütünlüğü aynı normalizer üzerinden doğrulanır.

Yeni testler Türkçe/Latin normalizasyonunu, desteklenmeyen alfabeleri, p2 deterministik kodlamasını, p1 manifest/dizin geçişini, veri bütünlüğünü, çakışma halinde kaynak korumasını ve profil izolasyonunu kapsar.
