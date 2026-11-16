# MIA Faz 0 — Doğrulanmış Envanter Verisi

> **Üretim:** `node scripts/arch-inventory.mjs --write` · 2026-11-15T23:58:53.837Z
> **Kapsam:** `src/` + `server.ts` — 202 kaynak dosya, 25 test dosyası, 204 statik test bloğu (çalıştırıcı alt testlerle daha fazla vaka raporlar).

## 1. Özet

| Metrik | Değer |
| --- | --- |
| Kaynak dosya | 202 |
| Toplam satır | 82.134 |
| İç import kenarı | 640 |
| Bunlardan `import type` | 130 |
| Döngüsel bileşen (SCC) | 3 |
| Gerçek değer döngüsü (yalnız değer kenarları) | 1 |
| Katman ihlali | 4 |
| Dışa açılan sembol | 1414 |

## 2. Katman Dağılımı

| Katman | Dosya | Satır |
| --- | --- | --- |
| `server` | 22 | 22.224 |
| `core` | 52 | 20.390 |
| `components` | 54 | 17.854 |
| `services` | 25 | 11.162 |
| `src-root` | 3 | 4.693 |
| `app` | 13 | 1.824 |
| `hooks` | 11 | 1.672 |
| `utils` | 6 | 739 |
| `design-system` | 6 | 503 |
| `server-entry` | 1 | 328 |
| `modules` | 4 | 292 |
| `workers` | 2 | 196 |
| `types` | 1 | 179 |
| `i18n` | 1 | 62 |
| `shared` | 1 | 16 |

## 3. En Büyük 25 Dosya

| Dosya | Satır | fan-in | fan-out | export |
| --- | --- | --- | --- | --- |
| `src/server/github-bidirectional-sync.ts` | 4.754 | 1 | 12 | 7 |
| `src/core/cinetrack-core.ts` | 4.691 | 72 | 12 | 119 |
| `src/App.tsx` | 4.651 | 1 | 49 | 1 |
| `src/server/persistent-store.ts` | 4.230 | 6 | 7 | 23 |
| `src/server/excel-profile-backup.ts` | 3.447 | 1 | 6 | 61 |
| `src/server/app.ts` | 2.281 | 1 | 15 | 6 |
| `src/services/api.ts` | 1.788 | 21 | 4 | 74 |
| `src/core/exporters.ts` | 1.054 | 10 | 3 | 17 |
| `src/server/tmdb-proxy.ts` | 1.049 | 1 | 0 | 9 |
| `src/components/DetailModal.tsx` | 1.041 | 1 | 8 | 1 |
| `src/core/cinema-kunye.ts` | 1.030 | 17 | 1 | 29 |
| `src/services/stock-engine.ts` | 992 | 9 | 8 | 27 |
| `src/components/RelationshipExplorer.tsx` | 988 | 3 | 10 | 1 |
| `src/components/IdentityView.tsx` | 973 | 0 | 4 | 3 |
| `src/services/series-service.ts` | 947 | 7 | 7 | 19 |
| `src/components/MediaGrid.tsx` | 941 | 2 | 9 | 1 |
| `src/core/relationship-explorer.ts` | 926 | 7 | 9 | 6 |
| `src/components/ProfileGitHubSyncSection.tsx` | 857 | 2 | 5 | 2 |
| `src/core/relationship-semantics.ts` | 791 | 2 | 3 | 31 |
| `src/core/user-data-merge.ts` | 785 | 3 | 3 | 7 |
| `src/core/actor-recommendations.ts` | 781 | 1 | 6 | 15 |
| `src/server/storage.ts` | 781 | 3 | 5 | 6 |
| `src/services/storage-idb.ts` | 776 | 20 | 4 | 43 |
| `src/services/poster-hydration-service.ts` | 737 | 2 | 3 | 22 |
| `src/server/sqlite-archive.ts` | 699 | 1 | 1 | 20 |

## 4. En Çok Bağımlı Olunan Dosyalar (fan-in)

