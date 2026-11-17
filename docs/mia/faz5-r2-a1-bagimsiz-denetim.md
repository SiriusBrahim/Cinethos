# MIA Faz 5 — R2-A1 Bağımsız Denetim Raporu (Agent 1)

**Denetçi:** Agent 1 (bağımsız test/CI doğrulama sorumlusu)
**Denetim tabanı:** `origin/master` @ `2ffe4bf82a5d512c1dafd7754498554e443c9098`
**Denetim tarihi:** 2026-11-17
**Denetlenen rapor:** `docs/mia/faz5-r2-a1-teknik-hazirlik.md` (Agent 2)

---

## 1. Kritik engel beyanı: Denetlenen rapor mevcut değil

Bu denetimin birincil girdisi olması gereken Agent 2 raporu **hiçbir konumda bulunamadı**:

| Konum | Arama sonucu |
|---|---|
| `origin/master` @ `2ffe4bf8` | `docs/mia/` altında R2-A1 raporu yok (mevcut: faz0, faz1-faz2, faz1a, faz3, faz4) |
| Tüm remote dallar (7 dal) | `r2` / `r2-a1` adlı dosya eşleşmesi sıfır |
| Lokal çalışma ağacı | Dosya yok; `git status` temiz |
| PR listesi (open + closed) | R2 raporu içeren PR yok |

**Sonuç:** Agent 2'nin teknik tespitlerinin birebir doğrulanması bu hâlle mümkün değildir. Bu rapor, (a) engeli resmî olarak kayıt altına alır, (b) güncel master üzerinde önceki bağımsız denetimlerin kod temelli tespitlerini yeniden doğrular, (c) görev talimatlarında tanımlanan R2-A1 tasarım öğelerinin kod uyumunu ön değerlendirir, (d) R2-A1 kodlamasına başlamanın koşullu güvenliğini değerlendirir.

## 2. Güncel master üzerinde yeniden doğrulanmış tespitler

Önceki bağımsız denetimlerin bulguları, güncel master (`2ffe4bf8`) üzerinde yeniden kanıtlandı — hepsi **hâlâ geçerli**:

| # | Tespit | Kanıt (dosya:satır) | Durum |
|---|---|---|---|
| T1 | Taste Store profil ayrımı yok; 6 dosya tek global set | `src/server/taste-store.ts:42-57` | Doğrulandı |
| T2 | `TasteEvent` tipinde `profileId` yok | `src/core/taste/types.ts:44-55` | Doğrulandı |
| T3 | Adapter, AppEvent→TasteEvent dönüşümünde profil etiketini düşürüyor | `src/server/taste-service-adapter.ts:86-98` | Doğrulandı |
| T4 | `processedEventIds` in-memory ve profil-dışı | `src/server/taste-service-adapter.ts:229` | Doğrulandı |
| T5 | `profile:changed` ShellEvent'ini dinleyen yok (istemci cache yenilenmiyor) | `src/app/app-event-bus.ts:169` yalnızca emit; abone sıfır | Doğrulandı |
| T6 | `LibraryItemRemoved` → `status_changed/'removed'`; `currentRating` korunuyor → silinen öğenin puan katkısı sürüyor | `taste-service-adapter.ts:137-150`; `src/core/taste/taste-event-projector.ts:70-75`; `taste-rebuild-coordinator.ts:472-474` | Doğrulandı |
| T7 | Cross-process kilit PID+yaş bazlı; host bilgisi yok; 15 sn stale eşiği canlı sürecin kilidini çalınabilir kılıyor | `taste-store.ts:105, 118-172` (stale tespiti :150-153) | Doğrulandı |
| T8 | Metadata cache kilitsiz yazılıyor | `src/server/taste-metadata-hydrator.ts:68-76` | Doğrulandı |
| T9 | GitHub sync Taste'ten yalnızca manifest+profile'ı kapsıyor; events/index/objections dışarıda | `src/server/github-bidirectional-sync.ts:106-121` | Doğrulandı |
| T10 | BackgroundManager hedef profili koruyor; ProfileConflictError → retry/failed, yanlış profile yazım yok | `src/modules/background/service.ts:292-304`; Faz 4 testleri F4-A3/A3b | Doğrulandı |
| T11 | API profil çözümleme mevcut: `x-cinetrack-profile-id` + strict mod | `src/server/app.ts:1648-1655` | Doğrulandı |
| T12 | ProfileContext sözleşmesi: `assertCurrent`/`assertWritable`/revision | `src/contracts/profile.ts:30-63` | Doğrulandı |

## 3. R2-A1 tasarım öğelerinin kod uyumu ön değerlendirmesi

