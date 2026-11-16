/**
 * MIA Faz 4 — Olay payload'ı allowlist'i.
 *
 * Kalıcı olay defterine YALNIZCA işleyicinin ihtiyaç duyduğu, olay türüne özgü
 * alanlar yazılır. Notlar, yorumlar, izleme geçmişi veya diğer profil alanları
 * deftere taşınmaz (payload minimizasyonu — talimat §4.2).
 */

import type { AppEventMap } from '../../contracts/index.ts';

type PayloadSource = Readonly<Record<string, unknown>>;

const EVENT_PAYLOAD_ALLOWLIST: Record<keyof AppEventMap, readonly string[]> = {
  LibraryItemAdded: ['mediaKey', 'mediaType', 'list'],
  LibraryItemUpdated: ['mediaKey', 'mediaType', 'changedFields'],
  LibraryStatusChanged: ['mediaKey', 'mediaType', 'from', 'to'],
  LibraryRatingChanged: ['mediaKey', 'mediaType', 'rating'],
  LibraryItemRemoved: ['mediaKey', 'mediaType', 'previousList'],
  FavoriteActorChanged: ['change', 'actorId'],
  // Profil kimliği zaten `profile_id` kolonunda; olay payload'ında yalnızca hedef kimlik.
  ProfileSwitched: ['toProfileId'],
  CatalogItemEnriched: ['mediaKey', 'mediaType', 'enrichedFields'],
};

function primitiveOrArray(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter(
      (entry) => entry === null || ['string', 'number', 'boolean'].includes(typeof entry),
    );
  }
  return undefined;
}

/**
 * Olay payload'ını tür başına allowlist ile küçültür. Bilinmeyen tür için boş
 * nesne döner: kalıcı defter asla rastgele kullanıcı verisi taşımaz.
 */
export function sanitizeEventPayload(
  eventType: string,
  payload: unknown
): Record<string, unknown> {
  const allowlist = EVENT_PAYLOAD_ALLOWLIST[eventType as keyof AppEventMap];
  if (!allowlist || !payload || typeof payload !== 'object') return {};
  const source = payload as PayloadSource;
  const out: Record<string, unknown> = {};
  for (const key of allowlist) {
    const value = primitiveOrArray(source[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Olay türü için allowlist alanları (dokümantasyon/test amaçlı). */
export function getEventPayloadAllowlist(eventType: string): readonly string[] {
  return EVENT_PAYLOAD_ALLOWLIST[eventType as keyof AppEventMap] ?? [];
}
