/**
 * MIA Faz 1 — Module Registry.
 *
 * Tek merkezi kayıt noktası: modüller burada kaydedilir, bağımlılık sırasına göre
 * başlatılır, sağlıkları toplanır ve yalnızca `api` yüzeyleri dışarı verilir.
 *
 * Garantiler:
 * - Bağımlılığı başlamamış modül başlamaz (`dependency_failed`).
 * - Döngüsel bağımlılık başlatılmaz, döngüdeki her modül hata olarak raporlanır.
 * - Başlatılamayan modül uygulamayı düşürmez; `module.failed` olayı yayınlanır.
 * - Modülün iç nesneleri paylaşılmaz; yalnız `api` görünür.
 */

import {
  type AppModule,
  type BootstrapReport,
  type ModuleDependencyAccess,
  type ModuleHealth,
  type ModuleManifest,
  type ModuleRegistration,
  type ModuleSnapshot,
  type ModuleState,
  type KernelErrorCode,
  type KernelLogger,
  type Result,
  ok,
  fail,
} from './types.ts';
import type { KernelEventBus } from './event-bus.ts';
import type { ProfileContext } from './profile-context.ts';

export class ModuleRegistryError extends Error {
  readonly code: KernelErrorCode;
  readonly moduleId?: string;

  constructor(code: KernelErrorCode, message: string, moduleId?: string) {
    super(message);
    this.name = 'ModuleRegistryError';
    this.code = code;
    if (moduleId) this.moduleId = moduleId;
  }
}

export interface ModuleRegistryOptions {
  readonly events: KernelEventBus;
  readonly profile: ProfileContext;
  readonly logger?: KernelLogger;
  readonly now?: () => Date;
}

export interface HealthSummary {
  readonly ok: boolean;
  readonly modules: readonly ModuleHealth[];
}

export interface ModuleRegistry {
  register(registration: ModuleRegistration): void;
  bootstrap(): Promise<BootstrapReport>;
  /** Yalnız çalışan modülün `api` yüzeyini döner. */
  getService<T = unknown>(moduleId: string): T;
  tryGetService<T = unknown>(moduleId: string): Result<T>;
  snapshot(): readonly ModuleSnapshot[];
  healthCheck(): Promise<HealthSummary>;
  stop(): Promise<void>;
  isBootstrapped(): boolean;
}

interface RegistryEntry {
  readonly registration: ModuleRegistration;
  module?: AppModule;
  state: ModuleState;
  lastError?: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+([-+][A-Za-z0-9.-]+)?$/;

const silentLogger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Kahn topolojik sıralama; döngüde kalanları ayrıca döndürür. */
export function resolveModuleOrder(
  manifests: readonly ModuleManifest[]
): { order: string[]; missing: Map<string, string[]>; cyclic: string[] } {
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  const missing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const manifest of manifests) {
    const absent = (manifest.dependencies ?? []).filter((dependency) => !byId.has(dependency));
    if (absent.length > 0) missing.set(manifest.id, absent);
    const deps = (manifest.dependencies ?? []).filter((dependency) => byId.has(dependency));
    indegree.set(manifest.id, deps.length);
    for (const dependency of deps) {
      const list = dependents.get(dependency) ?? [];
      list.push(manifest.id);
      dependents.set(dependency, list);
    }
  }

  const ready = manifests
    .filter((manifest) => (indegree.get(manifest.id) ?? 0) === 0 && !missing.has(manifest.id))
    .map((manifest) => manifest.id)
    .sort();
  const order: string[] = [];
  const queue = [...ready];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    order.push(id);
    for (const dependent of (dependents.get(id) ?? []).sort()) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0 && !missing.has(dependent)) {
        queue.push(dependent);
        queue.sort();
      }
    }
  }

  const cyclic = manifests
    .map((manifest) => manifest.id)
    .filter((id) => !order.includes(id) && !missing.has(id));

  return { order, missing, cyclic };
}

