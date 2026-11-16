/**
 * MIA Faz 1 — Merkezi profil bağlamı.
 *
 * Tek doğruluk kaynağı: aktif profil kimliği ve bu profile ait veri revizyonu.
 * Asenkron işler `beginTask()` ile başlar; profil değiştiğinde (epoch artar)
 * eski görevlerin token'ı geçersizleşir ve sonuçları uygulanmaz.
 *
 * Kural (mimari ilke 6): `profileId` + `revision` taşımayan arka plan işi yoktur.
 */

import type { KernelEventBus } from './event-bus.ts';

export interface ProfileSnapshot {
  readonly profileId: string;
  readonly revision: number;
  /** Profil değişim sayacı — her geçişte artar. */
  readonly epoch: number;
  readonly updatedAt: string;
}

export interface ProfileTaskToken {
  readonly profileId: string;
  readonly revision: number;
  readonly epoch: number;
}

export interface ProfileContext {
  getSnapshot(): ProfileSnapshot;
  /** Aktif profili değiştirir; eski görevleri geçersiz kılar ve olay yayınlar. */
  switchProfile(profileId: string, revision?: number): ProfileSnapshot;
  /** Sunucudan gelen yeni revizyonu işler; eski görevleri geçersiz kılar. */
  setRevision(revision: number): ProfileSnapshot;
  /** Uzun süreli işin başında çağrılır; sonuç uygulanmadan önce doğrulanır. */
  beginTask(): ProfileTaskToken;
  isTaskCurrent(token: ProfileTaskToken): boolean;
  /** Geçersiz token ile yazma denemesinde fırlatılır. */
  assertCurrent(token: ProfileTaskToken): void;
  subscribe(listener: (snapshot: ProfileSnapshot) => void): () => void;
}

export interface ProfileContextOptions {
  readonly profileId: string;
  readonly revision?: number;
  readonly events?: KernelEventBus;
  readonly now?: () => Date;
}

/** Eski profil için başlamış bir işin sonucu uygulanmaya çalışıldı. */
export class StaleProfileTaskError extends Error {
  readonly tokenProfileId: string;
  readonly activeProfileId: string;
  readonly tokenEpoch: number;
  readonly activeEpoch: number;

  constructor(token: ProfileTaskToken, active: ProfileSnapshot) {
    super(
      `Görev geçersiz: profil ${token.profileId} (epoch ${token.epoch}) artık aktif değil ` +
        `(${active.profileId}, epoch ${active.epoch}).`
    );
    this.name = 'StaleProfileTaskError';
    this.tokenProfileId = token.profileId;
    this.activeProfileId = active.profileId;
    this.tokenEpoch = token.epoch;
    this.activeEpoch = active.epoch;
  }
}

export function createProfileContext(options: ProfileContextOptions): ProfileContext {
  const now = options.now ?? (() => new Date());
  const listeners = new Set<(snapshot: ProfileSnapshot) => void>();
  let snapshot: ProfileSnapshot = {
    profileId: options.profileId,
    revision: options.revision ?? 0,
    epoch: 0,
    updatedAt: now().toISOString(),
  };

  const notify = (previous: ProfileSnapshot, next: ProfileSnapshot): void => {
    snapshot = next;
    if (previous.profileId !== next.profileId && options.events) {
      options.events.publish(
        'profile.changed',
        {
          previousProfileId: previous.profileId,
          profileId: next.profileId,
          revision: next.revision,
        },
        { profileId: next.profileId }
      );
    }
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // Dinleyici hatası bağlamı bozmamalı; sonraki dinleyiciler çalışmaya devam eder.
      }
    }
  };

  return {
    getSnapshot() {
      return snapshot;
    },

    switchProfile(profileId, revision) {
      if (!profileId) throw new Error('Profil kimliği boş olamaz');
      const previous = snapshot;
      const next: ProfileSnapshot = {
        profileId,
        revision: revision ?? 0,
        // Profil kimliği aynı olsa da geçiş sayılır: yarışan işler iptal edilir.
        epoch: previous.epoch + 1,
        updatedAt: now().toISOString(),
      };
      notify(previous, next);
      return next;
    },

    setRevision(revision) {
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new Error(`Geçersiz revizyon: ${String(revision)}`);
      }
      if (revision === snapshot.revision) return snapshot;
      const previous = snapshot;
      const next: ProfileSnapshot = {
        revision,
        profileId: previous.profileId,
        epoch: previous.epoch + 1,
        updatedAt: now().toISOString(),
      };
      notify(previous, next);
      return next;
    },

    beginTask() {
      return {
        profileId: snapshot.profileId,
        revision: snapshot.revision,
        epoch: snapshot.epoch,
      };
    },

    isTaskCurrent(token) {
      return token.epoch === snapshot.epoch && token.profileId === snapshot.profileId;
    },

    assertCurrent(token) {
      if (!this.isTaskCurrent(token)) throw new StaleProfileTaskError(token, snapshot);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
