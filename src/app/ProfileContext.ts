/**
 * MIA Faz 1B — Adım 6: ProfileContext Gerçek Uygulaması.
 *
 * Tek doğruluk kaynağı olarak aktif profil kimliğini ve güncel belge
 * revision'ını tutar; profil değişimlerini dinleyicilere ve isteğe bağlı
 * `IEventPublisher` kanalına (`ProfileSwitched`) bildirir.
 */

import { normalizeProfileId } from '../core/profile-id.ts';
import {
  ProfileConflictError,
  type IEventPublisher,
  type IProfileContext,
  type ProfileChangeEvent,
  type ProfileChangeListener,
  type ProfileRef,
  type TypedAppEvent,
  type WriteProfileRef,
} from '../contracts/index.ts';

function requireCanonicalProfileId(profileId: unknown): string {
  return normalizeProfileId(profileId) ?? '';
}

function isValidRevision(revision: unknown): revision is number {
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0;
}

function makeFrozenRef(profileId: string, revision: number): WriteProfileRef {
  return Object.freeze({ profileId, revision });
}

export interface ProfileContextOptions {
  initialProfileId: string;
  initialRevision?: number;
  eventPublisher?: IEventPublisher;
  onInvalidateInFlight?: () => void;
}

export class ProfileContext implements IProfileContext {
  private current: WriteProfileRef;
  private readonly listeners = new Set<ProfileChangeListener>();
  private eventPublisher?: IEventPublisher;
  private readonly onInvalidateInFlight?: () => void;

  constructor(options: ProfileContextOptions) {
    const profileId = requireCanonicalProfileId(options.initialProfileId);
    if (!profileId) {
      throw new ProfileConflictError('profile-not-found', {
        message: 'Başlangıç profil kimliği boş olamaz.',
      });
    }
    const revision = options.initialRevision ?? 0;
    if (!isValidRevision(revision)) {
      throw new ProfileConflictError('stale-revision', {
        expectedRevision: revision,
        message: `Geçersiz başlangıç revision değeri: ${String(options.initialRevision)}`,
      });
    }
    this.current = makeFrozenRef(profileId, revision);
    this.eventPublisher = options.eventPublisher;
    this.onInvalidateInFlight = options.onInvalidateInFlight;
  }

  attachEventPublisher(publisher: IEventPublisher | undefined): void {
    this.eventPublisher = publisher;
  }

  getCurrent(): WriteProfileRef {
    return this.current;
  }

  assertCurrent(ref: ProfileRef): void {
    const profileId = requireCanonicalProfileId(ref?.profileId);
    if (!profileId) {
      throw new ProfileConflictError('profile-not-found', {
        message: 'Profil referansında geçerli bir profileId yok.',
      });
    }
    if (profileId !== this.current.profileId) {
      throw new ProfileConflictError('profile-switched', {
        expectedRevision: ref.revision,
        actualRevision: this.current.revision,
        message: `Profil değişti: işlem '${profileId}' için başlatıldı, aktif profil '${this.current.profileId}'.`,
      });
    }
    if (ref.revision !== undefined) {
      if (!isValidRevision(ref.revision) || ref.revision !== this.current.revision) {
        throw new ProfileConflictError('stale-revision', {
          expectedRevision: ref.revision,
          actualRevision: this.current.revision,
        });
      }
    }
  }

  assertWritable(ref: WriteProfileRef): void {
    if (!isValidRevision(ref?.revision)) {
      throw new ProfileConflictError('stale-revision', {
        expectedRevision: ref?.revision,
        actualRevision: this.current.revision,
        message: 'Yazma işlemi için geçerli bir kaynak revision zorunludur.',
      });
    }
    this.assertCurrent(ref);
  }

  async getRevision(): Promise<number> {
    return this.current.revision;
  }

  onProfileChange(listener: ProfileChangeListener): { unsubscribe(): void } {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Aynı aktif profil için sunucu/yerel yazım sonrası yeni revision'ı işler.
   */
  commitRevision(nextRevision: number, expectedProfileId?: string): WriteProfileRef {
    if (expectedProfileId !== undefined) {
      const normalized = requireCanonicalProfileId(expectedProfileId);
      if (!normalized || normalized !== this.current.profileId) {
        throw new ProfileConflictError('profile-switched', {
          expectedRevision: nextRevision,
          actualRevision: this.current.revision,
        });
      }
    }
    if (!isValidRevision(nextRevision)) {
      throw new ProfileConflictError('stale-revision', {
        expectedRevision: nextRevision,
        actualRevision: this.current.revision,
        message: `Geçersiz revision değeri: ${String(nextRevision)}`,
      });
    }
    this.current = makeFrozenRef(this.current.profileId, nextRevision);
    return this.current;
  }

  /**
   * Aktif profili değiştirir (varsayılan sırada önce invalidate, sonra durum
   * güncellemesi, ardından dinleyiciler ve `ProfileSwitched` olayı).
   */
  async switchProfile(
    nextProfileId: string,
    nextRevision: number = this.current.revision
  ): Promise<ProfileChangeEvent> {
    const normalizedNext = requireCanonicalProfileId(nextProfileId);
    if (!normalizedNext) {
      throw new ProfileConflictError('profile-not-found', {
        message: 'Hedef profil kimliği boş olamaz.',
      });
    }
    if (!isValidRevision(nextRevision)) {
      throw new ProfileConflictError('stale-revision', {
        expectedRevision: nextRevision,
        actualRevision: this.current.revision,
      });
    }

    const previous = this.current;
    if (previous.profileId === normalizedNext && previous.revision === nextRevision) {
      return { previous, current: this.current };
    }

    this.onInvalidateInFlight?.();
    const next = makeFrozenRef(normalizedNext, nextRevision);
    this.current = next;

    const changeEvent: ProfileChangeEvent = { previous, current: next };

    for (const listener of this.listeners) {
      try {
        await listener(changeEvent);
      } catch (error) {
        console.warn('[ProfileContext] Profil değişim dinleyicisi hata fırlattı:', error);
      }
    }

    if (this.eventPublisher && previous.profileId !== next.profileId) {
      const switchedEvent: TypedAppEvent<'ProfileSwitched'> = {
        eventId:
          typeof globalThis.crypto?.randomUUID === 'function'
            ? globalThis.crypto.randomUUID()
            : `prof-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        eventType: 'ProfileSwitched',
        profileId: next.profileId,
        entityId: next.profileId,
        occurredAt: new Date().toISOString(),
        schemaVersion: 1,
        sourceRevision: next.revision,
        ref: next,
        payload: {
          fromProfileId: previous.profileId,
          toProfileId: next.profileId,
        },
      };
      await this.eventPublisher.publish(switchedEvent);
    }

    return changeEvent;
  }
}

export function createProfileContext(options: ProfileContextOptions): ProfileContext {
  return new ProfileContext(options);
}