| Dosya | fan-in | fan-out | Satır |
| --- | --- | --- | --- |
| `src/core/cinetrack-core.ts` | 72 | 12 | 4691 |
| `src/core/taste/types.ts` | 25 | 0 | 194 |
| `src/utils/helpers.ts` | 25 | 3 | 444 |
| `src/types/tmdb.ts` | 23 | 0 | 179 |
| `src/services/api.ts` | 21 | 4 | 1788 |
| `src/services/storage-idb.ts` | 20 | 4 | 776 |
| `src/core/cinema-kunye.ts` | 17 | 1 | 1030 |
| `src/shared/brand.ts` | 17 | 0 | 16 |
| `src/core/encoding.ts` | 12 | 1 | 311 |
| `src/core/taste/taxonomy.ts` | 11 | 1 | 675 |
| `src/core/exporters.ts` | 10 | 3 | 1054 |
| `src/app/module-registry.ts` | 9 | 3 | 128 |
| `src/core/keys.ts` | 9 | 0 | 361 |
| `src/core/taste/constants.ts` | 9 | 0 | 82 |
| `src/core/taste/metric-labels.ts` | 9 | 2 | 324 |

## 5. Döngüsel Bağımlılıklar

| # | Dosyalar | Kenar | type-only | Niteliği |
| --- | --- | --- | --- | --- |
| 1 | `src/core/actor-recommendations.ts`<br>`src/core/candidate-pool-store-port.ts`<br>`src/core/cinema-kunye.ts`<br>`src/core/cinetrack-core.ts`<br>`src/core/ring-lifecycle.ts` | 8 | 4 | tip ile kırılıyor<br>- src/core/cinetrack-core.ts → src/core/cinema-kunye.ts<br>- src/core/cinetrack-core.ts → src/core/candidate-pool-store-port.ts<br>- src/core/cinetrack-core.ts → src/core/ring-lifecycle.ts<br>- src/core/cinetrack-core.ts → src/core/actor-recommendations.ts |
| 2 | `src/core/relationship-explorer.ts`<br>`src/core/relationship-semantics.ts`<br>`src/core/relationship-wordlists.ts` | 4 | 1 | tip ile kırılıyor<br>- src/core/relationship-explorer.ts → src/core/relationship-wordlists.ts<br>- src/core/relationship-explorer.ts → src/core/relationship-semantics.ts<br>- src/core/relationship-semantics.ts → src/core/relationship-wordlists.ts |
| 3 | `src/server/github-bidirectional-sync.ts`<br>`src/server/github-catalog-sync.ts`<br>`src/server/persistent-store.ts` | 4 | 0 | **değer döngüsü** |

## 6. Katman İhlalleri

| Kural | Kaynak | Hedef | Tür |
| --- | --- | --- | --- |
| `core-services` | `src/core/actor-recommendations.ts` | `src/services/api-client.ts` | **değer** |
| `core-services` | `src/core/relationship-explorer.ts` | `src/services/encoding-service.ts` | **değer** |
| `core-services` | `src/core/relationship-explorer.ts` | `src/services/storage-idb.ts` | **değer** |
| `core-services` | `src/core/relationship-explorer.ts` | `src/services/series-tv-seeds.ts` | **değer** |

## 7. Paylaşılan Semboller

