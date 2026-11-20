/**
 * Faz 3 — Sezon/bölüm ilerlemesinin kayıpsız ama geri alınabilir modeli.
 *
 * Eski model yalnızca "sezon başına izlenen bölüm sayısı" (`season_progress`)
 * tutuyordu ve senkronizasyonda `Math.max(local, remote)` kullanıldığı için
 * kullanıcı yanlışlıkla işaretlediği ilerlemeyi geri alamıyordu. Bu modül üç
 * ek alanla bunu çözer:
 *
 * - `watched_episodes`: sezon → izlenmiş bölüm numaraları. Sırasız izlemeyi
 *   (1, 3, 5 izlenmiş; 2, 4 izlenmemiş) temsil eder.
 * - `progress_updated_at`: sezon → ilerlemenin son **bilinçli** değişim anı.
 *   Birleştirmede deterministik kazananı seçer ve geriye dönük düzeltmeyi
 *   (10 → 8) eski veriden ayırır.
 * - `watchedAt`: izleme etkileşiminin son anı (`updatedAt` değildir).
 *
 * Geriye dönük uyumluluk: yeni alanlar yoksa `season_progress` okunur ve
 * birleştirme eski `Math.max` davranışına düşer; mevcut veri kaybolmaz.
 */

import type { SavedItem } from './cinetrack-core.ts';
import {
  sanitizeSeasonProgressTimestamps,
  sanitizeSeasonWatchedMarks,
  type SeasonProgressTimestamps,
  type SeasonWatchedMarks,
} from './cinetrack-core.ts';

export type { SeasonProgressTimestamps, SeasonWatchedMarks };
export { sanitizeSeasonProgressTimestamps, sanitizeSeasonWatchedMarks };

function toSeasonNumber(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < 1 || num > 300) return null;
  return num;
}

function toEpisodeNumber(value: unknown, max = 10000): number | null {
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num < 1 || num > max) return null;
  return num;
}

/** Sayaçtan sıralı bölüm listesi üretir (legacy veriyi yeni modele taşır). */
export function seasonWatchedMarksFromProgress(
  progress: Record<number, number> | undefined | null
): SeasonWatchedMarks {
  const out: SeasonWatchedMarks = {};
  if (!progress) return out;
  for (const [rawSeason, rawCount] of Object.entries(progress)) {
    const season = toSeasonNumber(rawSeason);
    if (season === null) continue;
    const count = Math.max(0, Math.floor(Number(rawCount) || 0));
    if (count > 0) {
      out[season] = Array.from({ length: Math.min(count, 10000) }, (_, i) => i + 1);
    }
  }
  return out;
}

/** İşaretlerden sezon başına sayaç üretir. */
export function seasonProgressFromMarks(marks: SeasonWatchedMarks): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [rawSeason, episodes] of Object.entries(marks)) {
    const season = toSeasonNumber(rawSeason);
    if (season === null) continue;
    out[season] = episodes.length;
  }
  return out;
}

/** Kaydın etkin bölüm işaretleri: yeni alan varsa o, yoksa sayaçtan türetilir. */
export function effectiveSeasonMarks(
  item: Partial<SavedItem> | null | undefined
): SeasonWatchedMarks {
  if (!item) return {};
  const explicit = sanitizeSeasonWatchedMarks(item.watched_episodes);
  if (Object.keys(explicit).length > 0) return explicit;
  return seasonWatchedMarksFromProgress(item.season_progress);
}

/**
 * İzlenmiş bölümlerin "baştan kesintisiz" sayısı. Sırasız izlemede (1, 3, 5)
 * aktif bölüm 1'dir; toplam izlenen sayı 3'tür.
 */
export function contiguousWatchedCount(episodes: readonly number[]): number {
  const set = new Set(episodes);
  let count = 0;
  while (set.has(count + 1)) count += 1;
  return count;
}

export interface SeasonProgressPatch {
  readonly season_progress?: Record<number, number>;
  readonly watched_episodes?: SeasonWatchedMarks;
  readonly progress_updated_at?: SeasonProgressTimestamps;
}

