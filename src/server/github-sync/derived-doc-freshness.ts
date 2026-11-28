/**
 * GitHub senkronizasyonu (Faz 5.3 / F5.3-04B) — türetilmiş profil tazeliği.
 *
 * `isDerivedDocFreshForContext` private yöntemi GitHubBidirectionalSyncManager
 * sınıfından buraya taşındı. Yöntem tamamen saftır: verilen belgenin şema/
 * algoritma sürümü, kaynak katalog özeti ve profil imzası yönünden güncel
 * olup olmadığını karar olarak döndürür; dosya, lock veya forge erişimi yoktur.
 * Davranış birebir korunmuştur.
 */

import {
  ALGORITHM_VERSION,
  computeTasteProfileSignature,
  type Profile,
} from '../../core/cinetrack-core.ts';
import { DERIVED_PROFILE_SCHEMA_VERSION } from '../../core/derived-profile-cache.ts';
import type { DerivedProfileDocument } from '../persistent-store-types.ts';

export function isDerivedDocFreshForContext(
  doc: DerivedProfileDocument,
  expectedCatalogHash: string,
  matchingProfile?: Profile
): { valid: boolean; reason?: string } {
  if (Number(doc.schemaVersion) !== DERIVED_PROFILE_SCHEMA_VERSION) {
    return {
      valid: false,
      reason: `Şema sürümü eski (${doc.schemaVersion} != ${DERIVED_PROFILE_SCHEMA_VERSION})`,
    };
  }
  if (doc.algorithmVersion !== ALGORITHM_VERSION) {
    return {
      valid: false,
      reason: `Algoritma sürümü farklı (${doc.algorithmVersion} != ${ALGORITHM_VERSION})`,
    };
  }
  if (doc.sourceCatalogHash && expectedCatalogHash && doc.sourceCatalogHash !== expectedCatalogHash) {
    return {
      valid: false,
      reason: 'Kaynak katalog içerik özeti güncel katalogla uyuşmuyor',
    };
  }
  if (matchingProfile) {
    const expectedFp = computeTasteProfileSignature(
      matchingProfile.items || [],
      matchingProfile.preferences,
      matchingProfile.favoriteActors || [],
      { targetType: 'all', algorithmVersion: ALGORITHM_VERSION }
    );
    if (doc.profileFingerprint !== expectedFp) {
      return {
        valid: false,
        reason: 'Profil imzası (profileFingerprint) güncel kullanıcı tercihleriyle uyuşmuyor',
      };
    }
  }
  return { valid: true };
}
