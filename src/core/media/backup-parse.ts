/**
 * Yedek belgesi ayrıştırma (F5-05).
 *
 * Aşama 1 kuralları (B-05/B-06/B-07) birebir korunur: bilinmeyen/gelecek sürüm
 * açık hatayla reddedilir, doğrulanamayan kayıt sessizce düşürülmez.
 */

import { normalizeProfileId } from '../profile-id.ts';
import {
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_ITEMS_PER_PROFILE,
  DEFAULT_MAX_PROFILES,
  formatMaxDataLimitMb,
  measureUtf8Bytes,
} from '../limits.ts';
import {
  enrichSavedItemsFromCinemaKunye,
  extractCinemaKunyeFromItems,
  mergeCinemaKunyeDocumentsLossless,
  normalizeCinemaKunyeDocument,
  type CinemaKunyeDocument,
} from '../cinema-kunye.ts';
import {
  CURRENT_SCHEMA_VERSION,
  LATEST_BACKUP_VERSION,
  SUPPORTED_BACKUP_VERSIONS,
  type ParsedBackupDocument,
  type ParsedBackupProfile,
  type SavedItem,
  type FavoriteActorInfo,
} from './document-types.ts';
import {
  isPlainRecord,
  normalizeDeletedKeys,
  normalizeFavoriteActors,
  normalizeProfile,
  validItemId,
} from './document-normalize.ts';