| Sembol | Toplam | Değer | Tip | Kullanıcılar |
| --- | --- | --- | --- | --- |
| `src/core/cinetrack-core.ts#SavedItem` | 57 | 8 | 49 | `server.ts`<br>`src/App.tsx`<br>`src/app/AppModals.tsx`<br>`src/app/mobile/MobileDashboard.tsx`<br>`src/app/shell-context.tsx`<br>`src/components/ActorRecommendationsSection.tsx`<br>+51 |
| `src/types/tmdb.ts#TmdbItem` | 20 | 3 | 17 | `src/app/shell-context.tsx`<br>`src/components/ActorRecommendationsSection.tsx`<br>`src/components/Header.tsx`<br>`src/components/MediaCard.tsx`<br>`src/components/MediaGrid.tsx`<br>`src/components/PaginatedMediaModal.tsx`<br>+14 |
| `src/core/cinetrack-core.ts#DataDocument` | 19 | 1 | 18 | `src/App.tsx`<br>`src/app/AppModals.tsx`<br>`src/components/ProfileGitHubSyncSection.tsx`<br>`src/components/ProfileModal.tsx`<br>`src/core/sync-display.ts`<br>`src/core/taste/migration.ts`<br>+13 |
| `src/core/cinetrack-core.ts#Profile` | 18 | 1 | 17 | `src/App.tsx`<br>`src/app/AppModals.tsx`<br>`src/components/ProfileBackupTab.tsx`<br>`src/components/ProfileGitHubSyncSection.tsx`<br>`src/components/ProfileModal.tsx`<br>`src/components/ProfileStatsTab.tsx`<br>+12 |
| `src/utils/helpers.ts#displayTitle` | 16 | 16 | 0 | `src/App.tsx`<br>`src/app/AppModals.tsx`<br>`src/app/mobile/MobileDashboard.tsx`<br>`src/components/CommandPalette.tsx`<br>`src/components/DetailModal.tsx`<br>`src/components/Header.tsx`<br>+10 |
| `src/core/cinetrack-core.ts#FavoriteActorInfo` | 16 | 3 | 13 | `src/App.tsx`<br>`src/app/AppModals.tsx`<br>`src/components/ActorRecommendationsSection.tsx`<br>`src/components/MediaGrid.tsx`<br>`src/components/PersonDrawer.tsx`<br>`src/components/ProfileModal.tsx`<br>+10 |
| `src/shared/brand.ts#BRAND_NAME` | 15 | 15 | 0 | `src/App.tsx`<br>`src/app/AppFooter.tsx`<br>`src/app/AppSidebar.tsx`<br>`src/app/mobile/MobileTopBar.tsx`<br>`src/components/ErrorBoundary.tsx`<br>`src/components/Header.tsx`<br>+9 |
| `src/core/cinetrack-core.ts#Preferences` | 14 | 2 | 12 | `src/App.tsx`<br>`src/app/AppModals.tsx`<br>`src/components/ProfileBackupTab.tsx`<br>`src/components/ProfileModal.tsx`<br>`src/components/RelationshipExplorer.tsx`<br>`src/components/UniversesHub.tsx`<br>+8 |
| `src/core/cinema-kunye.ts#CinemaKunyeDocument` | 14 | 0 | 14 | `src/app/AppModals.tsx`<br>`src/components/ProfileBackupTab.tsx`<br>`src/components/ProfileModal.tsx`<br>`src/components/ProfileStatsTab.tsx`<br>`src/components/Stats.tsx`<br>`src/components/WrappedCard.tsx`<br>+8 |
| `src/utils/helpers.ts#getPoster` | 12 | 12 | 0 | `src/app/mobile/MobileDashboard.tsx`<br>`src/components/CommandPalette.tsx`<br>`src/components/DetailModal.tsx`<br>`src/components/Header.tsx`<br>`src/components/Hero.tsx`<br>`src/components/MediaCard.tsx`<br>+6 |
| `src/core/taste/types.ts#TasteProfile` | 12 | 0 | 12 | `src/components/taste/TasteCategoryDetail.tsx`<br>`src/components/taste/TasteComparePanel.tsx`<br>`src/components/taste/TasteMetricDetail.tsx`<br>`src/core/taste/profile-aggregator.ts`<br>`src/core/taste/profile-explainer.ts`<br>`src/core/taste/recommendation-adapter.ts`<br>+6 |
| `src/core/taste/types.ts#TasteEvent` | 12 | 0 | 12 | `src/core/taste/behavioral-patterns.ts`<br>`src/core/taste/evidence-ledger.ts`<br>`src/core/taste/migration.ts`<br>`src/core/taste/profile-aggregator.ts`<br>`src/core/taste/taste-archaeology.ts`<br>`src/core/taste/taste-event-projector.ts`<br>+6 |
| `src/core/cinetrack-core.ts#PoolCandidateItem` | 11 | 2 | 9 | `src/App.tsx`<br>`src/components/RelationshipDetailsPanel.tsx`<br>`src/components/RelationshipExplorer.tsx`<br>`src/components/RelationshipListView.tsx`<br>`src/components/UniversesHub.tsx`<br>`src/components/UniversesView.tsx`<br>+5 |
| `src/services/api.ts#fetchTmdb` | 10 | 10 | 0 | `src/App.tsx`<br>`src/components/CommandPalette.tsx`<br>`src/components/DetailModal.tsx`<br>`src/components/Header.tsx`<br>`src/components/PersonDrawer.tsx`<br>`src/services/actor-recommendations-engine.ts`<br>+4 |
| `src/core/taste/taxonomy.ts#TAXONOMY_V01` | 10 | 10 | 0 | `src/app/mobile/MobileDashboard.tsx`<br>`src/components/UniversesHub.tsx`<br>`src/components/profile/ProfileIdentityCard.tsx`<br>`src/components/taste/TasteComparePanel.tsx`<br>`src/components/taste/TasteProfileDashboard.tsx`<br>`src/components/taste/TasteProfileMinimal.tsx`<br>+4 |
| `src/services/storage-idb.ts#loadStockIdb` | 9 | 9 | 0 | `src/App.tsx`<br>`src/components/PersonDrawer.tsx`<br>`src/components/ProfileGitHubSyncSection.tsx`<br>`src/components/RelationshipExplorer.tsx`<br>`src/components/UniversesHub.tsx`<br>`src/services/idle-enrichment-service.ts`<br>+3 |
| `src/core/cinetrack-core.ts#PersistentTasteMapData` | 9 | 3 | 6 | `src/App.tsx`<br>`src/app/AppModals.tsx`<br>`src/components/IdentityView.tsx`<br>`src/components/TasteMapView.tsx`<br>`src/core/evaluation.ts`<br>`src/core/recommendation-orchestrator.ts`<br>+3 |
| `src/core/taste/types.ts#ContentTasteItem` | 9 | 0 | 9 | `src/core/taste/feature-extractor.ts`<br>`src/core/taste/profile-aggregator.ts`<br>`src/core/taste/profile-explainer.ts`<br>`src/core/taste/recommendation-adapter.ts`<br>`src/core/taste/taste-archaeology.ts`<br>`src/core/taste/taste-index-builder.ts`<br>+3 |
| `src/core/cinetrack-core.ts#findSavedItem` | 8 | 8 | 0 | `src/App.tsx`<br>`src/app/AppModals.tsx`<br>`src/components/ActorRecommendationsSection.tsx`<br>`src/components/DetailModal.tsx`<br>`src/components/PaginatedMediaModal.tsx`<br>`src/components/PersonDrawer.tsx`<br>+2 |
| `src/core/cinema-kunye.ts#enrichSavedItemsFromCinemaKunye` | 8 | 8 | 0 | `src/App.tsx`<br>`src/components/ProfileStatsTab.tsx`<br>`src/components/Stats.tsx`<br>`src/core/cinetrack-core.ts`<br>`src/core/exporters.ts`<br>`src/core/wrapped-summary.ts`<br>+2 |
| `src/core/cinema-kunye.ts#mergeCinemaKunyeDocumentsLossless` | 8 | 8 | 0 | `src/App.tsx`<br>`src/core/cinetrack-core.ts`<br>`src/core/exporters.ts`<br>`src/hooks/useCinemaKunye.ts`<br>`src/server/excel-profile-backup.ts`<br>`src/server/github-bidirectional-sync.ts`<br>+2 |
| `src/core/taste/metric-labels.ts#getMetricDisplayTitle` | 8 | 8 | 0 | `src/app/mobile/MobileDashboard.tsx`<br>`src/components/UniversesHub.tsx`<br>`src/components/profile/ProfileIdentityCard.tsx`<br>`src/components/taste/TasteComparePanel.tsx`<br>`src/components/taste/TasteEvolutionPanel.tsx`<br>`src/components/taste/TasteMetricDetail.tsx`<br>+2 |
| `src/utils/useDialogAccessibility.ts#useDialogAccessibility` | 8 | 8 | 0 | `src/components/AddCustomModal.tsx`<br>`src/components/CommandPalette.tsx`<br>`src/components/DetailModal.tsx`<br>`src/components/ImportChoiceModal.tsx`<br>`src/components/PaginatedMediaModal.tsx`<br>`src/components/PersonDrawer.tsx`<br>+2 |
| `src/utils/helpers.ts#imageUrl` | 8 | 8 | 0 | `src/components/DetailModal.tsx`<br>`src/components/Hero.tsx`<br>`src/components/MediaGrid.tsx`<br>`src/components/PersonDrawer.tsx`<br>`src/components/WrappedCard.tsx`<br>`src/components/taste/TasteMetricDetail.tsx`<br>+2 |
| `src/utils/helpers.ts#handleImageError` | 8 | 8 | 0 | `src/components/DetailModal.tsx`<br>`src/components/Header.tsx`<br>`src/components/Hero.tsx`<br>`src/components/MediaCard.tsx`<br>`src/components/MediaGrid.tsx`<br>`src/components/PersonDrawer.tsx`<br>+2 |

