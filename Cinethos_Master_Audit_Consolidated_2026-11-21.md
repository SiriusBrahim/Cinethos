# Cinethos `master` — Birleştirilmiş Teknik, Mimari ve Ürün Denetim Raporu

> İki bağımsız denetim raporu bu belgede **birleştirildi**: (R1) "Cinethos master — Teknik, Mimari ve Ürün Denetim Raporu" ve (R2) "CINETHOS — Master Dalı Teknik, Mimari ve Ürün Denetimi / Cinethos_Master_Audit_Consolidated_2026-11-21.md". İkisi de aynı commit'i inceledi; bulgular yan yana sıralanmadı, **kök nedene göre ilişkilendirildi**, farklı kök nedenler ayrı tutuldu ve her iki rapordaki olumlu teknik tespitler korundu.
>
> **İncelenen sürüm:** `11824de3f283ec9662e6d9a3feea9cbbaf864a4f` — *Merge pull request #63 from SiriusBrahim/feat/phase3-data-integrity* (20 Kasım 2026). `git fetch origin master` sonrası `HEAD == FETCH_HEAD == origin/master` doğrulandı.

---

## A. Yönetici Özeti

### Genel teknik durum

Cinethos, tek geliştiricili bir proje için **beklenenin belirgin üzerinde** bir mühendislik disiplini gösteriyor: atomik JSON yazımı (`.tmp` + `fsync` + `rename`), `.bak` + 7 döner snapshot kurtarma, bozuk JSON karantinası, `If-Match`/`ETag` revizyon denetimi, silmesiz (no-deletion) iki yönlü GitHub birleştirmesi, 30 günlük mezar taşları, uzak yazım sonrası yeniden okuma + `verifiedEqual`, CSP + Origin + timing-safe token + kayan pencere rate limit ve 608'i geçen gerçek entegrasyon testi. `npm run lint` (ESLint + iki `tsc --noEmit`), `npm run build`, `npm test` ve `npm run test:taste` iki denetimde de temiz geçti; bağımlılık döngüsü **0**.

Buna karşılık iki denetimin birleşimi, tek başına hiçbirinde görülmeyen bir tablo çıkarıyor: **altyapı güvenli, semantik değil.** Depolama ve senkronizasyon savunmaları sağlam; kayıp, birleştirme kurallarında, yedek formatında ve test izolasyonunda oluşuyor.

### En önemli 6 risk (birleşik sıralama)

| # | Risk | Önem | Kök neden grubu |
|---|---|---|---|
| 1 | Test paketi gerçek `data/` dizinine yazıyor; geliştiricinin arşivini ezebiliyor | P1 | R-I |
| 2 | Çok cihazlı birleştirmede "en güncel" kararı `addedAt` üzerinden veriliyor; puan silme ve durum geri alma kayboluyor | P1 | R-A |
| 3 | Öneri puanlaması O(aday × sevilen yapım); 5.000 adayda 13–29 sn, ana iş parçacığında donma | P1 | R-B |
| 4 | Yerel yedek `deleted_keys` taşımıyor → silinen içerik geri dirilebiliyor | P1 | R-D |
| 5 | Tam belge yedeği içe aktarımı diğer profilleri ve mezar taşlarını düşürüyor | P1 | R-D |
| 6 | 1024–1440 px'te sekme şeridi kırpılıyor; mobilde 218 px yapışkan başlık | P2 | R-M |

### Birleşik bulgu envanteri

**39 birleşik bulgu**: 5 × P1, 16 × P2, 14 × P3, 4 × P4. İki rapordaki 48 ham bulgu, 18 kök neden grubuna indirildi (bkz. Bölüm L.1). Aynı kökün farklı dosyalardaki görünümleri tek satırda; farklı kökler (ör. yedek şeması eksikliği ile ileri sürüm reddi; sekme taşması ile mobil başlık yüksekliği) ayrı tutuldu.

### Üretim ortamına hazır mı?

**Tek kullanıcı / tek cihaz / yerel kullanım için:** koşullu evet. Depolama yolu güvenli, hata mesajları çoğunlukla dürüst, kurtarma mekanizmaları çalışıyor. Ancak test paketi gerçek veri dizinine yazdığı için (B-14) üretim verisi olan bir makinede `npm test` koşulmamalı.

**Çok cihazlı senkronizasyon ve büyük arşivler için:** hayır. B-01 (eylem kaybı) ve B-03 (karesel puanlama) giderilmeden "kayıpsız çok cihazlı senkron" ve "5.000–10.000 kayıt" iddiaları doğrulanamaz.

**"Yedekten tam geri dönüş" için:** hayır. B-05 ve B-06 birlikte, yedeğin bugünkü haliyle tam bir geri dönüş garantisi vermediğini gösteriyor.

### Korunan olumlu tespitler (her iki rapordan)

- Depolama: atomik yazım, `.bak`, 7 snapshot, `restore-journal` + SHA-256, bozuk dosyada üzerine yazmayı reddetme.
- Veri modeli: `movie:`/`tv:` kanonik anahtarları, aynı sayısal kimliğin iki türde ayrı tutulması, 30 gün TTL mezar taşları, 1–10 puan doğrulaması, favori oyuncu tekilleştirme.
- Senkron: `runSerialized`, işlem öncesi güvenlik snapshot'ı, push/pull/reconcile ayrımı, `verifiedEqual` ile yazım sonrası doğrulama, hata sınıflandırması, transport hatasında hiç yazmama.
- Mimari: ölçülen katman sınırları (`server-isolation`, `client-no-server`, `contracts-isolation`: 0 ihlal), **0 döngü**, allowlist'in yalnızca küçülebilmesi kuralı.
- Taste Engine: deterministik, `now` enjekte edilebilir, 15 ağırlıklı sinyal, Bayesyen kalite düzeltmesi, shrinkage + yarılanma, `ring0/ring1/ring2` yaşam döngüsü, dürüst "yetersiz veri" durumu.
- Zevk Haritası: 90 düğüm / 160 kenar sınırı, tekilleştirme, Türkçe gerekçe metinleri, yan etkisiz ayrı depo.
- API: katı TMDB path allowlist, LRU + in-flight tekilleştirme, SSRF'e dayanıklı görsel vekili, `image.tmdb.org` dışına çıkmama, anahtarın istemciye sızmaması.
- Güvenlik: `dangerouslySetInnerHTML`/`innerHTML` **0** kullanım, timing-safe token, `redactSecrets`, path traversal koruması, public repoda kişisel verinin varsayılan engeli.
- UI: 6 genişlikte **0 px sayfa taşması**, tutarlı tema, anlamlı boş durumlar, 2 px odak halkası, `prefers-reduced-motion`.

---

## B. İnceleme Kapsamı ve Birleştirme Yöntemi

### B.1 İncelenen commit ve ağaç

- `11824de…` (HEAD = `origin/master` = `FETCH_HEAD`), 20.11.2026 19:04 +03.
- **284–285 TS/TSX kaynak dosyası, ~103.800 satır** (`src` + `server.ts`); 65 test dosyası; 5–6 Playwright spec'i (15 test).

### B.2 İki denetimin yürüttüğü kontroller

| Kontrol | R1 | R2 | Birleşik sonuç |
|---|---|---|---|
| `npm ci` | ✅ | ✅ | ✅ |
| `npm run lint` (ESLint + 2× tsc) | ✅ | ✅ | ✅ 0 hata/uyarı |
| `npm run cycles` | ✅ 0 döngü | ✅ | ✅ |
| `npm test` | 608 / 42 suite / 90,3 sn | 608 / 96,8 sn | ✅ (süre farkı makine yükü) |
| `npm run test:taste` | ✅ | 440 test ✅ | ✅ |
| `npm run build` | ✅ | ✅ | ✅ (786,77 kB ana chunk) |
| Mimari sınır taraması | 285 dosya, 873 import, 5 core-purity | aynı | ✅ 0 döngü, 5 allowlist ihlali |
| `npm audit --omit=dev` | 26 moderate | 26 moderate | ✅ 0 high/critical |
| Playwright e2e | ❌ sistem kütüphanesi yok | ❌ aynı | ❌ koşulamadı |
| Tarayıcı ölçümü | 6 genişlik, `vite preview` | 6 genişlik, `node server.ts` | ✅ iki bağımsız ölçüm |
| Performans sondaları | Node 26 / tsx | Node 26 / tsx | ✅ aynı eğri, farklı harness |

### B.3 Erişilemeyen sistemler (ikisinde de ortak)

- GitHub canlı API (token yok): gerçek push/pull/reconcile, SHA davranışı, iki cihaz senaryosu.
- TMDB / TVDB canlı çağrıları (anahtar yok).
- Gerçek Excel/SQLite uçlarının elle denenmesi.
- Ekran okuyucu / axe taraması.
- Playwright e2e (ortam kısıtı, depo hatası değil).

