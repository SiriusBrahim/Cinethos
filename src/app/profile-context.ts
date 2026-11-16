/**
 * MIA Faz 1B ① — ProfileContext uygulaması (sözleşme: `src/contracts/profile.ts`).
 *
 * BAĞLAMA STRATEJİSİ (davranış değişikliği yasak):
 * Mevcut App.tsx, aktif profili `DataDocument.activeProfileId` + `revision`
 * üzerinden yönetir ve v2 §G korumalarına sahiptir (requestGateRef,
 * applyingRemoteSnapshotRef, *_ref senkronizasyonu). Bu uygulama App.tsx'i
 * DEĞİŞTİRMEZ; mevcut akışı sözleşmeye bağlayan bir sağlayıcı (provider)
 * deseni kullanır: ana bilgisayar (App) güncel anlık görüntüyü bir getter ile
 * verir, ProfileContext bunun üzerinde izolasyon kurallarını uygular.
 *
 * §G uyumu:
 * - `assertCurrent()` requestGateRef'in `isCurrent` denetiminin YANINDA
 *   çağrılır; bilet mekanizmasının YERİNE geçmez (çift güvenlik).
 * - `applyingRemoteSnapshotRef` aktifken ana bilgisayar anlık görüntüyü
 *   yine de verir; yazım bastırma mevcut ref mekanizmasında kalır.
 * - `*_ref` senkronizasyonu korunur; getter'lar ref'lerden okur.
 */

import {
  ProfileConflictError,
  type ProfileChangeEvent,
  type ProfileChangeListener,
  type ProfileRef,
  type IProfileContext,
} from '../contracts/index.ts';

/** Ana bilgisayarın sunduğu güncel profil anlık görüntüsü. */
export interface ProfileSnapshot {
  readonly activeProfileId: string;
  readonly revision: number;
}

/** ProfileContext fabrika seçenekleri. */
export interface CreateProfileContextOptions {
  /**
   * Güncel anlık görüntü sağlayıcı. Her çağrıda CANLI durumu dönmek ZORUNDADIR
   * (App.tsx'te ref tabanlı okuma — `profilesRef`/belge durumu). null, hiç
   * profil yüklenmemiş durumudur.
   */
  readonly getSnapshot: () => ProfileSnapshot | null;
}

/**
 * Uygulama tipi: sözleşme + ana bilgisayar bildirim kanalı.
 * `notifyIfChanged` yalnızca ana bilgisayar tarafından çağrılır (App.tsx'in
 * `handleSwitchProfile`'ı ve uzak snapshot uygulaması — Faz 6/7'de bağlanır).
 */
export type ProfileContextWithHost = IProfileContext & {
  notifyIfChanged(): void;
};

/**
 * IProfileContext'in mevcut akışa bağlanan uygulaması.
 *
 * Kullanım (Faz 6/7'de yönetici kancalarına taşınırken):
 *   const profileContext = createProfileContext({ getSnapshot: () => ({
 *     activeProfileId: docRef.current?.activeProfileId ?? '',
 *     revision: docRef.current?.revision ?? 0,
 *   })});
 */
export function createProfileContext(options: CreateProfileContextOptions): ProfileContextWithHost {
  const { getSnapshot } = options;
  const listeners = new Set<ProfileChangeListener>();

  let lastSeen: ProfileRef | null = null;

  function readCurrent(): ProfileRef | null {
    const snapshot = getSnapshot();
    if (!snapshot || !snapshot.activeProfileId) return null;
    return { profileId: snapshot.activeProfileId, revision: snapshot.revision };
  }

  /** Anlık görüntü değişimini dinleyicilere bildir (ana bilgisayar çağırır). */
  function notifyIfChanged(): void {
    const current = readCurrent();
    const previous = lastSeen;
    if (
      current &&
      (!previous || previous.profileId !== current.profileId || previous.revision !== current.revision)
    ) {
      lastSeen = current;
      const event: ProfileChangeEvent = {
        previous: previous,
        current: current,
      };
      for (const listener of listeners) {
        try {
          const result = listener(event);
          if (result instanceof Promise) result.catch(() => undefined);
        } catch {
          // Dinleyici hatası profil bağlamını bozmaz; arka plan işleyicileri
          // kendi hata yönetiminden sorumludur (sessiz yutma yalnızca burada,
          // bildirim zincirinin korunması için).
        }
      }
    }
  }

  return {
    getCurrent(): ProfileRef {
      const current = readCurrent();
      if (!current) {
        // Henüz profil yüklenmemiş — nötr referans (assertCurrent reddeder).
        return { profileId: '', revision: 0 };
      }
      lastSeen = current;
      return current;
    },

    assertCurrent(ref: ProfileRef): void {
      const current = readCurrent();
      if (!current || !current.profileId) {
        throw new ProfileConflictError('profile-not-found', {
          expectedRevision: ref.revision,
          actualRevision: undefined,
        });
      }
      if (ref.profileId !== current.profileId) {
        throw new ProfileConflictError('profile-switched', {
          expectedRevision: ref.revision,
          actualRevision: current.revision,
        });
      }
      if (ref.revision !== undefined && ref.revision !== current.revision) {
        throw new ProfileConflictError('stale-revision', {
          expectedRevision: ref.revision,
          actualRevision: current.revision,
        });
      }
    },

    async getRevision(): Promise<number> {
      const current = readCurrent();
      return current?.revision ?? 0;
    },

    onProfileChange(listener: ProfileChangeListener): { unsubscribe(): void } {
      listeners.add(listener);
      return {
        unsubscribe(): void {
          listeners.delete(listener);
        },
      };
    },

    notifyIfChanged,
  };
}
