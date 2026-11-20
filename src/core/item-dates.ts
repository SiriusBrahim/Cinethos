/**
 * Faz 3 — Etkileşim tarihlerinin tek çözümleyicisi.
 *
 * `SavedItem` içinde dört ayrı zaman kavramı vardır ve bunlar birbirinin yerine
 * kullanılmamalıdır:
 *
 * - `addedAt` / `firstAddedAt`: içeriğin listeye ilk eklendiği an.
 * - `watchedAt`: izleme ilerlemesinin son değiştiği an (bölüm işaretleme dahil).
 * - `ratedAt`: kullanıcının puan verdiği an.
 * - `completedAt`: izlemenin tamamlandığı an.
 * - `updatedAt`: kaydın **son düzenlendiği** an (not, metadata, liste taşıma…).
 *
 * Kural: sinyal yaşı, yıllık özet ve dışa aktarma yalnızca gerçek etkileşim
 * tarihlerini kullanır. `updatedAt` bir not düzenlemesiyle değişebildiği için
 * izlenme/puanlama tarihi yerine kullanılmaz; yalnızca hiçbir etkileşim tarihi
 * bulunmayan eski kayıtlarda son çare olarak okunur.
 */

/**
 * Bu modül bilinçli olarak `cinetrack-core`'a bağımlı DEĞİLDİR; yalnızca
 * yapısal alan sözleşmesini kullanır. Böylece çekirdek modül tarih
 * çözümleyicisini içe aktarırken modül döngüsü oluşmaz.
 */
export interface ItemDateFields {
  addedAt?: string;
  firstAddedAt?: string;
  watchedAt?: string;
  ratedAt?: string;
  completedAt?: string;
  updatedAt?: string;
  status?: string;
}

export interface ItemInteractionDates {
  readonly addedAt?: string;
  readonly firstAddedAt?: string;
  readonly watchedAt?: string;
  readonly ratedAt?: string;
  readonly completedAt?: string;
  /** Son düzenleme; etkileşim tarihi DEĞİLDİR. */
  readonly lastEditedAt?: string;
}

function cleanIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseMs(value: string | undefined): number {
  if (!value) return NaN;
  return Date.parse(value);
}

function maxIso(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  let bestMs = -Infinity;
  for (const value of values) {
    const ms = parseMs(value);
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = value;
    }
  }
  return best;
}

/** Kayıttaki tarih alanlarını anlamsal adlarıyla döndürür. */
export function resolveItemInteractionDates(
  item: ItemDateFields | null | undefined
): ItemInteractionDates {
  if (!item) return {};
  return {
    addedAt: cleanIso(item.addedAt),
    firstAddedAt: cleanIso(item.firstAddedAt) ?? cleanIso(item.addedAt),
    watchedAt: cleanIso(item.watchedAt),
    ratedAt: cleanIso(item.ratedAt),
    completedAt: cleanIso(item.completedAt),
    lastEditedAt: cleanIso(item.updatedAt),
  };
}

/**
 * Sinyal yaşı için kullanılacak tarih: puan → tamamlama → izleme → ekleme.
 * `updatedAt` bilinçli olarak yoktur (not düzenlemesi sinyali tazelemez).
 */
export function resolveItemSignalDate(item: ItemDateFields | null | undefined): string | undefined {
  const dates = resolveItemInteractionDates(item);
  return dates.ratedAt ?? dates.completedAt ?? dates.watchedAt ?? dates.addedAt ?? dates.firstAddedAt;
}

/**
 * "İzlenme tarihi" olarak gösterilecek tarih. `updatedAt` kullanılmaz; hiçbir
 * etkileşim tarihi yoksa `undefined` döner (uydurma tarih üretilmez).
 */
export function resolveItemWatchedDate(item: ItemDateFields | null | undefined): string | undefined {
  const dates = resolveItemInteractionDates(item);
  return dates.completedAt ?? dates.watchedAt ?? dates.ratedAt ?? dates.addedAt ?? dates.firstAddedAt;
}

/** Yalnızca gerçek etkileşim tarihlerinden en yenisi (ms). Yoksa NaN. */
export function resolveItemInteractionTimestampMs(
  item: ItemDateFields | null | undefined
): number {
  const dates = resolveItemInteractionDates(item);
  const iso = maxIso([dates.watchedAt, dates.ratedAt, dates.completedAt, dates.addedAt, dates.firstAddedAt]);
  return parseMs(iso);
}

/**
 * Mezar taşı (tombstone) karşılaştırmaları için son bilinen zaman: etkileşim
 * tarihleri, hiçbiri yoksa `updatedAt` (eski kayıt uyumluluğu).
 */
export function resolveItemLastKnownTimestampMs(
  item: ItemDateFields | null | undefined
): number {
  const interaction = resolveItemInteractionTimestampMs(item);
  if (Number.isFinite(interaction)) return interaction;
  return parseMs(resolveItemInteractionDates(item).lastEditedAt);
}

export interface InteractionDateBackfillResult<T extends ItemDateFields = ItemDateFields> {
  readonly items: T[];
  readonly changedCount: number;
  /** Yeni alanlara taşınan kayıt sayısı (alan adı → adet). */
  readonly filled: Record<string, number>;
}

/**
 * Eski kayıtlar için güvenli ve idempotent geri doldurma.
 *
 * - `firstAddedAt` yoksa `addedAt`'ten türetilir.
 * - `watchedAt` yalnızca kesin bilgi varsa doldurulur: tamamlanmış kayıtta
 *   `completedAt`, izlenen kayıtta `ratedAt`. `updatedAt` **asla** izlenme
 *   tarihi olarak kabul edilmez (yalnızca ekleme tarihi hiç yoksa `addedAt`
 *   olarak kullanılır, çünkü eski sürümler ekleme anını başka yerde tutmuyordu).
 *
 * Var olan değerlerin üzerine yazılmaz; mevcut kullanıcı verisi kaybolmaz.
 */
export function backfillInteractionDates<T extends ItemDateFields>(
  items: readonly T[]
): InteractionDateBackfillResult<T> {
  const filled: Record<string, number> = {};
  let changedCount = 0;
  const next = (Array.isArray(items) ? items : []).map((item) => {
    if (!item || typeof item !== 'object') return item;
    const patch: Partial<ItemDateFields> = {};

    if (!cleanIso(item.firstAddedAt) && cleanIso(item.addedAt)) {
      patch.firstAddedAt = cleanIso(item.addedAt) as string;
    }
    if (!cleanIso(item.addedAt) && cleanIso(item.firstAddedAt)) {
      patch.addedAt = cleanIso(item.firstAddedAt) as string;
    }
    if (!cleanIso(item.watchedAt)) {
      const derived =
        item.status === 'completed'
          ? cleanIso(item.completedAt)
          : item.status === 'watching'
          ? cleanIso(item.ratedAt)
          : undefined;
      if (derived) patch.watchedAt = derived;
    }

    if (Object.keys(patch).length === 0) return item;
    changedCount += 1;
    for (const key of Object.keys(patch)) {
      filled[key] = (filled[key] || 0) + 1;
    }
    return { ...item, ...patch } as T;
  });

  return { items: next, changedCount, filled };
}