/**
 * Bir bölümün izlenme durumunu değiştirir. Sayaç, işaretlerden yeniden üretilir;
 * böylece sırasız izleme korunur ve "izlenmedi" işaretlemesi kalıcı olur.
 */
export function setEpisodeWatched(
  item: SavedItem,
  season: number,
  episode: number,
  watched: boolean,
  nowIso: string = new Date().toISOString()
): SeasonProgressPatch {
  const seasonNum = toSeasonNumber(season);
  const episodeNum = toEpisodeNumber(episode);
  if (seasonNum === null || episodeNum === null) return {};

  const marks = { ...effectiveSeasonMarks(item) };
  const current = new Set(marks[seasonNum] || []);
  if (watched) current.add(episodeNum);
  else current.delete(episodeNum);
  const nextEpisodes = Array.from(current).sort((a, b) => a - b);

  const nextMarks = { ...marks };
  if (nextEpisodes.length > 0) nextMarks[seasonNum] = nextEpisodes;
  else delete nextMarks[seasonNum];

  const timestamps = { ...sanitizeSeasonProgressTimestamps(item.progress_updated_at) };
  timestamps[seasonNum] = nowIso;

  return {
    season_progress: { ...(item.season_progress || {}), ...seasonProgressFromMarks({ [seasonNum]: nextEpisodes }), [seasonNum]: nextEpisodes.length },
    watched_episodes: nextMarks,
    progress_updated_at: timestamps,
  };
}

/**
 * Bir sezonun sayaç değerini bilinçli olarak ayarlar (10 → 8 gibi geri alma).
 * İşaretleri sayaca göre yeniden kurar ve sezonun ilerleme zamanını damgalar.
 */
export function setSeasonWatchedCount(
  item: SavedItem,
  season: number,
  count: number,
  nowIso: string = new Date().toISOString()
): SeasonProgressPatch {
  const seasonNum = toSeasonNumber(season);
  if (seasonNum === null) return {};
  const marks = { ...effectiveSeasonMarks(item) };
  const safeCount = Math.max(0, Math.min(10000, Math.floor(Number(count) || 0)));
  if (safeCount > 0) {
    marks[seasonNum] = Array.from({ length: safeCount }, (_, i) => i + 1);
  } else {
    delete marks[seasonNum];
  }
  const timestamps = { ...sanitizeSeasonProgressTimestamps(item.progress_updated_at) };
  timestamps[seasonNum] = nowIso;
  return {
    season_progress: {
      ...(item.season_progress || {}),
      ...seasonProgressFromMarks({ [seasonNum]: marks[seasonNum] || [] }),
      [seasonNum]: safeCount,
    },
    watched_episodes: marks,
    progress_updated_at: timestamps,
  };
}

export interface SeasonProgressMergeResult {
  readonly season_progress: Record<number, number>;
  readonly watched_episodes: SeasonWatchedMarks;
  readonly progress_updated_at: SeasonProgressTimestamps;
  /** Sezon düzeyinde uzak/yerel çakışması yaşanan sezonlar (raporlama için). */
  readonly conflictingSeasons: number[];
}

function marksFor(count: number): number[] {
  return count > 0 ? Array.from({ length: Math.min(count, 10000) }, (_, i) => i + 1) : [];
}

/**
 * Sezon ilerlemesini deterministik biçimde birleştirir.
 *
 * Her sezon bağımsız değerlendirilir:
 * 1. İki tarafta da `progress_updated_at` varsa **yeni olan kazanır** (geri alma
 *    dahil, `Math.max` yok).
 * 2. Yalnızca bir tarafta damga varsa o taraf kazanır (eski istemci damgasız veri
 *    gönderdiğinde bilinçli düzenleme ezilmez).
 * 3. Hiç damga yoksa ve işaret verisi varsa işaretler birleştirilir (kayıpsız
 *    legacy politikası); yoksa eski `Math.max` davranışı korunur.
 */
