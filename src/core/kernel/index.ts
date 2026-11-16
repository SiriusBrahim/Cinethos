/**
 * MIA Faz 1 — Modüler çekirdek.
 *
 * Kullanım:
 * ```ts
 * const kernel = createKernel({ profileId: 'profile-default', revision: 60 });
 * kernel.registry.register(contentIntelligenceModule);
 * const report = await kernel.bootstrap();
 * const content = kernel.registry.getService<ContentIntelligenceApi>('content-intelligence');
 * ```
 *
 * Çekirdek React'ten ve Node API'lerinden bağımsızdır; istemci, sunucu ve testler
 * aynı sözleşmeyi kullanır.
 */

import { createEventBus, type EventBusOptions, type KernelEventBus } from './event-bus.ts';
import {
  createProfileContext,
  type ProfileContext,
  type ProfileContextOptions,
} from './profile-context.ts';
import { createModuleRegistry, type ModuleRegistry } from './module-registry.ts';
import type { BootstrapReport, KernelLogger, ModuleRegistration } from './types.ts';

export * from './types.ts';
export * from './event-bus.ts';
export * from './profile-context.ts';
export * from './module-registry.ts';
export * from './repository-contracts.ts';

const silentLogger: KernelLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface KernelOptions {
  readonly profile?: Partial<Omit<ProfileContextOptions, 'events'>>;
  readonly logger?: KernelLogger;
  readonly now?: () => Date;
  readonly events?: EventBusOptions;
}

export interface Kernel {
  readonly events: KernelEventBus;
  readonly profile: ProfileContext;
  readonly registry: ModuleRegistry;
  register(registration: ModuleRegistration): void;
  bootstrap(): Promise<BootstrapReport>;
  stop(): Promise<void>;
  healthCheck(): ReturnType<ModuleRegistry['healthCheck']>;
}

export function createKernel(options: KernelOptions = {}): Kernel {
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? silentLogger;

  const events = createEventBus({
    now,
    ...options.events,
    onError:
      options.events?.onError ??
      ((failure) =>
        logger.warn('[EventBus] abone hata fırlattı', {
          type: failure.type,
          subscriberId: failure.subscriberId,
          error: failure.error instanceof Error ? failure.error.message : String(failure.error),
        })),
  });

  const profile = createProfileContext({
    profileId: options.profile?.profileId ?? 'profile-default',
    revision: options.profile?.revision ?? 0,
    now,
    events,
  });

  const registry = createModuleRegistry({ events, profile, logger, now });

  return {
    events,
    profile,
    registry,
    register(registration) {
      registry.register(registration);
    },
    bootstrap() {
      return registry.bootstrap();
    },
    stop() {
      return registry.stop();
    },
    healthCheck() {
      return registry.healthCheck();
    },
  };
}
