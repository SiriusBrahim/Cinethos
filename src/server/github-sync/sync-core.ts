import { normalizeProfileId } from '../../core/profile-id.ts';
import {
  ALGORITHM_VERSION,
  buildTasteProfileV3,
  computeTasteProfileSignature,
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  inferLifecycleRing,
  isItemSaved,
  makeMediaKey,
  normalizeDataDocument,
  normalizeDeletedKeys,
  RECOMMENDATION_WEIGHTS_V3,
  scoreCandidatesV3,
  validItemId,
  type DataDocument,
  type Profile,
} from '../../core/cinetrack-core.ts';
import {
  reconcileUserDataDocumentsLossless,
} from '../../core/user-data-merge.ts';
import {
  buildCinemaKunyeCanonicalPayload,
  
  normalizeCinemaKunyeDocument,
  type CinemaKunyeDocument,
} from '../../core/cinema-kunye.ts';
import { canonicalizeMediaKey, canonicalizeMediaKeyList } from '../../core/keys.ts';
import {  formatMaxDataLimitMb, measureUtf8Bytes } from '../../core/limits.ts';
import {
  computeDerivedProfileContentHash,
  DERIVED_PROFILE_SCHEMA_VERSION,
  normalizeDerivedProfileItem,
} from '../../core/derived-profile-cache.ts';
import type {
  BidirectionalSyncReport,
  
  SyncComparisonSummary,
  SyncErrorCategory,
  SyncErrorRecord,
  SyncFileCategory,
  SyncFileDiffDetail,
  SyncFileInspection,
  
  SyncSideSummary,
  UserDataConflictItem,
} from '../../core/sync-display.ts';
import { hashContent,   stringifyDeterministic, toCanonicalKey } from '../persistent-store-utils.ts';
import type { CatalogManifest, CatalogRecord, DerivedProfileDocument, DerivedProfileItem } from '../persistent-store-types.ts';
import type { PersistentDataStoreSyncPort } from '../persistent-store-types.ts';
import type { createDataStorage } from '../storage.ts';

/**
 * Senkronize edilen kalıcı veri envanteri:
 * 1. data/catalog/movies.json   -> Ortak film metaverileri (`movie:<id>`), özel depoda varsayılan; açık depoda yalnızca `CINETRACK_ALLOW_PUBLIC_CATALOG_SYNC=true` ile senkronize edilir.
 * 2. data/catalog/tv.json       -> Ortak dizi metaverileri (`tv:<id>`), özel depoda varsayılan; açık depoda yalnızca `CINETRACK_ALLOW_PUBLIC_CATALOG_SYNC=true` ile senkronize edilir.
 * 3. data/catalog/manifest.json -> Katalog sayım ve içerik hash özeti, özel depoda varsayılan; açık depoda yalnızca `CINETRACK_ALLOW_PUBLIC_CATALOG_SYNC=true` ile senkronize edilir.
 * 4. data/cinetrack-data.json   -> Kullanıcı profilleri, izleme listeleri, puanlar ve tercihler (yalnızca özel depoda; açık depoda `CINETRACK_ALLOW_PUBLIC_PERSONAL_SYNC=true` gerekir).
 * 5. data/profiles/*.json       -> Profil bazlı türetilmiş öneri puanları ve halkaları (yalnızca özel depoda; açık depoda `CINETRACK_ALLOW_PUBLIC_PERSONAL_SYNC=true` gerekir).
 *
 * Geçici önbellekler, `.bak`, `data/backups/*`, `data/sync-state.json`, `.tmp`, `.corrupt.*`,
 * `.env` ve derleme çıktıları envantere kesinlikle dahil edilmez.
 */

export const SYNC_STATIC_INVENTORY: ReadonlyArray<{
  repoPath: string;
  category: SyncFileCategory;
  personal: boolean;
  description: string;
}> = Object.freeze([
  {
    repoPath: 'data/catalog/movies.json',
    category: 'catalog_movies',
    personal: false,
    description: 'Ortak film kataloğu metaverileri (movie:<id>)',
  },
  {
    repoPath: 'data/catalog/tv.json',
    category: 'catalog_tv',
    personal: false,
    description: 'Ortak dizi kataloğu metaverileri (tv:<id>)',
  },
  {
    repoPath: 'data/catalog/manifest.json',
    category: 'catalog_manifest',
    personal: false,
    description: 'Katalog film/dizi sayıları ve içerik özeti doğrulaması',
  },
  {
    repoPath: 'data/cinetrack-data.json',
    category: 'user_data',
    personal: true,
    description: 'Kullanıcı profilleri, izleme listeleri, puanlar, tercihler ve favori oyuncular',
  },
  // Faz 6: Taste Engine — varsayılan olarak yalnızca manifest + profile senkrona girer (TP-006)
  // index ve events boyut nedeniyle dışarıda kalır
  {
    repoPath: 'data/taste/cinetrack-taste-manifest.json',
    category: 'taste_manifest',
    personal: true,
    description: 'Taste Engine veri özeti ve versiyon bilgisi',
  },
  {
    repoPath: 'data/taste/cinetrack-taste-profile.json',
    category: 'taste_profile',
    personal: true,
    description: 'Kullanıcı Taste Engine profili ve metrikler',
  },
  {
    repoPath: 'data/stock.json',
    category: 'stock',
    personal: true,
    description: 'Stok içerik deposu (film + dizi, sınırsız ve media:key tekilleştirmeli)',
  },
  {
    repoPath: 'data/sinema-kunyesi.json',
    category: 'cinema_kunye',
    personal: true,
    description: 'Sinema Künyesi izlenen içerik tür/yıl/oyuncu metaverileri (içerik ID anahtarlı)',
  },
]);

export function isPlainObject(val: unknown): val is Record<string, any> {
  return Boolean(val && typeof val === 'object' && !Array.isArray(val));
}

export function computeRawUtf8Hash(rawContent: string): string {
  return hashContent(rawContent);
}

export function classifyGitHubHttpStatus(
  status: number,
  headers: Headers,
  bodyMessage: string
): SyncErrorCategory {
  const remaining = headers.get('x-ratelimit-remaining');
  const lower = (bodyMessage || '').toLowerCase();
  if (
    status === 429 ||
    (status === 403 && (remaining === '0' || lower.includes('rate limit') || lower.includes('secondary rate')))
  ) {
    return 'rate_limit';
  }
  if (status === 401 || status === 403) {
    return 'auth_error';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 409) {
    return 'conflict';
  }
  return 'http_error';
}

