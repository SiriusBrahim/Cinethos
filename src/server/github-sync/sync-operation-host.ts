/**
 * F5.3-01 — Pull/push/reconcile işlemlerinin paylaşılan ana bilgisayar (host)
 * bağlamı. Koordinatör (`GitHubBidirectionalSyncManager`) yalnızca orkestrasyon
 * sorumluluğunu taşır; işlemler buradaki dar arayüz üzerinden yerel/uzak inceleme
 * yeteneklerine erişir. Private metotlara kontrolsüz bağımlılık (any cast,
 * `as unknown as` vb.) yoktur.
 */

import type {
  BidirectionalSyncDependencies,
  ParsedSideBundle,
} from './sync-core.ts';

export interface RemoteSideRequest {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface RemoteSideOptions {
  includePersonalFiles: boolean;
  includeCatalogFiles?: boolean;
  localProfilePaths: string[];
}

export interface RemoteSideInspection {
  bundle: ParsedSideBundle;
  rawRemoteContents: Record<string, { content: string; sha: string }>;
  transportFailed: boolean;
}

export interface SyncOperationHost {
  deps: BidirectionalSyncDependencies;
  readonly maxBytes: number;
  inspectLocalSide(): Promise<ParsedSideBundle>;
  inspectRemoteSide(
    cfg: RemoteSideRequest,
    options: RemoteSideOptions
  ): Promise<RemoteSideInspection>;
}

export interface ReconcileOperationHost extends SyncOperationHost {
  /** B-39: başarılı ve doğrulanmış eşitleme sonrası başlangıç damgası. */
  setInitialReconcileCompleted(): void;
}