export function mergeSeasonProgressLossless(
  localItem: Pick<
    SavedItem,
    'season_progress' | 'watched_episodes' | 'progress_updated_at' | 'watchedAt'
  >,
  remoteItem: Pick<
    SavedItem,
    'season_progress' | 'watched_episodes' | 'progress_updated_at' | 'watchedAt'
  >
): SeasonProgressMergeResult {
  const localProgress = localItem.season_progress || {};
  const remoteProgress = remoteItem.season_progress || {};
  const localMarks = sanitizeSeasonWatchedMarks(localItem.watched_episodes);
  const remoteMarks = sanitizeSeasonWatchedMarks(remoteItem.watched_episodes);
  const localStamps = sanitizeSeasonProgressTimestamps(localItem.progress_updated_at);
  const remoteStamps = sanitizeSeasonProgressTimestamps(remoteItem.progress_updated_at);

  const seasons = new Set<number>();
  for (const source of [localProgress, remoteProgress, localMarks, remoteMarks, localStamps, remoteStamps]) {
    for (const raw of Object.keys(source || {})) {
      const season = toSeasonNumber(raw);
      if (season !== null) seasons.add(season);
    }
  }

  const progress: Record<number, number> = {};
  const marks: SeasonWatchedMarks = {};
  const stamps: SeasonProgressTimestamps = {};
  const conflictingSeasons: number[] = [];

  for (const season of Array.from(seasons).sort((a, b) => a - b)) {
    const localStamp = localStamps[season];
    const remoteStamp = remoteStamps[season];
    const localCount = Math.max(0, Math.floor(Number(localProgress[season]) || 0));
    const remoteCount = Math.max(0, Math.floor(Number(remoteProgress[season]) || 0));

    let winner: 'local' | 'remote';
    if (localStamp && remoteStamp) {
      const lMs = Date.parse(localStamp);
      const rMs = Date.parse(remoteStamp);
      if (lMs !== rMs) {
        winner = lMs > rMs ? 'local' : 'remote';
      } else {
        // Aynı damga: deterministik eşitlik — mezar taşı riskini önlemek için
        // daha küçük sayaç (bilinçli geri alma) değil, daha büyük veri kümesi
        // değil; sözlüksel karşılaştırma ile sabit bir taraf seçilir.
        winner = String(localMarks[season] || localCount) <= String(remoteMarks[season] || remoteCount)
          ? 'local'
          : 'remote';
      }
      if (localCount !== remoteCount) conflictingSeasons.push(season);
    } else if (localStamp) {
      winner = 'local';
    } else if (remoteStamp) {
      winner = 'remote';
    } else if (localMarks[season] || remoteMarks[season]) {
      // Damgasız legacy veri: işaretleri kayıpsız birleştir (eski politika).
      const union = Array.from(new Set([...(localMarks[season] || []), ...(remoteMarks[season] || [])])).sort(
        (a, b) => a - b
      );
      if (union.length > 0) marks[season] = union;
      progress[season] = union.length;
      continue;
    } else {
      const winnerCount = Math.max(localCount, remoteCount);
      progress[season] = winnerCount;
      if (winnerCount > 0) marks[season] = marksFor(winnerCount);
      continue;
    }

    const winningMarks =
      winner === 'local' ? localMarks[season] : remoteMarks[season];
    const winningCount = winner === 'local' ? localCount : remoteCount;
    const resolvedMarks = winningMarks && winningMarks.length > 0 ? winningMarks : marksFor(winningCount);
    progress[season] = resolvedMarks.length;
    if (resolvedMarks.length > 0) marks[season] = resolvedMarks;
    const winningStamp = winner === 'local' ? localStamp : remoteStamp;
    if (winningStamp) stamps[season] = winningStamp;
  }

  return {
    season_progress: progress,
    watched_episodes: marks,
    progress_updated_at: stamps,
    conflictingSeasons,
  };
}