## 8. Depolama Anahtarları

### IndexedDB

| Depo | Erişen dosyalar |
| --- | --- |
| `cinetrack-skip-log-db` | `src/services/client-depots.ts` |
| `cinetrack-ui-prefs-db` | `src/services/client-depots.ts` |
| `cinetrack-actor-credits-db` | `src/services/client-depots.ts` |
| `cinetrack-encodings-db` | `src/services/client-depots.ts` |
| `cinetrack-offline-queue-db` | `src/services/offline-queue.ts`<br>`src/services/storage-idb.ts` |
| `cinetrack-poster-lru-db` | `src/services/poster-cache-manager.ts` |
| `cinetrack-relationship-cache` | `src/services/relationship-cache.ts` |
| `cinetrack-stock-db` | `src/services/storage-idb.ts` |
| `cinetrack-surfaced-db` | `src/services/storage-idb.ts` |
| `cinetrack-series-index-db` | `src/services/storage-idb.ts` |
| `cinetrack-user-lists-db` | `src/services/storage-idb.ts` |
| `cinetrack-profile-db` | `src/services/storage-idb.ts` |

### localStorage

| Anahtar | Erişen dosyalar |
| --- | --- |
| `cinetrack.profiles.v1` | `src/App.tsx` |
| `cinetrack.activeProfile.v1` | `src/App.tsx` |
| `cinetrack.profile.v1` | `src/App.tsx` |
| `cinetrack.dirty.v2` | `src/App.tsx` |
| `cinetrack_hide_listed_items` | `src/App.tsx` |
| `cinetrack.profile.*.watchlist.v1` | `src/App.tsx`<br>`src/services/storage-idb.ts` |
| `cinetrack.profile.*.preferences.v1` | `src/App.tsx`<br>`src/services/storage-idb.ts` |
| `cinetrack_fav_actors_*` | `src/App.tsx` |
| `cinetrack_deleted_keys_*` | `src/App.tsx` |
| `cinetrack_disliked_cache` | `src/App.tsx` |
| `ct:ui-prefs` | `src/App.tsx` |
| `ct:mobile-dashboard:*` | `src/app/mobile/MobileDashboard.tsx` |
| `cinetrack.actor-accordions.v1` | `src/components/ActorRecommendationsSection.tsx` |
| `cinetrack_evidence_objections` | `src/components/EvidenceModal.tsx` |
| `ct:library-view` | `src/components/MediaGrid.tsx` |
| `cinetrack.series-accordions.v1` | `src/components/SeriesRecommendationsSection.tsx` |
| `cinetrack_taste_map_*` | `src/core/cinetrack-core.ts` |
| `ct:cinema-kunye` | `src/hooks/useCinemaKunye.ts` |
| `ct:actor-credits:*` | `src/services/actor-recommendations-engine.ts`<br>`src/services/client-depots.ts` |
| `ct:stock` | `src/services/actor-recommendations-engine.ts`<br>`src/services/idb-schema-version.ts` |
| `cinetrack_client_token_v1` | `src/services/api-client.ts` |
| `ct:auto-backup-meta` | `src/services/auto-backup-service.ts` |
| `cinetrack_taste_map_` | `src/services/discovery-storage.ts` |
| `cinetrack_pool_*_*` | `src/services/discovery-storage.ts` |
| `cinetrack_idb_depot_versions_v1` | `src/services/idb-schema-version.ts` |
| `ct:encodings` | `src/services/idb-schema-version.ts` |
| `ct:profile` | `src/services/idb-schema-version.ts` |
| `ct:user-lists` | `src/services/idb-schema-version.ts` |
| `ct:series-index` | `src/services/idb-schema-version.ts`<br>`src/services/series-service.ts` |
| `ct:idle-enrichment-quota` | `src/services/idle-enrichment-service.ts` |
| `cinetrack_offline_sync_queue_v1` | `src/services/offline-queue.ts` |
| `cinetrack_offline_queue_store` | `src/services/offline-queue.ts` |
| `ct:poster-hydration` | `src/services/poster-hydration-service.ts` |
| `ct:stock-poster-hydration` | `src/services/stock-poster-hydration-service.ts` |
| `cinetrack_prefer_image_proxy` | `src/utils/helpers.ts` |
| `ct:theme` | `src/utils/theme.ts` |

