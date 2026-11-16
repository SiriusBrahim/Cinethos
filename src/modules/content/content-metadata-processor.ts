/**
 * MIA Faz 2 — Content Metadata Processor
 *
 * Sorumluluklar:
 * 1. Ham içerik metaverisini doğrulama (bozuk/geçersiz yapıda sistem çökmeden yapılandırılmış hata döner).
 * 2. Poster/backdrop/görsel alanlarını VE kullanıcıya ait kişisel alanları (profileId, rating, status vb.) ayıklama.
 * 3. Film (movie) ve Dizi (tv) ayrımını veri modelinde sıkılaştırma.
 * 4. Eksik veya geçersiz alanları tespit edip sahte varsayılan üretmeden raporlama.
 * 5. Kaynak, source_revision, acquiredAt izlenebilirliği ile deterministik data_hash üretme.
 */

import type { MediaKind } from '../../contracts/index.ts';
import { canonicalJsonStringify } from '../../core/derived-profile-cache.ts';
import { parseMediaKey } from '../../core/keys.ts';
import {
  CONTENT_INTELLIGENCE_VERSION,
  type ContentCollectionRef,
  type ContentCreditPerson,
  type ContentKeywordEntry,
  type MetadataValidationIssue,
  type MetadataValidationResult,
  type NormalizedContentMetadata,
} from './types.ts';

/** Görsel alanları — Content Intelligence deposuna ASLA kopyalanmaz. */
export const STRIPPED_VISUAL_KEYS = new Set([
  'poster_path',
  'posterpath',
  'poster_url',
  'posterurl',
  'backdrop_path',
  'backdroppath',
  'backdrop_url',
  'backdropurl',
  'profile_path',
  'profilepath',
  'still_path',
  'stillpath',
  'logo_path',
  'logopath',
  'images',
  'posters',
  'backdrops',
  'poster_blob',
  'poster_data_url',
]);

/** Kullanıcı / profil / izleme listesi alanları — ortak içerik havuzuna ASLA yazılmaz. */
export const STRIPPED_PERSONAL_KEYS = new Set([
  'profileid',
  'profile_id',
  'userid',
  'user_id',
  'username',
  'user_name',
  'listname',
  'list_name',
  'status',
  'list',
  'personal_rating',
  'personalrating',
  'personal_rating_cleared',
  'rating',
  'my_rating',
  'myrating',
  'userrating',
  'user_rating',
  'ratedat',
  'rated_at',
  'completedat',
  'completed_at',
  'addedat',
  'added_at',
  'updatedat',
  'updated_at',
  'episodes_watched',
  'episodeswatched',
  'current_season',
  'currentseason',
  'season_progress',
  'seasonprogress',
  'watch_progress',
  'watchprogress',
  'watched_at',
  'watchedat',
  'isdemo',
  'is_demo',
  'disliked',
  'notinterested',
  'not_interested',
  'hidden',
  'deleted_keys',
  'deletedkeys',
  'addedtopoolat',
  'added_to_pool_at',
  'notes',
  'note',
  'user_note',
  'usernote',
  'personal_note',
  'personalnote',
  'personal_notes',
  'personalnotes',
  'comment',
  'comments',
  'yorum',
  'favorite',
  'favorites',
  'favourite',
  'favourites',
  'favoriteactors',
  'favorite_actors',
]);

/**
 * MIA Faz 2 — Adım 2.1 (Dilim D): Ortak içerik deposu AÇIK ALLOWLIST sınırı.
 *
 * Bu kümede olmayan HER anahtar (hangi seviyede olursa olsun) varsayılan olarak
 * atılır (default-deny). Yalnızca TMDB / lisanslı kaynaklardan gelen ortak
 * doğrulanmış içerik metaverisi ortak havuza girebilir; profileId, kişisel
 * puan, not, izleme durumu gibi kullanıcı alanlarının bu kümeye dahil
 * edilmemesi tasarım gereğidir.
 *
 * Anahtarlar normalize biçimde tutulur: küçük harf + yalnızca alfanumerik
 * karakterler (`original_title` → `originaltitle`, `originalTitle` →
 * `originaltitle`). Böylece farklı yazım/kasalarla sınır aşılamaz.
 */