export function createModuleRegistry(options: ModuleRegistryOptions): ModuleRegistry {
  const logger = options.logger ?? silentLogger;
  const now = options.now ?? (() => new Date());
  const entries = new Map<string, RegistryEntry>();
  /** Başlatma sırası — durdurma bunun tersidir. */
  let startupOrder: string[] = [];
  let bootstrapped = false;

  const context = (moduleId: string) => ({
    moduleId,
    events: options.events,
    profile: options.profile,
    logger,
  });

  const dependencyAccess: ModuleDependencyAccess = {
    getService<T>(moduleId: string): T {
      return serviceOf<T>(moduleId);
    },
  };

  function serviceOf<T>(moduleId: string): T {
    const entry = entries.get(moduleId);
    if (!entry) {
      throw new ModuleRegistryError('unknown_module', `Bilinmeyen modül: ${moduleId}`, moduleId);
    }
    if (entry.state !== 'running' || entry.module?.api === undefined) {
      throw new ModuleRegistryError(
        'not_started',
        `Modül çalışmıyor: ${moduleId} (durum: ${entry.state})`,
        moduleId
      );
    }
    return entry.module.api as T;
  }

  const markFailed = (entry: RegistryEntry, message: string, code: KernelErrorCode): void => {
    entry.state = 'failed';
    entry.lastError = message;
    options.events.publish(
      'module.failed',
      { moduleId: entry.registration.manifest.id, message },
      { profileId: 'system' }
    );
    logger.error(`[Registry] ${entry.registration.manifest.id} başlatılamadı (${code}): ${message}`);
  };

  const markSkipped = (entry: RegistryEntry, reason: string): void => {
    entry.state = 'skipped';
    entry.lastError = reason;
  };

  return {
    register(registration) {
      if (bootstrapped) {
        throw new ModuleRegistryError(
          'already_started',
          'Kayıt defteri başlatıldıktan sonra modül eklenemez',
          registration.manifest.id
        );
      }
      const manifest = registration.manifest;
      if (!ID_PATTERN.test(manifest.id)) {
        throw new ModuleRegistryError(
          'invalid_manifest',
          `Modül kimliği küçük harf/rakam/tire olmalı: ${manifest.id}`,
          manifest.id
        );
      }
      if (!SEMVER_PATTERN.test(manifest.version)) {
        throw new ModuleRegistryError(
          'invalid_manifest',
          `Modül sürümü semver olmalı: ${manifest.id}@${manifest.version}`,
          manifest.id
        );
      }
      if (!Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
        throw new ModuleRegistryError(
          'invalid_manifest',
          `Modül şema sürümü pozitif tamsayı olmalı: ${manifest.id}`,
          manifest.id
        );
      }
      if ((manifest.dependencies ?? []).includes(manifest.id)) {
        throw new ModuleRegistryError(
          'invalid_manifest',
          `Modül kendine bağımlı olamaz: ${manifest.id}`,
          manifest.id
        );
      }
      if (entries.has(manifest.id)) {
        throw new ModuleRegistryError(
          'duplicate_module',
          `Modül zaten kayıtlı: ${manifest.id}`,
          manifest.id
        );
      }
      entries.set(manifest.id, { registration, state: 'registered' });
    },

    async bootstrap() {
      if (bootstrapped) {
        throw new ModuleRegistryError('already_started', 'Kayıt defteri zaten başlatıldı');
      }
      bootstrapped = true;
      const startedAt = Date.now();
      const manifests = [...entries.values()].map((entry) => entry.registration.manifest);
      const { order, missing, cyclic } = resolveModuleOrder(manifests);
      const started: string[] = [];
      const skipped: string[] = [];
      const failed: { moduleId: string; message: string }[] = [];

      for (const [moduleId, absent] of missing) {
        const entry = entries.get(moduleId);
        if (!entry) continue;
        const message = `Eksik bağımlılık: ${absent.join(', ')}`;
        markFailed(entry, message, 'dependency_missing');
        failed.push({ moduleId, message });
      }
      for (const moduleId of cyclic) {
        const entry = entries.get(moduleId);
        if (!entry) continue;
        const message = 'Döngüsel bağımlılık';
        markFailed(entry, message, 'dependency_cycle');
        failed.push({ moduleId, message });
      }

      startupOrder = [...order];

      for (const moduleId of order) {
        const entry = entries.get(moduleId);
        if (!entry) continue;
        const manifest = entry.registration.manifest;
        const blockedBy = (manifest.dependencies ?? []).find((dependency) => {
          const dependencyEntry = entries.get(dependency);
          return !dependencyEntry || dependencyEntry.state !== 'running';
        });
        if (blockedBy) {
          const message = `Bağımlılık hazır değil: ${blockedBy}`;
          markSkipped(entry, message);
          skipped.push(moduleId);
          continue;
        }

        entry.state = 'initializing';
        try {
          const module = await entry.registration.create(dependencyAccess);
          entry.module = module;
          const moduleContext = context(moduleId);
          await module.initialize?.(moduleContext);
          await module.start?.(moduleContext);
          entry.state = 'running';
          started.push(moduleId);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          markFailed(entry, message, 'module_failed');
          failed.push({ moduleId, message });
        }
      }

      return {
        started,
        skipped,
        failed,
        durationMs: Date.now() - startedAt,
      };
    },

    getService<T>(moduleId: string) {
      return serviceOf<T>(moduleId);
    },

    tryGetService<T>(moduleId: string) {
      try {
        return ok(serviceOf<T>(moduleId));
      } catch (error) {
        const registryError = error as ModuleRegistryError;
        return fail(registryError.code ?? 'unknown_module', registryError.message, { moduleId });
      }
    },

    snapshot() {
      return [...entries.values()]
        .map((entry) => ({
          moduleId: entry.registration.manifest.id,
          displayName: entry.registration.manifest.displayName,
          version: entry.registration.manifest.version,
          state: entry.state,
          ...(entry.lastError ? { lastError: entry.lastError } : {}),
        }))
        .sort((a, b) => a.moduleId.localeCompare(b.moduleId));
    },

    async healthCheck() {
      const modules: ModuleHealth[] = [];
      for (const entry of entries.values()) {
        const moduleId = entry.registration.manifest.id;
        const checkedAt = now().toISOString();
        if (entry.state !== 'running' || !entry.module) {
          modules.push({
            moduleId,
            state: entry.state,
            healthy: false,
            detail: entry.lastError ?? 'Modül çalışmıyor',
            checkedAt,
          });
          continue;
        }
        try {
          const report = (await entry.module.healthCheck?.(context(moduleId))) ?? {
            healthy: true,
          };
          modules.push({
            moduleId,
            state: entry.state,
            healthy: report.healthy,
            ...(report.detail ? { detail: report.detail } : {}),
            ...(report.metrics ? { metrics: report.metrics } : {}),
            checkedAt,
          });
        } catch (error) {
          modules.push({
            moduleId,
            state: entry.state,
            healthy: false,
            detail: error instanceof Error ? error.message : String(error),
            checkedAt,
          });
        }
      }
      modules.sort((a, b) => a.moduleId.localeCompare(b.moduleId));
      return { ok: modules.every((module) => module.healthy), modules };
    },

    async stop() {
      const order = [...startupOrder].reverse();
      for (const moduleId of order) {
        const entry = entries.get(moduleId);
        if (!entry?.module) continue;
        try {
          await entry.module.stop?.(context(moduleId));
        } catch (error) {
          logger.warn(`[Registry] ${moduleId} durdurulurken hata`, {
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          entry.state = 'stopped';
        }
      }
    },

    isBootstrapped() {
      return bootstrapped;
    },
  };
}