## 9. Test → Kaynak Eşlemesi

| Test dosyası | `test()` bloğu | Satır | Hedef kaynaklar |
| --- | --- | --- | --- |
| `tests/api-auth-coverage.test.mjs` | 3 | 83 | — |
| `tests/api-error-policy.test.mjs` | 7 | 102 | `src/core/cinema-kunye.ts`<br>`src/services/api.ts` |
| `tests/archive-restore-consistency.test.mjs` | 9 | 551 | `src/server/app.ts`<br>`src/server/archive-integrity.ts`<br>`src/server/sqlite-archive.ts` |
| `tests/audit-spec-fixes.test.mjs` | 8 | 707 | `src/core/cinetrack-core.ts`<br>`src/core/keys.ts`<br>`src/core/mood-affinity.ts`<br>`src/core/recommendation-orchestrator.ts`<br>`src/i18n/index.ts`<br>+8 |
| `tests/cinema-kunye-backup-sync.test.mjs` | 5 | 692 | `src/core/cinema-kunye.ts`<br>`src/core/cinetrack-core.ts`<br>`src/core/exporters.ts`<br>`src/core/user-data-merge.ts`<br>`src/core/wrapped-summary.ts`<br>+5 |
| `tests/core.test.mjs` | 0 | 4844 | `src/core/cinetrack-core.ts`<br>`src/services/api.ts`<br>`src/services/discovery-storage.ts`<br>`src/utils/helpers.ts` |
| `tests/excel-profile-backup.test.mjs` | 10 | 1284 | `src/server/app.ts`<br>`src/server/excel-profile-backup.ts`<br>`src/server/persistent-store.ts`<br>`src/services/api.ts` |
| `tests/feat-03-encoding-relationships.test.mjs` | 2 | 438 | `src/core/encoding.ts`<br>`src/core/relationship-explorer.ts`<br>`src/core/scoring.ts`<br>`src/services/client-depots.ts`<br>`src/services/encoding-service.ts`<br>+3 |
| `tests/github-bidirectional-sync.test.mjs` | 35 | 2549 | `src/core/cinetrack-core.ts`<br>`src/core/derived-profile-cache.ts`<br>`src/core/sync-display.ts`<br>`src/server/app.ts`<br>`src/server/config.ts`<br>+2 |
| `tests/image-proxy-hardening.test.mjs` | 6 | 208 | `src/server/tmdb-proxy.ts` |
| `tests/loved-similarity.test.mjs` | 9 | 213 | `src/core/cinetrack-core.ts` |
| `tests/module-registry.test.mjs` | 0 | 102 | `src/app/module-registry.ts`<br>`src/app/navigation.ts` |
| `tests/offline-queue-durability.test.mjs` | 7 | 196 | `src/services/offline-queue.ts` |
| `tests/persistent-store.test.mjs` | 11 | 935 | `src/core/derived-profile-cache.ts`<br>`src/core/exporters.ts`<br>`src/core/limits.ts`<br>`src/core/recommendation-orchestrator.ts`<br>`src/server/app.ts`<br>+3 |
| `tests/phases-1-to-4-architecture.test.mjs` | 4 | 769 | `src/core/cinetrack-core.ts`<br>`src/server/app.ts`<br>`src/server/config.ts`<br>`src/server/persistent-store.ts`<br>`src/server/security.ts`<br>+6 |
| `tests/phases-all.test.mjs` | 15 | 1890 | `src/core/cinetrack-core.ts`<br>`src/core/evaluation.ts`<br>`src/core/exporters.ts`<br>`src/core/keys.ts`<br>`src/core/recommendation-orchestrator.ts`<br>+6 |
| `tests/relationship-explorer.test.mjs` | 24 | 793 | `src/core/relationship-explorer.ts`<br>`src/services/relationship-cache.ts` |
| `tests/respan-telemetry.test.mjs` | 4 | 117 | `src/server/respan-telemetry.ts` |
| `tests/shell-events.test.mjs` | 5 | 72 | `src/app/shell-events.ts` |
| `tests/spec-v2-remaining.test.mjs` | 7 | 859 | `src/components/PaginatedMediaModal.tsx`<br>`src/server/app.ts`<br>`src/server/persistent-store.ts`<br>`src/services/actor-recommendations-engine.ts`<br>`src/services/discovery-storage.ts`<br>+4 |
| `tests/spec-v3-validation.test.mjs` | 1 | 126 | `src/services/series-service.ts`<br>`src/services/storage-idb.ts` |
| `tests/spec-v6-improvements.test.mjs` | 1 | 833 | `src/core/duplicate-detector.ts`<br>`src/core/person-insights.ts`<br>`src/core/relationship-explorer.ts`<br>`src/core/tv-progress.ts`<br>`src/core/wrapped-summary.ts`<br>+9 |
| `tests/spec-v7-regressions.test.mjs` | 22 | 1427 | `src/components/CommandPalette.tsx`<br>`src/components/ErrorBoundary.tsx`<br>`src/components/RelationshipCanvas.ts`<br>`src/components/charts/ColumnChart.tsx`<br>`src/components/charts/profile-chart-data.ts`<br>+15 |
| `tests/sqlite-archive.test.mjs` | 5 | 358 | `src/server/app.ts`<br>`src/server/sqlite-archive.ts` |
| `tests/sqlite-primary-store.test.mjs` | 4 | 140 | `src/server/sqlite-primary-store.ts`<br>`src/server/storage.ts` |