export function parseBackupText(
  text: string,
  options: { maxBytes?: number } = {}
): ParsedBackupDocument {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DATA_BYTES;
  if (typeof text !== 'string' || measureUtf8Bytes(text) > maxBytes) {
    throw new Error(
      `Gönderilen yedek dosyası izin verilen sınırı (${formatMaxDataLimitMb(maxBytes)}) aşıyor.`
    );
  }

  let backup: any;
  try {
    backup = JSON.parse(text);
  } catch {
    // `SyntaxError` adı korunur (çağıranlar bozuk JSON'ı ayırt edebilsin).
    throw new SyntaxError('Yedek dosyası bozuk JSON içeriyor; içe aktarma durduruldu.');
  }
  if (!isPlainRecord(backup)) {
    throw new Error('Bu dosya geçerli bir Cinethos yedeği değil.');
  }

  // Sürüm alanı sayı olmalı; "4" gibi metin sürümler sessizce kabul edilmez.
  const version = backup.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('Bu dosya geçerli bir Cinethos yedeği değil (sürüm bilgisi okunamadı).');
  }
  if (version > LATEST_BACKUP_VERSION) {
    throw new Error(
      `Bu yedek daha yeni bir Cinethos sürümüyle (v${version}) oluşturulmuş. ` +
        `Veri kaybını önlemek için uygulamayı güncelleyin; bu sürüm en fazla v${LATEST_BACKUP_VERSION} yedekleri içe aktarabilir.`
    );
  }

  const containsFullDocument = Array.isArray(backup.profiles) && backup.profiles.length > 0;
  let rawProfiles: any[];
  if (version >= 4 && !containsFullDocument) {
    throw new Error(
      "Bu dosya geçerli bir Cinethos yedeği değil (v4 yedeğinde 'profiles' listesi zorunludur)."
    );
  }
  if (containsFullDocument) {
    rawProfiles = backup.profiles;
  } else if (Array.isArray(backup.items)) {
    rawProfiles = [
      {
        id: normalizeProfileId(backup.profileId) ?? 'PROFILE-DEFAULT',
        name: typeof backup.profileName === 'string' ? backup.profileName : 'Profilim',
        createdAt: typeof backup.createdAt === 'string' ? backup.createdAt : '',
        preferences: backup.preferences,
        items: backup.items,
        favoriteActors: backup.favoriteActors,
        deleted_keys: backup.deleted_keys,
        isDemo: backup.isDemo === true,
        cinemaKunye: backup.cinemaKunye || backup.sinemaKunyesi || null,
      },
    ];
  } else {
    throw new Error('Bu dosya geçerli bir Cinethos yedeği değil.');
  }

  if (rawProfiles.length > DEFAULT_MAX_PROFILES) {
    throw new Error(
      `Yedek ${rawProfiles.length} profil içeriyor; izin verilen en fazla ${DEFAULT_MAX_PROFILES} profil destekleniyor. ` +
        `Veri kaybını önlemek için içe aktarma durduruldu.`
    );
  }

  const seenProfileIds = new Set<string>();
  const normalizedProfiles: ParsedBackupProfile[] = [];
  const kunyeParts: CinemaKunyeDocument[] = [
    normalizeCinemaKunyeDocument(backup.cinemaKunye || backup.sinemaKunyesi || null),
  ];

  for (const [index, rawProfile] of rawProfiles.entries()) {
    if (!isPlainRecord(rawProfile)) {
      throw new Error(`Yedekteki ${index + 1}. profil geçersiz; içe aktarma durduruldu.`);
    }
    const canonicalId = normalizeProfileId(rawProfile.id);
    if (!canonicalId) {
      throw new Error(
        `Yedekteki ${index + 1}. profilin kimliği geçersiz ('${String(rawProfile.id ?? '')}'). ` +
          `Profil sessizce düşürülmedi; içe aktarma durduruldu.`
      );
    }
    if (seenProfileIds.has(canonicalId)) {
      throw new Error(
        `Yedekte yinelenen profil kimliği var (${canonicalId}); hangi profilin geçerli olduğu belirsiz. İçe aktarma durduruldu.`
      );
    }
    seenProfileIds.add(canonicalId);

    const rawItems = rawProfile.items;
    if (rawItems !== undefined && !Array.isArray(rawItems)) {
      throw new Error(`Yedekteki '${canonicalId}' profilinin kayıtları dizi değil.`);
    }
    const itemsArray: any[] = Array.isArray(rawItems) ? rawItems : [];
    if (itemsArray.length > DEFAULT_MAX_ITEMS_PER_PROFILE) {
      throw new Error(
        `Yedekteki '${canonicalId}' profili ${itemsArray.length} kayıt içeriyor; ` +
          `izin verilen sınır ${DEFAULT_MAX_ITEMS_PER_PROFILE}. Veri kaybını önlemek için içe aktarma durduruldu.`
      );
    }
    if (
      itemsArray.some(
        (item: any) =>
          !isPlainRecord(item) || !validItemId(item.id) || !['movie', 'tv'].includes(item.media_type)
      )
    ) {
      throw new Error(
        `Yedekte geçersiz içerik kimliği veya türü var ('${canonicalId}'). Güvenlik nedeniyle içe aktarma durduruldu.`
      );
    }

    const normalized = normalizeProfile(
      { ...rawProfile, id: canonicalId },
      { maxItems: DEFAULT_MAX_ITEMS_PER_PROFILE }
    );
    if (!normalized) {
      throw new Error(`Yedekteki '${canonicalId}' profili normalize edilemedi; içe aktarma durduruldu.`);
    }

    kunyeParts.push(
      normalizeCinemaKunyeDocument(rawProfile.cinemaKunye || rawProfile.sinemaKunyesi || null)
    );

    normalizedProfiles.push({
      id: normalized.id,
      name: normalized.name,
      createdAt: normalized.createdAt,
      preferences: normalized.preferences,
      items: normalized.items,
      favoriteActors: normalized.favoriteActors || [],
      ...(normalized.deleted_keys && Object.keys(normalized.deleted_keys).length > 0
        ? { deleted_keys: normalized.deleted_keys }
        : {}),
      isDemo: Boolean(normalized.isDemo),
    });
  }

  if (normalizedProfiles.length === 0) {
    throw new Error('Yedekte içe aktarılabilecek profil bulunamadı.');
  }

  const requestedActive = normalizeProfileId(backup.activeProfileId);
  const activeProfile =
    normalizedProfiles.find((profile) => profile.id === requestedActive) ?? normalizedProfiles[0];

  const rawSchemaVer = Number(backup.schemaVersion || backup.version);
  const schemaVersion =
    Number.isSafeInteger(rawSchemaVer) && rawSchemaVer > 0 ? rawSchemaVer : CURRENT_SCHEMA_VERSION;

  let cinemaKunye = kunyeParts.reduce(
    (acc, part) => mergeCinemaKunyeDocumentsLossless(acc, part),
    normalizeCinemaKunyeDocument(null)
  );
  const allItems = normalizedProfiles.flatMap((profile) => profile.items);
  cinemaKunye = mergeCinemaKunyeDocumentsLossless(cinemaKunye, extractCinemaKunyeFromItems(allItems));

  const enrichedProfiles = normalizedProfiles.map((profile) => ({
    ...profile,
    items: enrichSavedItemsFromCinemaKunye(profile.items, cinemaKunye),
  }));
  const enrichedActive =
    enrichedProfiles.find((profile) => profile.id === activeProfile.id) ?? enrichedProfiles[0];
  // Ham tercih nesnesi (geçersizse null) — çağıranlar normalize edilmiş kopyayı
  // profil kaydından alır; bu alan geriye dönük bilgi amaçlıdır.
  const rawActiveProfile =
    rawProfiles[normalizedProfiles.findIndex((profile) => profile.id === enrichedActive.id)] ??
    rawProfiles[0];
  const rawPreferences =
    isPlainRecord(rawActiveProfile?.preferences) ? rawActiveProfile.preferences : null;

  const rawRevision = Number(backup.revision);
  return {
    version,
    schemaVersion,
    containsFullDocument,
    activeProfileId: enrichedActive.id,
    profiles: enrichedProfiles,
    items: enrichedActive.items,
    profileName: enrichedActive.name.trim().slice(0, 40),
    preferences: rawPreferences,
    favoriteActors: normalizeFavoriteActors(enrichedActive.favoriteActors),
    cinemaKunye,
    isDemo: Boolean(enrichedActive.isDemo),
    ...(Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? { revision: rawRevision } : {}),
    deletedKeys: normalizeDeletedKeys(enrichedActive.deleted_keys),
  };
}