export const COMMON_METADATA_ALLOWLIST = new Set([
  // Medya kimliği
  'id',
  'tmdbid',
  'mediakey',
  'mediatype',
  'contentid',
  'imdbid',
  'externalids',
  'adult',
  // Başlıklar
  'title',
  'originaltitle',
  'name',
  'originalname',
  // Özet ve slogan
  'overview',
  'tagline',
  // Türler ve anahtar kelimeler
  'genres',
  'genreids',
  'keywords',
  'keywordids',
  // Tarihler
  'releasedate',
  'firstairdate',
  'lastairdate',
  // Süre / sezon / bölüm
  'runtime',
  'runtimeminutes',
  'episoderuntime',
  'numberofseasons',
  'numberofepisodes',
  // Ülke / dil / prodüksiyon
  'originallanguage',
  'origincountry',
  'productioncountries',
  'productioncompanies',
  'networks',
  'createdby',
  'belongstocollection',
  'collection',
  // İçerik kredileri ve kredi girdisi alanları (nested)
  'credits',
  'cast',
  'crew',
  'job',
  'department',
  'character',
  'order',
  // TMDB ortak puan/popülerlik (kişisel puan DEĞİL)
  'voteaverage',
  'votecount',
  'popularity',
  // Kaynak izlenebilirliği
  'source',
  'sourcerevision',
  'acquiredat',
  'fetchedat',
  // İşlem bookkeeping bayrağı
  'corrupt',
]);

const TMDB_GENRE_ID_LABELS: Record<number, string> = {
  12: 'Adventure',
  14: 'Fantasy',
  16: 'Animation',
  18: 'Drama',
  27: 'Horror',
  28: 'Action',
  35: 'Comedy',
  36: 'History',
  37: 'Western',
  53: 'Thriller',
  80: 'Crime',
  99: 'Documentary',
  878: 'Science Fiction',
  9648: 'Mystery',
  10402: 'Music',
  10749: 'Romance',
  10751: 'Family',
  10752: 'War',
  10759: 'Action & Adventure',
  10762: 'Kids',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
  10770: 'TV Movie',
};

const GENRE_NAME_LOOKUP: Record<string, { id: number; label: string }> = {
  action: { id: 28, label: 'Action' },
  aksiyon: { id: 28, label: 'Action' },
  adventure: { id: 12, label: 'Adventure' },
  macera: { id: 12, label: 'Adventure' },
  animation: { id: 16, label: 'Animation' },
  animasyon: { id: 16, label: 'Animation' },
  comedy: { id: 35, label: 'Comedy' },
  komedi: { id: 35, label: 'Comedy' },
  crime: { id: 80, label: 'Crime' },
  suç: { id: 80, label: 'Crime' },
  suc: { id: 80, label: 'Crime' },
  documentary: { id: 99, label: 'Documentary' },
  belgesel: { id: 99, label: 'Documentary' },
  drama: { id: 18, label: 'Drama' },
  dram: { id: 18, label: 'Drama' },
  family: { id: 10751, label: 'Family' },
  aile: { id: 10751, label: 'Family' },
  fantasy: { id: 14, label: 'Fantasy' },
  fantastik: { id: 14, label: 'Fantasy' },
  history: { id: 36, label: 'History' },
  tarih: { id: 36, label: 'History' },
  horror: { id: 27, label: 'Horror' },
  korku: { id: 27, label: 'Horror' },
  music: { id: 10402, label: 'Music' },
  müzik: { id: 10402, label: 'Music' },
  muzik: { id: 10402, label: 'Music' },
  mystery: { id: 9648, label: 'Mystery' },
  gizem: { id: 9648, label: 'Mystery' },
  romance: { id: 10749, label: 'Romance' },
  romantik: { id: 10749, label: 'Romance' },
  'science fiction': { id: 878, label: 'Science Fiction' },
  'sci-fi': { id: 878, label: 'Science Fiction' },
  scifi: { id: 878, label: 'Science Fiction' },
  'bilim kurgu': { id: 878, label: 'Science Fiction' },
  'bilim-kurgu': { id: 878, label: 'Science Fiction' },
  thriller: { id: 53, label: 'Thriller' },
  gerilim: { id: 53, label: 'Thriller' },
  war: { id: 10752, label: 'War' },
  savaş: { id: 10752, label: 'War' },
  savas: { id: 10752, label: 'War' },
  western: { id: 37, label: 'Western' },
  'action & adventure': { id: 10759, label: 'Action & Adventure' },
  kids: { id: 10762, label: 'Kids' },
  'sci-fi & fantasy': { id: 10765, label: 'Sci-Fi & Fantasy' },
  'war & politics': { id: 10768, label: 'War & Politics' },
};

