# MIA Faz 6 — Öneri ve Keşif Yöneticisi Uygulama Kaydı

**Tarih:** 2026-11-18
**Dal:** `agent-2/phase-5-r2-a3-codlama-master` (PR #41)
**Girdi:** `MIA_TRANSFORMATION_PLAN.md` §1 Yönetici 6 + §7 Faz 6 kabul kriteri

Amaç: öneri motorunu bağımsız yöneticiye ayırmak ve **aynı veri setinde
puanların değişmediğini** kanıtlayan önce/sonra karşılaştırma testini eklemek.

## 1. Taşınma

| Önce | Sonra |
|---|---|
| `src/core/recommendation-orchestrator.ts` | `src/modules/recommendations/RecommendationEngine.ts` |
| `enforceStrictMediaTypePool` (aynı dosya) | `src/modules/recommendations/CandidatePoolManager.ts` |
| `resolveDisplayedLifecycleRing`, `mapRecommendationBatchToDisplayItems` (aynı dosya) | `src/modules/recommendations/ExplanationManager.ts` |
| `core/evaluation.ts` (çekirdek koşum) | `src/modules/recommendations/EvaluationManager.ts` (yönetici yüzü, formül değişmedi) |
| `core/actor-recommendations.ts` (çekirdek algoritma) | `src/modules/recommendations/RankingManager.ts` (yönetici yüzü) |
| `App.tsx` → `core/recommendation-orchestrator.ts` | `App.tsx` → `modules/recommendations/index.ts` |

Eski çekirdek dosyası **kaldırıldı** (tek sahip ilkesi). Çağıran testler
(`phases-all`, `persistent-store`, `audit-spec-fixes`) yeni yola güncellendi.
Puanlama matematiği `src/core/cinetrack-core.ts` içinde değişmeden kaldı.

`createRecommendationManager()` yöneticiyi `id: 'recommendations'`,
`version: '1.0.0'` ve beş alt yöneticiyle (`engine`, `pool`, `explanations`,
`evaluation`, `ranking`) döner. Yönetici durum tutmaz ve kullanıcı hafızasına
yazmaz.

## 2. Önce/sonra karşılaştırma testi

- Veri seti: `tests/fixtures/faz6-recommendation-dataset.mjs` — sabit
  `REFERENCE_NOW = 2026-11-18T00:00:00.000Z`, yinelenen kayıt, kayıtlı /
  beğenilmeyen / gizlenen öğeler, oyuncu-yönetmen-tür sinyalleri, `ring1` ve
  `ring2` Zevk Haritası kayıtları.
- Altın anlık görüntü: `tests/fixtures/faz6-recommendation-before-scores.json`
  — taşınmadan **önceki** uygulamadan, aynı veri setiyle iki kez üretilip
  bayt-eşit olduğu doğrulandıktan sonra kaydedildi.
- Test: `tests/phase6-recommendation-manager.test.mjs`
  1. Taşınma sonrası `enrichCatalogItemsWithTaste` ve
     `mapRecommendationBatchToDisplayItems` çıktısı altın anlık görüntüyle
     `deepEqual` (tasteScore, matchScore, priorityScore, sıra, halka,
     gerekçeler, kapsam/güven dahil).
  2. Ardışık iki koşum deterministik.
  3. Yönetici kimliği/alt yöneticileri kurulur; `App.tsx` yönetici yüzünü
     kullanır ve eski çekirdek dosyası yoktur.
  4. Aday havuzu film/dizi ayrımını korur; değerlendirme/sıralama yöneticileri
     çekirdek algoritmayı yeniden yazmaz.

Deterministik puanlama için `enrichCatalogItemsWithTaste` isteğe bağlı `now`
parametresi aldı; verilmezse davranış aynıdır (güncel zaman).

## 3. Doğrulama

| Kontrol | Sonuç |
|---|---|
| `npm run lint` (eslint + tsc + tsconfig.tests) | 0 hata |
| `npm test` | 519/519 (önceki 513 + 6 yeni) |
| `npm run test:taste` | 436/436 |
| `npm run build` | başarılı |
| Mimari sınır taraması (`architecture-boundaries.test.mjs`) | yeni ihlal yok |

## 4. Kalan işler / riskler

- `App.tsx` içindeki `forYou*` / `catalog*` durum kancalarının
  `modules/discover/state.ts` altına taşınması bu dilimde yapılmadı; Faz 6
  kapsamının UI durum ayrıştırma kısmı Faz 7 ile birlikte ele alınmalı.
- `IRecommendationService` sözleşmesinin (revision'lı önbellek yenileme)
  yöneticiye bağlanması, aday havuzunun sunucu tarafı besleyicisi
  netleşmeden yapılmadı; mevcut istemci akışı korunuyor.
