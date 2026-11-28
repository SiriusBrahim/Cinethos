/**
 * F5.3-05 — Uzak senkronizasyon motoru kayıt defteri.
 *
 * Yerel veri katmanı bu modülden motor ister; motorun hangi sağlayıcıya ait
 * olduğunu bilmez. Sağlayıcı (şu an GitHub) kendi modülünde
 * `registerRemoteSyncEngineFactory` çağırır. Kayıt yoksa yerel modda çalışan
 * bir "yok" motoru döner: uygulamanın açılması, okuma ve yazma etkilenmez.
 */

import {
  createRemoteSyncUnavailableReport,
  type RemoteSyncDeps,
  type RemoteSyncEngine,
  type RemoteSyncEngineFactory,
  type RemoteSyncPullOptions,
  type RemoteSyncReconcileOptions,
} from './remote-sync-port.ts';

let registeredFactory: RemoteSyncEngineFactory | null = null;

export function registerRemoteSyncEngineFactory(factory: RemoteSyncEngineFactory): void {
  registeredFactory = factory;
}

export function isRemoteSyncEngineRegistered(): boolean {
  return registeredFactory !== null;
}

const EMPTY_QUEUE_SNAPSHOT = {
  state: 'idle',
  depth: 0,
  running: false,
  runningOperation: null,
  runningSince: null,
  queuedOperations: [],
  lastOutcome: null,
  recoveredInterrupted: 0,
  totalSucceeded: 0,
  totalFailed: 0,
  totalCancelled: 0,
  maxDepth: 0,
} as const;

/**
 * Entegrasyon yokken kullanılan motor. Hiçbir uzak çağrı yapmaz; yalnızca
 * yerel modda olduğunu bildiren rapor döndürür.
 */
export function createLocalOnlyRemoteSyncEngine(deps: RemoteSyncDeps): RemoteSyncEngine {
  const isPublicRepo = () => Boolean(deps.getConfig().isPublicRepo);
  return {
    isBusy: () => false,
    getQueueStatus: () => ({ ...EMPTY_QUEUE_SNAPSHOT }),
    getRecoveredInterruption: () => null,
    isExclusiveActive: () => false,
    hasCompletedInitialReconcile: () => false,
    runExclusive: <T>(_operation: string, fn: () => Promise<T>) => fn(),
    inspectLocalSideSync: () => {
      throw new Error('Uzak senkronizasyon entegrasyonu etkin değil.');
    },
    inspect: () =>
      Promise.resolve(
        createRemoteSyncUnavailableReport('inspect', new Date().toISOString(), isPublicRepo())
      ),
    pull: (_options?: RemoteSyncPullOptions) =>
      Promise.resolve(
        createRemoteSyncUnavailableReport('pull', new Date().toISOString(), isPublicRepo())
      ),
    push: () =>
      Promise.resolve(
        createRemoteSyncUnavailableReport('push', new Date().toISOString(), isPublicRepo())
      ),
    reconcile: (_options?: RemoteSyncReconcileOptions) =>
      Promise.resolve(
        createRemoteSyncUnavailableReport('reconcile', new Date().toISOString(), isPublicRepo())
      ),
  };
}

export function createRemoteSyncEngine(deps: RemoteSyncDeps): RemoteSyncEngine {
  return registeredFactory ? registeredFactory(deps) : createLocalOnlyRemoteSyncEngine(deps);
}
