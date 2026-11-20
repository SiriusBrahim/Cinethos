/**
 * Faz 3 — Sunucu senkronizasyonunun saf birleştirme adımı.
 *
 * App.tsx içindeki `mergeRemoteDocumentIntoState` gövdesinin hesaplama kısmı
 * buraya taşındı: normalize → kayıpsız birleştirme → aktif profil çıkarımı →
 * \"yerel ileride mi\" kararı. React state atamaları App'te kalır (koordinatör).
 *
 * Aynı birleştirme kuralları kullanılır; yeni bir senkron yolu açılmaz.
 */

import {
  normalizeDeletedKeys,
  normalizeFavoriteActors,
  normalizeDataDocument,
  type DataDocument,
  type FavoriteActorInfo,
  type Profile,
} from '../core/cinetrack-core.ts';
import {
  areUserDataDocumentsSemanticallyEqual,
  reconcileUserDataDocumentsLossless,
} from '../core/user-data-merge.ts';

export interface RemoteMergeOptions {
  readonly preferActiveFrom?: 'local' | 'remote';
  readonly foldUnhydrated?: boolean;
  readonly keepDirtyIfLocalAhead?: boolean;
}

export interface RemoteMergeResult {
  readonly mergedDoc: DataDocument;
  readonly activeProfile: Profile;
  readonly favoriteActors: FavoriteActorInfo[];
  readonly deletedKeys: Record<string, string>;
  readonly shouldStayDirty: boolean;
}

/**
 * Uzak belgeyi yerel canlı belgeyle kayıpsız birleştirir.
 * Geçersiz belge için `null` döner (çağıran mevcut durumu korur).
 */
export function mergeRemoteDocument(
  localDoc: DataDocument,
  rawRemoteDoc: DataDocument,
  options: RemoteMergeOptions = {}
): RemoteMergeResult | null {
  const remoteDoc = normalizeDataDocument(rawRemoteDoc);
  if (!remoteDoc) return null;

  const { mergedDoc } = reconcileUserDataDocumentsLossless(localDoc, remoteDoc, {
    foldUnhydratedDefaultProfile: Boolean(options.foldUnhydrated),
    preferActiveProfileFrom: options.preferActiveFrom || 'local',
  });

  const activeProfile =
    mergedDoc.profiles.find((profile) => profile.id === mergedDoc.activeProfileId) ||
    mergedDoc.profiles[0];
  if (!activeProfile) return null;

  const favoriteActors = normalizeFavoriteActors(activeProfile.favoriteActors || []);
  const deletedKeys = normalizeDeletedKeys(activeProfile.deleted_keys);

  const localHasUnpushedAdditions = !areUserDataDocumentsSemanticallyEqual(mergedDoc, remoteDoc);
  const shouldStayDirty =
    options.keepDirtyIfLocalAhead !== false && localHasUnpushedAdditions;

  return { mergedDoc, activeProfile, favoriteActors, deletedKeys, shouldStayDirty };
}