export function normalizeCatalogRecordStrict(
  rawKey: string,
  rawVal: any,
  expectedType: 'movie' | 'tv'
): CatalogRecord | null {
  if (!isPlainObject(rawVal)) return null;
  const parsedKeyMatch = /^((?:movie|tv)):(\d+)$/.exec(String(rawKey || '').trim());
  const rawId = Number(rawVal.id ?? (parsedKeyMatch ? parsedKeyMatch[2] : NaN));
  if (!Number.isSafeInteger(rawId) || rawId <= 0) return null;

  const itemType =
    rawVal.media_type === 'tv' || rawVal.media_type === 'movie'
      ? rawVal.media_type
      : parsedKeyMatch
      ? (parsedKeyMatch[1] as 'movie' | 'tv')
      : expectedType;

  if (itemType !== expectedType) return null;

  const key = `${expectedType}:${rawId}`;
  const title = String(rawVal.title || rawVal.name || '').trim();
  if (!title) return null;

  const originalTitle = String(rawVal.original_title || rawVal.original_name || '').trim();
  const overview = typeof rawVal.overview === 'string' ? rawVal.overview.trim() : '';
  const genreSet = new Set<number>();
  if (Array.isArray(rawVal.genre_ids)) {
    for (const g of rawVal.genre_ids) {
      if (Number.isSafeInteger(g) && g > 0) genreSet.add(g);
    }
  }

  const voteAverage = Number.isFinite(Number(rawVal.vote_average)) ? Number(rawVal.vote_average) : 0;
  const voteCount =
    Number.isSafeInteger(Number(rawVal.vote_count)) && Number(rawVal.vote_count) > 0
      ? Number(rawVal.vote_count)
      : undefined;
  const popularity = Number.isFinite(Number(rawVal.popularity))
    ? Number(rawVal.popularity)
    : undefined;

  const releaseDate =
    typeof rawVal.release_date === 'string' && rawVal.release_date.trim()
      ? rawVal.release_date.trim()
      : undefined;
  const firstAirDate =
    expectedType === 'tv' && typeof rawVal.first_air_date === 'string' && rawVal.first_air_date.trim()
      ? rawVal.first_air_date.trim()
      : undefined;

  const firstStoredAt =
    typeof rawVal.firstStoredAt === 'string' && rawVal.firstStoredAt.trim()
      ? rawVal.firstStoredAt.trim()
      : '1970-01-01T00:00:00.000Z';
  const lastUpdatedAt =
    typeof rawVal.lastUpdatedAt === 'string' && rawVal.lastUpdatedAt.trim()
      ? rawVal.lastUpdatedAt.trim()
      : firstStoredAt;

  return {
    key,
    id: rawId,
    media_type: expectedType,
    title,
    original_title: originalTitle || undefined,
    overview: overview || undefined,
    poster_path: rawVal.poster_path ?? null,
    backdrop_path: rawVal.backdrop_path ?? null,
    genre_ids: Array.from(genreSet).sort((a, b) => a - b),
    vote_average: voteAverage,
    vote_count: voteCount,
    release_date: releaseDate,
    first_air_date: firstAirDate,
    popularity,
    firstStoredAt,
    lastUpdatedAt,
    source: rawVal.source === 'demo' ? 'demo' : 'tmdb',
  };
}

/**
 * İki katalog kaydını hiçbir dolu alanı (poster, özet, türler, oy sayısı) kaybetmeden
 * deterministik biçimde birleştirir.
 */
export function mergeCatalogRecordsLossless(
  localRec: CatalogRecord,
  remoteRec: CatalogRecord
): CatalogRecord {
  const localTs = localRec.lastUpdatedAt || localRec.firstStoredAt || '';
  const remoteTs = remoteRec.lastUpdatedAt || remoteRec.firstStoredAt || '';
  const remoteIsNewer = remoteTs > localTs;

  const pickString = (a?: string, b?: string): string => {
    const sa = (a || '').trim();
    const sb = (b || '').trim();
    if (sa && !sb) return sa;
    if (sb && !sa) return sb;
    if (!sa && !sb) return '';
    if (sa === sb) return sa;
    return remoteIsNewer ? sb : sa;
  };

  // Özet alanında daha zengin (boş olmayan ve daha kapsamlı) açıklamayı koru
  const pickRicherOverview = (a?: string, b?: string): string | undefined => {
    const sa = (a || '').trim();
    const sb = (b || '').trim();
    if (sa && !sb) return sa;
    if (sb && !sa) return sb;
    if (!sa && !sb) return undefined;
    if (sb.length > sa.length) return sb;
    if (sa.length > sb.length) return sa;
    return remoteIsNewer ? sb : sa;
  };

  const pickNullablePath = (a?: string | null, b?: string | null): string | null => {
    const sa = typeof a === 'string' && a.trim() ? a.trim() : null;
    const sb = typeof b === 'string' && b.trim() ? b.trim() : null;
    if (sa && !sb) return sa;
    if (sb && !sa) return sb;
    if (!sa && !sb) return null;
    return remoteIsNewer ? sb : sa;
  };

  const genreSet = new Set<number>([...(localRec.genre_ids || []), ...(remoteRec.genre_ids || [])]);
  const genreIds = Array.from(genreSet)
    .filter((g) => Number.isSafeInteger(g) && g > 0)
    .sort((a, b) => a - b);

  const localVotes = localRec.vote_count || 0;
  const remoteVotes = remoteRec.vote_count || 0;
  const voteCount = Math.max(localVotes, remoteVotes) || undefined;

  let voteAverage = 0;
  if ((localRec.vote_average || 0) > 0 && !(remoteRec.vote_average > 0)) {
    voteAverage = localRec.vote_average;
  } else if ((remoteRec.vote_average || 0) > 0 && !(localRec.vote_average > 0)) {
    voteAverage = remoteRec.vote_average;
  } else if (remoteVotes > localVotes) {
    voteAverage = remoteRec.vote_average;
  } else if (localVotes > remoteVotes) {
    voteAverage = localRec.vote_average;
  } else {
    voteAverage = remoteIsNewer ? remoteRec.vote_average : localRec.vote_average;
  }

  let popularity: number | undefined;
  const popA = localRec.popularity;
  const popB = remoteRec.popularity;
  if (Number.isFinite(popA) && Number.isFinite(popB)) {
    popularity = remoteIsNewer ? popB : popA;
  } else if (Number.isFinite(popA)) {
    popularity = popA;
  } else if (Number.isFinite(popB)) {
    popularity = popB;
  }

  const validFirstDates = [localRec.firstStoredAt, remoteRec.firstStoredAt]
    .filter((d): d is string => Boolean(d && d !== '1970-01-01T00:00:00.000Z'))
    .sort();
  const firstStoredAt =
    validFirstDates[0] || localRec.firstStoredAt || remoteRec.firstStoredAt || '1970-01-01T00:00:00.000Z';

  const validLastDates = [localRec.lastUpdatedAt, remoteRec.lastUpdatedAt]
    .filter((d): d is string => Boolean(d))
    .sort();
  const lastUpdatedAt =
    validLastDates[validLastDates.length - 1] || firstStoredAt;

  const originalTitle = pickString(localRec.original_title, remoteRec.original_title);
  const releaseDate = pickString(localRec.release_date, remoteRec.release_date);
  const firstAirDate =
    localRec.media_type === 'tv'
      ? pickString(localRec.first_air_date, remoteRec.first_air_date) || releaseDate || undefined
      : undefined;

  return {
    key: localRec.key,
    id: localRec.id,
    media_type: localRec.media_type,
    title: pickString(localRec.title, remoteRec.title),
    original_title: originalTitle || undefined,
    overview: pickRicherOverview(localRec.overview, remoteRec.overview),
    poster_path: pickNullablePath(localRec.poster_path, remoteRec.poster_path),
    backdrop_path: pickNullablePath(localRec.backdrop_path, remoteRec.backdrop_path),
    genre_ids: genreIds,
    vote_average: voteAverage,
    vote_count: voteCount,
    release_date: releaseDate || undefined,
    first_air_date: firstAirDate,
    popularity,
    firstStoredAt,
    lastUpdatedAt,
    source: localRec.source === 'tmdb' || remoteRec.source === 'tmdb' ? 'tmdb' : 'demo',
  };
}