/** 128-bit deterministik (Node/Tarayıcı uyumlu) canonical hash. */
export function computeDeterministicDataHash(payload: unknown): string {
  const canonical = canonicalJsonStringify(payload);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  let h3 = 0x85ebca6b;
  let h4 = 0xc2b2ae35;
  for (let i = 0; i < canonical.length; i += 1) {
    const c = canonical.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + (i & 255);
    h2 = Math.imul(h2, 0x85ebca6b);
    h3 = Math.imul(h3 ^ (c * 31), 0xc2b2ae35);
    h4 = Math.imul(h4 + c + 17, 0x27d4eb2f);
  }
  return [
    (h1 >>> 0).toString(16).padStart(8, '0'),
    (h2 >>> 0).toString(16).padStart(8, '0'),
    (h3 >>> 0).toString(16).padStart(8, '0'),
    (h4 >>> 0).toString(16).padStart(8, '0'),
  ].join('');
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function classifyStrippedKey(key: string): 'visual' | 'personal' | null {
  const lower = normalizeKey(key);
  if (STRIPPED_VISUAL_KEYS.has(lower)) return 'visual';
  if (STRIPPED_PERSONAL_KEYS.has(lower)) return 'personal';
  return null;
}

export interface SanitizeResult {
  readonly sanitized: Record<string, unknown>;
  readonly strippedVisualFields: string[];
  readonly strippedPersonalFields: string[];
  /** Allowlist dışında kalan ve default-deny ile atılan bilinmeyen alanlar. */
  readonly strippedUnknownFields: string[];
}

function sanitizeValueRecursive(
  value: unknown,
  visualOut: Set<string>,
  personalOut: Set<string>,
  unknownOut: Set<string>,
  depth = 0
): unknown {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeValueRecursive(entry, visualOut, personalOut, unknownOut, depth + 1)
    );
  }
  const obj = value as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const kind = classifyStrippedKey(k);
    if (kind === 'visual') {
      visualOut.add(k);
      continue;
    }
    if (kind === 'personal') {
      personalOut.add(k);
      continue;
    }
    // MIA Faz 2 — Adım 2.1: default-deny allowlist. Bilinmeyen anahtar hangi
    // seviyede olursa olsun atılır; bu, denylist'in kaçıracağı yeni kişisel
    // alanların ortak havuza sızmasını tasarım düzeyinde engeller.
    if (!COMMON_METADATA_ALLOWLIST.has(normalizeKey(k))) {
      unknownOut.add(k);
      continue;
    }
    clean[k] = sanitizeValueRecursive(v, visualOut, personalOut, unknownOut, depth + 1);
  }
  return clean;
}

/** Ham nesneyi poster/backdrop, kişisel ve allowlist dışı alanlardan tamamen arındırır. */
export function sanitizeRawContentInput(raw: unknown): SanitizeResult {
  const visualOut = new Set<string>();
  const personalOut = new Set<string>();
  const unknownOut = new Set<string>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      sanitized: {},
      strippedVisualFields: [],
      strippedPersonalFields: [],
      strippedUnknownFields: [],
    };
  }
  const sanitized = sanitizeValueRecursive(raw, visualOut, personalOut, unknownOut, 0) as Record<
    string,
    unknown
  >;
  return {
    sanitized,
    strippedVisualFields: [...visualOut].sort(),
    strippedPersonalFields: [...personalOut].sort(),
    strippedUnknownFields: [...unknownOut].sort(),
  };
}

function resolveIdentity(
  raw: Record<string, unknown>,
  issues: MetadataValidationIssue[],
  errors: string[]
): { mediaKey: string | null; mediaType: MediaKind | null; tmdbId: number | null } {
  const rawKey =
    typeof raw.mediaKey === 'string'
      ? raw.mediaKey.trim()
      : typeof raw.media_key === 'string'
        ? raw.media_key.trim()
        : typeof raw.contentId === 'string'
          ? raw.contentId.trim()
          : '';

  const parsedFromKey = rawKey ? parseMediaKey(rawKey) : null;

  const rawTypeField = raw.mediaType ?? raw.media_type;
  let mediaType: MediaKind | null = null;
  if (rawTypeField !== undefined && rawTypeField !== null && rawTypeField !== '') {
    if (rawTypeField === 'movie' || rawTypeField === 'tv') {
      mediaType = rawTypeField;
    } else {
      issues.push({
        field: 'mediaType',
        kind: 'invalid',
        message: `Geçersiz medya türü: ${String(rawTypeField)}`,
      });
      errors.push(`Geçersiz medya türü: ${String(rawTypeField)}`);
    }
  } else if (parsedFromKey) {
    mediaType = parsedFromKey.type;
  } else if (raw.first_air_date || raw.firstAirDate || raw.number_of_seasons !== undefined) {
    mediaType = 'tv';
  } else if (raw.release_date || raw.releaseDate || typeof raw.title === 'string') {
    mediaType = 'movie';
  } else if (typeof raw.name === 'string' && !raw.title) {
    mediaType = 'tv';
  }

  const candidateNumericId = raw.tmdbId ?? raw.tmdb_id ?? raw.id ?? parsedFromKey?.id;
  const num = Number(candidateNumericId);
  let tmdbId: number | null = null;
  if (
    candidateNumericId !== undefined &&
    candidateNumericId !== null &&
    candidateNumericId !== '' &&
    Number.isInteger(num) &&
    num > 0
  ) {
    tmdbId = num;
  } else {
    issues.push({
      field: 'tmdbId',
      kind: candidateNumericId == null || candidateNumericId === '' ? 'missing' : 'invalid',
      message: 'Geçerli pozitif tam sayı TMDB kimliği zorunludur.',
    });
    errors.push('Geçerli pozitif tam sayı TMDB kimliği zorunludur.');
  }

  if (!mediaType) {
    issues.push({
      field: 'mediaType',
      kind: 'missing',
      message: "Medya türü ('movie' veya 'tv') belirlenemedi.",
    });
    errors.push("Medya türü ('movie' veya 'tv') belirlenemedi.");
  } else if (parsedFromKey && parsedFromKey.type !== mediaType) {
    errors.push(
      `Medya anahtarı (${rawKey}) ile mediaType (${mediaType}) çelişiyor.`
    );
  }

  const mediaKey = mediaType && tmdbId ? `${mediaType}:${tmdbId}` : null;
  return { mediaKey, mediaType, tmdbId };
}

