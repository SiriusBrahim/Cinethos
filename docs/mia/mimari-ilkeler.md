# MIA — Mimari İlkeler ve Değişmez Kurallar

> **Statü:** Bağlayıcı. Faz 1'den itibaren her değişiklik bu sekiz kurala göre değerlendirilir; kural ihlali "borç" olarak değil **kusur** olarak işlenir.
> **Dayanak:** [Faz 0 denetimi](./faz0-checklist.md) · [Dönüşüm planı](../../MIA_TRANSFORMATION_PLAN.md) §4 ve §8
> **Son doğrulama:** 425/425 çekirdek + 362/362 zevk testi, lint temiz, build 427,71 kB.

## 1. Modüler monolit

**Kural:** Mikroservis yok. Modüller tek uygulamada, tanımlı arayüzler (`service.ts`) üzerinden konuşur.

**Bugünkü durum:** Tek süreç (`server.ts` + Vite istemcisi), tek SQLite/JSON deposu — hedefe uygun. Ancak gerçek modül sınırı yok: `App.tsx` 4.651 satırla kabuk + kütüphane + öneri + senkron + ayarları birlikte taşıyor.
**Mekanizma:** Faz 3–7'de yönetici klasörleri + `service.ts` sözleşmeleri; Faz 8'de `no-restricted-imports` kuralları. Ağ çağrısı yalnız `content/providers` ve `data/synchronization` içinden.
**Açık risk:** App.tsx bölünmeden eklenen her özellik sınırı daha da bulanıklaştırır; yeni özellikler doğrudan hedef modüle yazılmalı.

## 2. Hiyerarşik yapı — Manager → Submodule → Helper

**Kural:** Üç katman. Her küçük fonksiyon için dosya/modül açılmaz; yardımcılar sahibinin yanında kalır.

**Bugünkü durum:** Envanter 73 manager/service yüzeyi tespit etti; buna karşılık **11 hiç import edilmeyen dosya** ve 189 kullanılmayan export var — "her iş için ayrı dosya" eğiliminin ürettiği artık.
**Mekanizma:** Yeni modül ancak (a) kendi durumu veya (b) dışa açılmış sözleşmesi varsa açılır; tek kullanımlık dönüşümler sahibi modülün `helpers` bloğunda kalır. Faz 8'de ölü dosya temizliği, öncesinde yeni ölü dosya eklenmez.
**Açık risk:** "Helper" adı altında dördüncü katman türemesi; kod incelemesinde katman sayısı kontrol edilir.

## 3. Mevcut sistemleri koruma

**Kural:** İncelenmeden yeniden yazılmaz. Önce davranış kayda alınır, sonra taşınır.

**Bugünkü durum:** Faz 0'da 7 belge + ölçüm aracı (`npm run inventory:arch`) ve 3 baseline testi mevcut; davranış `tests/faz0-baseline.test.mjs` ile kilitli (öneri puanları 66/49, silme/geri yükleme, profil izolasyonu).
**Mekanizma:** Her taşıma öncesi ilgili akış için karakterizasyon testi; taşıma sonrası aynı test değişmeden yeşil kalmalı. Test değişikliği gerekiyorsa gerekçe commit mesajında yazılır.
**Açık risk:** Kalan 7 E2E testi eski seçicilerle kırık; bu davranışlar şu an yalnız kod incelemesiyle biliniyor.

## 4. Veri bütünlüğü

**Kural:** İzleme listeleri, tercihler, zevk profili, öneri geçmişi ve ilişki grafiği refaktör sırasında korunur.

**Bugünkü durum:** Sunucu tarafı sağlam: `revision` + `If-Match`, `409`, `sudden_item_drop`, 7 dönüşümlü snapshot, mezar taşı (`deleted_keys`, 30 gün), bozuk yedeğin reddi — hepsi testli.
**Açık risk (gerçek):** Marka değişikliği tarayıcı anahtarlarını (`*_taste_map_*`, IDB adları, PWA cache) yeni ada taşıdı; **eski anahtarlardaki mevcut kullanıcı verisi okunmuyor.** Karar bekliyor: geçiş katmanı (eski ad koda yazılmadan) veya bilinçli sıfırlama.
**Mekanizma:** Şema değişikliği = sürüm + geçiş + geri alma yolu. `archive-restore-consistency` ve baseline testleri kapı bekçisi.

## 5. Tekrarlı işlemden kaçınma

**Kural:** İndirilen/analiz edilen içerik gereksiz yeniden indirilmez veya yeniden hesaplanmaz.