export function stripCatalogVolatileFields(map: Record<string, CatalogRecord>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of Object.keys(map).sort((a, b) => a.localeCompare(b))) {
    const rec = map[key];
    if (!rec) continue;
    out[key] = {
      ...rec,
      firstStoredAt: '',
      lastUpdatedAt: '',
    };
  }
  return out;
}

export function computeCatalogSemanticMapHash(map: Record<string, CatalogRecord>): string {
  return hashContent(stringifyDeterministic(stripCatalogVolatileFields(map)));
}

export function computeCatalogManifestContentHash(
  movies: Record<string, CatalogRecord>,
  tv: Record<string, CatalogRecord>
): string {
  return hashContent(stringifyDeterministic(movies) + stringifyDeterministic(tv));
}

export function mergeCatalogMapsLossless(
  localMap: Record<string, CatalogRecord>,
  remoteMap: Record<string, CatalogRecord>,
  expectedType: 'movie' | 'tv'
): {
  merged: Record<string, CatalogRecord>;
  addedToLocal: number;
  addedToRemote: number;
  updatedLocal: number;
  updatedRemote: number;
  unchanged: number;
} {
  const merged: Record<string, CatalogRecord> = {};
  const allKeys = new Set<string>([...Object.keys(localMap), ...Object.keys(remoteMap)]);
  const sortedKeys = Array.from(allKeys).sort((a, b) => a.localeCompare(b));

  let addedToLocal = 0;
  let addedToRemote = 0;
  let updatedLocal = 0;
  let updatedRemote = 0;
  let unchanged = 0;

  for (const rawKey of sortedKeys) {
    const localRec = localMap[rawKey]
      ? normalizeCatalogRecordStrict(rawKey, localMap[rawKey], expectedType)
      : null;
    const remoteRec = remoteMap[rawKey]
      ? normalizeCatalogRecordStrict(rawKey, remoteMap[rawKey], expectedType)
      : null;

    if (localRec && !remoteRec) {
      merged[localRec.key] = localRec;
      addedToRemote++;
      continue;
    }
    if (remoteRec && !localRec) {
      merged[remoteRec.key] = remoteRec;
      addedToLocal++;
      continue;
    }
    if (!localRec || !remoteRec) continue;

    const combined = mergeCatalogRecordsLossless(localRec, remoteRec);
    merged[combined.key] = combined;

    const localSem = stringifyDeterministic({ ...localRec, firstStoredAt: '', lastUpdatedAt: '' });
    const remoteSem = stringifyDeterministic({ ...remoteRec, firstStoredAt: '', lastUpdatedAt: '' });
    const combSem = stringifyDeterministic({ ...combined, firstStoredAt: '', lastUpdatedAt: '' });

    const localDiff = localSem !== combSem;
    const remoteDiff = remoteSem !== combSem;
    if (!localDiff && !remoteDiff) {
      unchanged++;
    } else {
      if (localDiff) updatedLocal++;
      if (remoteDiff) updatedRemote++;
    }
  }

  return { merged, addedToLocal, addedToRemote, updatedLocal, updatedRemote, unchanged };
}

export function stripUserDataVolatileFields(doc: DataDocument): Record<string, any> {
  const profiles = [...(doc.profiles || [])]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((p) => {
      const items = [...(p.items || [])]
        .map((it) => {
          const key = makeMediaKey(it);
          return {
            key,
            id: it.id,
            media_type: it.media_type,
            title: it.title,
            status: it.status,
            personal_rating: it.personal_rating === '' ? '' : Number(it.personal_rating),
            personal_rating_cleared: Boolean(it.personal_rating_cleared),
            status_changed_at: it.status_changed_at || '',
            rating_changed_at: it.rating_changed_at || '',
            season_progress: it.season_progress || {},
            season_episode_counts: it.season_episode_counts || {},
            genre_ids: [...(it.genre_ids || [])].sort((a, b) => a - b),
            overview: it.overview || '',
            poster_path: it.poster_path || '',
            backdrop_path: it.backdrop_path || '',
            isDemo: Boolean(it.isDemo),
          };
        })
        .sort((a, b) => a.key.localeCompare(b.key));

      const prefs = p.preferences || {
        disliked: [],
        providers: [],
        mood: '',
        reminders: false,
        notified: [],
      };
      const normalizedTombstones = normalizeDeletedKeys(p.deleted_keys);
      return {
        id: p.id,
        name: p.name,
        isDemo: Boolean(p.isDemo),
        preferences: {
          disliked: canonicalizeMediaKeyList(prefs.disliked || []).sort(),
          hidden: canonicalizeMediaKeyList(prefs.hidden || []).sort(),
          providers: [...(prefs.providers || [])].map(String).sort(),
          mood: prefs.mood || '',
          reminders: Boolean(prefs.reminders),
        },
        favoriteActors: [...(p.favoriteActors || [])]
          .map((a) => ({ id: a.id, name: a.name, profile_path: a.profile_path ?? null }))
          .sort((a, b) => a.id - b.id),
        ...(Object.keys(normalizedTombstones).length > 0
          ? { deleted_keys: normalizedTombstones }
          : {}),
        items,
      };
    });

  return {
    version: 3,
    schemaVersion: doc.schemaVersion || CURRENT_SCHEMA_VERSION,
    activeProfileId: doc.activeProfileId,
    profiles,
  };
}

