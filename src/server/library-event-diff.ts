/**
 * MIA Faz 2 — Adım 2.5 (Dilim F): Gerçek kullanıcı liste olaylarının türetilmesi.
 *
 * PUT /api/data gibi gerçek yazma akışlarında önceki ve sonraki belge
 * karşılaştırılarak AppEventBus sözleşmesindeki typed olaylar üretilir.
 *
 * KURALLAR (plan 2.5):
 * - Olay payload'ı ortak metadata deposuna kullanıcıya ait alan TAŞIMAZ;
 *   yalnızca mediaKey/mediaType ve gerekli sinyal alanları kullanılır.
 * - RatingChanged olayı kişisel puanı ortak metadata'ya YAZMAZ (subscriber
 *   yalnızca içerik henüz yoksa indekslemeyi tetikler).
 * - Remove olayı ortak içerik kaydını silmez.
 * - eventId opak ve kişisel olmayan UUID'dir; profil/oyuncu kimliği taşımaz.
 */

import { createAppEvent } from '../app/app-event-bus.ts';
import type { LibraryListId, MediaKind, TypedAppEvent } from '../contracts/index.ts';
import { makeMediaKey } from '../core/keys.ts';
import type { DataDocument, FavoriteActorInfo, Profile, SavedItem } from '../core/cinetrack-core.ts';

/** SavedItem.status → sözleşmedeki LibraryListId eşlemesi. */
export function toLibraryListId(item: SavedItem): LibraryListId {
  if (item.status === 'completed') return 'watched';
  if (item.status === 'watching') return 'watching';
  return 'watchlist';
}

export function savedItemMediaKey(item: SavedItem): string {
  return makeMediaKey(item.media_type, item.id);
}

export function savedItemMediaKind(item: SavedItem): MediaKind {
  return item.media_type === 'tv' ? 'tv' : 'movie';
}

/** Kişisel ilerleme alanları — LibraryItemUpdated changedFields raporunda kullanılır. */
const ITEM_TRACKED_FIELDS: readonly string[] = [
  'title',
  'name',
  'overview',
  'poster_url',
  'poster_path',
  'season_progress',
  'episodes_watched',
  'current_season',
  'next_episode',
  'runtime',
  'episode_run_time',
  'number_of_seasons',
  'number_of_episodes',
  'cast',
  'crew',
  'genres',
  'genre_ids',
];

function createOpaqueEventId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function actorSignature(list: FavoriteActorInfo[] | undefined): string {
  if (!Array.isArray(list)) return '';
  return list
    .map((a) => `${(a as unknown as Record<string, unknown>).id ?? ''}`)
    .sort()
    .join(',');
}