### B.4 Çelişkiler ve çözümleri

İki rapor altı noktada farklı sonuç verdi; bunlar gizlenmedi, kanıtla çözüldü:

| Konu | R1 | R2 | Çözüm |
|---|---|---|---|
| **Test izolasyonu** | "Testler geçici dizin kullanıyor, birbirinden bağımsız" | "Testler `cwd/data` altına yazıyor" | **R2 doğru.** Statik doğrulama: `createDataStorage(options: StorageOptions)` tek parametreli (`storage.ts:125`); `tests/cinema-kunye-backup-sync.test.mjs:232,346,507` ise `createDataStorage(dataFile, {…})` çağırıyor → ikinci argüman yok sayılıyor, `dataDir` `undefined` → `process.cwd()/data`. R1'in bu cümlesi düzeltildi. |
| **1024–1440 gezinme** | "Taşma yok, sekmeler çalışıyor" | "Sekme şeridi kırpılıyor (613 px içerik / 377 px alan)" | **İkisi de doğru, farklı ölçüm düzeyi.** Sayfa düzeyinde yatay taşma 0; şerit kendi içinde `overflow-x: auto` + gizli scrollbar (`workspace.css:750-760`). Kullanıcı etkisi R2'nin bulgusuyla tanımlanır (B-24). |
| **`any` sayısı** | 645 | 676 | Regex kapsamı farkı (`: any` / `as any` / `<any>`). Rapor "**645–676**" aralığı olarak veriyor; büyüklük sırası aynı. |
| **Performans (5.000/5.000)** | 28.611 ms | 13.128 ms | Farklı harness + veri şekli (alan doluluğu, özet uzunluğu). **Ortalama alınmadı**; iki ölçüm ayrı ayrı ve aralık olarak verildi. Eğri (karesel büyüme) ikisinde de aynı. |
| **XSS** | "`dangerouslySetInnerHTML` aranmadı" | "grep: 0 kullanım" | Kanıt R2'den alındı: **0 kullanım**. |
| **Tekrar öneri** | "Ring1 kesin dışlanır, büyük ölçüde engellenmiş" | "Top-up yolunda filtre atlanıyor" | **R2, R1'in iddiasını daraltıyor:** ana seçim yolu korumalı, `overflowPool` top-up yolu değil (B-12). |

Birleştirmede ayrıca şu kural uygulandı: **aynı kök neden = tek bulgu** (ör. puanlama maliyeti R1 L-02 + R2 F-02; test izolasyonu R2 F-01; mimari borç R1 L-19/L-20 + R2 F-13). **Farklı kök = ayrı bulgu** (ör. yedek şeması eksikliği ≠ ileri sürüm reddi; sekme taşması ≠ mobil başlık yüksekliği; `core-purity` ihlali ≠ tanrı dosyaları).

---

## C. Mimari Değerlendirme

### C.1 Katmanlar ve ölçülen sınırlar

```
core (saf)  →  server (Express + kalıcılık)  →  app (orkestrasyon)  →  components/hooks
     ↘ contracts ↗        ↘ modules (library/content/recommendations/background) ↗
```

`architecture-boundaries.mjs` bu sınırları CI'da ölçüyor: `server-isolation` 0, `client-no-server` 0, `contracts-isolation` 0, döngü 0, **`core-purity` 5 ihlal** (hepsi beyan edilmiş allowlist'te, allowlist yalnızca küçülebilir).

Beş ihlal: `cinetrack-core.ts:4` (`idb-keyval`), `cinetrack-core.ts:5` ve `actor-recommendations.ts` (`services/api-client`), `relationship-explorer.ts` (`services/encoding-service`), `taste/migration.ts:264` (`crypto`). Sonuç: çekirdek katman bugün "saf ve sunucuda yeniden kullanılabilir" değil; Node'da yalnızca koşullu yükleme sayesinde çalışıyor.

### C.2 Modül ayrışması: gerçek olan ve olmayan

Gerçek olan: `library/operations.ts` (saf kurallar) ↔ `service.ts` (I/O) ayrımı; `pickContentFields` allowlist'i ile kullanıcı verisinin ortak içeriğe sızmaması (testle doğrulanmış); `pipeline.ts` / `RecommendationService` / `RankingManager` React'ten bağımsız; puanlama tek kaynakta.

Tamamlanmayan: `App.tsx` **2.372 satır / 31 `useState` / 24 `useEffect`**; profil senkronu, payload üretimi, localStorage aynalama ve çakışma kararları hâlâ kabukta. 41 bileşenin 7'si 750+ satır. `MergeRemoteDocumentIntoState` ile `applyDataDocumentToState` neredeyse aynı 40 satırlık state yazımını iki kez içeriyor.

### C.3 Tanrı dosyaları ve tekrar

`cinetrack-core.ts` 6.101 · `github-bidirectional-sync.ts` 5.028 · `persistent-store.ts` 4.029 · `excel-profile-backup.ts` 3.533 · `app.ts` 2.943 · `App.tsx` 2.372 · `catalog-loader.ts` 1.416 satır. İlk üçü tek başına ~15.500 satır.

Tekrar: (a) `mergeTwoSavedItemsLossless`, `dedupeItems`, `normalizeSavedItem` üç ayrı "daha yeni kazanır" kuralı uyguluyor — B-01'in kök nedeni; (b) `store-types.ts` ↔ `persistent-store-utils.ts` aynı `redactSecrets` / `stringifyDeterministic` / `hashContent` fonksiyonlarını kopyalıyor (güvenlik kritik fonksiyonun iki kopyası); (c) `github-catalog-sync.ts` ↔ `github-bidirectional-sync.ts` katalog normalize/merge/hash kopyaları.

### C.4 State, eşzamanlılık, sızıntı

- Sunucu yazımları `FileWriteSerializer` + `saveDataSerialized` ile serileştirilmiş — doğru.
- GitHub işlemleri `runSerialized` ile sıraya giriyor; ancak `rejectIfBusy` yalnızca çalışma anını görüyor, kuyruktaki işi görmüyor (B-10).
- `RecommendationService.cache` sınırsız `Map`; anahtar revizyon içerdiği için her yazımda büyüyor (B-22).
- Event listener: 23 `addEventListener` / 21 `removeEventListener`; kritik sızıntı yok.

### C.5 Tip güvenliği

`strict: true` ve `tsc --noEmit` temiz; `@ts-ignore`/`@ts-expect-error` **0**; `eslint-disable` 9 (hepsi gerekçeli, `react-hooks/exhaustive-deps`). Buna karşılık `any` **645–676** kez geçiyor; yoğunluk `cinetrack-core` (skorlama girdileri), `persistent-store` (GitHub yanıtları), `tvdb-proxy`, `App.tsx` (filtre/sıralama). `noUnusedLocals`/`noUnusedParameters` kapalı. Tip güvenliği "delik deşik" değil, **sınır katmanlarında gevşek**.

### C.6 Bakım maliyeti

Yeni öneri sinyali = `scoreCandidatesV3` + `RECOMMENDATION_WEIGHTS_V3` + `ExplanationManager` + testler. Yeni senkron dosyası = envanter/inspect/pull/push/reconcile/verify bloklarının beşinde değişiklik (~5.000 satırlık dosya). Testlerin bir kısmı davranış değil kaynak metni eşleştirdiği için bu refactor'lar test kırılmasıyla karşılaşacak (B-15).

**Değerlendirme:** iskelet doğru ve ölçülebilir; ayrıştırma "doğru yönde" ama dosya boyutları, tip erozyonu ve çekirdek kirliliği nedeniyle henüz "düşük maliyetli" değil.

---

## D. Veri Bütünlüğü ve Senkronizasyon

### D.1 Veri modeli (birleşik doğrulama)