export function computeUserDataSemanticHash(doc: DataDocument): string {
  return hashContent(stringifyDeterministic(stripUserDataVolatileFields(doc)));
}

/**
 * Kaynak profil ve katalogdan sunucu tarafında güncel türetilmiş profil belgesi üretir.
 * Eski/geçersiz profil önbellekleri yenilendiğinde kullanılır.
 */
export function buildFreshDerivedProfileDocumentOnServer(
  profile: Profile,
  movies: Record<string, CatalogRecord>,
  tv: Record<string, CatalogRecord>,
  sourceCatalogHash: string
): DerivedProfileDocument {
  const savedItems = profile.items || [];
  const preferences = profile.preferences || {
    disliked: [],
    providers: [],
    mood: '',
    reminders: false,
    notified: [],
  };
  const favoriteActors = profile.favoriteActors || [];
  const fingerprint = computeTasteProfileSignature(savedItems, preferences, favoriteActors, {
    targetType: 'all',
    algorithmVersion: ALGORITHM_VERSION,
  });

  const candidates: CatalogRecord[] = [...Object.values(movies), ...Object.values(tv)];
  const tasteProfile = buildTasteProfileV3(savedItems, {
    dislikedKeys: preferences.disliked || [],
  });
  const scored = scoreCandidatesV3(candidates, tasteProfile, {
    weights: RECOMMENDATION_WEIGHTS_V3,
    mood: preferences.mood || '',
  });

  const nowIso = new Date().toISOString();
  const items: Record<string, DerivedProfileItem> = {};

  for (const s of scored) {
    const cand = s.candidate || s;
    const key = toCanonicalKey(cand);
    if (!key) continue;
    const tasteScore = Math.max(
      1,
      Math.min(100, Math.round(Number(s.tasteScore ?? s.score ?? 50)))
    );
    const saved = isItemSaved(savedItems, cand, cand.media_type);
    const disliked = Boolean(
      preferences.disliked?.some((k) => canonicalizeMediaKey(k) === key)
    );
    const hidden = Boolean(
      preferences.hidden?.some((k) => canonicalizeMediaKey(k) === key)
    );
    const status: DerivedProfileItem['status'] = saved
      ? 'saved'
      : disliked
      ? 'disliked'
      : hidden
      ? 'hidden'
      : 'active';

    const normalized = normalizeDerivedProfileItem(key, {
      mediaKey: key,
      matchScore: tasteScore,
      tasteScore,
      priorityScore: tasteScore,
      lifecycleRing: inferLifecycleRing(key, { shownCount: 0, skippedCount: 0 }, []),
      signals: s.parts && Object.keys(s.parts).length > 0 ? s.parts : undefined,
      reasons: Array.isArray(s.tags) && s.tags.length > 0 ? s.tags : undefined,
      shownCount: 0,
      skippedCount: 0,
      demotionPenalty: 0,
      status,
      scoreCoverage: 'basic',
      calculatedAt: nowIso,
    });
    if (normalized) {
      items[key] = normalized;
    }
  }

  const contentHash = computeDerivedProfileContentHash({
    schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
    profileId: profile.id,
    algorithmVersion: ALGORITHM_VERSION,
    profileFingerprint: fingerprint,
    sourceCatalogHash,
    items,
  });

  return {
    schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
    profileId: profile.id,
    algorithmVersion: ALGORITHM_VERSION,
    profileFingerprint: fingerprint,
    sourceCatalogHash,
    contentHash,
    generatedAt: nowIso,
    items,
  };
}