function normalizeGenres(
  raw: Record<string, unknown>,
  issues: MetadataValidationIssue[],
  errors: string[]
): { genreIds: number[]; genres: string[] } {
  const ids = new Set<number>();
  const names = new Set<string>();

  if (raw.genre_ids !== undefined && !Array.isArray(raw.genre_ids)) {
    issues.push({
      field: 'genre_ids',
      kind: 'invalid',
      message: 'genre_ids alanı dizi olmalıdır.',
    });
    errors.push('genre_ids alanı bozuk (dizi değil).');
  }
  if (raw.genreIds !== undefined && !Array.isArray(raw.genreIds)) {
    issues.push({
      field: 'genreIds',
      kind: 'invalid',
      message: 'genreIds alanı dizi olmalıdır.',
    });
    errors.push('genreIds alanı bozuk (dizi değil).');
  }
  if (raw.genres !== undefined && !Array.isArray(raw.genres)) {
    issues.push({
      field: 'genres',
      kind: 'invalid',
      message: 'genres alanı dizi olmalıdır.',
    });
    errors.push('genres alanı bozuk (dizi değil).');
  }

  const pushGenreValue = (entry: unknown) => {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry > 0) {
      ids.add(entry);
      if (TMDB_GENRE_ID_LABELS[entry]) {
        names.add(TMDB_GENRE_ID_LABELS[entry]);
      }
    } else if (typeof entry === 'string' && entry.trim()) {
      const trimmed = entry.trim();
      const asNum = Number(trimmed);
      if (Number.isInteger(asNum) && asNum > 0) {
        ids.add(asNum);
        if (TMDB_GENRE_ID_LABELS[asNum]) {
          names.add(TMDB_GENRE_ID_LABELS[asNum]);
        }
      } else {
        const mapped = GENRE_NAME_LOOKUP[trimmed.toLocaleLowerCase('tr-TR')];
        if (mapped) {
          ids.add(mapped.id);
          names.add(mapped.label);
        } else {
          names.add(trimmed);
        }
      }
    } else if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      if (obj.id !== undefined) pushGenreValue(obj.id);
      if (typeof obj.name === 'string' && obj.name.trim()) {
        const mapped = GENRE_NAME_LOOKUP[obj.name.trim().toLocaleLowerCase('tr-TR')];
        if (mapped) {
          ids.add(mapped.id);
          names.add(mapped.label);
        } else {
          names.add(obj.name.trim());
        }
      }
    }
  };

  if (Array.isArray(raw.genre_ids)) raw.genre_ids.forEach(pushGenreValue);
  if (Array.isArray(raw.genreIds)) raw.genreIds.forEach(pushGenreValue);
  if (Array.isArray(raw.genres)) raw.genres.forEach(pushGenreValue);

  const sortedIds = [...ids].sort((a, b) => a - b);
  const sortedGenres = [...names].sort((a, b) => a.localeCompare(b, 'en'));
  return { genreIds: sortedIds, genres: sortedGenres };
}

