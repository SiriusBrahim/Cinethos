# Aşama 3 — Öneri motoru doğruluğu ve performansı

**Kapsam:** B-03, B-11, B-12, B-13, B-22
**Branch:** `remediation/full-project-remediation` · **PR:** #65
**Başlangıç HEAD:** `cd7c1c7` · **Bitiş HEAD:** bu dokümanın commit'i (rapor sonunda)

Bu aşamada öneri motorunun mevcut mimarisi **yerinde** bırakıldı: tek öneri hattı
(`scoreRecommendationPool` → `rescoreShortlist` → `selectRecommendationBatch`),
tek puanlayıcı (`scoreCandidatesV3`) ve tek profil kurucu (`buildTasteProfileV3`)
korundu. İkinci bir sıralama yolu, yeni bir framework veya Worker eklenmedi.

---

## 1. Mevcut akış (kod üzerinden çıkarıldı)

| Soru | Cevap (dosya / fonksiyon) |
|---|---|
| Zevk profili nerede kuruluyor? | `src/core/cinetrack-core.ts` → `buildTasteProfileV3` (tür, oyuncu, yönetmen, anahtar kelime, sevilen yapım özellikleri, medya tercihi) |
| İzlenen/favori/puanlanan/gizlenen nasıl katılıyor? | `getUserSignalV3`: durum + puan → sinyal (`-0.8 … 1`), ağırlık, zaman azalması; gizlenen/ilgilenilmeyen yalnızca `isCandidateEligibleInPool` ile havuzdan elenir |
| Film ve dizi önerileri hangi fonksiyonlardan geçiyor? | `src/app/catalog-loader.ts` → film ve dizi havuzları ayrı `scoreRecommendationPool` çağrıları; nihai seçim tek `selectRecommendationBatch` |
| Benzerlik hangi özellikleri kullanıyor? | `src/core/loved-similarity.ts`: tür (Dice), hikâye (özet token örtüşmesi), kadro, atmosfer (yönetmen/koleksiyon), dönem |
| Aday havuzu nasıl oluşuyor? | `replenishCandidatePool` + `topUpFilteredCandidates` + katalog hidrasyonu; film/dizi ayrı |
| Ana seçim ve top-up nasıl çalışıyor? | `selectBalancedRecommendations` (ring0 → ring2, tür/dönem/popülerlik kotaları) + `pipeline.ts` overflow tamamlama |
| Hangi filtre hangi aşamada? | Havuz: `isCandidateEligibleInPool`; kısa liste: `filterOutLastRecommendedCandidates` + ring; seçim: ring/tip/kota |
| `serverTaste` nerede üretiliyor/kullanılıyor? | `modules/recommendations/taste-signal.ts` → `buildServerTasteSignal`; `services/taste-signal-service.ts` (profil başına 5 dk önbellek); `scoreCandidatesV3` içinde puanlanıyor |
| Cache anahtarları? | `RecommendationService`: profil + revizyon + limit (Aşama 3'te katalog imzası, kapsam ve nesil eklendi) |
| Cache geçersizleştirme? | `invalidateProfile` (revizyon anahtarı) — Aşama 3'te LRU/TTL/nesil/katalog imzası eklendi |
| Skor açıklamaları nereden? | `scoreCandidatesV3` içindeki `tags`, gerçek `parts` değerlerinden; gösterimde `mapRecommendationBatchToDisplayItems` korur |

**Ölçüm öncesi tespit:** Baskın maliyet `computeLovedSimilarityScore` içindeydi:
her aday için **tüm** sevilen yapımlar dolaşılıyor ve her çiftte tür kimlikleri
yeniden kanonikleştiriliyordu (O(aday × geçmiş)).

---

## 2. B-03 — Karesel benzerlik maliyeti

**Önceki durum.** Her aday × her sevilen yapım için `calculateGenreSim` çağrısı
tür dizilerini yeniden kanonikleştiriyor, kadro/anahtar kelime kümeleri her çiftte
yeniden kuruluyordu. 5.000 × 5.000'de 25 milyon tam karşılaştırma.

**Kök neden.** Özellikler profil kurulurken hazırlanıyordu ama **benzerlik
karşılaştırmasında tekrar üretiliyordu**; ters indeks yoktu.

**Yapılan değişiklik (`src/core/loved-similarity.ts`, `buildTasteProfileV3`).**
1. Sevilen yapım özellikleri profilde bir kez hazırlanır; kanonik tür anahtarları
   `LovedItemFeatures.genreKeys` olarak saklanır.
2. Tür / oyuncu / yönetmen / koleksiyon / anahtar kelime için **ters indeks** kurulur;
   indeks `WeakMap` ile profil dizisi başına bir kez oluşturulur (profil değişmezse
   yeniden kurulmaz).
3. Aday için yalnızca ortak özellik taşıyan yapımlar indeksten çekilir ve paylaşılan
   özellik **sayaçları** üzerinden tam olarak puanlanır (çift başına Set araması yok).
4. Ortak özellik taşımayan yapımların benzerliği analitik taban değerden hesaplanır.
   Hızlı yol **yalnızca sonucu değiştiremeyeceği kanıtlandığında** kullanılır: en iyi
   eşleşme ve ilk üç benzerlik, eşleşmeyen bir yapımın ulaşabileceği üst sınırın
   kesinlikle üzerindeyse atlanır. Aksi halde tam yol çalışır.
5. Eşit katkıda eski algoritmanın seçtiği **ilk** yapım korunur (indeks sırasına göre
   gezilir); `matchedKey` dahil çıktı birebir aynıdır.
6. Tanılama için `getLovedSimilarityStats()` / `resetLovedSimilarityStats()`.

**Worker/dilimleme kararı.** Ölçüm, üretim boyutunda (1.000 aday ≈ 500 film + 500 dizi,
≈ 500 sevilen) toplam puanlamanın **~80 ms** olduğunu gösterdi; bu, etkileşimli akış
için kabul edilebilir. 5.000×5.000 yalnızca stres senaryosudur ve tek seferlik toplu
hesaplamadır. Ölçülen darboğaz artık ana iş parçacığında "saniyeler" değil, bu yüzden
**Worker eklenmedi**: iptal/eski sonuç yönetimi ve revizyon uyumu maliyeti, ölçülen
kazanca göre gerekçesiz karmaşıklık olurdu.

### Ölçüm

Komut: `node --import tsx scripts/bench-recommendations.mjs [--reference] [--only=…] [--shape=…] [--repeat=…]`
Ortam: Node **v26.13.1**, tek süreç, deterministik fixture (mulberry32 sabit tohum),
`now` sabit; gerçek kullanıcı verisi kullanılmaz. "Önce" = aynı betikte gömülü,
Aşama 3 öncesi algoritmanın birebir kopyası.

| Senaryo (aday × geçmiş) | Profil | Önce (ms) | Sonra soğuk (ms) | Hız | İndeksli karşılaştırma | Analitik | Fallback |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1.000 × 500 | karma | 1.115 | 158 | **7,1×** | 332.834 | 167.166 | 0 |
| 5.000 × 2.000 | karma | 22.474 | 1.434–1.561 | **~15×** | 6.670.400 | 3.329.600 | 0 |
| 5.000 × 5.000 | karma | 57.636 | 3.491–3.675 | **16,5×** | 16.688.088 | 8.311.912 | 0 |
| 10.000 × 5.000 | film/dizi/karma | — | 6.951–7.369 | — | 33.377.784 | 16.622.216 | 0 |
| 5.000 × 10.000 | film/dizi/karma | — | 6.837–7.437 | — | 33.367.322 | 16.632.678 | 0 |

- İlk üç satırda "önce" değerleri **aynı betikle** ölçüldü (1000×500: `--reference`,
  5000×5000: `--reference`); 5000×2000 "önce" değeri değişiklik öncesi kodla ayrıca
  ölçüldü (22.474 ms).
- 5.000 × 5.000 hedefi (denetimdeki 13–29 s) **3,5 s**'ye indi.
- **Skor uyuşmazlığı: 0**, ilk-20 örtüşmesi **20/20** (referansla birebir).
- Bellek: 5.000 × 5.000 karma senaryoda heap deltası **~54 MB** (indeks + sayaçlar).
- Soğuk/sıcak: indeks profil başına bir kez kurulduğundan sıcak koşumda indeks
  kurulumu yoktur; `indexBuilds = 1`. Kalan süre aday puanlamasıdır (deterministik).
- Ana iş parçacığı: puanlama senkron olduğu için "bloklanma" = ölçülen süre. Üretim
  boyutunda ~80 ms; stres senaryosunda 3,5 s (toplu hesaplama).

**Test kanıtı.** `tests/phase3-loved-similarity-index.test.mjs` (5 test):
farklı boyutlarda referansla **birebir skor + eşleşme** karşılaştırması, indeks
ön elemesinin kanıtı (400 yapımda ≤ 20 tam karşılaştırma), indeksin bir kez
kurulması, küçük liste/güvensiz durumda tam yol, eşleşmesiz taban davranışı.

**Son durum:** FIXED (ölçülmüş).
**Kalan risk:** Bellek kullanımı geçmiş boyutuyla doğrusal büyür (~54 MB @ 5.000);
10.000 sevilen yapımda indeks kurulumu ~0,6 s'dir. Çok büyük arşivlerde (>20.000)
indeksin kalıcılaştırılması veya dilimlenmesi ayrı bir iş olarak değerlendirilebilir.

---

## 3. B-11 — Film ve dizi tercih kapsamlarının ayrıştırılması

**Önceki durum.** `catalog-loader.ts` içinde film/dizi profilleri yerel olarak
kuruluyordu: dizi geçmişi yoksa **genel profil** (film + dizi karışık, film egemen)
dizi önerisinde kullanılıyor ve medya tipi tercihi (`mediaPreference`) olduğu gibi
taşınıyordu. Kural kod içinde dağınık ve test edilmemişti.

**Kök neden.** Kapsam politikası tek bir yerde tanımlı değildi; "hangi sinyal
paylaşılır" kararı kodun davranışından türetilemiyordu.

**Yapılan değişiklik.** `src/core/cinetrack-core.ts` → `buildScopedTasteProfiles`.

Politika (kodda ve testlerde sabit):
- Film profili **yalnızca film**, dizi profili **yalnızca dizi** geçmişinden kurulur.
  Bir türdeki kayıt sayısı diğer türün profilini ağırlıklandırmaz.
- Türler arası otomatik sinyal paylaşımı **yoktur**. Favori oyuncular ayrı bir ürün
  sinyalidir (`favoriteActors`); puanlar/favoriler türüne aittir.
- Kapsamlı profillerde `mediaPreference` **nötrlenir** (0.5/0.5): seçim film/dizi
  dengesini zaten ayrı yönettiği için "500 film izleyen" kullanıcı film adaylarına
  yapay tip bonusu almaz.
- Bir türde hiç geçmiş yoksa o kapsam **soğuk başlangıç** olarak genel profilden
  türetilir (yine nötr medya tercihiyle) ve `movieColdStart` / `tvColdStart` ile
  işaretlenir; yeni kullanıcı boş liste görmez. `movieItemCount` / `tvItemCount`
  gözlemlenebilirlik için döner.
- `catalog-loader.ts` yerel kopya mantığı kaldırıldı; tek çağrı kullanılıyor.

**Test kanıtı.** `tests/phase3-taste-scope.test.mjs` (8 test): büyük film + küçük dizi,
büyük dizi + küçük film, dengeli, yalnız film, yalnız dizi, iki türde favori oyuncu,
aynı türü farklı puanlama (film draması pozitif / dizi draması negatif), kaynak
verinin değişmemesi.

**Son durum:** FIXED.
**Kalan risk:** Soğuk başlangıçta diğer türün sinyalleri bilinçli olarak kullanılır;
bu, "soğuk başlangıç" işaretiyle açıktır ve ilk kayıt eklendiğinde kendiliğinden
kaybolur. Medya tipi tercihi nötrlendiği için `mediaType` bileşeni (ağırlık 0.03)
tür içi sıralamada sabit katkı yapar.

---

## 4. B-12 — Top-up/overflow filtre tutarlılığı

**Önceki durum.** Ana yol (`rescoreShortlist`) izlenen/gizlenen/ilgilenilmeyen ve son
önerilenleri eliyordu; `pipeline.ts` içindeki overflow tamamlama yolu ise yalnızca
anahtar tekrarına bakıyor ve **çağıranın filtrelemesine güveniyordu**. Ayrıca
`enrichedMovies/enrichedTv` listeleri seçim öncesi yeniden doğrulanmıyordu.

**Kök neden.** Aynı uygunluk mantığı iki yerde, biri eksik uygulanıyordu.

**Yapılan değişiklik (`src/modules/recommendations/pipeline.ts`).**
- Yeni tek fonksiyon: `filterEligibleSelectionEntries` — medya kapsamı (film-only
  istekte dizi elenir), izlenmiş/izlenecek/izleniyor, gizlenen, ilgilenilmeyen,
  son önerilenler (ring1) ve yinelenen TMDB kimlikleri.
- `selectRecommendationBatch` dört listeyi (enriched film/dizi, remaining film/dizi)
  bu fonksiyondan geçirir; overflow havuzu da aynı fonksiyonla **yeniden** filtrelenir
  (savunma katmanı) ve `targetType` dışına çıkamaz.
- `pipeline.ts` dışa aktarımı `index.ts` üzerinden yapılır (UI sınırı korunur).

**Test kanıtı.** `tests/phase3-selection-filters.test.mjs` (10 test): yeterli/ yetersiz
ana seçim, gizlenen içeriğin overflow'da elenmesi, izlenen/izlenecek/izleniyor
içeriklerin dönmemesi, film-only overflow'a TV sızmaması, TV'nin film hedefini
azaltmaması (10+10), ana seçim ↔ overflow arasında yineleme olmaması, tüm adaylar
elendiğinde boş sonuç + açıklama, ortak fonksiyonun tüm kuralları tek yerde uygulaması.

**Son durum:** FIXED.
**Kalan risk:** `isCandidateEligibleInPool` kayıtlı içerikleri `savedItems` üzerinden
eler; kayıt listesi çağrı anında tutarlı olmalıdır (mevcut tek kaynak ilkesi korunur).

---

## 5. B-13 — `serverTaste` sinyalinin gerçek katkısı

**Önceki durum.** Sinyal tür puanına gizlice karışıyordu:
`genreScore = genreScore·(1−w) + ((avg+1)/2)·w`, `w = 0.25·confidence`. Buna karşılık
`parts.serverTaste` **hiçbir ağırlığa bağlı değildi**, yani kırılımda ve açıklamada
katkı varmış gibi görünüyordu. Açıklama etiketi `avg ≥ 0.25` koşuluna bağlıydı, bu da
gerçek katkıyla birebir eşleşmiyordu.

**Karar: Seçenek A (gerçek katkı).** Sinyal anlamlı bir ürün verisidir (sunucudaki
metrik motorunun tür/ruh hâli afiniteleri), bu yüzden kaldırılmadı.

**Yapılan değişiklik (`scoreCandidatesV3`).**
- Katkı **tek yerde ve açık ağırlıkla**: `SERVER_TASTE_WEIGHT = 0.06`; ağırlık
  yalnızca sinyal gerçekten hesaplanabildiğinde ağırlık kümesine eklenir.
- Bileşen: `parts.serverTaste = clamp01(0.5 + avg/2 · confidence)` — 0.5 nötr,
  güven arttıkça afiniteye açılır. Tür puanına gizli karışma kaldırıldı, böylece
  çifte sayım yok.
- Açıklama etiketi gerçek katkı eşiğinden üretilir:
  `SERVER_TASTE_EXPLANATION_PART_THRESHOLD = 0.62`.
- Sinyal yoksa ağırlık kümesi ve dolayısıyla **puanlar birebir eskisi gibi** kalır.

**Test kanıtı.** `tests/phase3-server-taste-attribution.test.mjs` (7 test): sinyalsiz
durumda `parts.serverTaste` yok ve puanlar değişmiyor; sinyalli durumda katkı açık
formülle **(1e-6 toleransla)** eşleşiyor; olumsuz afinite puanı düşürüp etiket
üretmiyor; etiket yalnızca eşik aşıldığında var; güçlü/zıt afinite sıralamayı ve
drama-komedi farkını gerçekten değiştiriyor; düşük güvenli sinyal hiçbir şeyi
etkilemiyor; `calculateTastePillars` sütunları sinyalden etkilenmiyor (çifte sayım yok).

**Son durum:** FIXED (ölü sinyal değil; katkısı kanıtlandı ve açıklaması hizalandı).
**Kalan risk:** Sunucu profili güncellenmeden istemci sinyali 5 dakikaya kadar
bayatlayabilir (`taste-signal-service` TTL'i); sıralama etkisi küçük ve açıklama
etiketi bayat sinyale dayanabilir.

---

## 6. B-22 — Öneri önbelleği sınırlandırması

**Önceki durum.** `RecommendationService.cache = Map<profileId:revision:limit, …>`
sınırsızdı: profil başına limit kombinasyonları birikiyor, katalog değişimi anahtarda
yoktu, TTL yoktu ve geçersizleştirme sırasında uçuştaki bir hesaplama tamamlanınca
eski sonucu yazabiliyordu.

**Yapılan değişiklik (`RecommendationService.ts`).**
- **LRU + boyut sınırı:** `maxEntries` (varsayılan 64); aşınca en eski girdi düşer,
  erişilen girdi sona taşınır.
- **TTL:** `ttlMs` (varsayılan 5 dk, `0` kapatır), enjekte edilebilir `now()`.
- **Anahtar:** `profileId : revision : catalogSignature : scope(all|movie|tv) : limit : generation`.
  Böylece katalog revizyonu, film/dizi kapsamı ve filtre değişimi eski sonucu döndürmez.
- **Nesil (generation):** `invalidateProfile` nesli artırır; uçuştaki eski hesaplama
  yeni neslin anahtarını **ezemez**. `clear()` tüm önbelleği bırakır.
- **Eşzamanlılık:** Aynı anahtar için uçuş tekilleştirmesi (tek yükleme).
- **Uygunluk:** Servis, kapsam filtresi + `isCandidateEligibleInPool` uygular; izleme
  listesine eklenen içerik öneri olarak dönmez.
- `cacheSize` tanılama/test için dışa açıldı.

**Test kanıtı.** `tests/phase3-recommendation-cache.test.mjs` (11 test): LRU üst sınırı,
TTL, revizyon, katalog imzası, film/TV ayrımı, izleme listesi değişimi, eşzamanlı
istek tekilleştirme, geç gelen eski sonucun yeni nesli ezmemesi, soğuk/sıcak tutarlılık,
temizliğin kalıcı kullanıcı verisini değiştirmemesi.

**Son durum:** FIXED.
**Kalan risk:** Katalog imzası verilmezse servis önce yükleme yapar ve imzayı
snapshot'tan alır (tek ek yükleme); çağıran katman imzayı biliyorsa bunu geçirmelidir.
Önbellek süreç içidir; çok sekmede ayrı kopyalar bulunur (mevcut mimari).

---

## 7. Skor açıklanabilirliği

- Her etiket gerçek `parts` değerlerinden üretilir: tür, favori oyuncu, yönetmen,
  kadro uyumu, franchise, sevilen yapım benzerliği, TMDB kalitesi, keşif ve
  `serverTaste` (Aşama 3'te gerçek ağırlığa bağlandı).
- `parts` içinde ağırlıksız/ölü anahtar kalmadı: `serverTaste` artık ağırlıklıdır.
- `calculateTastePillars` sütunları (tür/hikâye, kadro/yaratıcı, keşif/kalite)
  `serverTaste`'ten etkilenmez; test bunu doğrular.
- Açıklama metinleri (`mapRecommendationBatchToDisplayItems`) puan üretmez; kalıcı
  Zevk Haritası gerekçelerini korur.

---

## 8. Kalite karşılaştırması (eski ↔ yeni motor)

- **Skor eşitliği:** 1000×500 ve 5000×5000 senaryolarında referans algoritmayla
  **0 uyuşmazlık**; ayrıca birim testte 12–1200 geçmiş boyutlarında birebir eşitlik.
- **İlk-20 sıralaması:** her iki senaryoda **20/20** örtüşme.
- **B-11/B-12/B-13 etkisi:** sıralama değişiklikleri yalnızca bu bulguların bilinçli
  düzeltmelerinden gelir (tür kapsamı, ortak eleme, sunucu sinyali ağırlığı); performans
  işi tek başına hiçbir sıralamayı değiştirmedi (B-03 testleri).
- **Filtre ihlali:** yeni seçim testleri film-only/TV-only ve gizlenen/izlenen
  içerik ihlallerini doğrudan hedefler.

---

## 9. Kalite kapıları

| Kapı | Sonuç |
|---|---|
| `npm run lint` (eslint + iki tsc) | ✅ 0 hata / 0 uyarı |
| `npm run cycles` | ✅ döngü yok |
| `npm test` | ✅ **793/793** (72 dosya; 754 → +39 Aşama 3 testi) |
| `npm run test:taste` | ✅ **440/440** |
| `npm run build` | ✅ başarılı |
| `npm run test:e2e` | ⚠️ bu sandbox'ta **koşulamadı** (aşağıya bakın) |
| `data/` sha256 | ✅ 15 dosya, önce/sonra aynı |

**E2E ortam engeli.** Bu çalışma alanında Playwright Chromium'u sayfa render ederken
Chromium'un kendi Skia font katmanında ölüyor:
`FATAL:third_party/skia/src/ports/SkFontMgr_FontConfigInterface.cpp:163 Not implemented`.
Aynı hata, **değişiklik öncesi commit (`cd7c1c7`) ayrı bir worktree'de aynı şekilde
derlenip çalıştırıldığında da** oluştu; yani Aşama 3 kodundan kaynaklanmıyor. Basit
bir HTML sayfası (emoji dâhil) aynı tarayıcıda sorunsuz açılıyor, uygulama sayfası ise
3 saniye içinde düşüyor. Eksik sistem kütüphaneleri (`libnspr4`, `libfontconfig`,
`libfreetype`, emoji fontları) Ubuntu arşivinden `/tmp/pwlibs` altına çıkarılarak
denendi; sonuç değişmedi. E2E sonucu **başarı sayılmadı**; CI'da (Playwright imajı)
koşulması gerekir.

---

## 10. Veri güvenliği ve migration

- `data/` öncesi/sonrası sha256 manifesti aynı (15 dosya).
- Testler geçici dizinlerde koşar (`scripts/run-tests.mjs`); gerçek kullanıcı verisine
  yazılmadı. Benchmark yalnızca bellekte deterministik fixture üretir.
- **Şema değişikliği yok.** `LovedItemFeatures.genreKeys` türetilmiş, isteğe bağlı bir
  alandır; kalıcı veri modeline yazılmaz (`buildDerivedProfilePayloadFromTasteMap`
  yalnızca mevcut alanları taşır). Eski türetilmiş önbellek dosyaları okunmaya devam eder.
- `RecommendationService` kullanıcı tercihlerini yeniden hesaplayıp **kaydetmez**.

---

## 11. Rollback

Her bulgu bağımsız geri alınabilir:
- B-03: `loved-similarity.ts` dosyasını `cd7c1c7` sürümüne döndürmek yeterli; çağrı
  imzaları aynı kaldı.
- B-11: `catalog-loader.ts` içindeki tek çağrıyı eski yerel kuruluma döndürmek.
- B-12: `selectRecommendationBatch` içindeki ortak filtre çağrılarını kaldırmak
  (önerilmez; regresyon testleri ihlali yakalar).
- B-13: `SERVER_TASTE_WEIGHT` bloğunu kaldırıp eski tür karışımına dönmek.
- B-22: `RecommendationService` önbellek katmanını eski `Map`'e döndürmek; API
  geriye dönük uyumludur (yeni parametreler opsiyonel).

---

## 12. Bilinen riskler ve ertelenen işler

1. E2E bu sandbox'ta ortam nedeniyle koşulamadı; CI'da doğrulanmalı.
2. 5.000 × 5.000 stres senaryosu 3,5 s (senkron). Üretim boyutu ~80 ms olduğu için
   Worker ertelendi; daha büyük arşivler için indeksin kalıcılaştırılması düşünülebilir.
3. `serverTaste` sinyali 5 dakikaya kadar bayat olabilir.
4. Kapsam profilleri soğuk başlangıçta diğer türün sinyalini kullanır (işaretli).
5. Önbellek süreç içidir; sekmeler arası paylaşım yoktur.
6. Canlı TMDB/TVDB/GitHub doğrulaması kimlik bilgisi yokluğunda koşulmadı.