export function inspectCatalogRawContent(
  repoPath: string,
  rawText: string,
  expectedType: 'movie' | 'tv',
  maxBytes: number,
  sha?: string
): {
  inspection: SyncFileInspection;
  parsedMap?: Record<string, CatalogRecord>;
} {
  const category: SyncFileCategory =
    expectedType === 'movie' ? 'catalog_movies' : 'catalog_tv';
  const sizeBytes = measureUtf8Bytes(rawText);
  if (sizeBytes > maxBytes) {
    return {
      inspection: {
        repoPath,
        category,
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Dosya boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxBytes)}) aşıyor.`,
        errorCategory: 'payload_too_large',
      },
    };
  }

  let rawParsed: any;
  try {
    rawParsed = JSON.parse(rawText);
  } catch (err: any) {
    return {
      inspection: {
        repoPath,
        category,
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Geçersiz JSON: ${err?.message || 'ayrıştırılamadı'}`,
        errorCategory: 'corrupt_remote_json',
      },
    };
  }

  if (!isPlainObject(rawParsed)) {
    return {
      inspection: {
        repoPath,
        category,
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'Katalog dosyası nesne (key-value map) şemasında değil.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const entries = Object.entries(rawParsed);
  const normalizedMap: Record<string, CatalogRecord> = {};
  for (const [k, v] of entries) {
    const rec = normalizeCatalogRecordStrict(k, v, expectedType);
    if (!rec) {
      return {
        inspection: {
          repoPath,
          category,
          personal: false,
          exists: true,
          valid: false,
          sizeBytes,
          rawFileHash: computeRawUtf8Hash(rawText),
          semanticHash: null,
          recordCount: entries.length,
          uniqueKeyCount: 0,
          sha,
          error: `Katalogda geçersiz veya farklı medya tipinde kayıt bulundu (${k}).`,
          errorCategory: 'schema_mismatch',
        },
      };
    }
    normalizedMap[rec.key] = rec;
  }

  const semanticHash = computeCatalogSemanticMapHash(normalizedMap);
  return {
    inspection: {
      repoPath,
      category,
      personal: false,
      exists: true,
      valid: true,
      sizeBytes,
      rawFileHash: computeRawUtf8Hash(rawText),
      semanticHash,
      recordCount: entries.length,
      uniqueKeyCount: Object.keys(normalizedMap).length,
      sha,
    },
    parsedMap: normalizedMap,
  };
}

export function inspectManifestRawContent(
  rawText: string,
  actualMovies: Record<string, CatalogRecord>,
  actualTv: Record<string, CatalogRecord>,
  maxBytes: number,
  sha?: string
): {
  inspection: SyncFileInspection;
  manifest?: CatalogManifest;
  manifestConsistent: boolean;
  mismatchReason?: string;
} {
  const repoPath = 'data/catalog/manifest.json';
  const sizeBytes = measureUtf8Bytes(rawText);
  if (sizeBytes > maxBytes) {
    return {
      manifestConsistent: false,
      mismatchReason: 'Boyut sınırı aşıldı',
      inspection: {
        repoPath,
        category: 'catalog_manifest',
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'Manifest boyutu sınırı aşıyor.',
        errorCategory: 'payload_too_large',
      },
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: any) {
    return {
      manifestConsistent: false,
      mismatchReason: 'Manifest JSON bozuk',
      inspection: {
        repoPath,
        category: 'catalog_manifest',
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Manifest geçersiz JSON: ${err?.message || 'ayrıştırılamadı'}`,
        errorCategory: 'corrupt_remote_json',
      },
    };
  }

  if (
    !isPlainObject(parsed) ||
    !Number.isSafeInteger(Number(parsed.movieCount)) ||
    !Number.isSafeInteger(Number(parsed.tvCount)) ||
    typeof parsed.contentHash !== 'string' ||
    !parsed.contentHash.trim()
  ) {
    return {
      manifestConsistent: false,
      mismatchReason: 'Manifest şeması eksik',
      inspection: {
        repoPath,
        category: 'catalog_manifest',
        personal: false,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'Manifest şeması beklenen alanları (movieCount, tvCount, contentHash) içermiyor.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const expectedMovieCount = Object.keys(actualMovies).length;
  const expectedTvCount = Object.keys(actualTv).length;
  const expectedHash = computeCatalogManifestContentHash(actualMovies, actualTv);

  const reasons: string[] = [];
  if (Number(parsed.movieCount) !== expectedMovieCount) {
    reasons.push(`manifest movieCount (${parsed.movieCount}) != gerçek (${expectedMovieCount})`);
  }
  if (Number(parsed.tvCount) !== expectedTvCount) {
    reasons.push(`manifest tvCount (${parsed.tvCount}) != gerçek (${expectedTvCount})`);
  }
  if (parsed.contentHash !== expectedHash) {
    reasons.push('manifest contentHash gerçek katalog özetiyle uyuşmuyor');
  }

  const consistent = reasons.length === 0;
  const mismatchReason = consistent ? undefined : reasons.join('; ');
  const semanticHash = hashContent(
    stringifyDeterministic({
      version: 1,
      movieCount: Number(parsed.movieCount),
      tvCount: Number(parsed.tvCount),
      contentHash: parsed.contentHash,
    })
  );

  return {
    manifest: parsed as CatalogManifest,
    manifestConsistent: consistent,
    mismatchReason,
    inspection: {
      repoPath,
      category: 'catalog_manifest',
      personal: false,
      exists: true,
      valid: consistent,
      sizeBytes,
      rawFileHash: computeRawUtf8Hash(rawText),
      semanticHash,
      recordCount: 1,
      uniqueKeyCount: 1,
      sha,
      ...(consistent
        ? {}
        : {
            error: `Manifest tutarsızlığı: ${mismatchReason}`,
            errorCategory: 'schema_mismatch' as const,
          }),
    },
  };
}

export function inspectUserDataRawContent(
  rawText: string,
  maxBytes: number,
  sha?: string
): {
  inspection: SyncFileInspection;
  doc?: DataDocument;
  rawItemsCount: number;
  uniqueItemsCount: number;
} {
  const repoPath = 'data/cinetrack-data.json';
  const sizeBytes = measureUtf8Bytes(rawText);
  if (sizeBytes > maxBytes) {
    return {
      rawItemsCount: 0,
      uniqueItemsCount: 0,
      inspection: {
        repoPath,
        category: 'user_data',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Kullanıcı veri dosyası sınırı (${formatMaxDataLimitMb(maxBytes)}) aşıyor.`,
        errorCategory: 'payload_too_large',
      },
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: any) {
    return {
      rawItemsCount: 0,
      uniqueItemsCount: 0,
      inspection: {
        repoPath,
        category: 'user_data',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Kullanıcı verisi geçersiz JSON: ${err?.message || 'ayrıştırılamadı'}`,
        errorCategory: 'corrupt_remote_json',
      },
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      rawItemsCount: 0,
      uniqueItemsCount: 0,
      inspection: {
        repoPath,
        category: 'user_data',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'cinetrack-data.json kök düzeyi geçerli bir nesne değil.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  if (Array.isArray(parsed.profiles)) {
    for (const p of parsed.profiles) {
      if (!isPlainObject(p) || !Array.isArray(p.items)) continue;
      for (const item of p.items) {
        if (
          !isPlainObject(item) ||
          !validItemId(item.id) ||
          (item.media_type !== 'movie' && item.media_type !== 'tv')
        ) {
          return {
            rawItemsCount: 0,
            uniqueItemsCount: 0,
            inspection: {
              repoPath,
              category: 'user_data',
              personal: true,
              exists: true,
              valid: false,
              sizeBytes,
              rawFileHash: computeRawUtf8Hash(rawText),
              semanticHash: null,
              recordCount: 0,
              uniqueKeyCount: 0,
              sha,
              error: 'Kullanıcı listesinde geçersiz kimlikli veya bozuk içerik kaydı tespit edildi.',
              errorCategory: 'schema_mismatch',
            },
          };
        }
      }
    }
  }

  // Boş başlangıç dokümanı (`profiles: []`) sunucuda geçerli boş durumdur
  if (Array.isArray(parsed.profiles) && parsed.profiles.length === 0) {
    const emptyDoc: DataDocument = {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: '',
      profiles: [],
      revision: Number(parsed.revision) || 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
    return {
      doc: emptyDoc,
      rawItemsCount: 0,
      uniqueItemsCount: 0,
      inspection: {
        repoPath,
        category: 'user_data',
        personal: true,
        exists: true,
        valid: true,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: computeUserDataSemanticHash(emptyDoc),
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
      },
    };
  }

  const normalized = normalizeDataDocument(parsed);
  if (!normalized) {
    return {
      rawItemsCount: 0,
      uniqueItemsCount: 0,
      inspection: {
        repoPath,
        category: 'user_data',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'cinetrack-data.json beklenen Cinethos veri şemasına uymuyor.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  let rawItemsCount = 0;
  if (Array.isArray(parsed.profiles)) {
    for (const p of parsed.profiles) {
      if (Array.isArray(p?.items)) rawItemsCount += p.items.length;
    }
  }
  const uniqueKeys = new Set<string>();
  let normalizedItemsTotal = 0;
  for (const p of normalized.profiles) {
    normalizedItemsTotal += p.items.length;
    for (const it of p.items) {
      uniqueKeys.add(`${p.id}::${makeMediaKey(it)}`);
    }
  }

  return {
    doc: normalized,
    rawItemsCount: rawItemsCount || normalizedItemsTotal,
    uniqueItemsCount: uniqueKeys.size,
    inspection: {
      repoPath,
      category: 'user_data',
      personal: true,
      exists: true,
      valid: true,
      sizeBytes,
      rawFileHash: computeRawUtf8Hash(rawText),
      semanticHash: computeUserDataSemanticHash(normalized),
      recordCount: rawItemsCount || normalizedItemsTotal,
      uniqueKeyCount: uniqueKeys.size,
      sha,
    },
  };
}

export function normalizeStockItemList(raw: unknown): any[] | null {
  if (raw === undefined || raw === null) return [];
  return Array.isArray(raw) ? raw.filter((it) => isPlainObject(it)) : null;
}

export function inspectStockRawContent(
  rawText: string,
  maxBytes: number,
  sha?: string
): { inspection: SyncFileInspection } {
  const repoPath = 'data/stock.json';
  const sizeBytes = measureUtf8Bytes(rawText);
  if (sizeBytes > maxBytes) {
    return {
      inspection: {
        repoPath,
        category: 'stock',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Stok dosyası sınırı (${formatMaxDataLimitMb(maxBytes)}) aşıyor.`,
        errorCategory: 'payload_too_large',
      },
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: any) {
    return {
      inspection: {
        repoPath,
        category: 'stock',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Stok verisi geçersiz JSON: ${err?.message || 'ayrıştırılamadı'}`,
        errorCategory: 'corrupt_remote_json',
      },
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      inspection: {
        repoPath,
        category: 'stock',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'data/stock.json kök düzeyi geçerli bir nesne değil.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const movies = normalizeStockItemList(parsed.movies);
  const tv = normalizeStockItemList(parsed.tv);
  if (movies === null || tv === null) {
    return {
      inspection: {
        repoPath,
        category: 'stock',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'data/stock.json movies/tv alanları dizi olmalı.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  // Tekilleştirme doğrulaması: her media:key (movie:<id> / tv:<id>) yalnızca bir kez görünebilir
  const seen = new Set<string>();
  let duplicates = 0;
  let invalidIds = 0;
  for (const [type, list] of [
    ['movie', movies],
    ['tv', tv],
  ] as const) {
    for (const it of list) {
      const id = Number(it?.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        invalidIds++;
        continue;
      }
      const key = `${type}:${id}`;
      if (seen.has(key)) duplicates++;
      else seen.add(key);
    }
  }

  if (invalidIds > 0 || duplicates > 0) {
    return {
      inspection: {
        repoPath,
        category: 'stock',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: movies.length + tv.length,
        uniqueKeyCount: seen.size,
        sha,
        error:
          duplicates > 0 && invalidIds === 0
            ? `Stok verisinde tekrarlayan içerik kaydı var (${duplicates} adet media:key çifti).`
            : invalidIds > 0 && duplicates === 0
              ? `Stok verisinde geçersiz kimlikli içerik kaydı var (${invalidIds} adet).`
              : `Stok verisinde ${invalidIds} geçersiz kimlik ve ${duplicates} tekrarlayan kayıt var.`,
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const sortedKeys = Array.from(seen).sort((a, b) => a.localeCompare(b));
  return {
    inspection: {
      repoPath,
      category: 'stock',
      personal: true,
      exists: true,
      valid: true,
      sizeBytes,
      rawFileHash: computeRawUtf8Hash(rawText),
      semanticHash: hashContent(sortedKeys.join('\n')),
      recordCount: movies.length + tv.length,
      uniqueKeyCount: seen.size,
      sha,
    },
  };
}

export function inspectCinemaKunyeRawContent(
  rawText: string,
  maxBytes: number,
  sha?: string
): {
  inspection: SyncFileInspection;
  doc?: CinemaKunyeDocument;
} {
  const repoPath = 'data/sinema-kunyesi.json';
  const sizeBytes = measureUtf8Bytes(rawText);
  if (sizeBytes > maxBytes) {
    return {
      inspection: {
        repoPath,
        category: 'cinema_kunye',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Sinema künyesi dosyası sınırı (${formatMaxDataLimitMb(maxBytes)}) aşıyor.`,
        errorCategory: 'payload_too_large',
      },
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: any) {
    return {
      inspection: {
        repoPath,
        category: 'cinema_kunye',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `data/sinema-kunyesi.json geçersiz JSON: ${err?.message || 'ayrıştırılamadı'}`,
        errorCategory: 'corrupt_remote_json',
      },
    };
  }

  if (
    !isPlainObject(parsed) ||
    (!isPlainObject(parsed.entries) && !Array.isArray(parsed.entries))
  ) {
    return {
      inspection: {
        repoPath,
        category: 'cinema_kunye',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'data/sinema-kunyesi.json şeması geçersiz (entries alanı eksik).',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const rawCount = Array.isArray(parsed.entries)
    ? parsed.entries.length
    : Object.keys(parsed.entries).length;
  const doc = normalizeCinemaKunyeDocument(parsed);
  const uniqueCount = Object.keys(doc.entries).length;

  if (rawCount > 0 && uniqueCount === 0) {
    return {
      inspection: {
        repoPath,
        category: 'cinema_kunye',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: rawCount,
        uniqueKeyCount: 0,
        sha,
        error: 'data/sinema-kunyesi.json içindeki tüm künye kayıtları geçersiz.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const canonicalPayload = buildCinemaKunyeCanonicalPayload(doc);
  const semanticHash = hashContent(stringifyDeterministic(canonicalPayload));

  return {
    doc,
    inspection: {
      repoPath,
      category: 'cinema_kunye',
      personal: true,
      exists: true,
      valid: true,
      sizeBytes,
      rawFileHash: computeRawUtf8Hash(rawText),
      semanticHash,
      recordCount: rawCount,
      uniqueKeyCount: uniqueCount,
      sha,
    },
  };
}

export function inspectDerivedProfileRawContent(
  repoPath: string,
  rawText: string,
  maxBytes: number,
  sha?: string
): {
  inspection: SyncFileInspection;
  doc?: DerivedProfileDocument;
} {
  const sizeBytes = measureUtf8Bytes(rawText);
  if (sizeBytes > maxBytes) {
    return {
      inspection: {
        repoPath,
        category: 'derived_profile',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Profil önbellek dosyası sınırı (${formatMaxDataLimitMb(maxBytes)}) aşıyor.`,
        errorCategory: 'payload_too_large',
      },
    };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(rawText);
  } catch (err: any) {
    return {
      inspection: {
        repoPath,
        category: 'derived_profile',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: `Türetilmiş profil geçersiz JSON: ${err?.message || 'ayrıştırılamadı'}`,
        errorCategory: 'corrupt_remote_json',
      },
    };
  }

  if (
    !isPlainObject(parsed) ||
    typeof parsed.profileId !== 'string' ||
    !normalizeProfileId(parsed.profileId) ||
    typeof parsed.algorithmVersion !== 'string' ||
    typeof parsed.profileFingerprint !== 'string' ||
    !isPlainObject(parsed.items)
  ) {
    return {
      inspection: {
        repoPath,
        category: 'derived_profile',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        sha,
        error: 'Türetilmiş profil dosyası şeması geçersiz.',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const rawEntries = Object.entries(parsed.items);
  const normalizedItems: Record<string, DerivedProfileItem> = {};
  for (const [k, val] of rawEntries) {
    const norm = normalizeDerivedProfileItem(k, val);
    if (!norm) {
      return {
        inspection: {
          repoPath,
          category: 'derived_profile',
          personal: true,
          exists: true,
          valid: false,
          sizeBytes,
          rawFileHash: computeRawUtf8Hash(rawText),
          semanticHash: null,
          recordCount: rawEntries.length,
          uniqueKeyCount: 0,
          sha,
          error: `Türetilmiş profil içinde bozuk öğe (${k}).`,
          errorCategory: 'schema_mismatch',
        },
      };
    }
    normalizedItems[norm.mediaKey] = norm;
  }

  const computedHash = computeDerivedProfileContentHash({
    schemaVersion: Number(parsed.schemaVersion) || 1,
    profileId: parsed.profileId,
    algorithmVersion: parsed.algorithmVersion,
    profileFingerprint: parsed.profileFingerprint,
    sourceCatalogHash: String(parsed.sourceCatalogHash || ''),
    items: normalizedItems,
  });

  if (typeof parsed.contentHash === 'string' && parsed.contentHash && parsed.contentHash !== computedHash) {
    return {
      inspection: {
        repoPath,
        category: 'derived_profile',
        personal: true,
        exists: true,
        valid: false,
        sizeBytes,
        rawFileHash: computeRawUtf8Hash(rawText),
        semanticHash: null,
        recordCount: rawEntries.length,
        uniqueKeyCount: Object.keys(normalizedItems).length,
        sha,
        error: 'Türetilmiş profil contentHash doğrulaması başarısız (veri bütünlüğü bozuk).',
        errorCategory: 'schema_mismatch',
      },
    };
  }

  const doc: DerivedProfileDocument = {
    schemaVersion: Number(parsed.schemaVersion) || 1,
    profileId: parsed.profileId,
    algorithmVersion: parsed.algorithmVersion,
    profileFingerprint: parsed.profileFingerprint,
    sourceCatalogHash: String(parsed.sourceCatalogHash || ''),
    contentHash: computedHash,
    generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : '',
    items: normalizedItems,
  };

  return {
    doc,
    inspection: {
      repoPath,
      category: 'derived_profile',
      personal: true,
      exists: true,
      valid: true,
      sizeBytes,
      rawFileHash: computeRawUtf8Hash(rawText),
      semanticHash: computedHash,
      recordCount: rawEntries.length,
      uniqueKeyCount: Object.keys(normalizedItems).length,
      sha,
    },
  };
}

export interface ParsedSideBundle {
  summary: SyncSideSummary;
  movies: Record<string, CatalogRecord>;
  tv: Record<string, CatalogRecord>;
  manifest: CatalogManifest | null;
  userData: DataDocument | null;
  cinemaKunye: CinemaKunyeDocument | null;
  derivedProfiles: Record<string, DerivedProfileDocument>;
  errors: SyncErrorRecord[];
}

export function compareSyncSides(
  localBundle: ParsedSideBundle,
  remoteBundle: ParsedSideBundle,
  options: { includePersonalFiles: boolean; includeCatalogFiles?: boolean }
): SyncComparisonSummary {
  const includeCatalog = options.includeCatalogFiles !== false;
  const allPaths = new Set<string>([
    ...Object.keys(localBundle.summary.files),
    ...Object.keys(remoteBundle.summary.files),
  ]);

  const differingFiles: SyncFileDiffDetail[] = [];
  const reasons: string[] = [];
  let rawFilesEqual = true;
  let semanticEqual = true;
  let comparedFilesCount = 0;
  let differentRecordsCount = 0;

  const sortedPaths = Array.from(allPaths).sort((a, b) => a.localeCompare(b));
  for (const repoPath of sortedPaths) {
    const lf = localBundle.summary.files[repoPath];
    const rf = remoteBundle.summary.files[repoPath];
    const personal = Boolean(lf?.personal ?? rf?.personal);
    if (personal && !options.includePersonalFiles) continue;
    if (!personal && !includeCatalog) continue;

    const lExists = Boolean(lf?.exists);
    const rExists = Boolean(rf?.exists);
    if (!lExists && !rExists) continue;

    comparedFilesCount++;
    const category: SyncFileCategory = lf?.category || rf?.category || 'catalog_movies';
    const lValid = lExists ? Boolean(lf?.valid) : true;
    const rValid = rExists ? Boolean(rf?.valid) : true;
    const lRecords = lf?.uniqueKeyCount ?? 0;
    const rRecords = rf?.uniqueKeyCount ?? 0;

    const fileRawEqual = Boolean(
      lExists && rExists && lValid && rValid && lf?.rawFileHash && lf.rawFileHash === rf?.rawFileHash
    );
    const fileSemanticEqual = Boolean(
      lExists &&
        rExists &&
        lValid &&
        rValid &&
        lf?.semanticHash &&
        lf.semanticHash === rf?.semanticHash
    );

    if (!fileRawEqual) rawFilesEqual = false;
    if (!fileSemanticEqual) {
      semanticEqual = false;
      let reason = '';
      if (!lValid && lf?.error) {
        reason = `Yerel dosya geçersiz (${lf.error})`;
      } else if (!rValid && rf?.error) {
        reason = `GitHub dosyası geçersiz (${rf.error})`;
      } else if (lExists && !rExists) {
        reason = "Yalnızca yerelde mevcut (GitHub'da henüz yok)";
      } else if (rExists && !lExists) {
        reason = "Yalnızca GitHub'da mevcut (yerelde henüz yok)";
      } else if (lRecords !== rRecords) {
        reason = `Kayıt sayısı farklı (Yerel: ${lRecords}, GitHub: ${rRecords})`;
      } else {
        reason = 'Kayıt içerikleri veya özetleri farklı';
      }

      differingFiles.push({
        repoPath,
        category,
        localExists: lExists,
        remoteExists: rExists,
        localValid: lValid,
        remoteValid: rValid,
        localRecords: lRecords,
        remoteRecords: rRecords,
        rawEqual: fileRawEqual,
        semanticEqual: fileSemanticEqual,
        reason,
      });
      reasons.push(`${repoPath}: ${reason}`);
    }
  }

  // Katalog bazında farklı kayıt sayısını doğrudan anahtar farkından hesapla
  if (includeCatalog) {
    const allMovieKeys = new Set([
      ...Object.keys(localBundle.movies),
      ...Object.keys(remoteBundle.movies),
    ]);
    for (const k of allMovieKeys) {
      const lm = localBundle.movies[k];
      const rm = remoteBundle.movies[k];
      if (!lm || !rm) {
        differentRecordsCount++;
      } else {
        const ls = stringifyDeterministic({ ...lm, firstStoredAt: '', lastUpdatedAt: '' });
        const rs = stringifyDeterministic({ ...rm, firstStoredAt: '', lastUpdatedAt: '' });
        if (ls !== rs) differentRecordsCount++;
      }
    }

    const allTvKeys = new Set([
      ...Object.keys(localBundle.tv),
      ...Object.keys(remoteBundle.tv),
    ]);
    for (const k of allTvKeys) {
      const lt = localBundle.tv[k];
      const rt = remoteBundle.tv[k];
      if (!lt || !rt) {
        differentRecordsCount++;
      } else {
        const ls = stringifyDeterministic({ ...lt, firstStoredAt: '', lastUpdatedAt: '' });
        const rs = stringifyDeterministic({ ...rt, firstStoredAt: '', lastUpdatedAt: '' });
        if (ls !== rs) differentRecordsCount++;
      }
    }
  }

  let localOnlyUserItemsCount = 0;
  let remoteOnlyUserItemsCount = 0;
  let conflictingUserItemsCount = 0;
  let userDataConflicts: UserDataConflictItem[] = [];

  if (options.includePersonalFiles) {
    if (localBundle.userData && remoteBundle.userData) {
      const mergePreview = reconcileUserDataDocumentsLossless(
        localBundle.userData,
        remoteBundle.userData
      );
      localOnlyUserItemsCount = mergePreview.addedToRemote;
      remoteOnlyUserItemsCount = mergePreview.addedToLocal;
      userDataConflicts = mergePreview.conflicts;
      conflictingUserItemsCount = mergePreview.conflicts.length;
      differentRecordsCount +=
        localOnlyUserItemsCount + remoteOnlyUserItemsCount + mergePreview.updatedItems;
    } else if (localBundle.userData && !remoteBundle.userData) {
      localOnlyUserItemsCount = localBundle.summary.userUniqueSavedItemsCount;
      differentRecordsCount += localOnlyUserItemsCount;
    } else if (remoteBundle.userData && !localBundle.userData) {
      remoteOnlyUserItemsCount = remoteBundle.summary.userUniqueSavedItemsCount;
      differentRecordsCount += remoteOnlyUserItemsCount;
    }

    const allProfilePaths = new Set([
      ...Object.keys(localBundle.derivedProfiles),
      ...Object.keys(remoteBundle.derivedProfiles),
    ]);
    for (const pPath of allProfilePaths) {
      const ld = localBundle.derivedProfiles[pPath];
      const rd = remoteBundle.derivedProfiles[pPath];
      if (!ld && rd) {
        differentRecordsCount += Object.keys(rd.items || {}).length || 1;
      } else if (ld && !rd) {
        differentRecordsCount += Object.keys(ld.items || {}).length || 1;
      } else if (ld && rd && ld.contentHash !== rd.contentHash) {
        const pKeys = new Set([
          ...Object.keys(ld.items || {}),
          ...Object.keys(rd.items || {}),
        ]);
        let pDiff = 0;
        for (const pk of pKeys) {
          if (stringifyDeterministic(ld.items[pk]) !== stringifyDeterministic(rd.items[pk])) {
            pDiff++;
          }
        }
        differentRecordsCount += Math.max(1, pDiff);
      }
    }
  }

  if (differentRecordsCount === 0 && differingFiles.length > 0) {
    differentRecordsCount = differingFiles.length;
  }

  return {
    semanticEqual,
    rawFilesEqual,
    comparedFilesCount,
    differentFilesCount: differingFiles.length,
    differentRecordsCount,
    differingFiles,
    hasUserDataConflict: localOnlyUserItemsCount > 0 || conflictingUserItemsCount > 0,
    localOnlyUserItemsCount,
    remoteOnlyUserItemsCount,
    conflictingUserItemsCount,
    userDataConflicts,
    reasons,
  };
}

export interface BidirectionalSyncDependencies {
  dataDir: string;
  maxDataBytes?: number;
  enableStartupRecovery?: boolean;
  store: PersistentDataStoreSyncPort;
  storage: ReturnType<typeof createDataStorage>;
  getGitHubConfig: () => {
    token?: string;
    owner?: string;
    repo?: string;
    branch: string;
    isPublicRepo: boolean;
    allowPublicPersonalSync?: boolean;
    allowPublicCatalogSync?: boolean;
  };
  onSyncCompleted?: (info: {
    report: BidirectionalSyncReport;
    lastRemoteSummary: SyncSideSummary | null;
    lastComparison: SyncComparisonSummary | null;
  }) => void;
}

export function buildBlockedPublicPaths(includeCatalog: boolean, includePersonal: boolean): string[] {
  const blocked: string[] = [];
  if (!includeCatalog) {
    blocked.push(
      'data/catalog/manifest.json',
      'data/catalog/movies.json',
      'data/catalog/tv.json'
    );
  }
  if (!includePersonal) {
    blocked.push('data/cinetrack-data.json', 'data/profiles/*');
  }
  return blocked;
}