function normalizeKeywords(
  raw: Record<string, unknown>,
  issues: MetadataValidationIssue[],
  errors: string[]
): ContentKeywordEntry[] {
  const byId = new Map<number, ContentKeywordEntry>();
  let list: unknown[] = [];

  if (raw.keywords !== undefined) {
    if (Array.isArray(raw.keywords)) {
      list = raw.keywords;
    } else if (raw.keywords && typeof raw.keywords === 'object') {
      const kwObj = raw.keywords as Record<string, unknown>;
      if (Array.isArray(kwObj.keywords)) list = kwObj.keywords;
      else if (Array.isArray(kwObj.results)) list = kwObj.results;
      else {
        issues.push({
          field: 'keywords',
          kind: 'invalid',
          message: 'keywords nesnesi geçerli liste içermiyor.',
        });
        errors.push('keywords nesnesi bozuk.');
      }
    } else {
      issues.push({
        field: 'keywords',
        kind: 'invalid',
        message: 'keywords alanı dizi veya nesne olmalıdır.',
      });
      errors.push('keywords alanı bozuk.');
    }
  } else if (Array.isArray(raw.keyword_ids)) {
    list = raw.keyword_ids;
  }

  for (const entry of list) {
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const id = Number(obj.id);
      if (Number.isInteger(id) && id > 0) {
        const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : undefined;
        byId.set(id, name ? { id, name } : { id });
      }
    } else {
      const id = Number(entry);
      if (Number.isInteger(id) && id > 0) {
        byId.set(id, { id });
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.id - b.id);
}

function normalizeCreditsList(
  rawList: unknown,
  kind: 'cast' | 'crew',
  issues: MetadataValidationIssue[]
): ContentCreditPerson[] {
  if (rawList === undefined || rawList === null) return [];
  if (!Array.isArray(rawList)) {
    issues.push({
      field: kind,
      kind: 'invalid',
      message: `${kind} alanı dizi değil; yoksayıldı.`,
    });
    return [];
  }
  const seen = new Set<string>();
  const out: ContentCreditPerson[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const id = Number(obj.id);
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!Number.isInteger(id) || id <= 0 || !name) continue;
    const job = typeof obj.job === 'string' && obj.job.trim() ? obj.job.trim() : undefined;
    const department =
      typeof obj.department === 'string' && obj.department.trim()
        ? obj.department.trim()
        : undefined;
    const character =
      typeof obj.character === 'string' && obj.character.trim() ? obj.character.trim() : undefined;
    const dedupeKey = kind === 'crew' ? `${id}:${job || department || ''}` : String(id);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({
      id,
      name,
      ...(kind === 'cast' && character ? { character } : {}),
      ...(kind === 'crew' && job ? { job } : {}),
      ...(kind === 'crew' && department ? { department } : {}),
    });
  }
  return out.slice(0, kind === 'cast' ? 20 : 15);
}

function normalizeCountryCodes(rawValue: unknown): string[] {
  if (!Array.isArray(rawValue)) return [];
  const codes = new Set<string>();
  for (const entry of rawValue) {
    if (typeof entry === 'string' && entry.trim()) {
      codes.add(entry.trim().toUpperCase());
    } else if (entry && typeof entry === 'object') {
      const code = (entry as Record<string, unknown>).iso_3166_1;
      if (typeof code === 'string' && code.trim()) {
        codes.add(code.trim().toUpperCase());
      }
    }
  }
  return [...codes].sort();
}

function parseValidDate(rawValue: unknown, field: string, issues: MetadataValidationIssue[]): string | null {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (typeof rawValue !== 'string') {
    issues.push({
      field,
      kind: 'invalid',
      message: `${field} metin formatında olmalıdır.`,
    });
    return null;
  }
  const trimmed = rawValue.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(5, 7));
    const day = Number(trimmed.slice(8, 10));
    if (year >= 1880 && year <= 2100 && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return trimmed;
    }
  } else if (/^\d{4}$/.test(trimmed)) {
    const year = Number(trimmed);
    if (year >= 1880 && year <= 2100) {
      return trimmed;
    }
  }
  issues.push({
    field,
    kind: 'invalid',
    message: `Geçersiz tarih değeri (${trimmed}).`,
  });
  return null;
}

function parseOptionalPositiveInt(
  rawValue: unknown,
  field: string,
  issues: MetadataValidationIssue[],
  max: number
): number | null {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const num = Number(rawValue);
  if (!Number.isFinite(num) || num <= 0 || num > max) {
    issues.push({
      field,
      kind: 'invalid',
      message: `${field} için geçersiz sayısal değer.`,
    });
    return null;
  }
  return Math.round(num);
}

function parseOptionalNumber(
  rawValue: unknown,
  field: string,
  issues: MetadataValidationIssue[],
  min: number,
  max: number
): number | null {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const num = Number(rawValue);
  if (!Number.isFinite(num) || num < min || num > max) {
    issues.push({
      field,
      kind: 'invalid',
      message: `${field} geçerli aralık (${min}..${max}) dışında.`,
    });
    return null;
  }
  return Math.round(num * 1000) / 1000;
}

export class ContentMetadataProcessor {
  validateAndNormalize(
    rawInput: unknown,
    options: {
      source?: string;
      sourceRevision?: string;
      acquiredAt?: string;
      processingVersion?: string;
    } = {}
  ): MetadataValidationResult {
    const issues: MetadataValidationIssue[] = [];
    const errors: string[] = [];

    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
      return {
        valid: false,
        mediaKey: null,
        mediaType: null,
        tmdbId: null,
        imdbId: null,
        errors: ['Metaveri girdisi geçerli bir JSON nesnesi değil.'],
        issues: [
          {
            field: 'root',
            kind: 'invalid',
            message: 'Metaveri girdisi geçerli bir nesne değil.',
          },
        ],
        missingFields: [],
        invalidFields: ['root'],
        strippedVisualFields: [],
        strippedPersonalFields: [],
        strippedUnknownFields: [],
        fieldCompleteness: 0,
        sanitizedRawMetadata: {},
        normalized: null,
        dataHash: '',
        sourceRevision: options.sourceRevision || 'v1',
      };
    }