| Konu | Durum | Kanıt |
|---|---|---|
| Profil kimliği | **İyi** | NFKD + transliterasyon + `PROFILE-* / PROFIL-* / P<sayı>`; `/`, `\`, `..`, kontrol karakteri reddi (`profile-id.ts:39`) |
| Film/dizi ayrımı | **İyi** | `movie:550` / `tv:550`; aynı sayı iki türde ayrı (probe [10]) |
| Durum normalizasyonu | **İyi** | `watching/watchlist/completed` dışı → `watchlist` |
| Puan | **İyi** | 1–10 dışı `''`; `'7.5'` → 7.5; `personal_rating_cleared` ayrı işaretçi |
| Favori oyuncu | **İyi** | id bazlı tekilleştirme, 60 sınır |
| İlgilenmiyorum / gizle | **İyi** | kanonik anahtar + 500 sınır |
| Mezar taşı | **İyi** | 30 gün TTL, 2.000 sınır, canlı kayıtla çakışan taş silinir |
| Şema sürümü / migration | **Kısmi** | `schemaVersion` korunuyor ama **adım adım migration yok**; her okumada yeniden normalize |

### D.2 Doğrulanmış senaryolar

| Senaryo | Sonuç | Değerlendirme |
|---|---|---|
| Boş/bozuk JSON | 400 `invalid_document`; bozuk dosyada 500 `corrupt_storage`, yazma durur | ✅ |
| Eski yedek (v1–v3) | kabul + normalize | ✅ |
| Yeni yedek (v4) | **reddedilir**, mesaj "geçerli Cinethos yedeği değil" | ⚠️ B-07 |
| Aynı kaydın tekrar içe aktarımı | `dedupeItems` + `makeMediaKey` | ✅ |
| Aynı içerik iki türde | ayrı kayıt | ✅ |
| Üzerine yazma | `lossless` varsayılan + `sudden_item_drop` + snapshot | ✅ (koruma eşiği için B-09) |
| Birleştirmede kayıt kaybı | kayıt düzeyinde yok | ✅ |
| Birleştirmede **alan** kaybı | puan silme / durum geri alma kayboluyor | ❌ B-01 |
| Profil değişimi | profil anahtarlı localStorage + revizyon kilidi | ✅ (kod) |
| Profiller arası erişim | `/api/data` tüm profilleri döner | ⚠️ tek kullanıcı modeli, belgelenmeli |
| Yarım yazma | `.tmp` + `fsync` + `rename`, açılışta `.tmp` temizliği | ✅ |
| Yazarken kapanma | atomik rename; dizin `fsync` yok (küçük risk) | ✅ |
| GitHub kesintisi | `network_error`, hiçbir veri değişmez | ✅ |
| İki cihaz çakışması | `If-Match` → 409 + üç seçenek | ✅ akış / ❌ semantik (B-01) |

**Sessiz kırpma (doğrulandı):** 22 profil → 20, 25.010 kayıt → 25.000, `user-1234` kimlikli profil **tüm kayıtlarıyla** düşüyor (`cinetrack-core.ts:876,938,960`). Okuma diske yazmadığı için ilk okuma sessiz; bir sonraki başarılı yazım kırpılmış belgeyi kalıcılaştırıyor (B-04).

**Yedek yolu (R2):** `LocalBackupDocument` şemasında `deleted_keys` yok; içe aktarma yalnızca `savedItems/preferences/favoriteActors/cinemaKunye` yazıyor. `parseBackupText` ise tam belgede yalnızca aktif/ilk profili alıyor. İki bulgu aynı kökten: **yedek, belgenin silme ve çok-profil bilgisini taşımıyor** (B-05, B-06).

### D.3 GitHub çift yönlü senkronizasyon — 10 soru

| # | Soru | Birleşik yanıt | Kanıt |
|---|---|---|---|
| 1 | Yerel ve uzak bağımsız güncellenebilir mi? | **Evet** — iki taraf ayrı taranır, ham + semantik hash karşılaştırılır | `inspect` 3052, `compareSyncSides` |
| 2 | Eski uzak veri yeni yerelin üzerine yazar mı? | **Varsayılan hayır**; `ask` modunda onay, `overwrite_with_remote` açık seçim + snapshot | `pull` 3211 |
| 3 | İki cihazın değişiklikleri kayıpsız birleşir mi? | **Kayıt düzeyinde evet, alan düzeyinde hayır** (B-01) | probe A/B |
| 4 | Aynı anda iki senkron? | İkincisi kuyruğa girer; `rejectIfBusy` kuyruğu görmez | B-10 |
| 5 | Yarıda kalan senkron tutarlı mı? | Dosya bazlı atomik, **işlem bazlı rollback yok**; sonraki reconcile düzeltir | pull/push sıralı yazımlar |
| 6 | SHA bütünlüğü garanti eder mi? | Amaçlandığı ölçüde: commit öncesi SHA, 409'da 3 deneme, sonrasında yeniden okuma + hash | `commitFileToGitHub` |
| 7 | Başarılı görünen ama eksik işlem? | **Evet**: `filesSkipped` ile `ok` dönebilir; sayaçlar alan değişimini yansıtmaz | B-39 |
| 8 | Profil yedeği başkasıyla karışır mı? | Profil kimliği bazında birleşir; `PROFILE-DEFAULT` katlaması açık bayrakla sınırlı | `user-data-merge.ts:475-505` |
| 9 | Profil kimliği migration'ı eski veriyi korur mu? | Evet, kanonikleştirme + `dedupeItems` | `normalizeDataDocument` |
| 10 | Yanlış seçimde geri dönüş var mı? | **Kısmen**: snapshot + restore var, tek tık geri alma yok; restore revizyon ön koşulu istemiyor | B-08, B-36 |

**Envanter hijyeni:** `cinetrack.db`, `data/backups`, `sync-state.json`, `.env`, `.corrupt.*` gönderilmiyor; kişisel veri public repoda varsayılan engelli (`isPersonalSyncAllowedForRepo`). Bu doğru ve iki raporda da olumlu.

---

## E. Taste Engine ve Öneri Algoritması

### E.1 Gerçek işleyiş (korunan güçlü yanlar)

`buildTasteProfileV3` her kayıt için sinyal üretir: puan `(r-5)/5`, reddetme `-0.8`, tamamlandı `+0.4`, izleniyor/izlenecek `+0.2`; ağırlık tamamlandı 2.5 / izleniyor 1.6 / puanlı 1.0 / izlenecek 0.35; yarılanma puan 730 gün, durum 365 gün. `scoreCandidatesV3` 15 ağırlıklı sinyali toplar (`RECOMMENDATION_WEIGHTS_V3`, toplam 1.00), Bayesyen kalite (prior 6.5, minVotes 300), kadro uyumunda üstel doyum, çift görülme bonusu. `now` dışarıdan enjekte edilebiliyor → deterministik ve test edilebilir. `ring0/ring1/ring2` + `demotionPenalty` + çok boyutlu çeşitlendirme gerçek. Az veride tür ağırlıkları 0.5 nötre çekiliyor ve UI "veri yetersiz" diyor — dürüst.

### E.2 Birleşik zayıflıklar

1. **Film/dizi tercih sızması (B-11).** Havuzlar ayrı skorlanıyor, ancak tür/oyuncu/anahtar kelime profilleri ortak; tek ayrım `mediaPreference` ve ağırlığı **0.03**. Ölçüm: yalnız film izleyen profilde aynı türdeki dizi adayı **56,0**, film adayı **59,0** — pratikte eşit. `profile-aggregator.ts` `mediaType: "unified"` altında ağırlıklı birleştiriyor. Bilinçli tasarım olabilir ama sınırı belgelenmemiş.
2. **Ölü `serverTaste` sinyali (B-13).** `parts.serverTaste` hesaplanıyor, `signalBreakdown`'da görünüyor, fakat ağırlıklar tablosunda karşılığı yok → puana katkı vermiyor. Açıklama katmanı olmayan bir katkıyı gösteriyor.
3. **Top-up yolunda filtre atlanması (B-12).** Hedef dolmadığında `overflowPool` ham havuzdan sıralanıp ekleniyor; `filterOutLastRecommendedCandidates` ve `isCandidateEligibleInPool` orada yeniden uygulanmıyor. Ana yol korumalı, top-up yolu değil → B-12, R1'in "tekrar engellenmiş" iddiasını sınırlıyor.
4. **Karesel maliyet (B-03).** `computeLovedSimilarityScore` her aday için tüm sevilen yapıları dolaşıyor; `lovedItemFeatures` geçmişle büyüyor. Bölüm I'deki ölçümler.
5. **Negatif sinyal ağırlık değil dışlama.** `disliked` aday havuzundan tamamen çıkarılıyor; tür/kadro bilgisiyle negatif öğrenme yok. Tasarım tercihi, hata değil.
6. **Silme sonrası yeniden hesaplama doğru:** profil her seferinde tam listeden kuruluyor; türetilmiş önbellek `profileFingerprint` + `sourceCatalogHash` ile doğrulanıyor. Bu korunması gereken bir tasarım.

---

## F. Zevk Haritası ve İlişki Keşif Motoru

| Konu | Birleşik bulgu |
|---|---|
| Düğüm/kenar | `universe / person / semantic / atmosphere / contrast`; `RelationshipGraphNode/Link` |
| Sınır | **maxNodes 90, maxLinks 160**; düğümler kanonik anahtarla tekilleştirilir |
| Karmaşıklık | 90 düğümde O(n²)=4.005 çift, önceden hesaplanmış içerikle → pratikte hızlı |
| Kanıt metni | Türkçe gerekçeler ("Farklı anlatım temposu", "İçerik zekâsı: %N") — şeffaflık güçlü |
| Boş veri | Hata fırlatmıyor; UI boş durum gösteriyor |
| Yan etki | Ayrı IndexedDB deposu, Zevk Haritası sayaçlarını kirletmiyor |
| Önbellek | Profil imzası (`computeRelationshipProfileSignature`) ile ilişkilendirilmiş |

**Bulgular:** (a) durum/renk sinyali ham tercih anahtarlarıyla eşleştiriliyor (`relationship-explorer.ts:710-714`, kanonikleştirme yok) → B-34; (b) ilişki türü ağırlıkları (`universe > person > semantic`) sabit, kişiselleştirilemiyor → B-35; (c) Aynı çift için ikinci geçiş yalnızca kaynak-odaklı modda; grafik adayları sınırlı olduğu için puanlama maliyeti burada küçük.

**Değerlendirme:** projenin en olgun modülü. Sınırlı, deterministik, açıklanabilir, yan etkisiz. Eksikler kalibrasyon ve anahtar kanonikleştirme düzeyinde.

---

## G. API ve Harici Veri Entegrasyonları

### G.1 TMDB vekili (güçlü)

Katı `ALLOWED_TMDB_PATH` allowlist'i; parametre tip/aralık doğrulaması (`page ≤ 500`, dil, tarih, tür/oyuncu kimlikleri); anahtar yalnızca sunucuda; 500 girdilik LRU + in-flight tekilleştirme + bayat önbellek dönüşü; 10 MB gövde sınırı; görsel vekili yalnızca `image.tmdb.org`/`img.tmdb.org`, `https`, `..` yasak, MIME allowlist, eşzamanlı indirme tavanı → **SSRF açısından sağlam**.

### G.2 Zayıflıklar

1. **429 toparlanması yok (B-30).** İstemci 429'u doğrudan hata olarak fırlatıyor; `Retry-After`/backoff yok. LAN varsayılanı 60/dk; sekme geçişlerinde katalog patlaması → konsolda 429/502 birikimi, boş "Güncel trendler", eksik kartlar.
2. `/api/tmdb` ve `/api/tvdb` GET'leri tokenGuard'dan geçmiyor (yalnızca rate limiter). Kişisel veri taşımadıkları için kabul edilebilir; LAN'da kimliksiz dış çağrı kaynağı.
3. TVDB canlı doğrulanamadı; yanıtlar `any` ile ayrıştırılıyor, şema kontrolü kısmi, atıf/lisans metni yalnızca TMDB için var.
4. Kodda **IMDb API entegrasyonu yok** — yalnızca CSV formatı IMDb/Letterboxd uyumlu; lisans riski düşük.
5. Önbellek: TMDB LRU + poster kotası (200 MiB, 5 dakikada bir zorlama) + IndexedDB ilişki önbelleği; `imageCache` yalnızca bellekte (kabul edilebilir).
6. Excel önizleme tüm veri setini JSON olarak döndürüyor → B-23.

---

## H. UI/UX Değerlendirmesi

### H.1 Birleşik tarayıcı ölçümü (iki bağımsız koşum)

| Genişlik | Sayfa yatay taşması | Gezinme | Başlık yüksekliği | Not |
|---|---|---|---|---|
| 360×640 | **0 px** | mobil alt bar | **218 px** | başlık ekranın ~%26'sı |
| 390×844 | **0 px** | mobil alt bar | **218 px** | scroll sonrası sabit |
| 768×1024 | **0 px** | mobil alt bar | **98,5 px** | ≥1024'te masaüstü sekmeleri |
| 1024×768 | **0 px** | üst sekmeler, **şerit kırpık** | **98,5 px** | şerit 613 px / alan 377 px; "İlişkiler/Seriler/İşlemler" görünmez |
| 1440×900 | **0 px** | üst sekmeler, hafif kırpık | **103 px** | şerit 613 / alan 588; "İşlemle…" kesik; "Ekle" ikinci satıra düşüyor |
| 1920×1080 | **0 px** | tam | **103 px** | sorun yok |

İki raporun çelişkisi bu tabloda çözüldü: **sayfa düzeyinde taşma yok** (R1), **sekme şeridi kendi içinde kırpılıyor** (R2). İkisi aynı olgunun farklı ölçüm düzeyleri.

### H.2 Güçlü yanlar (korundu)

Tutarlı koyu tema + altın vurgu; net tipografi hiyerarşisi; anlamlı boş durumlar (eylem düğmeli); mobilde alt bar + "Daha fazla" dialogu; `useDialogAccessibility` ile ortak odak tuzağı ve Escape; `Tab` odağında **2 px outline**; `prefers-reduced-motion`; klavye kısayolları input içinde devre dışı; uzun başlıklarda `line-clamp`.

### H.3 Sorunlar

1. **Sekme şeridi kırpılması (B-24, P2).** `workspace.css:750-760` bilinçli `overflow-x: auto` + gizli scrollbar; görsel kaydırma işareti yok. 1024'te yedi sekmeden üçü tamamen görünmez; fare kullanıcısı scroll çubuğu olmadığı için erişemez (klavye erişir). Aynı düzen kökü: 1440'ta arama placeholder'ı kırpılıyor ("Film v…") ve 1024–1920 arası özel kırılım yok.
2. **Mobil 218 px yapışkan başlık (B-25, P2).** `components.css:217` `position: sticky` + marka/aksiyonlar/arama dört satıra sarılıyor. 390×844'te 218 px başlık + 56 px alt bar = içerik için ~570 px.
3. **İşlem Merkezi'nde "Yeniden dene" uygun olmayan görevlerde etkin (B-26, P3).** Tıklanınca 409 `task_not_retryable`; düğme durum bazlı devre dışı bırakılmalı.
4. **Görsel cila (B-27, P3).** Keşfet rozetleri posterin üzerine biniyor; yatay kaydırıcılarda son kart kesiliyor; mobil zevk profili filtre çubuğu "Tem…" olarak kırpılıyor.
5. **Modal arka planı `inert`/`aria-hidden` değil (B-28, P3).** Ekran okuyucu arka planı görebilir.
6. **`useKeyboardShortcuts` `handlers` kimliğine bağlı (B-29, P3).** Satır içi nesne verilirse her render'da dinleyici yeniden bağlanır.
7. **Erişilebilirlik doğrulanmadı.** `eslint-plugin-jsx-a11y` yapılandırılmış ve lint geçiyor; axe/ekran okuyucu/kontrast ölçümü yapılmadı. Bu nedenle "erişilebilirlik doğrulandı" denemez.

---

## I. Performans Değerlendirmesi

### I.1 Ölçümler (iki bağımsız koşum, Node 26 / tsx)

| Senaryo | R1 | R2 |
|---|---|---|
| 200 geçmiş + 200 aday: puanlama | **66 ms** | — |
| 1.000 + 1.000: puanlama | **1.205 ms** | **804 ms** |
| 5.000 + 5.000: puanlama | **28.611 ms** | **13.128 ms** |
| 10.000 + 10.000: puanlama | — | **53.037 ms** |
| 10.000 + 1.000 | **11.305 ms** | **7.033 ms** |
| 10.000 + 500 | — | **3.339 ms** |
| Normalize 10.000 kayıt (~4,9 MB) | — | **75 ms** |
| Taste profili 10.000 kayıt | — | **110 ms** |
| Birleştirme 10.000 kayıt | — | **135 ms** |

**Yorum:** mutlak süreler harness/veri şekline göre 2× kadar değişiyor, **eğri değişmiyor**: süre `aday × sevilen_yapım` çarpımıyla büyüyor (ölçek 5× → süre 24–40×). Normalize/merge/parse ölçekleniyor; darboğaz yalnızca puanlama. Bu iş tarayıcıda **ana iş parçacığında** çalıştığı için donma olarak görülür ve keşfet / "Sana Özel" / zevk haritası / ilişki grafiği aynı fonksiyonu çağırdığı için birden çok ekranda tekrarlanır. Üretim havuzu 500+500 ile sınırlı olduğundan 10.000 kayıtlı profilde beklenen blokaj ~3,3–7 sn.

**Çözüm yönü (mevcut mimariye uygun):** (a) ters indeks (tür/oyuncu/yönetmen/token/yıl/collection → ağırlıklı katkı); (b) `lovedItemFeatures`'ı ağırlık sırasına göre üst-N (400–800) ile sınırla; (c) Worker veya dilimli hesaplama; (d) `extractOverviewTokens` sonucunu aday başına bir kez hesapla. Yan etki: puanlar değişir, altın fixture'lar yeniden üretilmeli.

### I.2 Diğer performans bulguları

| Konu | Bulgu | ID |
|---|---|---|
| Üretim paketi | tek `index` chunk **786,77 kB** (gzip 233,54), React vendor 210,90 kB | B-20 |
| Etkisiz dinamik import | `TasteProfileDashboard`, `RelationshipExplorer` hem dinamik hem statik → ayrı chunk'a çıkmıyor (`INEFFECTIVE_DYNAMIC_IMPORT` ×2) | B-20 |
| localStorage | her state değişiminde tam `savedItems` `JSON.stringify` + senkron yazma; kotada `overview` 120 karaktere kırpılıyor | B-21 |
| Öneri önbelleği | sınırsız `Map`, revizyon başına yeni anahtar | B-22 |
| Excel | tam çalışma kitabı bellekte + posterler gömülü; önizleme tüm dataset'i JSON döndürüyor | B-23 |
| GitHub senkronu | dosya başına commit + dosya başına yeniden okuma (ölçülmedi) | — |
| Zevk Haritası | 90/160 sınırı sayesinde risk düşük | — |

---

## J. Güvenlik ve Gizlilik

### J.1 İyi uygulamalar (birleşik)

Sırlar yalnızca sunucuda (`TMDB_API_KEY`, `CINETRACK_GITHUB_PAT`, `CINETRACK_TOKEN`, `TVDB_API_KEY`); `VITE_` sırrı yok. Token karşılaştırması SHA-256 + `timingSafeEqual`. Loopback dışında token yoksa mutasyonlar `503 auth_required`. CSRF: Origin/Referer ↔ Host, `null` Origin reddi, `trustProxy` varsayılan kapalı. CSP: `default-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, üretimde `unsafe-inline` script yok, `script-src-attr 'none'`. İstemci tokenı yalnızca `sessionStorage`. `redactSecrets` hata mesajlarında ve görev `lastError`'ında. `dangerouslySetInnerHTML`/`innerHTML` **0**. Yükleme yollarında `backupId` deseni + `path.resolve` + `startsWith(backupsDir + sep)`. Public repoda kişisel veri varsayılan engelli, görünürlük uzaktan doğrulanıyor. `image-proxy-hardening` testleri SSRF/path traversal/boyut kapsıyor.