function diffProfileEvents(
  profileBefore: Profile | undefined,
  profileAfter: Profile,
  revision: number
): TypedAppEvent[] {
  const profileId = String(profileAfter.id ?? 'default');
  const ref = { profileId, revision };
  const events: TypedAppEvent[] = [];

  const beforeItems = new Map<string, SavedItem>();
  for (const it of profileBefore?.items ?? []) {
    beforeItems.set(savedItemMediaKey(it), it);
  }
  const afterItems = new Map<string, SavedItem>();
  for (const it of profileAfter.items ?? []) {
    afterItems.set(savedItemMediaKey(it), it);
  }

  const eventId = (): string => createOpaqueEventId();

  // Eklenenler
  for (const [mediaKey, item] of afterItems) {
    if (beforeItems.has(mediaKey)) continue;
    events.push(
      createAppEvent({
        eventType: 'LibraryItemAdded',
        ref,
        entityId: mediaKey,
        eventId: eventId(),
        payload: {
          mediaKey,
          mediaType: savedItemMediaKind(item),
          list: toLibraryListId(item),
        },
      })
    );
  }

  // Silinenler
  for (const [mediaKey, item] of beforeItems) {
    if (afterItems.has(mediaKey)) continue;
    events.push(
      createAppEvent({
        eventType: 'LibraryItemRemoved',
        ref,
        entityId: mediaKey,
        eventId: eventId(),
        payload: {
          mediaKey,
          mediaType: savedItemMediaKind(item),
          previousList: toLibraryListId(item),
        },
      })
    );
  }

  // Güncellenenler
  for (const [mediaKey, after] of afterItems) {
    const before = beforeItems.get(mediaKey);
    if (!before) continue;

    const listBefore = toLibraryListId(before);
    const listAfter = toLibraryListId(after);
    if (listBefore !== listAfter) {
      events.push(
        createAppEvent({
          eventType: 'LibraryStatusChanged',
          ref,
          entityId: mediaKey,
          eventId: eventId(),
          payload: { mediaKey, mediaType: savedItemMediaKind(after), from: listBefore, to: listAfter },
        })
      );
    }

    const ratingBefore = typeof before.personal_rating === 'number' ? before.personal_rating : null;
    const ratingAfter = typeof after.personal_rating === 'number' ? after.personal_rating : null;
    if (ratingBefore !== ratingAfter) {
      events.push(
        createAppEvent({
          eventType: 'LibraryRatingChanged',
          ref,
          entityId: mediaKey,
          eventId: eventId(),
          payload: {
            mediaKey,
            mediaType: savedItemMediaKind(after),
            rating: ratingAfter,
            previousRating: ratingBefore,
          },
        })
      );
    }

    const changedFields = ITEM_TRACKED_FIELDS.filter(
      (f) =>
        JSON.stringify((before as unknown as Record<string, unknown>)[f] ?? null) !==
        JSON.stringify((after as unknown as Record<string, unknown>)[f] ?? null)
    );
    if (changedFields.length > 0) {
      events.push(
        createAppEvent({
          eventType: 'LibraryItemUpdated',
          ref,
          entityId: mediaKey,
          eventId: eventId(),
          payload: { mediaKey, mediaType: savedItemMediaKind(after), changedFields },
        })
      );
    }
  }

  // Favori oyuncu değişimi (kişisel sinyal; ortak tabloya yazılmaz ama
  // olay kataloğunun tamamı gerçek akışlara bağlanmalı).
  const actorsBefore = actorSignature(profileBefore?.favoriteActors);
  const actorsAfter = actorSignature(profileAfter.favoriteActors);
  if (actorsBefore !== actorsAfter) {
    const beforeSet = new Set(actorsBefore.split(',').filter(Boolean));
    const afterSet = new Set(actorsAfter.split(',').filter(Boolean));
    let change: 'added' | 'removed' | 'updated' = 'updated';
    for (const id of afterSet) {
      if (!beforeSet.has(id)) {
        change = 'added';
        break;
      }
    }
    if (change === 'updated') {
      for (const id of beforeSet) {
        if (!afterSet.has(id)) {
          change = 'removed';
          break;
        }
      }
    }
    events.push(
      createAppEvent({
        eventType: 'FavoriteActorChanged',
        ref,
        eventId: eventId(),
        payload: {
          change,
          ...(afterSet.size > 0
            ? { actorId: Number([...afterSet][afterSet.size - 1]) || undefined }
            : {}),
        },
      })
    );
  }

  return events;
}

/**
 * İki veri belgesi arasındaki tüm profil liste değişikliklerini typed
 * AppEvent listesine dönüştürür. Olay sırası: eklenen → silinen → güncellenen.
 */
export function diffLibraryEvents(
  before: DataDocument | null | undefined,
  after: DataDocument
): TypedAppEvent[] {
  const beforeProfiles = new Map<string, Profile>();
  for (const p of before?.profiles ?? []) {
    beforeProfiles.set(String(p.id ?? ''), p);
  }

  const events: TypedAppEvent[] = [];
  const revision = typeof after.revision === 'number' ? after.revision : 0;
  for (const p of after.profiles ?? []) {
    events.push(...diffProfileEvents(beforeProfiles.get(String(p.id ?? '')), p, revision));
  }
  return events;
}

/**
 * Plan 2.5 — "gerekli kaynak ipuçları": Kütüphane olayı yayımlanırken içeriğin
 * ortak (allowlist) metaverisi metadata hint olarak kaydedilir. SavedItem'ın
 * kişisel alanları (status, personal_rating, notlar, izleme ilerlemesi, kullanıcı
 * tarihleri) ContentEventSubscriber.registerMetadataHint içindeki
 * sanitizeRawContentInput ile atılır; yalnızca lisanslı ortak içerik alanları
 * kalır. Hint yoksa tüketicisi yalnızca mediaKey ile kuyruğa alır.
 */
export function findSavedItemByMediaKey(
  doc: DataDocument | null | undefined,
  mediaKey: string
): SavedItem | undefined {
  if (!doc || !mediaKey) return undefined;
  for (const profile of doc.profiles ?? []) {
    for (const item of profile.items ?? []) {
      if (savedItemMediaKey(item) === mediaKey) return item;
    }
  }
  return undefined;
}