    const { sanitized, strippedVisualFields, strippedPersonalFields, strippedUnknownFields } =
      sanitizeRawContentInput(rawInput);
    const { mediaKey, mediaType, tmdbId } = resolveIdentity(sanitized, issues, errors);

    if (sanitized.corrupt === true) {
      errors.push('Metaveri bozuk olarak işaretlenmiş (corrupt=true).');
      issues.push({
        field: 'corrupt',
        kind: 'invalid',
        message: 'Bozuk metaveri bayrağı tespit edildi.',
      });
    }

    // Başlık doğrulama (movie için title, tv için name/title)
    const rawTitle =
      mediaType === 'tv'
        ? sanitized.name ?? sanitized.title ?? sanitized.original_name ?? sanitized.original_title
        : sanitized.title ?? sanitized.name ?? sanitized.original_title ?? sanitized.original_name;
    let title = '';
    if (typeof rawTitle === 'string' && rawTitle.trim()) {
      title = rawTitle.trim();
    } else if (rawTitle !== undefined && rawTitle !== null && rawTitle !== '') {
      issues.push({
        field: 'title',
        kind: 'invalid',
        message: 'Başlık alanı metin olmalıdır.',
      });
      errors.push('Başlık alanı geçersiz tipte.');
    } else {
      issues.push({
        field: 'title',
        kind: 'missing',
        message: 'Başlık alanı eksik.',
      });
      errors.push('Başlık alanı eksik.');
    }

    const rawOriginalTitle =
      mediaType === 'tv'
        ? sanitized.original_name ?? sanitized.originalName ?? sanitized.original_title
        : sanitized.original_title ?? sanitized.originalTitle ?? sanitized.original_name;
    const originalTitle =
      typeof rawOriginalTitle === 'string' && rawOriginalTitle.trim()
        ? rawOriginalTitle.trim()
        : title;

    const overview =
      typeof sanitized.overview === 'string' ? sanitized.overview.trim() : '';
    if (!overview) {
      issues.push({
        field: 'overview',
        kind: 'missing',
        message: 'Özet (overview) alanı eksik.',
      });
    } else if (sanitized.overview !== undefined && typeof sanitized.overview !== 'string') {
      issues.push({
        field: 'overview',
        kind: 'invalid',
        message: 'Özet (overview) metin değil.',
      });
    }

    const { genreIds, genres } = normalizeGenres(sanitized, issues, errors);
    if (genreIds.length === 0 && genres.length === 0) {
      issues.push({
        field: 'genres',
        kind: 'missing',
        message: 'Tür (genre) bilgisi eksik.',
      });
    }

    const keywords = normalizeKeywords(sanitized, issues, errors);
    if (keywords.length === 0) {
      issues.push({
        field: 'keywords',
        kind: 'missing',
        message: 'Anahtar kelime (keywords) eksik.',
      });
    }

    const rawExternalIds =
      sanitized.external_ids && typeof sanitized.external_ids === 'object'
        ? (sanitized.external_ids as Record<string, unknown>)
        : {};
    const rawImdb = sanitized.imdb_id ?? sanitized.imdbId ?? rawExternalIds.imdb_id;
    let imdbId: string | null = null;
    if (typeof rawImdb === 'string' && rawImdb.trim()) {
      const cleanedImdb = rawImdb.trim();
      if (/^tt\d{5,}$/.test(cleanedImdb)) {
        imdbId = cleanedImdb;
      } else {
        issues.push({
          field: 'imdbId',
          kind: 'invalid',
          message: `Geçersiz IMDb kimliği: ${cleanedImdb}`,
        });
      }
    }

    // Movie vs TV ayrışık tarih ve süre alanları
    const releaseDate =
      mediaType === 'tv'
        ? parseValidDate(
            sanitized.first_air_date ?? sanitized.firstAirDate ?? sanitized.releaseDate,
            'first_air_date',
            issues
          )
        : parseValidDate(
            sanitized.release_date ?? sanitized.releaseDate,
            'release_date',
            issues
          );
    if (!releaseDate) {
      issues.push({
        field: mediaType === 'tv' ? 'first_air_date' : 'release_date',
        kind: 'missing',
        message: 'Yayın tarihi eksik.',
      });
    }