### J.2 Riskler

1. **PAT düz metin `.env`'e atomik olmayan yazımla kaydediliyor (B-31, P2).** `writeFileSync`, `.tmp`+`rename`, `fsync`, `0o600` ve yedek yok; yazma sırasında çökme `.env`'i bozabilir, izinler umask'a bağlı kalır.
2. **Profil seçimi yetkilendirme değil.** Aynı `CINETRACK_TOKEN` ile `/api/data` tüm profilleri döndürür; `X-CineTrack-Profile-Id` yalnızca yazma tutarlılığı için. LAN'a açık kullanımda token'ı bilen herkes tüm profilleri okur/yazar; README bunu açıkça belirtmiyor.
3. **Public depo onayı ile görünürlük aynı bayrakta (B-32, P3).** `getEffectiveConfiguredIsPublicRepo` onay true ise true döner; depo sonradan private olsa bile uyarılar "public" varsayımıyla üretilebilir.
4. **CSP geniş (B-33, P4).** `connect-src` içinde `ws:`/`wss:` ve `*.run.app`; `frame-ancestors` içinde `*.googleusercontent.com` ve `localhost:*` — AI Studio uyumluluğu için; kendi barındırmada daraltılmalı.
5. **`git credential fill`** kullanıcının GCM kimlik bilgisini süreç ortamına taşır ve `CINETRACK_GITHUB_PAT` olarak diske yazılır (kalıcı sır kopyası). Kalıcı token (`ghp_`/`github_pat_`) korunuyor, yalnızca `gho_` yenileniyor — iyi ayrım.
6. **Public repoda ne açığa çıkar:** varsayılan hiçbiri. Açık onay verilirse `data/cinetrack-data.json` içinde izleme listeleri, durumlar, 1–10 puanlar, "ilgilenmiyorum/gizle", favori oyuncular, ruh hâli, sağlayıcılar, mezar taşları ve varsa notlar herkese açık olur — yani **izleme alışkanlığı ve zevk profili**. Kod engeli doğru; uyarı arayüzde açık olmalı.
7. **Bağımlılık:** 26 moderate, 0 high/critical (`uuid < 11.1.1` via exceljs/gaxios; `@opentelemetry/core` via `@respan`). Düzeltme `exceljs@3.4.0`'a kırıcı düşüş gerektiriyor → B-19.