Agent 2 raporunun tam metni olmadığından aşağıdaki değerlendirme, görev talimatlarında tanımlanan tasarım öğeleri üzerinden yapılmıştır; rapora özgü ayrıntılar rapor ulaştığında kesinleştirilmelidir.

| Tasarım öğesi | Ön değerlendirme | Koşul/eksik |
|---|---|---|
| Reversible `profileIdSafe` + mapping manifest | Yön doğru | Base64URL uzunluk stratejisi (255B FS sınırı) ve kanonik kimlik formu (trim/NFC) tanımlanmalı — `app.ts:1650` header'da trim uyguluyor, doküman tarafında politika yok |
| Global mapping-manifest kilidi | Yön doğru | Manifest kilidi ↔ profil kilidi edinim sırası ve "birlikte tutma" kuralı yazılı olmalı; `byDir` türetilmiş indeks olmalı |
| Taxonomy + ham TMDB cache global | Doğru | Cache içeriği kişisel değil (`hydrator.ts:21`); "kişisel alan yok" negatif testi istenmeli |
| Stale lock güvenliği | **Riskli** | T7'deki PID/yaş zayıflığı profil partition ile büyür; heartbeat/lease veya fail-closed (hata) tercihi A1'de kesinleşmeli |
| Fail-closed manifest davranışı | Kod tabanıyla uyumlu | `CorruptJsonFileError` deseni (`taste-store.ts:307-310`) manifest için de zorlanmalı |
| R2-A1 kapsamı (manifest + resolver, veri yazımı yok) | Güvenli ve küçük | Kabul kriterleri rapor metni olmadan doğrulanamadı |

## 4. R2-A1 kodlamasına başlanmasının güvenliği

**Değerlendirme: KOŞULLU GÜVENLİ.**

R2-A1 (profil-dizin eşleme manifest'i + resolver, henüz veri yazımı olmadan) tek başına güvenli bir ilk adımdır: geri dönüşü kolaydır, en kötü durum boş bir manifest dosyasıdır ve mevcut davranışı değiştirmez. Ancak başlamadan önce aşağıdaki koşulların yazılı olarak kesinleşmesi gerekir:

1. **Kanonik profil kimliği formu** (trim/NFC, tek noktada uygulanır) — aksi hâlde manifest'te çift girdi riski.
2. **Uzunluk stratejisi** — base64URL çıktısı FS sınırını aşarsa davranış (hata önerilir; sessiz hash-suffix reversibility'yi bozar).
3. **Stale lock stratejisi** — heartbeat/lease yenileme veya "kanıtlanamayan durumda hata" ilkesi; mevcut 15 sn çalma davranışının devralınmaması (T7).
4. **Kabul kriterleri** — traversal/çakışma/uzunluk/reversibility negatif testleri ve manifest bozukluğunda fail-closed testi olarak yazılı hâlde tanımlı olmalı.

Ayrıca süreç ön koşulu: **R1 dokümanı (`agent-2/phase-5-r1-eventbus-boundaries` @ `3f256a7`) hâlâ merge edilmedi ve PR'ı hâlâ açılmamış durumda.** R2'nin dayandığı EventBus sınır sözleşmesinin resmîleşmesi için önce R1'in PR'ının açılıp birleştirilmesi önerilir.

## 5. Bulgu özeti

| Seviye | Bulgu |
|---|---|
| P1 | Denetlenen rapor mevcut değil — denetim girdisi eksik (bu raporun §1'i) |
| P1 | R1 merge edilmedi ve PR'ı yok — R2 ön koşulu tamamlanmamış |
| P1 | T6: silinen öğenin Taste katkısı nötralize edilmiyor; R2 kapsamı dışına alındıysa ayrı görev olarak kayıt altına alınmalı |
| P2 | T7: stale lock'ta canlı sürecin kilidi çalınabilir |
| P2 | T8: metadata cache kilitsiz; R2 kilit hiyerarşisindeki yeri tanımlanmalı |
| P2 | T4: `processedEventIds` profil-dışı; R2-A3'te profil bazlı ayrılmalı |
| P2 | T5: `profile:changed` istemci aboneliği yok |
| P3 | T9: events yedeği kapsam dışı — backup/sync/restore ayrı onay kapsamında ele alınmalı |

## 6. Sonraki adım

Agent 2'nin raporu ulaştığında (mesaj olarak veya repoya push edilerek) bu denetim, raporun maddeleri tek tek kodla karşılaştırılarak tamamlanacak ve nihai karar (APPROVED / APPROVED WITH CONDITIONS / REJECTED) verilecektir. Bu rapor, eksik girdi hâlinde verilebilecek en ileri bağımsız değerlendirmedir.

---
*Bu denetim salt-okunur yapılmıştır; hiçbir uygulama kodu, test veya şema değiştirilmemiştir.*