    let runtimeMinutes: number | null = null;
    let episodeRunTime: number[] = [];
    let numberOfSeasons: number | null = null;
    let numberOfEpisodes: number | null = null;

    if (mediaType === 'tv') {
      const rawEpRt = sanitized.episode_run_time ?? sanitized.episodeRunTime;
      if (Array.isArray(rawEpRt)) {
        episodeRunTime = rawEpRt
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0 && n <= 600)
          .map((n) => Math.round(n));
      } else if (rawEpRt !== undefined && rawEpRt !== null) {
        issues.push({
          field: 'episode_run_time',
          kind: 'invalid',
          message: 'episode_run_time dizi olmalıdır.',
        });
      }
      const explicitRt = parseOptionalPositiveInt(
        sanitized.runtimeMinutes ?? sanitized.runtime,
        'runtime',
        issues,
        600
      );
      runtimeMinutes =
        explicitRt ??
        (episodeRunTime.length > 0
          ? Math.round(
              episodeRunTime.reduce((acc, v) => acc + v, 0) / episodeRunTime.length
            )
          : null);
      numberOfSeasons = parseOptionalPositiveInt(
        sanitized.number_of_seasons ?? sanitized.numberOfSeasons,
        'number_of_seasons',
        issues,
        100
      );
      numberOfEpisodes = parseOptionalPositiveInt(
        sanitized.number_of_episodes ?? sanitized.numberOfEpisodes,
        'number_of_episodes',
        issues,
        5000
      );
      if (runtimeMinutes === null && episodeRunTime.length === 0) {
        issues.push({ field: 'episode_run_time', kind: 'missing', message: 'Bölüm süresi eksik.' });
      }
      if (numberOfSeasons === null) {
        issues.push({ field: 'number_of_seasons', kind: 'missing', message: 'Sezon sayısı eksik.' });
      }
    } else {
      runtimeMinutes = parseOptionalPositiveInt(
        sanitized.runtime ?? sanitized.runtimeMinutes,
        'runtime',
        issues,
        1000
      );
      if (runtimeMinutes === null) {
        issues.push({ field: 'runtime', kind: 'missing', message: 'Film süresi eksik.' });
      }
    }

    const rawLang = sanitized.original_language ?? sanitized.originalLanguage;
    let originalLanguage: string | null = null;
    if (typeof rawLang === 'string' && rawLang.trim()) {
      originalLanguage = rawLang.trim().toLowerCase();
    } else {
      issues.push({ field: 'original_language', kind: 'missing', message: 'Orijinal dil eksik.' });
    }

    const originCountries = normalizeCountryCodes(
      sanitized.origin_country ?? sanitized.originCountries
    );
    const productionCountries = normalizeCountryCodes(
      sanitized.production_countries ?? sanitized.productionCountries
    );
    if (originCountries.length === 0 && productionCountries.length === 0) {
      issues.push({ field: 'origin_countries', kind: 'missing', message: 'Ülke bilgisi eksik.' });
    }

    // Cast & Crew (credits.cast/crew veya doğrudan cast/crew)
    const creditsObj =
      sanitized.credits && typeof sanitized.credits === 'object'
        ? (sanitized.credits as Record<string, unknown>)
        : {};
    const cast = normalizeCreditsList(sanitized.cast ?? creditsObj.cast, 'cast', issues);
    const crew = normalizeCreditsList(sanitized.crew ?? creditsObj.crew, 'crew', issues);
    if (cast.length === 0 && crew.length === 0) {
      issues.push({ field: 'credits', kind: 'missing', message: 'Oyuncu/ekip kadrosu eksik.' });
    }

    let collection: ContentCollectionRef | null = null;
    if (
      mediaType === 'movie' &&
      sanitized.belongs_to_collection &&
      typeof sanitized.belongs_to_collection === 'object'
    ) {
      const col = sanitized.belongs_to_collection as Record<string, unknown>;
      const cid = Number(col.id);
      if (Number.isInteger(cid) && cid > 0) {
        collection = {
          id: cid,
          ...(typeof col.name === 'string' && col.name.trim() ? { name: col.name.trim() } : {}),
        };
      }
    } else if (
      sanitized.collection &&
      typeof sanitized.collection === 'object'
    ) {
      const col = sanitized.collection as Record<string, unknown>;
      const cid = Number(col.id);
      if (Number.isInteger(cid) && cid > 0) {
        collection = {
          id: cid,
          ...(typeof col.name === 'string' && col.name.trim() ? { name: col.name.trim() } : {}),
        };
      }
    }

    const externalRating = parseOptionalNumber(
      sanitized.externalRating ?? sanitized.vote_average,
      'externalRating',
      issues,
      0,
      10
    );
    const voteCount = parseOptionalNumber(
      sanitized.voteCount ?? sanitized.vote_count,
      'voteCount',
      issues,
      0,
      100_000_000
    );
    const popularity = parseOptionalNumber(
      sanitized.popularity,
      'popularity',
      issues,
      0,
      10_000_000
    );

    const source =
      typeof options.source === 'string' && options.source.trim()
        ? options.source.trim()
        : typeof sanitized.source === 'string' && sanitized.source.trim()
          ? sanitized.source.trim()
          : 'tmdb';

    const acquiredAt =
      options.acquiredAt ||
      (typeof sanitized.acquiredAt === 'string' && sanitized.acquiredAt.trim()
        ? sanitized.acquiredAt.trim()
        : typeof sanitized.fetchedAt === 'string' && sanitized.fetchedAt.trim()
          ? sanitized.fetchedAt.trim()
          : new Date().toISOString());

    const explicitSourceRev =
      options.sourceRevision ??
      (typeof sanitized.source_revision === 'string' && sanitized.source_revision.trim()
        ? sanitized.source_revision.trim()
        : typeof sanitized.sourceRevision === 'string' && sanitized.sourceRevision.trim()
          ? sanitized.sourceRevision.trim()
          : null);

    const processingVersion = options.processingVersion ?? CONTENT_INTELLIGENCE_VERSION;

    const missingFields = [...new Set(issues.filter((i) => i.kind === 'missing').map((i) => i.field))].sort();
    const invalidFields = [...new Set(issues.filter((i) => i.kind === 'invalid').map((i) => i.field))].sort();

    if (errors.length > 0 || !mediaKey || !mediaType || !tmdbId || !title) {
      return {
        valid: false,
        mediaKey,
        mediaType,
        tmdbId,
        imdbId,
        errors,
        issues,
        missingFields,
        invalidFields,
        strippedVisualFields,
        strippedPersonalFields,
        strippedUnknownFields,
        fieldCompleteness: 0,
        sanitizedRawMetadata: sanitized,
        normalized: null,
        dataHash: '',
        sourceRevision: explicitSourceRev || `${source}:invalid`,
      };
    }

    // Deterministik hash için zaman damgalarından bağımsız çekirdek metaveri gövdesi
    const hashPayload = {
      processingVersion,
      mediaKey,
      mediaType,
      tmdbId,
      imdbId,
      title,
      originalTitle,
      overview,
      genres,
      genreIds,
      keywords,
      cast: cast.map((c) => ({ id: c.id, name: c.name, character: c.character ?? null })),
      crew: crew.map((c) => ({
        id: c.id,
        name: c.name,
        job: c.job ?? null,
        department: c.department ?? null,
      })),
      collection,
      releaseDate,
      ...(mediaType === 'tv' ? { firstAirDate: releaseDate } : {}),
      runtimeMinutes,
      episodeRunTime,
      numberOfSeasons,
      numberOfEpisodes,
      originalLanguage,
      originCountries,
      productionCountries,
      externalRating,
      voteCount,
      popularity,
      source,
    };

    const dataHash = computeDeterministicDataHash(hashPayload);
    const sourceRevision = explicitSourceRev || `${source}:${dataHash.slice(0, 12)}`;

    const normalized: NormalizedContentMetadata = {
      mediaKey,
      mediaType,
      tmdbId,
      imdbId,
      title,
      originalTitle,
      overview,
      genres,
      genreIds,
      keywords,
      cast,
      crew,
      collection,
      releaseDate,
      ...(mediaType === 'tv' ? { firstAirDate: releaseDate } : {}),
      runtimeMinutes,
      episodeRunTime,
      numberOfSeasons,
      numberOfEpisodes,
      originalLanguage,
      originCountries,
      productionCountries,
      externalRating,
      voteCount,
      popularity,
      source,
      sourceRevision,
      acquiredAt,
    };

    const trackedFieldChecks = [
      Boolean(title),
      Boolean(overview),
      genreIds.length > 0 || genres.length > 0,
      keywords.length > 0,
      Boolean(releaseDate),
      runtimeMinutes !== null,
      Boolean(originalLanguage),
      originCountries.length > 0 || productionCountries.length > 0,
      cast.length > 0 || crew.length > 0,
      externalRating !== null,
    ];
    const presentCount = trackedFieldChecks.filter(Boolean).length;
    const fieldCompleteness = Math.round((presentCount / trackedFieldChecks.length) * 100) / 100;

    return {
      valid: true,
      mediaKey,
      mediaType,
      tmdbId,
      imdbId,
      errors: [],
      issues,
      missingFields,
      invalidFields,
      strippedVisualFields,
      strippedPersonalFields,
      strippedUnknownFields,
      fieldCompleteness,
      sanitizedRawMetadata: sanitized,
      normalized,
      dataHash,
      sourceRevision,
    };
  }
}

export function createContentMetadataProcessor(): ContentMetadataProcessor {
  return new ContentMetadataProcessor();
}