---

## K. Test Kapsamı ve Eksikler

### K.1 Mevcut durum

65 test dosyası (60 ana + 26 taste alt dosyası), **608 test / 608 geçti**, `test:taste` 440, 4.871 `assert`, 0 skip/todo. Testler gerçek modülleri kullanıyor: `createCineTrackApp` ile gerçek Express, geçici dizinde gerçek dosyalar, `fetch` mock'uyla GitHub simülasyonu. Negatif kapsam iyi: bozuk JSON, 401/403/404 ayrımı, 409 retry, boyut aşımı, geçersiz şema, public repo guard, aynı ID'nin film/dizi ayrımı.

### K.2 Boşluklar (birleşik)

| # | Boşluk | Neden kritik |
|---|---|---|
| 1 | **Test izolasyonu bozuk** (B-14, P1) | `createDataStorage(dataFile, {…})` yanlış imza → `cwd/data`; testler gerçek arşivi ezer, amaçlanan izole senaryoyu test etmez |
| 2 | `mergeTwoSavedItemsLossless` için **doğrudan test yok** (`grep` = 0) (B-02) | B-01 tam bu fonksiyonda; `dedupeItems` farklı fonksiyon |
| 3 | `addedAt`/`watchedAt` dolu gerçekçi fixture yok | Hata bu yüzden gizleniyor |
| 4 | Durum geri alma (completed → watchlist/watching) senaryosu yok | B-01'in ikinci yarısı |
| 5 | 20+ profil / 25.000+ kayıt sınır davranışı yok | B-04 doğrulanmamış |
| 6 | Geçersiz profil kimliği içeren belge | Profil sessizce düşüyor |
| 7 | v4 yedek ve ileri uyumluluk | B-07 |
| 8 | 1.000/5.000/10.000 kayıtta puanlama bütçesi | B-03 regression koruması yok |
| 9 | Yedek → reconcile → silinen içeriğin dirilmemesi | B-05 |
| 10 | Restore sırasında eşzamanlı istemci yazımı | B-08 |
| 11 | 429 sonrası otomatik toparlanma | B-30 |
| 12 | `.env` yazımının yarıda kesilmesi | B-31 |
| 13 | Erişilebilirlik (axe/kontrast/klavye) | H.3/7 |

### K.3 Testlerin gizlediği riskler ve nitelik

- `spec-v2-remaining`, `phases-all`, `spec-v7-regressions` `readFileSync` + `includes` ile **kaynak metni** arıyor → refactor'ı engeller, davranışı doğrulamaz (B-15).
- GitHub testleri `fetch` mock'u kullanıyor; gerçek 403 `too_large`, 422, secondary rate limit simüle edilmiyor.
- E2E `mockApi` ile çalışıyor; gerçek sunucu + gerçek dosya sistemi ile uçtan uca test yok.
- Playwright e2e bu ortamda **koşulamadı** (`libnspr4.so` eksik, root yok); 15 testin 5 dosyada derlendiği `--list` ile doğrulandı, koşum yapılmadı.

---

## L. Birleştirilmiş Bulgular

### L.1 Kök neden haritası