## 10. Giriş Noktaları (fan-in = 0)

- `src/app/mobile/MobileDashboard.tsx`
- `src/components/FloatingGlassDock.tsx`
- `src/components/IdentityView.tsx`
- `src/components/MoodSelectorBar.tsx`
- `src/components/UniversesHub.tsx`
- `src/components/UniversesView.tsx`
- `src/components/profile/ProfileIdentityCard.tsx`
- `src/components/taste/TasteCategoryDetail.tsx`
- `src/components/taste/TasteComparePanel.tsx`
- `src/components/taste/TasteEvidenceList.tsx`
- `src/components/taste/TasteEvolutionPanel.tsx`
- `src/components/taste/TasteProfileDashboard.tsx`
- `src/components/taste/TasteProfileMinimal.tsx`
- `src/core/evaluation.ts`
- `src/core/sources/index.ts`
- `src/core/taste/behavioral-patterns.ts`
- `src/core/taste/recommendation-adapter.ts`
- `src/core/taste/taste-event-projector.ts`
- `src/main.tsx`
- `src/modules/relationships/RelationshipsSection.tsx`
- `src/modules/taste-map/TasteMapSection.tsx`
- `src/services/stock-import-export.ts`
- `src/vite-env.d.ts`
- `src/workers/encoding.worker.ts`
- `src/workers/taste-profile-worker.ts`
- `server.ts`
