/**
 * Keşfet / Sana Özel katalog yükleyicisi.
 *
 * PR #60 sonrası App.tsx içinde kalan ~1.140 satırlık `loadCategoryResults`
 * gövdesi buraya taşındı. React'e bağımlı değildir: ihtiyaç duyduğu durum ve
 * setter'lar `CatalogLoaderContext` üzerinden verilir. Böylece App yalnızca
 * koordinasyon yapar; veri toplama, havuz puanlama ve seçim akışı burada kalır.
 *
 * Öneri kararı TEK hattan gelir (`scoreRecommendationPool` -> `rescoreShortlist`
 * -> `selectRecommendationBatch`); bu dosya yeni bir sıralama yolu açmaz.
 */

import { normalizeProfileId } from '../core/profile-id.ts';
import {
  ALGORITHM_VERSION,
  HIDE_LISTED_CATEGORIES,
  POOL_LOW_WATERMARK,
  TARGET_RECOMMENDATION_COUNT,
  replenishCandidatePool,
  buildTasteProfileSummary,
  buildScopedTasteProfiles,
  computeTasteProfileSignature,
  filterDislikedByType,
  filterHiddenUserRegisteredItems,
  filterHistoryByType,
  filterOutLastRecommendedCandidates,
  hydratePoolFromCatalog,
  isCandidateEligibleInPool,
  isTasteMapCacheValid,
  loadPersistentPoolData,
  loadPersistentTasteMap,
  makeMediaKey,
  matchesSelectedGenre,
  recordDisplayedRecommendations,
  resolveDiscoverGenreParam,
  savePersistentPoolData,
  savePersistentTasteMap,
  topUpFilteredCandidates,
  updateTasteMapWithBatch,
  type PersistentTasteMapData,
  type PoolCandidateItem,
  type Preferences,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import { computeSourceCatalogSignature } from '../core/derived-profile-cache.ts';
import { computeProfileCentroid, cosineSimilarity } from '../core/encoding.ts';
import {
  fetchCatalogItems,
  fetchDerivedProfileData,
  fetchTmdb,
  fetchTmdbCached,
  pushCatalogItems,
  pushDerivedProfileData,
} from '../services/api.ts';
import { loadSemanticRelationHints } from '../services/content-intelligence-api.ts';
import { rankBySemanticAffinity } from '../core/semantic-ranking.ts';
import { filterRecommendableItems } from '../core/item-effective-state.ts';

/**
 * Keşfet ve arama sonuçlarında "ilgilenmiyorum"/"gizli" içerikleri tek merkezi
 * çözümleyiciyle eler. Bileşenler kendi filtrelerini yazmaz; bu fonksiyon
 * `enrichItemsWithPersonalizedTaste` üzerinden tüm katalog yollarına uygulanır.
 */
export function filterCatalogItemsByPreferences(
  input: Parameters<typeof filterRecommendableItems>[0],
  items: any[]
): any[] {
  return filterRecommendableItems(input, items);
}
import { getItemEncodingSync } from '../services/encoding-service.ts';
import {
  isCandidateEligibleForStock,
  seedCandidatePoolFromStock,
  syncStockWithUserExclusions,
  executeStockReplenishment,
  enrichStockItemsTopCast,
} from '../services/stock-engine.ts';
import { loadStockIdb } from '../services/storage-idb.ts';
import {
  buildDerivedProfilePayloadFromTasteMap,
  enforceStrictMediaTypePool,
  enrichCatalogItemsWithTaste,
  hydrateTasteMapWithDerivedCache,
  mapRecommendationBatchToDisplayItems,
  rescoreShortlist,
  scoreRecommendationPool,
  selectRecommendationBatch,
  type ServerTasteSignal,
} from '../modules/recommendations/index.ts';
import { dateYearsAgo, displayTitle, mapLimit } from '../utils/helpers.ts';
import {
  compareMediaDatesAscending,
  compareMediaDatesDescending,
  isWithinReleaseWindow,
} from '../utils/release-window.ts';

type RequestGate = { begin(): { id: number; signal: AbortSignal }; isCurrent(id: number): boolean };

export interface CatalogLoaderContext {
  readonly query: string;
  readonly selectedProvider: string;
  readonly showToast: (message: string) => void;
  readonly requestGateRef: { current: RequestGate };
  readonly selectedTypeRef: { current: string };
  readonly selectedGenreRef: { current: string };
  readonly selectedSortRef: { current: string };
  readonly hideListedItemsRef: { current: boolean };
  readonly activeProfileIdRef: { current: string };
  readonly savedItemsRef: { current: SavedItem[] };
  readonly preferencesRef: { current: Preferences };
  readonly genresMapRef: { current: Record<number | string, string> };
  readonly tasteMapRef: { current: PersistentTasteMapData };
  readonly favoriteActorsRef: { current: any[] };
  readonly dislikedItemsRef: { current: any[] };
  readonly serverTasteRef: { current: ServerTasteSignal | null };
  readonly forYouItemsRef: { current: any[] };
  readonly lastForYouQueryKeyRef: { current: string };
  readonly setIsLoading: (value: boolean) => void;
  readonly setLoadingMore: (value: boolean) => void;
  readonly setCatalogItems: (updater: any[] | ((prev: any[]) => any[])) => void;
  readonly setCatalogPage: (value: number) => void;
  readonly setCatalogTotalPages: (value: number) => void;
  readonly setTrendingTop: (value: any) => void;
  readonly setForYouExplanation: (value: string) => void;
  readonly setForYouReasons: (value: Map<string, string>) => void;
  readonly setForYouItems: (value: any[]) => void;
  readonly setForYouProgressStep: (value: string) => void;
  readonly setTasteMap: (value: PersistentTasteMapData) => void;
  readonly setStockStats: (value: { movieCount: number; tvCount: number }) => void;
}

/**
 * Katalog yükleyicisini oluşturur. Dönen fonksiyon App'in `loadCategoryResults`
 * sözleşmesini birebir korur.
 */
export function createCatalogLoader(ctx: CatalogLoaderContext) {
  const {
    query,
    selectedProvider,
    showToast,
    requestGateRef,
    selectedTypeRef,
    selectedGenreRef,
    selectedSortRef,
    hideListedItemsRef,
    activeProfileIdRef,
    savedItemsRef,
    preferencesRef,
    genresMapRef,
    tasteMapRef,
    favoriteActorsRef,
    dislikedItemsRef,
    serverTasteRef,
    forYouItemsRef,
    lastForYouQueryKeyRef,
    setIsLoading,
    setLoadingMore,
    setCatalogItems,
    setCatalogPage,
    setCatalogTotalPages,
    setTrendingTop,
    setForYouExplanation,
    setForYouReasons,
    setForYouItems,
    setForYouProgressStep,
    setTasteMap,
    setStockStats,
  } = ctx;

  /**
   * Keşfet'in genel sıralamasında İçerik Zekâsı semantik sinyali.
   * Yalnızca kategori kendi doğal sırasını korumak zorunda olmadığında ve
   * kullanıcı özel bir sıralama seçmediğinde devreye girer. Sunucu kapalıysa
   * veya analiz yoksa sıralama değişmez (güvenli dönüş).
   */
  const DISCOVER_SEMANTIC_CATEGORIES = new Set(['trending', 'gems', 'provider']);
  let discoverSemanticCache: {
    signature: string;
    at: number;
    hints: Map<string, number>;
  } | null = null;

  async function loadDiscoverSemanticHints(): Promise<Map<string, number> | null> {
    const seeds = Array.from(savedItemsRef.current || [])
      .filter((it) => it && (Number(it.personal_rating) > 0 || it.status === 'completed'))
      .sort(
        (a, b) =>
          Number(b.personal_rating || 0) - Number(a.personal_rating || 0) ||
          String(b.completedAt || b.ratedAt || '').localeCompare(String(a.completedAt || a.ratedAt || ''))
      )
      .slice(0, 6)
      .map((it) => `${it.media_type}:${it.id}`)
      .filter((key) => /^(movie|tv):\d+$/.test(key));
    if (seeds.length === 0) return null;

    const signature = [...seeds].sort().join('|');
    const now = Date.now();
    if (
      discoverSemanticCache &&
      discoverSemanticCache.signature === signature &&
      now - discoverSemanticCache.at < 5 * 60_000
    ) {
      return discoverSemanticCache.hints.size > 0 ? discoverSemanticCache.hints : null;
    }

    const hints = await loadSemanticRelationHints(seeds, { limit: 10, maxSources: 6 });
    discoverSemanticCache = { signature, at: now, hints };
    return hints.size > 0 ? hints : null;
  }

  async function applyDiscoverSemanticOrdering(cat: string, items: any[]): Promise<any[]> {
    if (!Array.isArray(items) || items.length < 2) return items;
    if (!DISCOVER_SEMANTIC_CATEGORIES.has(cat)) return items;
    const activeSort = selectedSortRef.current;
    if (activeSort && activeSort !== 'popularity' && activeSort !== 'default') return items;
    try {
      const hints = await loadDiscoverSemanticHints();
      if (!hints) return items;
      return rankBySemanticAffinity(items, hints);
    } catch {
      return items;
    }
  }

  const enrichItemsWithPersonalizedTaste = (items: any[]): any[] => {
    if (!items || items.length === 0) return items;
    try {
      const currentProfileId = activeProfileIdRef.current;
      const currentTasteMap = tasteMapRef.current || loadPersistentTasteMap(currentProfileId);
      const visibleItems = filterCatalogItemsByPreferences(
        { savedItems: savedItemsRef.current, preferences: preferencesRef.current },
        items
      );
      return enrichCatalogItemsWithTaste({
        items: visibleItems,
        savedItems: savedItemsRef.current,
        preferences: preferencesRef.current,
        genresMap: genresMapRef.current,
        tasteMap: currentTasteMap,
        serverTaste: serverTasteRef.current,
      });
    } catch {
      return items;
    }
  };

  function mergeDiscoverResults(cat: string, movies: any[], tvs: any[]): any[] {
    const mList = (movies || []).map((m: any) => ({ ...m, media_type: 'movie' }));
    const tList = (tvs || []).map((t: any) => ({ ...t, media_type: 'tv' }));

    if (mList.length === 0) return tList;
    if (tList.length === 0) return mList;

    if (cat === 'top-rated') {
      return [...mList, ...tList].sort((a, b) => (Number(b.vote_average) || 0) - (Number(a.vote_average) || 0));
    }
    if (cat === 'upcoming') {
      return [...mList, ...tList].sort((a, b) =>
        compareMediaDatesAscending(
          a.release_date || a.first_air_date,
          b.release_date || b.first_air_date
        )
      );
    }
    if (cat === 'gems') {
      return [...mList, ...tList].sort((a, b) => (Number(b.vote_average) || 0) - (Number(a.vote_average) || 0));
    }
    const merged: any[] = [];
    const maxLen = Math.max(mList.length, tList.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < mList.length) merged.push(mList[i]);
      if (i < tList.length) merged.push(tList[i]);
    }
    return merged;
  }

  // Load Catalog Data (Trending, For-You, Gems, Upcoming, etc.)
  const loadCategoryResults = async (
      cat: string,
      p = 1,
      append = false,
      currentQuery = query,
      provider = selectedProvider,
      forceRefresh = false,
      typeFilter?: string,
      genreFilter?: string
    ) => {
      const ticket = requestGateRef.current.begin();
      if (!append) {
        setIsLoading(true);
        setCatalogPage(1);
      } else {
        setLoadingMore(true);
      }

      const activeGenre = genreFilter !== undefined ? genreFilter : selectedGenreRef.current;
      const effectiveType = typeFilter || selectedTypeRef.current || 'all';
      const targetType = effectiveType === 'movie' || effectiveType === 'tv' ? effectiveType : 'all';

      try {
        if (currentQuery.trim()) {
          const res = await fetchTmdb(
            '/search/multi',
            { query: currentQuery.trim(), page: String(p) },
            ticket.signal
          );
          if (!requestGateRef.current.isCurrent(ticket.id)) return;
          const items = (res.results || []).filter(
            (item: any) => item.media_type === 'movie' || item.media_type === 'tv'
          );
          const enriched = enrichItemsWithPersonalizedTaste(items);
          setCatalogItems((prev) => (append ? [...prev, ...enriched] : enriched));
          setCatalogTotalPages(res.total_pages || 1);
          setCatalogPage(p);
          return;
        }

        const fetchDiscoverPageByCategory = async (pageNum: number): Promise<{ rawItems: any[]; totalPages: number }> => {
          if (cat === 'stock') {
            const stock = await loadStockIdb();
            const stockMovies = (stock.movies || [])
              .map((m: any) => ({ ...m, media_type: 'movie' }))
              .filter((m: any) =>
                isCandidateEligibleForStock(m, savedItemsRef.current, preferencesRef.current)
              );
            const stockSeries = (stock.tv || [])
              .map((t: any) => ({ ...t, media_type: 'tv' }))
              .filter((t: any) =>
                isCandidateEligibleForStock(t, savedItemsRef.current, preferencesRef.current)
              );

            setStockStats({
              movieCount: stockMovies.length,
              tvCount: stockSeries.length,
            });

            console.info('[Cinethos Stock] loadStockIdb (arındırılmış):', {
              movies: stockMovies.length,
              tv: stockSeries.length,
              updatedAt: stock.updatedAt || null,
            });
            if (stockMovies.length === 0 && stockSeries.length === 0) {
              void executeStockReplenishment(activeProfileIdRef.current, {
                userListItems: savedItemsRef.current,
                preferences: preferencesRef.current,
              });
            } else if (
              stockMovies.length !== (stock.movies || []).length ||
              stockSeries.length !== (stock.tv || []).length
            ) {
              void syncStockWithUserExclusions(
                activeProfileIdRef.current,
                savedItemsRef.current,
                preferencesRef.current
              );
            }

            let filtered: any[] = [];
            if (targetType === 'movie') {
              filtered = stockMovies;
            } else if (targetType === 'tv') {
              filtered = stockSeries;
            } else {
              filtered = mergeDiscoverResults(cat, stockMovies, stockSeries);
            }

            filtered = filtered.filter((it) => {
              const d = it.release_date || it.first_air_date || '';
              return d ? isWithinReleaseWindow(d) : true;
            });

            if (hideListedItemsRef.current) {
              filtered = filterHiddenUserRegisteredItems(filtered, {
                savedItems: savedItemsRef.current,
                preferences: preferencesRef.current,
                tasteMap: tasteMapRef.current,
                hideListedItems: true,
              });
            }

            if (activeGenre) {
              const targetGenreId = Number(activeGenre);
              if (Number.isFinite(targetGenreId)) {
                filtered = filtered.filter((it) =>
                  Array.isArray(it.genre_ids) && it.genre_ids.includes(targetGenreId)
                );
              }
            }

            const activeSort = selectedSortRef.current;
            if (activeSort === 'similarity') {
              const savedEncodings = savedItemsRef.current.map((it) => ({
                encoding: getItemEncodingSync(it),
                personal_rating: it.personal_rating,
              }));
              const profileCentroid = computeProfileCentroid(savedEncodings);
              if (profileCentroid.length > 0) {
                const simMap = new Map<string, number>();
                for (const it of filtered) {
                  const enc = getItemEncodingSync(it);
                  const sim = cosineSimilarity(profileCentroid, enc.denseVector);
                  simMap.set(`${it.media_type}:${it.id}`, sim);
                }
                filtered.sort((a, b) => (simMap.get(`${b.media_type}:${b.id}`) ?? 0) - (simMap.get(`${a.media_type}:${a.id}`) ?? 0));
              } else {
                filtered.sort((a, b) => (Number(b.popularity) || 0) - (Number(a.popularity) || 0));
              }
            } else if (activeSort === 'rating' || activeSort === 'rating.desc' || activeSort === 'vote_average.desc') {
              filtered.sort((a, b) => (Number(b.vote_average) || 0) - (Number(a.vote_average) || 0));
            } else if (activeSort === 'recent' || activeSort === 'date.desc' || activeSort === 'primary_release_date.desc') {
              filtered.sort((a, b) =>
                compareMediaDatesDescending(
                  a.release_date || a.first_air_date,
                  b.release_date || b.first_air_date
                )
              );
            } else if (activeSort === 'title') {
              filtered.sort((a, b) => displayTitle(a).localeCompare(displayTitle(b), 'tr'));
            } else {
              filtered.sort((a, b) => (Number(b.popularity) || 0) - (Number(a.popularity) || 0));
            }

            const PAGE_SIZE = 24;
            const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
            const startIdx = (pageNum - 1) * PAGE_SIZE;
            const pageSlice = filtered.slice(startIdx, startIdx + PAGE_SIZE);

            return {
              rawItems: pageSlice,
              totalPages,
            };
          }

          const movieGenreParam = resolveDiscoverGenreParam(activeGenre, 'movie');
          const tvGenreParam = resolveDiscoverGenreParam(activeGenre, 'tv');

          if (provider && cat !== 'for-you') {
            const baseParams = {
              with_watch_providers: provider,
              watch_region: 'TR',
              sort_by: 'popularity.desc',
              page: String(pageNum),
            };
            let moviesPromise = Promise.resolve({ results: [], total_pages: 1 });
            let tvsPromise = Promise.resolve({ results: [], total_pages: 1 });
            if (targetType === 'all' || targetType === 'movie') {
              moviesPromise = fetchTmdb(
                '/discover/movie',
                movieGenreParam ? { ...baseParams, with_genres: movieGenreParam } : baseParams,
                ticket.signal
              );
            }
            if (targetType === 'all' || targetType === 'tv') {
              tvsPromise = fetchTmdb(
                '/discover/tv',
                tvGenreParam ? { ...baseParams, with_genres: tvGenreParam } : baseParams,
                ticket.signal
              );
            }
            const [movies, tvs] = await Promise.all([moviesPromise, tvsPromise]);
            return {
              rawItems: mergeDiscoverResults(cat, movies.results || [], tvs.results || []),
              totalPages: Math.max(movies.total_pages || 1, tvs.total_pages || 1),
            };
          }

          if (cat === 'gems') {
            const cutoffDate = dateYearsAgo(15);
            const common: Record<string, string> = {
              'vote_average.gte': '7',
              'vote_count.gte': '200',
              'vote_count.lte': '3000',
              sort_by: 'popularity.asc',
              page: String(pageNum),
            };
            let moviesPromise = Promise.resolve({ results: [], total_pages: 1 });
            let tvsPromise = Promise.resolve({ results: [], total_pages: 1 });
            if (targetType === 'all' || targetType === 'movie') {
              moviesPromise = fetchTmdb(
                '/discover/movie',
                {
                  ...common,
                  'primary_release_date.gte': cutoffDate,
                  ...(movieGenreParam ? { with_genres: movieGenreParam } : {}),
                },
                ticket.signal
              );
            }
            if (targetType === 'all' || targetType === 'tv') {
              tvsPromise = fetchTmdb(
                '/discover/tv',
                {
                  ...common,
                  'first_air_date.gte': cutoffDate,
                  ...(tvGenreParam ? { with_genres: tvGenreParam } : {}),
                },
                ticket.signal
              );
            }
            const [movies, tvs] = await Promise.all([moviesPromise, tvsPromise]);
            return {
              rawItems: mergeDiscoverResults(cat, movies.results || [], tvs.results || []),
              totalPages: Math.max(movies.total_pages || 1, tvs.total_pages || 1),
            };
          }

          if (cat === 'upcoming') {
            const todayIso = new Date().toISOString().slice(0, 10);
            let moviesPromise = Promise.resolve({ results: [], total_pages: 1 });
            let tvsPromise = Promise.resolve({ results: [], total_pages: 1 });
            if (targetType === 'all' || targetType === 'movie') {
              moviesPromise = movieGenreParam
                ? fetchTmdb(
                    '/discover/movie',
                    {
                      'primary_release_date.gte': todayIso,
                      with_genres: movieGenreParam,
                      sort_by: 'popularity.desc',
                      page: String(pageNum),
                    },
                    ticket.signal
                  )
                : fetchTmdb('/movie/upcoming', { page: String(pageNum) }, ticket.signal);
            }
            if (targetType === 'all' || targetType === 'tv') {
              tvsPromise = tvGenreParam
                ? fetchTmdb(
                    '/discover/tv',
                    {
                      'first_air_date.gte': todayIso,
                      with_genres: tvGenreParam,
                      sort_by: 'popularity.desc',
                      page: String(pageNum),
                    },
                    ticket.signal
                  )
                : fetchTmdb('/tv/on_the_air', { page: String(pageNum) }, ticket.signal);
            }
            const [movies, tvs] = await Promise.all([moviesPromise, tvsPromise]);
            const mergedUpcoming = mergeDiscoverResults(
              cat,
              movies.results || [],
              tvs.results || []
            ).filter((it) => {
              const d = it.release_date || it.first_air_date || '';
              return d ? isWithinReleaseWindow(d) : false;
            });
            return {
              rawItems: mergedUpcoming,
              totalPages: Math.max(movies.total_pages || 1, tvs.total_pages || 1),
            };
          }

          if (activeGenre) {
            let moviesPromise = Promise.resolve({ results: [], total_pages: 1 });
            let tvsPromise = Promise.resolve({ results: [], total_pages: 1 });

            if (cat === 'top-rated') {
              if (targetType === 'all' || targetType === 'movie') {
                moviesPromise = fetchTmdb(
                  '/discover/movie',
                  {
                    ...(movieGenreParam ? { with_genres: movieGenreParam } : {}),
                    sort_by: 'vote_average.desc',
                    'vote_count.gte': '200',
                    page: String(pageNum),
                  },
                  ticket.signal
                );
              }
              if (targetType === 'all' || targetType === 'tv') {
                tvsPromise = fetchTmdb(
                  '/discover/tv',
                  {
                    ...(tvGenreParam ? { with_genres: tvGenreParam } : {}),
                    sort_by: 'vote_average.desc',
                    'vote_count.gte': '150',
                    page: String(pageNum),
                  },
                  ticket.signal
                );
              }
            } else if (cat === 'popular-movies') {
              moviesPromise = fetchTmdb(
                '/discover/movie',
                {
                  ...(movieGenreParam ? { with_genres: movieGenreParam } : {}),
                  sort_by: 'popularity.desc',
                  page: String(pageNum),
                },
                ticket.signal
              );
            } else if (cat === 'popular-tv') {
              tvsPromise = fetchTmdb(
                '/discover/tv',
                {
                  ...(tvGenreParam ? { with_genres: tvGenreParam } : {}),
                  sort_by: 'popularity.desc',
                  page: String(pageNum),
                },
                ticket.signal
              );
            } else {
              if (targetType === 'all' || targetType === 'movie') {
                moviesPromise = fetchTmdb(
                  '/discover/movie',
                  {
                    ...(movieGenreParam ? { with_genres: movieGenreParam } : {}),
                    sort_by: 'popularity.desc',
                    page: String(pageNum),
                  },
                  ticket.signal
                );
              }
              if (targetType === 'all' || targetType === 'tv') {
                tvsPromise = fetchTmdb(
                  '/discover/tv',
                  {
                    ...(tvGenreParam ? { with_genres: tvGenreParam } : {}),
                    sort_by: 'popularity.desc',
                    page: String(pageNum),
                  },
                  ticket.signal
                );
              }
            }

            const [mRes, tRes] = await Promise.all([moviesPromise, tvsPromise]);
            return {
              rawItems: mergeDiscoverResults(cat, mRes.results || [], tRes.results || []),
              totalPages: Math.max(mRes.total_pages || 1, tRes.total_pages || 1),
            };
          }

          if (cat === 'popular-movies') {
            const res = await fetchTmdb('/movie/popular', { page: String(pageNum) }, ticket.signal);
            return {
              rawItems: (res.results || []).map((m: any) => ({ ...m, media_type: 'movie' })),
              totalPages: res.total_pages || 1,
            };
          }
          if (cat === 'popular-tv') {
            const res = await fetchTmdb('/tv/popular', { page: String(pageNum) }, ticket.signal);
            return {
              rawItems: (res.results || []).map((t: any) => ({ ...t, media_type: 'tv' })),
              totalPages: res.total_pages || 1,
            };
          }
          if (cat === 'top-rated') {
            if (targetType === 'tv') {
              const res = await fetchTmdb('/tv/top_rated', { page: String(pageNum) }, ticket.signal);
              return {
                rawItems: (res.results || []).map((t: any) => ({ ...t, media_type: 'tv' })),
                totalPages: res.total_pages || 1,
              };
            }
            if (targetType === 'movie') {
              const res = await fetchTmdb('/movie/top_rated', { page: String(pageNum) }, ticket.signal);
              return {
                rawItems: (res.results || []).map((m: any) => ({ ...m, media_type: 'movie' })),
                totalPages: res.total_pages || 1,
              };
            }
            const [mRes, tRes] = await Promise.all([
              fetchTmdb('/movie/top_rated', { page: String(pageNum) }, ticket.signal),
              fetchTmdb('/tv/top_rated', { page: String(pageNum) }, ticket.signal),
            ]);
            return {
              rawItems: mergeDiscoverResults(cat, mRes.results || [], tRes.results || []),
              totalPages: Math.max(mRes.total_pages || 1, tRes.total_pages || 1),
            };
          }

          const trendEndpoint =
            targetType === 'movie'
              ? '/trending/movie/day'
              : targetType === 'tv'
              ? '/trending/tv/day'
              : '/trending/all/day';
          const res = await fetchTmdb(trendEndpoint, { page: String(pageNum) }, ticket.signal);
          return {
            rawItems: (res.results || []).map((item: any) =>
              item.media_type
                ? item
                : { ...item, media_type: targetType !== 'all' ? targetType : item.title ? 'movie' : 'tv' }
            ),
            totalPages: res.total_pages || 1,
          };
        };

        if (cat === 'for-you') {
          const currentProfileId = activeProfileIdRef.current;
          const rawSaved = savedItemsRef.current;
          const currentPrefs = preferencesRef.current;
          const currentGenres = genresMapRef.current;
          const isFilteredView = Boolean(activeGenre || provider);
          const forYouQueryKey = `${currentProfileId}|${targetType}|${activeGenre || ''}|${provider || ''}`;
          const isFilterTriggeredRun = Boolean(
            !forceRefresh &&
            lastForYouQueryKeyRef.current &&
            lastForYouQueryKeyRef.current !== forYouQueryKey
          );

          const currentSig = computeTasteProfileSignature(rawSaved, currentPrefs, favoriteActorsRef.current, { targetType });
          const diskTasteMap = loadPersistentTasteMap(currentProfileId);
          const inMemTasteMap = tasteMapRef.current;
          let storedTasteMap =
            inMemTasteMap &&
            normalizeProfileId(inMemTasteMap.profileId) === normalizeProfileId(currentProfileId) &&
            (inMemTasteMap.updatedAt || '') > (diskTasteMap.updatedAt || '')
              ? inMemTasteMap
              : diskTasteMap;

          // Yerel Zevk Haritası henüz soğuksa veya imzası güncellenmişse sunucudaki doğrulanmış türetilmiş profil önbelleğini dene
          let serverCatalogSnapshot: any = null;
          if (
            !forceRefresh &&
            (Object.keys(storedTasteMap.entries || {}).length < 400 ||
              storedTasteMap.profileSignature !== currentSig)
          ) {
            const [remoteDerived, remoteCatalog] = await Promise.all([
              fetchDerivedProfileData(currentProfileId, {
                profileFingerprint: currentSig,
                algorithmVersion: ALGORITHM_VERSION,
              }),
              fetchCatalogItems(),
            ]);
            if (!requestGateRef.current.isCurrent(ticket.id)) return;
            serverCatalogSnapshot = remoteCatalog;

            if (remoteDerived) {
              const catalogLookup: Record<string, any> = {
                ...(remoteCatalog?.movies || {}),
                ...(remoteCatalog?.tv || {}),
              };
              const expectedCatalogHash =
                typeof remoteCatalog?.manifest?.contentHash === 'string'
                  ? remoteCatalog.manifest.contentHash
                  : undefined;

              const hydratedCache = hydrateTasteMapWithDerivedCache({
                tasteMap: storedTasteMap,
                derivedDoc: remoteDerived,
                profileId: currentProfileId,
                profileFingerprint: currentSig,
                algorithmVersion: ALGORITHM_VERSION,
                sourceCatalogHash: expectedCatalogHash,
                savedItems: rawSaved,
                preferences: currentPrefs,
                catalogLookup,
                forceRefresh,
              });

              if (hydratedCache.cacheHit) {
                storedTasteMap = hydratedCache.tasteMap;
                savePersistentTasteMap(currentProfileId, storedTasteMap);
                tasteMapRef.current = storedTasteMap;
              }
            }
          }

          // 500 + 500 havuz Zevk Haritasında zaten işlenmişse (>= 400 kayıt) ve filtre yoksa önbellekten hızlı yükle
          const processedEntriesCount = Object.keys(storedTasteMap.entries || {}).length;
          if (
            !isFilteredView &&
            processedEntriesCount >= 400 &&
            isTasteMapCacheValid({
              tasteMap: storedTasteMap,
              currentSig,
              targetType,
              savedItems: rawSaved,
              preferences: currentPrefs,
              favoriteActors: favoriteActorsRef.current,
              forceRefresh,
            })
          ) {
            const restored = enforceStrictMediaTypePool(
              (storedTasteMap.cachedBalancedItems || []).filter((item: any) =>
                isCandidateEligibleInPool(item.candidate || item, rawSaved, currentPrefs)
              ),
              targetType
            );
            if (restored.length >= TARGET_RECOMMENDATION_COUNT) {
              const impressionSync = recordDisplayedRecommendations(storedTasteMap, restored, {
                targetType,
              });
              const activeMap = impressionSync.tasteMap;
              if (impressionSync.changed) {
                savePersistentTasteMap(currentProfileId, activeMap);
              }
              tasteMapRef.current = activeMap;

              setForYouExplanation(activeMap.lastExplanation || '');
              const { displayItems, reasonsMap } = mapRecommendationBatchToDisplayItems(
                restored,
                activeMap,
                targetType
              );
              setForYouReasons(reasonsMap);
              setForYouItems(displayItems);
              lastForYouQueryKeyRef.current = forYouQueryKey;
              setTasteMap(activeMap);
              setCatalogTotalPages(1);
              setCatalogPage(1);
              setForYouProgressStep('');
              setIsLoading(false);
              return;
            }
          }

          // Aynı profil + tür + kategori + platform sorgusu halihazırda 20 öneriyle yüklüyse ve manuel yenileme istenmediyse koru
          if (
            forYouItemsRef.current.length >= TARGET_RECOMMENDATION_COUNT &&
            !forceRefresh &&
            processedEntriesCount >= 400 &&
            lastForYouQueryKeyRef.current === forYouQueryKey
          ) {
            setIsLoading(false);
            return;
          }

          // Hem film hem dizi zevk profillerini kullanıcının geçmişinden hesapla (500 film + 500 dizi tam işleme için)
          const selectTopSeeds = (list: SavedItem[], watchedCap: number, watchlistCap: number) => {
            const watched = list
              .filter(
                (item) =>
                  item.status === 'completed' ||
                  item.status === 'watching' ||
                  Number(item.personal_rating) >= 7
              )
              .sort(
                (a, b) =>
                  Number(b.personal_rating || (b.status === 'completed' ? 7 : 5)) -
                  Number(a.personal_rating || (a.status === 'completed' ? 7 : 5))
              )
              .slice(0, watchedCap);
            const wlist = list
              .filter(
                (item) =>
                  item.status === 'watchlist' &&
                  (item.personal_rating === '' || Number(item.personal_rating) < 7)
              )
              .slice(0, watchlistCap);
            return [...watched, ...wlist];
          };

          const rawMovieSaved = filterHistoryByType(rawSaved, 'movie');
          const rawTvSaved = filterHistoryByType(rawSaved, 'tv');
          const seeds = [
            ...selectTopSeeds(rawMovieSaved, 8, 2),
            ...selectTopSeeds(rawTvSaved, 8, 2),
          ];

          const allDislikedKeys = filterDislikedByType(currentPrefs.disliked, 'all');
          const dislikedSeeds = allDislikedKeys
            .map((key) => {
              const [mediaType, id] = key.split(':');
              if (!/^\d+$/.test(id) || !['movie', 'tv'].includes(mediaType)) return undefined;
              return dislikedItemsRef.current.find(
                (item) => String(item.id) === id && item.media_type === mediaType
              );
            })
            .filter(Boolean)
            .slice(0, 10)
            .map((item) => ({ ...item, status: 'disliked', isDisliked: true }));

          setForYouProgressStep('Zevk profili ve geçmiş sinyalleri analiz ediliyor…');
          const historyCredits = await mapLimit([...seeds, ...dislikedSeeds], 4, async (seed) => {
            try {
              const details = await fetchTmdbCached(
                `/${seed.media_type}/${seed.id}`,
                { append_to_response: 'credits' },
                ticket.signal
              );
              return {
                ...seed,
                overview: seed.overview || details?.overview || '',
                belongs_to_collection: details?.belongs_to_collection || null,
                production_companies: details?.production_companies || [],
                cast: (details?.credits?.cast || []).slice(0, 8),
                crew: (details?.credits?.crew || []).filter(
                  (m: any) => m.job === 'Director' || m.job === 'Creator'
                ),
              };
            } catch {
              return { ...seed, cast: seed.cast || [], crew: seed.crew || [] };
            }
          });
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          const creditsByKey = new Map(
            historyCredits.map((entry) => [makeMediaKey(entry), entry])
          );

          // B-11: Film ve dizi zevk kapsamları tek bir politika fonksiyonundan
          // ayrıştırılır (yalnızca kendi türünün geçmişi, nötr medya tercihi,
          // türü boşsa işaretli soğuk başlangıç). Yerel kopya mantık kaldırıldı.
          const scopedTasteProfiles = buildScopedTasteProfiles(
            [
              ...rawSaved.map((item) => creditsByKey.get(makeMediaKey(item)) || item),
              ...dislikedSeeds.map((item) => creditsByKey.get(makeMediaKey(item)) || item),
            ],
            {
              lambda: 1,
              dislikedKeys: allDislikedKeys,
            }
          );
          const generalTasteProfile = scopedTasteProfiles.general;
          const movieTasteProfile = scopedTasteProfiles.movie;
          const tvTasteProfile = scopedTasteProfiles.tv;

          // FEAT-02 #5: Önce birincil istemci deposu ct:stock'tan aday havuzlarını besle (sıfır ağ maliyeti)
          await Promise.all([
            seedCandidatePoolFromStock(currentProfileId, 'movie', rawSaved, currentPrefs),
            seedCandidatePoolFromStock(currentProfileId, 'tv', rawSaved, currentPrefs),
          ]);
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          // Sunucuda indirilmiş katalog (data/catalog/movies.json & tv.json) varsa yerel havuzları tamamla
          const preMoviePool = loadPersistentPoolData(currentProfileId, 'movie');
          const preTvPool = loadPersistentPoolData(currentProfileId, 'tv');
          if (
            preMoviePool.items.length <= POOL_LOW_WATERMARK ||
            preTvPool.items.length <= POOL_LOW_WATERMARK
          ) {
            const serverCatalog = serverCatalogSnapshot || (await fetchCatalogItems());
            if (!requestGateRef.current.isCurrent(ticket.id)) return;
            if (serverCatalog) {
              if (preMoviePool.items.length <= POOL_LOW_WATERMARK && serverCatalog.movies) {
                const hydratedMovies = hydratePoolFromCatalog(
                  preMoviePool,
                  serverCatalog.movies,
                  rawSaved,
                  currentPrefs
                );
                if (hydratedMovies.addedCount > 0) {
                  savePersistentPoolData(currentProfileId, hydratedMovies.poolData);
                }
              }
              if (preTvPool.items.length <= POOL_LOW_WATERMARK && serverCatalog.tv) {
                const hydratedTv = hydratePoolFromCatalog(
                  preTvPool,
                  serverCatalog.tv,
                  rawSaved,
                  currentPrefs
                );
                if (hydratedTv.addedCount > 0) {
                  savePersistentPoolData(currentProfileId, hydratedTv.poolData);
                }
              }
            }
          }

          const shouldForcePoolForType = (mType: 'movie' | 'tv'): boolean => {
            if (!forceRefresh) return false;
            const existingPool = loadPersistentPoolData(currentProfileId, mType);
            const eligibleNonRing1 = filterOutLastRecommendedCandidates(
              existingPool.items.filter(
                (it) => it.media_type === mType && isCandidateEligibleInPool(it, rawSaved, currentPrefs)
              ),
              storedTasteMap.lastRecommendedKeys
            );
            const ring0Count = eligibleNonRing1.filter((it) => {
              const key = makeMediaKey(it);
              const mapEntry = storedTasteMap.entries?.[key];
              return (
                (it.shownCount || 0) === 0 &&
                (it.skippedCount || 0) === 0 &&
                (mapEntry?.shownCount || 0) === 0 &&
                (mapEntry?.skippedCount || 0) === 0
              );
            }).length;
            return existingPool.items.length <= POOL_LOW_WATERMARK || ring0Count < 60;
          };

          // Her koşuda hem 500 film hem 500 dizi havuzu tam kapasitede tutulur ve kullanıcıya göre işlenir
          setForYouProgressStep('500 film + 500 dizi aday havuzu kullanıcı zevk haritasına göre işleniyor…');
          const [moviePool, tvPool] = await Promise.all([
            replenishCandidatePool({
              profileId: currentProfileId,
              mediaType: 'movie',
              savedItems: rawSaved,
              preferences: currentPrefs,
              favoriteActors: favoriteActorsRef.current,
              fetchTmdbFn: fetchTmdbCached,
              signal: ticket.signal,
              force: shouldForcePoolForType('movie'),
              onProgress: (step: string) => {
                if (requestGateRef.current.isCurrent(ticket.id)) setForYouProgressStep(step);
              },
            }),
            replenishCandidatePool({
              profileId: currentProfileId,
              mediaType: 'tv',
              savedItems: rawSaved,
              preferences: currentPrefs,
              favoriteActors: favoriteActorsRef.current,
              fetchTmdbFn: fetchTmdbCached,
              signal: ticket.signal,
              force: shouldForcePoolForType('tv'),
            }),
          ]);
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          const fullMovieCandidates = moviePool.items.filter(
            (item: any) => item.media_type === 'movie' && isCandidateEligibleInPool(item, rawSaved, currentPrefs)
          );
          const fullTvCandidates = tvPool.items.filter(
            (item: any) => item.media_type === 'tv' && isCandidateEligibleInPool(item, rawSaved, currentPrefs)
          );

          // En güncel Zevk Haritası durumunu al
          const latestDiskMap = loadPersistentTasteMap(currentProfileId);
          const tasteMap =
            tasteMapRef.current &&
            normalizeProfileId(tasteMapRef.current.profileId) === normalizeProfileId(currentProfileId) &&
            (tasteMapRef.current.updatedAt || '') >= (latestDiskMap.updatedAt || '') &&
            (tasteMapRef.current.lastRecommendedKeys?.length || 0) >=
              (latestDiskMap.lastRecommendedKeys?.length || 0)
              ? tasteMapRef.current
              : latestDiskMap;
          const prevRecommendedKeys = tasteMap.lastRecommendedKeys || [];

          // İçerik Zekâsı → öneri: en güçlü geçmiş sinyallerinin sunucudaki
          // anlamsal komşuları sıralamaya gerçek bir bonus olarak katılır.
          const semanticSeedKeys = rawSaved
            .filter((item) => item.status === 'completed' || Number(item.personal_rating) >= 7)
            .slice(0, 6)
            .map((item) => makeMediaKey(item));
          const semanticHints = await loadSemanticRelationHints(semanticSeedKeys, {
            signal: ticket.signal,
          });
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          // Daraltılmış filtrelerde (örn. Sana Özel -> Film -> Fantastik) 20 öneriyi garantilemek için çok sayfalı tamamlama
          let movieCandidates = fullMovieCandidates;
          let tvCandidates = fullTvCandidates;
          const extraCatalogItemsToPersist: PoolCandidateItem[] = [];

          if (isFilteredView || fullMovieCandidates.length < TARGET_RECOMMENDATION_COUNT || fullTvCandidates.length < TARGET_RECOMMENDATION_COUNT) {
            const minNeeded = targetType === 'all' ? 16 : 28;
            if (targetType === 'all' || targetType === 'movie') {
              setForYouProgressStep('Seçili filtrelere uygun film adayları tamamlanıyor…');
              const topUpMovies = await topUpFilteredCandidates({
                profileId: currentProfileId,
                mediaType: 'movie',
                existingCandidates: fullMovieCandidates,
                savedItems: rawSaved,
                preferences: currentPrefs,
                lastRecommendedKeys: prevRecommendedKeys,
                selectedGenre: activeGenre,
                selectedProvider: provider,
                minFreshRequired: minNeeded,
                fetchTmdbFn: fetchTmdbCached,
                signal: ticket.signal,
              });
              movieCandidates = topUpMovies.filteredCandidates;
              extraCatalogItemsToPersist.push(...topUpMovies.newlyDiscovered);
            } else {
              movieCandidates = [];
            }

            if (targetType === 'all' || targetType === 'tv') {
              setForYouProgressStep('Seçili filtrelere uygun dizi adayları tamamlanıyor…');
              const topUpTv = await topUpFilteredCandidates({
                profileId: currentProfileId,
                mediaType: 'tv',
                existingCandidates: fullTvCandidates,
                savedItems: rawSaved,
                preferences: currentPrefs,
                lastRecommendedKeys: prevRecommendedKeys,
                selectedGenre: activeGenre,
                selectedProvider: provider,
                minFreshRequired: minNeeded,
                fetchTmdbFn: fetchTmdbCached,
                signal: ticket.signal,
              });
              tvCandidates = topUpTv.filteredCandidates;
              extraCatalogItemsToPersist.push(...topUpTv.newlyDiscovered);
            } else {
              tvCandidates = [];
            }
          }
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          // İndirilmiş tüm 500 film + 500 dizi (+ filtre keşifleri) kalıcı kataloğa senkronize edilir
          const catalogSyncPayload = [
            ...fullMovieCandidates,
            ...fullTvCandidates,
            ...extraCatalogItemsToPersist,
          ];
          const catalogUpsertPromise = pushCatalogItems(catalogSyncPayload);

          // Tüm 500 film + 500 dizi havuzunu kullanıcının kendi zevk profiline göre puanla
          const allMoviesUnionMap = new Map<string, PoolCandidateItem>();
          for (const m of [...fullMovieCandidates, ...movieCandidates]) {
            allMoviesUnionMap.set(makeMediaKey(m), m);
          }
          const allTvUnionMap = new Map<string, PoolCandidateItem>();
          for (const t of [...fullTvCandidates, ...tvCandidates]) {
            allTvUnionMap.set(makeMediaKey(t), t);
          }

          // Tek öneri hattı: havuz puanlama + zenginleştirme kısa listesi.
          const poolScoreBase = {
            savedItems: rawSaved,
            preferences: currentPrefs,
            genresMap: currentGenres,
            tasteMap,
            isFilteredView,
            serverTaste: serverTasteRef.current,
            semanticHints,
          };
          const moviePoolScore = scoreRecommendationPool({
            ...poolScoreBase,
            candidates: Array.from(allMoviesUnionMap.values()),
            activeCandidates: movieCandidates,
            profile: movieTasteProfile,
            targetType: 'movie',
            shortlistSize: targetType === 'all' ? 24 : 40,
          });
          const tvPoolScore = scoreRecommendationPool({
            ...poolScoreBase,
            candidates: Array.from(allTvUnionMap.values()),
            activeCandidates: tvCandidates,
            profile: tvTasteProfile,
            targetType: 'tv',
            shortlistSize: targetType === 'all' ? 24 : 40,
          });

          const fullMovieScored = moviePoolScore.scored;
          const fullTvScored = tvPoolScore.scored;
          const movieScored = fullMovieScored;
          const tvScored = fullTvScored;
          const movieShortlist = moviePoolScore.shortlist;
          const tvShortlist = tvPoolScore.shortlist;
          const shortlist: any[] =
            targetType === 'movie'
              ? movieShortlist
              : targetType === 'tv'
              ? tvShortlist
              : [...movieShortlist, ...tvShortlist];

          setForYouProgressStep('Öne çıkan adayların kadro ve hikâye sinyalleri zenginleştiriliyor…');
          const shortlistTopCast: Record<string, number[]> = {};
          await mapLimit(shortlist, 5, async (entry) => {
            try {
              const details = await fetchTmdbCached(
                `/${entry.candidate.media_type}/${entry.candidate.id}`,
                { append_to_response: 'credits' },
                ticket.signal
              );
              const castSlice = (details?.credits?.cast || []).slice(0, 8);
              const top3Ids = castSlice
                .slice(0, 3)
                .map((c: any) => Number(c?.id))
                .filter((n: number) => Number.isInteger(n) && n > 0);
              if (top3Ids.length > 0) {
                shortlistTopCast[makeMediaKey(entry.candidate)] = top3Ids;
              }
              Object.assign(entry.candidate, {
                overview: entry.candidate.overview || details?.overview || '',
                belongs_to_collection: details?.belongs_to_collection || null,
                production_companies: details?.production_companies || [],
                cast: castSlice,
                crew: (details?.credits?.crew || []).filter(
                  (m: any) => m.job === 'Director' || m.job === 'Creator'
                ),
              });
            } catch {}
          });
          if (Object.keys(shortlistTopCast).length > 0) {
            void enrichStockItemsTopCast(shortlistTopCast);
          }
          if (!requestGateRef.current.isCurrent(ticket.id)) return;

          // Zenginleştirilmiş adayları aynı motorla yeniden puanla; seçim ve
          // gerekçeler tek hattan (`selectRecommendationBatch`) gelir.
          const rescoreBase = {
            savedItems: rawSaved,
            preferences: currentPrefs,
            genresMap: currentGenres,
            tasteMap,
            serverTaste: serverTasteRef.current,
            semanticHints,
          };
          const enrichedMovieScored = rescoreShortlist({
            ...rescoreBase,
            shortlist: movieShortlist,
            profile: movieTasteProfile,
          });
          const enrichedTvScored = rescoreShortlist({
            ...rescoreBase,
            shortlist: tvShortlist,
            profile: tvTasteProfile,
          });

          const movieShortlistKeys = new Set(movieShortlist.map((e) => makeMediaKey(e.candidate)));
          const tvShortlistKeys = new Set(tvShortlist.map((e) => makeMediaKey(e.candidate)));
          const remainingMovieScored = filterOutLastRecommendedCandidates(movieScored, prevRecommendedKeys).filter(
            (entry) =>
              !movieShortlistKeys.has(makeMediaKey(entry.candidate)) &&
              isCandidateEligibleInPool(entry.candidate, rawSaved, currentPrefs)
          );
          const remainingTvScored = filterOutLastRecommendedCandidates(tvScored, prevRecommendedKeys).filter(
            (entry) =>
              !tvShortlistKeys.has(makeMediaKey(entry.candidate)) &&
              isCandidateEligibleInPool(entry.candidate, rawSaved, currentPrefs)
          );

          const selection = selectRecommendationBatch({
            targetType,
            isFilteredView,
            tasteMap,
            lastRecommendedKeys: prevRecommendedKeys,
            savedItems: rawSaved,
            preferences: currentPrefs,
            enrichedMovies: enrichedMovieScored,
            enrichedTv: enrichedTvScored,
            remainingMovies: remainingMovieScored,
            remainingTv: remainingTvScored,
            targetTotal: TARGET_RECOMMENDATION_COUNT,
          });

          const picked = selection.picked;
          const explanationText = selection.explanation;
          setForYouExplanation(explanationText);

          // Tam 500 film + 500 dizi kullanıcı puanlarını tek bir haritada birleştir (hiçbir filtre havuz kayıtlarını silmez!)
          const fullPoolScoredMap = new Map<string, any>();
          for (const entry of [...fullMovieScored, ...fullTvScored, ...enrichedMovieScored, ...enrichedTvScored]) {
            fullPoolScoredMap.set(makeMediaKey(entry.candidate || entry), entry);
          }
          const allPoolCandidates = Array.from(fullPoolScoredMap.values());

          const summaryProfile =
            targetType === 'movie'
              ? movieTasteProfile
              : targetType === 'tv'
              ? tvTasteProfile
              : generalTasteProfile;
          const tasteSummary = buildTasteProfileSummary(summaryProfile, tasteMap, currentGenres);

          const updatedTasteMap = updateTasteMapWithBatch({
            tasteMap,
            newRecommendedItems: picked,
            allPoolCandidates,
            savedItems: rawSaved,
            preferences: currentPrefs,
            favoriteActors: favoriteActorsRef.current,
            profileSignature: currentSig,
            targetType,
            explanation: explanationText,
            summary: tasteSummary,
            isFilterChange: isFilterTriggeredRun,
            isFilteredView,
            pruneInactiveCandidates: !isFilteredView,
            normalizeLegacyRings: true,
          });
          savePersistentTasteMap(currentProfileId, updatedTasteMap);
          tasteMapRef.current = updatedTasteMap;
          setTasteMap(updatedTasteMap);

          // Kullanıcının işlenmiş 500+500 Zevk Haritası verisini (signals + reasons + katalog özetiyle) sunucudaki data/profiles/<profileId>.json dosyasına yaz
          const localCatalogSignature = computeSourceCatalogSignature(catalogSyncPayload);
          void catalogUpsertPromise.then((catalogRes) => {
            const effectiveCatalogHash =
              typeof catalogRes?.contentHash === 'string' && catalogRes.contentHash
                ? catalogRes.contentHash
                : localCatalogSignature;
            const derivedPayload = buildDerivedProfilePayloadFromTasteMap({
              profileId: currentProfileId,
              tasteMap: updatedTasteMap,
              profileFingerprint: currentSig,
              algorithmVersion: ALGORITHM_VERSION,
              sourceCatalogHash: effectiveCatalogHash,
            });
            return pushDerivedProfileData(derivedPayload);
          });

          const { displayItems, reasonsMap } = mapRecommendationBatchToDisplayItems(
            picked,
            updatedTasteMap,
            targetType
          );

          setForYouReasons(reasonsMap);
          setForYouItems(displayItems);
          lastForYouQueryKeyRef.current = forYouQueryKey;
          setCatalogTotalPages(1);
          setCatalogPage(1);
          setForYouProgressStep('');
          if (forceRefresh) showToast(explanationText);
          return;
        }

        // Diğer Keşfet kategorileri (Gündemdekiler, Yüksek Puanlılar, Gizli Cevherler, Yakında, Platform):
        // 'Listemdekileri Gizle' veya beğenilmeyenler nedeniyle sonuç 20'nin altına düşerse sonraki sayfalardan 20'ye tamamla
        const firstPage = await fetchDiscoverPageByCategory(p);
        if (!requestGateRef.current.isCurrent(ticket.id)) return;

        const combinedRawItems = [...firstPage.rawItems];
        const totalPages = firstPage.totalPages;
        let effectiveLastPage = p;

        if (!append) {
          const seenKeys = new Set(combinedRawItems.map((it) => makeMediaKey(it)));
          const shouldHideListed =
            hideListedItemsRef.current &&
            (HIDE_LISTED_CATEGORIES as readonly string[]).includes(cat);

          const countVisibleItems = (list: any[]) =>
            list.filter((it) => {
              const mType = it.media_type || (it.title ? 'movie' : 'tv');
              const k = makeMediaKey(mType, it.id);
              if (preferencesRef.current.disliked.includes(k)) return false;
              if (preferencesRef.current.hidden?.includes(k)) return false;
              if (targetType !== 'all' && mType !== targetType) return false;
              if (activeGenre && !matchesSelectedGenre(it, activeGenre)) return false;
              if (
                shouldHideListed &&
                filterHiddenUserRegisteredItems([it], {
                  savedItems: savedItemsRef.current,
                  preferences: preferencesRef.current,
                  tasteMap: tasteMapRef.current,
                  hideListedItems: true,
                }).length === 0
              ) {
                return false;
              }
              return true;
            }).length;

          let extraScans = 0;
          while (
            cat !== 'stock' &&
            countVisibleItems(combinedRawItems) < TARGET_RECOMMENDATION_COUNT &&
            effectiveLastPage < totalPages &&
            extraScans < 5
          ) {
            extraScans += 1;
            effectiveLastPage += 1;
            const nextRes = await fetchDiscoverPageByCategory(effectiveLastPage);
            if (!requestGateRef.current.isCurrent(ticket.id)) return;
            for (const item of nextRes.rawItems) {
              const k = makeMediaKey(item);
              if (!seenKeys.has(k)) {
                seenKeys.add(k);
                combinedRawItems.push(item);
              }
            }
          }
        }

        const enriched = await applyDiscoverSemanticOrdering(
          cat,
          enrichItemsWithPersonalizedTaste(combinedRawItems)
        );

        if (cat === 'trending' && !append && enriched[0]) {
          setTrendingTop(enriched[0]);
        }
        setCatalogItems((prev) => {
          if (!append) return enriched;
          const seen = new Set(prev.map((it) => makeMediaKey(it.media_type || (it.title ? 'movie' : 'tv'), it.id)));
          const fresh = enriched.filter((it) => {
            const k = makeMediaKey(it.media_type || (it.title ? 'movie' : 'tv'), it.id);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          return [...prev, ...fresh];
        });
        setCatalogTotalPages(totalPages);
        setCatalogPage(effectiveLastPage);
      } catch (err: any) {
        if (!ticket.signal.aborted) {
          console.warn('Catalog load error:', err.message);
          if (forceRefresh) showToast('Öneriler yenilenemedi. Lütfen tekrar deneyin.');
          if (!append) setCatalogItems([]);
        }
      } finally {
        if (requestGateRef.current.isCurrent(ticket.id)) {
          setForYouProgressStep('');
          setIsLoading(false);
          setLoadingMore(false);
        }
      }
  };
  return loadCategoryResults;
}