| Grup | Kök neden | Birleşik bulgular | Neden aynı grupta |
|---|---|---|---|
| **R-A** | Birleştirme zaman kaynağı | B-01, B-02 | Üç ayrı merge fonksiyonu farklı zaman önceliği uyguluyor; test boşluğu aynı fonksiyonun kör noktası |
| **R-B** | Puanlama karmaşıklığı | B-03 | Tek fonksiyon, tek çift tarama |
| **R-C** | Normalizasyonda sessiz kırpma | B-04 | Tek politika: sınır aşımını hata değil kesme saymak |
| **R-D** | Yedek formatı daraltması | B-05, B-06 | Yedek/dışa aktarma belgenin silme ve çok-profil bilgisini taşımıyor |
| **R-E** | İleri uyumluluk politikası | B-07 | Sürüm kapısı + mesajlandırma (R-D'den ayrı kök) |
| **R-F** | Yazma/eşzamanlılık korumaları | B-08, B-09, B-10 | Üç farklı koruma noktası; ortak konu eşzamanlı değişimi görememek |
| **R-G** | Film/dizi tercih ayrımı | B-11 | Tek `unified` profil + 0.03 ağırlık |
| **R-H** | Öneri seçimi/açıklaması | B-12, B-13 | Seçim ve açıklama katmanındaki iki ayrı kural boşluğu |
| **R-I** | Test altyapısı | B-14, B-15 | İzolasyon ve test niteliği |
| **R-J** | Mimari borç | B-16, B-17 | Ayrıştırma tamamlanmamış (dosya boyutu, `any`, kopya) + katman sınırı ihlali ayrı satırda |
| **R-K** | Bağımlılık yüzeyi | B-18, B-19 | Kullanılmayan SDK + audit açıkları |
| **R-L** | İstemci maliyeti | B-20, B-21, B-22, B-23 | Paket, localStorage, önbellek, Excel bellek |
| **R-M** | Header/gezinme düzeni | B-24, B-25 | Aynı dosya ailesi; iki ayrı düzen hatası (şerit taşması ≠ mobil sarma) |
| **R-N** | UI etkileşim/cila | B-26…B-29 | Düğme durumu, görsel taşma, odak/klavye |
| **R-O** | API dayanıklılığı | B-30 | 429 politikası |
| **R-P** | Sır/gizlilik yapılandırması | B-31, B-32, B-33 | Sır yazımı, görünürlük bayrağı, CSP |
| **R-Q** | İlişki grafiği kalibrasyonu | B-34, B-35 | Anahtar kanonikleştirme + sabit ağırlık |
| **R-R** | Geri yükleme UX / bakım | B-36…B-39 | Operasyonel geri dönüş ve raporlama kolaylıkları |

### L.2 Bulgu tablosu (39)

| ID | Önem | Kategori | Sorun | Dosya / satır | Kaynak | Kanıt |
|---|---|---|---|---|---|---|
| **B-01** | **P1** | Doğrulanmış hata | Çok cihazlı birleştirmede "en güncel" `addedAt`'e göre seçiliyor; puan silme ve durum geri alma kayboluyor | `src/core/user-data-merge.ts:90-160` | R1 L-01 | probe: `merged= 9 (beklenen "")`; `status= completed (beklenen watchlist)` |
| **B-02** | P2 | Güçlü teknik risk | `mergeTwoSavedItemsLossless` için doğrudan test yok; fixture'lar `addedAt` içermiyor | `tests/**` | R1 L-08 | `grep mergeTwoSavedItemsLossless tests` = 0 |
| **B-03** | **P1** | Doğrulanmış performans | Puanlama O(aday × sevilen yapım); 5.000 adayda 13–29 sn | `loved-similarity.ts:190-260`, `cinetrack-core.ts:3339` | R1 L-02 + R2 F-02 | I.1 tablosu |
| **B-04** | P2 | Doğrulanmış hata | Sessiz kırpma: 22→20 profil, 25.010→25.000 kayıt, geçersiz kimlikli profil tümüyle düşüyor | `cinetrack-core.ts:876,938,960`; `profile-id.ts:39` | R1 L-03 | probe [4],[5],[7] |
| **B-05** | **P1** | Güçlü teknik risk | Yerel yedek `deleted_keys` taşımıyor; içe aktarma mezar taşı yazmıyor | `app/profile-backup.ts:45-58`; `hooks/useProfileBackupCoordinator.ts:116-160` | R2 F-03 | şema + import akışı |
| **B-06** | **P1** | Güçlü teknik risk | Tam belge yedeğinde yalnızca aktif/ilk profil alınıyor; diğer profiller ve mezar taşları atılıyor | `cinetrack-core.ts:700-770` (`parseBackupText`) | R2 F-04 | kod |
| **B-07** | P2 | Doğrulanmış hata | v4 yedek "geçerli Cinethos yedeği değil" mesajıyla reddediliyor | `cinetrack-core.ts:685-716` | R1 L-05 + R2 F-16 | probe [8] |
| **B-08** | P2 | Güçlü teknik risk | `POST /api/data/restore` revizyon ön koşulu istemiyor; eşzamanlı yazımı ezer | `server/app.ts:1988-2015` | R2 F-07 | kod: yalnızca `backupId` |
| **B-09** | P2 | Olası problem | `sudden_item_drop` yalnızca toplam sayıya bakıyor (60 sil + 11 ekle korumayı atlatır) | `server/storage.ts:517-536` | R2 F-08 | eşik ifadesi |
| **B-10** | P3 | Olası problem | `rejectIfBusy` kuyruktaki işi görmüyor; "busy" sinyali yarışa açık | `github-bidirectional-sync.ts:1779-1793` | R1 L-12 | kod |
| **B-11** | P2 | Güçlü teknik risk | Film/dizi tercih profilleri ortak; tek ayrım 0.03 ağırlıklı `mediaType` | `taste/profile-aggregator.ts:400-450` | R1 L-06 + R2 F-10 | tv 56,0 / movie 59,0 |
| **B-12** | P2 | Olası problem | Top-up yolunda `lastRecommended`/uygunluk filtresi atlanıyor | `modules/recommendations/pipeline.ts:203-222` | R2 F-09 | kod |
| **B-13** | P3 | Doğrulanmış hata | `serverTaste` hesaplanıyor ama ağırlığı yok; açıklamada katkı gibi görünüyor | `cinetrack-core.ts:3376-3380,3472` | R2 F-15 | ağırlık tablosu |
| **B-14** | **P1** | Doğrulanmış hata | Test paketi gerçek `data/` dizinine yazıyor (`createDataStorage` yanlış imza; taste varsayılanı `data`) | `tests/cinema-kunye-backup-sync.test.mjs:232,346,507`; `tests/taste/taste-store.test.mjs:98-124`; `storage.ts:125` | R2 F-01 | `npm test` sırasında `data/` oluştu; statik imza doğrulandı |
| **B-15** | P3 | Olası problem | Kaynak metni eşleştiren kırılgan testler davranışı doğrulamıyor | `tests/spec-v2-remaining…`, `phases-all…`, `spec-v7…` | R2 F-22 | `readFileSync` + `includes` |
| **B-16** | P2 | Doğrulanmış | Tanrı dosyaları + 645–676 `any` + kopya yardımcılar + `App.tsx`'te iş mantığı | `cinetrack-core.ts`, `github-bidirectional-sync.ts`, `persistent-store.ts`, `App.tsx`; `store-types.ts:225-264` ↔ `persistent-store-utils.ts:8-47` | R1 L-19, L-20 + R2 F-13 | satır sayıları, grep, kopya fonksiyonlar |
| **B-17** | P2 | Doğrulanmış | 5 `core-purity` ihlali (`idb-keyval`, `api-client`, `encoding-service`, `crypto`) | `cinetrack-core.ts:4-5`, `actor-recommendations.ts`, `relationship-explorer.ts`, `taste/migration.ts:264` | R1 L-07 | `architecture-boundaries.mjs` |
| **B-18** | P3 | Olası problem | `@respan/respan` hiç model çağrısı olmayan uygulamada gereksiz bağımlılık | `respan-telemetry.ts` | R1 L-18 | kod |
| **B-19** | P2 | Güçlü teknik risk | 26 moderate bağımlılık açığı (0 high/critical) | `package-lock.json` (`exceljs`→`uuid`, `@respan`→OTel) | R1 L-11 + R2 F-14 | `npm audit --omit=dev` |
| **B-20** | P2 | Güçlü teknik risk | Tek chunk 786,77 kB; iki dinamik import etkisiz | build çıktısı | R1 L-10 | `INEFFECTIVE_DYNAMIC_IMPORT` ×2 |
| **B-21** | P2 | Güçlü teknik risk | Her değişimde tam liste localStorage'a; kotada `overview` sessizce 120 karaktere kırpılıyor | `App.tsx:480-512` | R1 L-04 | kod |
| **B-22** | P3 | Olası problem | Öneri önbelleği sınırsız; her revizyonda yeni anahtar | `RecommendationService.ts:44` | R1 L-09 | kod |
| **B-23** | P4 | İyileştirme | Excel tam çalışma kitabı bellekte; önizleme tüm veri setini JSON döndürüyor | `excel-profile-backup.ts`; `app.ts:2767-2825` | R1 L-24 + R2 F-24 | kod |
| **B-24** | P2 | Doğrulanmış UI | 1024–1440'ta sekme şeridi kırpılıyor (613/377 px), kaydırma işareti yok; 1440'ta arama dar; 1024–1920 özel kırılım yok | `styles/workspace.css:750-760`; `Header.tsx`; `style.css` | R2 F-05 + R1 L-13 + R1 L-23 | tarayıcı ölçümü |
| **B-25** | P2 | Doğrulanmış UI | Mobilde 218 px yapışkan başlık ekranın ~%26'sı | `styles/components.css:217`; `Header.tsx` | R2 F-06 | tarayıcı: header 218, sticky |
| **B-26** | P3 | Doğrulanmış UI | İşlem Merkezi'nde "Yeniden dene" uygun olmayan görevlerde etkin (409) | `modules/operations/OperationsSection.tsx` | R2 F-19 | tarayıcı + API |
| **B-27** | P3 | Doğrulanmış UI | Rozetler poster üzerine biniyor; kaydırıcı son kartı kesiyor; filtre çubuğu kırpılıyor | `components/MediaGrid.tsx`; `styles/*.css` | R2 F-21 | ekran görüntüleri |
| **B-28** | P3 | Olası problem | Modal açıkken arka plan `inert`/`aria-hidden` değil | `hooks/useDialogAccessibility.ts` | R1 L-14 | kod |
| **B-29** | P3 | Olası problem | `useKeyboardShortcuts` `handlers` kimliğine bağlı; satır içi nesne → her render'da yeniden bağlama | `hooks/useKeyboardShortcuts.ts` | R1 L-15 | kod |
| **B-30** | P2 | Doğrulanmış davranış | 429'da istemci backoff/retry yok; katalog patlaması boş bölümlere yol açıyor | `services/api.ts:224`; `server/security.ts:311-360` | R2 F-11 | konsolda 429/502 |
| **B-31** | P2 | Güçlü teknik risk | PAT `.env`'e atomik olmayan, izinsiz yazımla kaydediliyor | `server/github-token-refresh.ts:105-123` | R2 F-12 | `writeFileSync` |
| **B-32** | P3 | Olası problem | Public depo onayı ile depo görünürlüğü aynı bayrakta karışıyor | `server/persistent-store.ts:392-399` | R2 F-18 | kod |
| **B-33** | P4 | İyileştirme | CSP `connect-src` içinde `ws:`/`wss:`/`*.run.app`, `frame-ancestors` geniş | `server/security.ts:66-90` | R2 F-23 | kod |
| **B-34** | P3 | Olası problem | İlişki grafiğinde durum/renk ham tercih anahtarlarıyla eşleşiyor | `core/relationship-explorer.ts:710-714` | R2 F-20 | kod |
| **B-35** | P4 | İyileştirme | İlişki türü ağırlıkları sabit; kişiselleştirilemiyor | `relationship-explorer.ts` | R1 L-22 | kod |
| **B-36** | P3 | Olası problem | Toplu geri yükleme sonrası tek tık "geri al" yok | `app.ts:1988`; `ProfileBackupTab` | R1 L-17 | kod |
| **B-37** | P3 | Olası problem | `data/exports` sınırsız büyüyor; retention yok | `excel-profile-backup.ts:3256-3300` | R2 F-17 | kod |
| **B-38** | P3 | Olası problem | Serileştirilmemiş `saveData` dışa açık (yalnızca testler kullanıyor) | `server/storage.ts` | R1 L-16 | `grep '.saveData('` |
| **B-39** | P4 | İyileştirme | `recordsAdded/recordsUpdated` alan düzeyi değişimi yansıtmıyor; rapor yanıltıcı | `github-bidirectional-sync.ts` | R1 L-21 | probe [D] |

### L.3 P1 bulguların ayrıntısı

#### B-01 — Birleştirmede kullanıcı eylemi kaybı (P1, Doğrulanmış hata)

- **Dosya:** `src/core/user-data-merge.ts:90-160`, `mergeTwoSavedItemsLossless`; çağrılar `cinetrack-core.ts` ve `github-bidirectional-sync.ts`.
- **Mekanizma:** "Hangi taraf daha yeni?" kararı `addedAt` (kaydın eklendiği an) üzerinden veriliyor; `updatedAt` pratikte hiç devreye girmiyor. Bir kayıt silinip yeniden eklenmediği sürece `addedAt` sabit kaldığı için, sonradan yapılan puan silme veya durum geri alma "daha eski" sayılıyor.
- **Tetikleme:** A cihazında puanı sil → senkron → B cihazının eski puanı geri gelir. Aynı şekilde `completed → watchlist` geri alması `completed` olarak geri döner.
- **Kanıt:** probe A: `merged = 9`, beklenen `""`; probe B: `status = completed`, beklenen `watchlist`.
- **Çözüm:** `resolveItemActionTimestamps` benzeri tek bir "eylem zamanı" fonksiyonu; `updatedAt`/`watchedAt`/`ratedAt` alanlarından türetilen `lastActionAt`; üç merge fonksiyonu aynı kuralı paylaşmalı. Önce testler (B-02).
- **Risk:** Mevcut birleştirme davranışı değişir; altın fixture'lar güncellenmeli, aksi halde sessiz regresyon.

#### B-03 — Karesel puanlama (P1, Doğrulanmış performans)

- **Dosya:** `src/core/loved-similarity.ts:190-260` (`computeLovedSimilarityScore`), çağrı `cinetrack-core.ts:3339`; `lovedItemFeatures` üretimi 1224/1334/3341.
- **Mekanizma:** Her aday için `lovedItems` tamamı dolaşılıyor, her çift için `computeItemToItemLovedSim`; her çiftte `canonicalGenreKeys` yeniden `Set` üretiyor. Karmaşıklık O(aday × geçmiş); ek olarak aday başına `scored` ve kırılım nesneleri ayrılıyor (GC baskısı).
- **Tetikleme:** Geçmiş > ~2.000 ve/veya havuz > 500; keşfet, "Sana Özel", zevk haritası, ilişki grafiği.
- **Kanıt:** 1.000/1.000 → 804–1.205 ms; 5.000/5.000 → 13.128–28.611 ms; 10.000/10.000 → 53.037 ms; 10.000/500 → 3.339 ms.
- **Çözüm:** ters indeks + üst-N sınırı + Worker/dilimleme (I.1).
- **Risk:** Puanlar değişir; altın anlık görüntü testleri yeniden üretilmeli.

#### B-05 / B-06 — Yedeğin silme ve çok-profil bilgisini taşımaması (P1, Güçlü teknik risk)

- **B-05:** Dışa aktarılan yerel belge `deleted_keys` içermiyor; içe aktarma `savedItems/preferences/favoriteActors/cinemaKunye` dışına yazmıyor. Sil → yedek al → geri yükle → reconcile zincirinde içerik eski uzak kopyadan geri dirilebilir.
- **B-06:** `parseBackupText` belgede `profiles[]` görürse yalnızca `activeProfileId` (yoksa ilk) profili okuyor; diğer profiller, `activeProfileId`, `deleted_keys` ve `revision` yok sayılıyor. `/api/data` çıktısını "yedek" sanıp içe aktaran kullanıcı diğer profillerini kaybeder.
- **Ortak kök:** yedek formatı, belgenin tüm durumunu temsil etmiyor. **Çözüm tek yerde:** yedek şeması v4, `deleted_keys` + tüm profiller; içe aktarmada `reconcileUserDataDocumentsLossless`, `overwrite` modunda açık onay + snapshot; eski yedeklerde alan yoksa mevcutlar korunur ve kullanıcıya "bu yedek silme bilgisi taşımıyor" uyarısı verilir.

#### B-14 — Testlerin gerçek veri dizinine yazması (P1, Doğrulanmış hata)

- **Dosya:** `src/server/storage.ts:125` (`createDataStorage(options: StorageOptions)`), `tests/cinema-kunye-backup-sync.test.mjs:232,346,507` (`createDataStorage(dataFile, { persistentStore: store })`), `tests/taste/taste-store.test.mjs:98-124` (`dataDir` verilmeyen `appendTasteEvent`/`writeTasteProfile`).
- **Mekanizma:** İkinci argüman yok sayılıyor; `options.dataDir` `undefined` → `path.resolve(undefined || cwd/data)` → `process.cwd()/data`. Taste tarafında varsayılan `"data"`.
- **Kanıt:** `npm test` öncesi `data/` yoktu; koşu sırasında `data/cinetrack-data.json` (rev 2, 1 profil, 0 öğe), `data/backups/*`, `data/restore-journal`, `data/taste/*` ve `cinetrack-taste-events.json.corrupt.*` oluştu. Statik imza doğrulaması bu turda yeniden yapıldı.
- **Etki:** Geliştiricinin gerçek arşivinin ezilmesi, snapshot'ların dönmesi, "testler izole" güvencesinin çürümesi.
- **Çözüm:** `createDataStorage({ dataDir: tmpDir })`; taste çağrılarına `tmpDir`; `process.env.CINETRACK_DATA_DIR` test guard'ı; CI'da `data/` önce/sonra hash karşılaştırması.

#### B-24 / B-25 — Header ve gezinme düzeni (P2, Doğrulanmış UI)

- **B-24:** Yedi sekme 613 px; 1024'te 377 px, 1440'ta 588 px alan. `overflow-x: auto` + `scrollbar-width: none` bilinçli ama görsel ipucu yok → fare kullanıcısı üç sekmeye ulaşamıyor. Aynı düzen kökünde 1440'ta arama alanı daralıyor ve 1024–1920 arası özel kırılım yok.
- **B-25:** Mobilde marka + aksiyonlar + profil/Ekle + arama dört satıra sarılıyor; `sticky` başlık 218 px. 390×844'te 218 px başlık + 56 px alt bar → içerik ~570 px.
- **Ayrım gerekçesi:** B-24 şerit taşması, B-25 dikey sarma; CSS düzeltmeleri farklı (ikon-only/taşma menüsü + fade/ok ↔ mobilde yalnız marka+arama sticky, aksiyonlar menüde).

---

## M. Önceliklendirilmiş Çözüm Planı

### 1. Acil (veri ve kaynak güvenliği)

| Sıra | İş | İlgili | Bağımlılık |
|---|---|---|---|
| 1 | Testleri izole et (`{ dataDir: tmpDir }`, taste `tmpDir`, CI hash kontrolü) | B-14 | — |
| 2 | Birleştirme zaman kaynağını düzelt + önce doğrudan testler | B-01, B-02 | Altın fixture kararı |
| 3 | Yedek şemasını tamamla (`deleted_keys` + tüm profiller) veya tam belge içe aktarımını reddet | B-05, B-06 | Yedek sürüm kararı |
| 4 | `POST /api/data/restore` → `If-Match` + 409 akışı | B-08 | İstemci restore çağrısı |
| 5 | `.env` token yazımını atomik + `0600` + yedekli yap | B-31 | — |
| 6 | `sudden_item_drop`'u mezar taşsız silmelere göre hesapla | B-09 | 3 ile birlikte |

### 2. Bir sonraki sürümden önce

| Sıra | İş | İlgili |
|---|---|---|
| 7 | Puanlamayı ters indeks + üst-N + Worker/dilimleme ile düzelt | B-03 |
| 8 | 1024–1440 gezinme çözümü; mobil sticky başlık sadeleştirmesi | B-24, B-25 |
| 9 | Top-up döngüsünde ring1/uygunluk filtresi | B-12 |
| 10 | 429 backoff + katalog eşzamanlılık sınırı | B-30 |
| 11 | `parseBackupText` sürüm ayrımı ve dürüst mesaj | B-07 |
| 12 | `rejectIfBusy` için `queued` durumu | B-10 |

### 3. Mimari iyileştirmeler

| Sıra | İş | İlgili |
|---|---|---|
| 13 | Birleştirme mantığını tek `mergePolicy` modülünde topla | B-01, B-02 |
| 14 | `cinetrack-core` ve `PersistentDataStore`'u böl; kopya yardımcıları tekilleştir | B-16 |
| 15 | 5 `core-purity` ihlalini port/adaptör arkasına al | B-17 |
| 16 | `any` → alan tipleri; `noUnusedLocals`/`noUnusedParameters` aç | B-16 |
| 17 | `App.tsx`'i `useLibrarySync` / `useProfilePersistence` / `useRecommendationController` olarak böl | B-16 |

### 4. Performans ve istemci

| Sıra | İş | İlgili |
|---|---|---|
| 18 | `manualChunks` + etkisiz dinamik import'ları düzelt | B-20 |
| 19 | localStorage yazımını debounce/idle'a al; >2 MB'de IDB | B-21 |
| 20 | Öneri önbelleğine LRU sınırı | B-22 |
| 21 | Excel streaming + önizlemede sayfalama; `data/exports` retention | B-23, B-37 |

### 5. UI/UX ve güvenlik cilası

| Sıra | İş | İlgili |
|---|---|---|
| 22 | Görev düğmelerini duruma göre devre dışı bırak; rozet/kaydırıcı cilası | B-26, B-27 |
| 23 | Modal açıkken `inert` + `aria-hidden`; `handlers` memoizasyonu | B-28, B-29 |
| 24 | axe + kontrast + klavye taraması | H.3/7 |
| 25 | CSP daraltma; public repo bayrağını ayır | B-32, B-33 |

### 6. Uzun vadeli

- Şema migration çerçevesi (adım adım `migrateV1toV2` zinciri).
- Film/dizi için ayrı zevk profilleri ve karşılaştırmalı değerlendirme.
- Gerçek sunucu + gerçek dosya sistemi ile mock'suz e2e; canlı GitHub/TMDB/TVDB entegrasyon testleri (opt-in).
- Senkronizasyon için işlem günlüğü (yarım reconcile'ı otomatik tamamlama).
- Performans bütçeleri (1k/5k/10k) ve CI eşik testleri; `@respan` ihtiyacının netleştirilmesi.

**Önerilen sıra:** 1 → 2 → 3 → 4 → 5 → 7 → 9 → 10 → 8 → 6 → 13 → 14 → 15 → 18 → 22. Veri güvenliği işleri (1–6) tamamlanmadan üretim verisiyle `npm test` koşulmamalı.

---

## N. Genel Kalite Puanlaması

İki raporun puanları farklıydı (R1 daha ılımlı, R2 daha katı). Birleşik puan, **kanıtla doğrulanan** bulgulara göre yeniden kalibre edildi; fark gerekçeleri son sütunda.

| Alan | R1 | R2 | **Birleşik** | Gerekçe |
|---|---|---|---|---|
| Mimari | 6,5 | 5 | **6,0** | Katmanlar ölçülüyor, 0 döngü; 5 core-purity + tanrı dosyaları doğrulandı |
| Kod kalitesi | 6,5 | 5 | **6,0** | Lint/tsc temiz, 0 `ts-ignore`; 645–676 `any`, kopya güvenlik yardımcıları |
| Veri bütünlüğü | 6 | 6 | **5,5** | Depolama güçlü; B-01, B-05, B-06, B-08 birlikte puanı düşürüyor |
| Senkronizasyon | 7,5 | 7 | **7,0** | Serileştirme/doğrulama güçlü; alan düzeyi birleştirme ve rollback eksik |
| Taste Engine | 6,5 | 7 | **6,0** | Deterministik ve açıklanabilir; tür sızması + ölü sinyal + karesel maliyet |
| Zevk Haritası | 7,5 | 6 | **7,0** | Sınırlı, yan etkisiz, gerekçeli; kanonikleştirme ve kalibrasyon eksik |
| API entegrasyonları | 7,5 | 7 | **7,0** | TMDB vekili güçlü; 429 toparlanması yok, TVDB/IMDb doğrulanamadı |
| UI/UX | 7,5 | 6 | **6,5** | Tema/boş durum/klavye iyi; sekme kırpılması ve 218 px başlık doğrulandı |
| Performans | 5 | 5 | **4,5** | Karesel puanlama + 786 kB chunk + senkron localStorage |
| Güvenlik | 8 | 8 | **8,0** | CSP/Origin/timing-safe/redaction/path traversal güçlü; 26 moderate |
| Test kalitesi | 7 | 7 | **6,5** | 608 gerçek test; izolasyon hatası (P1) ve kritik merge fonksiyonunun testsizliği |
| Genel olgunluk | 7 | 7 | **6,5** | Tek cihaz için üretime yakın; çok cihaz + büyük arşiv + tam yedek iddiaları karşılanmıyor |

**Puanlanmayan alanlar:** Gerçek tarayıcı e2e'si, ekran okuyucu/axe taraması, canlı TMDB/TVDB/GitHub gecikmesi, Excel bellek zirvesi, iki fiziksel cihaz senaryosu. Bunlar ölçülmediği için puana dahil edilmedi.

---

## Ek — Kanıtlar, yeniden üretim ve dürüstlük notu

**Yeniden üretilebilir komutlar (her iki denetimde de):**

```bash
npm ci
npm run lint          # PASS (ESLint --max-warnings 0 + 2× tsc --noEmit)
npm run cycles        # PASS — 0 döngü
npm test              # 608 pass / 0 fail  (uyarı: gerçek data/ dizinine yazar — B-14)
npm run test:taste    # PASS
npm run build         # PASS — index 786,77 kB (gzip 233,54)
node scripts/maintenance/architecture-boundaries.mjs   # 285 dosya, 5 core-purity ihlali
npm audit --omit=dev  # 26 moderate, 0 high/critical
npx playwright test --list   # 15 test / 5 dosya derleniyor (koşum yapılamadı)
```

**Tarayıcı doğrulaması:** iki bağımsız koşum (R1: `vite preview`; R2: `node server.ts`) × 360/390/768/1024/1440/1920; sayfa taşması 0, sekme şeridi ve başlık yüksekliği ölçüldü; 390 ve 1440 ekran görüntüleri alındı. Görsel denetim yalnızca bu iki ekran ve altı ölçümle sınırlı; tüm ekranlar gezilmedi.

> **Dürüstlük notu:** Playwright e2e bu ortamda çalıştırılamadı (eksik sistem kütüphaneleri, root yok). GitHub/TMDB/TVDB canlı çağrıları yapılmadı; Excel ve SQLite uçları elle denenmedi; erişilebilirlik taraması yapılmadı. Bu alanlardaki değerlendirmeler kod okuması, mevcut test kapsamı ve statik doğrulamaya dayanır. İki rapor arasındaki altı çelişki B.4'te kanıtla çözüldü; çözülemeyen bir çelişki kalmadı.