**Bugünkü durum:** Katmanlar var — istemci TTL + in-flight birleştirme (`fetchTmdbCached`), sunucu LRU (500), poster IDB LRU (200 MiB, günlük kota), `ct:stock` deposu, film detay önbelleği. Buna karşılık `SeriesRecommendationsSection` kendi `buildTasteProfileV3` hesabını yapıyor (çift hesap yolu).
**Mekanizma:** Pahalı hesap tek sahipte memoize edilir; modüller arası paylaşım için sonuç `service.ts` üzerinden alınır. Yeni önbellek eklemek yerine var olan anahtar kullanılır (`ct:*`).
**Açık risk:** Profil başına anahtarlanmayan önbellekler profil karışmasına yol açar (kural 6 ile birlikte değerlendirilir).

## 6. Asenkron işlem güvenliği

**Kural:** Arka plan görevleri `profileId` + kaynak `revision` taşır; eski profil için başlamış iş yeni profilin verisini değiştiremez.

**Bugünkü durum: SAĞLANMIYOR.** Öneri/katalog/poster/stok işleri `App` içinde tek state'e yazıyor, sonuç `profileId` damgası taşımıyor; profil değişiminde eski hesabın sonucu yeni profile düşebilir. Veri katmanı korumalı (409), UI katmanı değil.
**Mekanizma (Faz 2 ön koşulu):** Her uzun görev `{ profileId, baseRevision }` ile başlar; sonuç yalnız eşleşen profilde ve revizyonda uygulanır; `ProfileSwitched` olayı bekleyen görevleri iptal eder. `tests/` altında yarış testi zorunlu.
**Açık risk:** Bu kural uygulanmadan Faz 3+ modül taşımaları yarışı görünmez kılar.

## 7. Ortak iş mantığı (masaüstü + mobil)

**Kural:** İki arayüz aynı temel iş mantığını kullanır; fark yalnız sunumdadır.

**Bugünkü durum:** `MobileDashboard` hazır veri alır (`savedItems`, `recommendations` prop'ları) — ayrı hesap yapmıyor, bu yönüyle kurala uygun. Ancak mobil varyantta öneri seçimi tamamen App'e bağlı; App bölünürken mobilin de aynı sözleşmeye geçmesi gerekir.
**Mekanizma:** Sunum bileşeni yalnız `presentation/` altında; sorgu/komut çağrıları `service.ts`. Mobil ve masaüstü aynı hook/servis çağrısını kullanır, kopya mantık yasak.
**Açık risk:** Mobil için "hızlı" eklenen yerel hesap, kural 5 ve 7'yi aynı anda bozar.

## 8. Aşamalı geçiş

**Kural:** Bir fazın kabul kriterleri karşılanmadan sonraki fazın büyük uygulamasına geçilmez.

**Bugünkü durum:** Faz 0 kapandı: 13/15 madde tamam, 2 madde açık (asenkron profil yarışı, E2E seçicileri). Faz 1 (sözleşme tasarımı) için engel yok.
**Faz kapıları:**
| Kapı | Koşul |
| --- | --- |
| Faz 2 başlangıcı | `SyncStorePort` çıkarımı + profile damgası + yarış testi |
| Faz 3 başlangıcı | Kütüphane sözleşmeleri yeşil, App'ten taşınan akışlarda baseline testleri değişmeden geçiyor |
| Her faz sonu | lint 0 uyarı · 425/425 · 362/362 · build < 500 kB · E2E kritik senaryolar yeşil |

## Kural → doğrulama eşlemesi

| Kural | Bugünkü kanıt | Otomatik bekçi |
| --- | --- | --- |
| 1 Modüler monolit | tek süreç, tek depo | Faz 8 import kuralları |
| 2 Hiyerarşi | 73 yüzey, 11 ölü dosya | envanter §14–15 |
| 3 Mevcut koruma | 7 Faz 0 belgesi | `faz0-baseline.test.mjs` |
| 4 Veri bütünlüğü | 409/428, snapshot, mezar taşı | `persistent-store`, `sqlite-primary-store`, `archive-restore-consistency` |
| 5 Tekrarsız iş | TTL + LRU + stok | `tmdb-proxy`, `poster-cache-manager` testleri |
| 6 Asenkron güvenlik | **yok** | Faz 2 yarış testi (yazılacak) |
| 7 Ortak mantık | mobil hazır veri alıyor | Faz 3 sözleşme testleri |
| 8 Aşamalı geçiş | Faz 0 kapandı | faz kapıları tablosu |
