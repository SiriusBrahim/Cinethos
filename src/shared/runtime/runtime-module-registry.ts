/**
 * MIA Faz 1B — Adım 5: Yönetici Modül Çalışma Zamanı Kayıt Defteri (ModuleRegistry).
 *
 * UI rota/sekme kayıt defteri (`src/app/module-registry.ts`, M1) ile
 * karıştırılmamalıdır: o dosya UI sekmelerini, bu modül ise `IApplicationModule`
 * yaşam döngüsünü (`initialize → start → stop → healthCheck`) yönetir.
 */

import type {
  IApplicationModule,
  IModuleRegistry,
  ModuleContext,
  ModuleHealth,
} from '../../contracts/index.ts';

export class ModuleRegistry implements IModuleRegistry {
  private readonly modules = new Map<string, IApplicationModule>();
  private readonly initializedIds = new Set<string>();
  private readonly startedIds: string[] = [];

  register(module: IApplicationModule): void {
    const id = typeof module?.id === 'string' ? module.id.trim() : '';
    if (!id) {
      throw new Error('Modül kimliği (id) boş olamaz.');
    }
    if (this.modules.has(id)) {
      throw new Error(`Modül zaten kayıtlı: ${id}`);
    }
    this.modules.set(id, module);
  }

  get(id: string): IApplicationModule | undefined {
    return this.modules.get(id);
  }

  list(): readonly IApplicationModule[] {
    return Array.from(this.modules.values());
  }

  async startAll(context: ModuleContext): Promise<void> {
    const newlyStarted: IApplicationModule[] = [];

    try {
      for (const mod of this.modules.values()) {
        if (!this.initializedIds.has(mod.id)) {
          await mod.initialize(context);
          this.initializedIds.add(mod.id);
        }
        if (!this.startedIds.includes(mod.id)) {
          await mod.start();
          this.startedIds.push(mod.id);
          newlyStarted.push(mod);
        }
      }
    } catch (error) {
      // Başlatma sırasında bir modül hata verirse yeni başlatılanları ters sırayla durdur.
      for (const startedMod of [...newlyStarted].reverse()) {
        try {
          await startedMod.stop();
        } catch (stopError) {
          context.logger.error(
            startedMod.id,
            'Başlatma geri alımı sırasında durdurma hatası oluştu.',
            { error: stopError instanceof Error ? stopError.message : String(stopError) }
          );
        } finally {
          const idx = this.startedIds.lastIndexOf(startedMod.id);
          if (idx >= 0) this.startedIds.splice(idx, 1);
        }
      }
      throw error;
    }
  }

  async stopAll(): Promise<void> {
    const toStopIds = [...this.startedIds].reverse();
    const errors: Array<{ moduleId: string; error: unknown }> = [];

    for (const id of toStopIds) {
      const mod = this.modules.get(id);
      if (!mod) continue;
      try {
        await mod.stop();
      } catch (error) {
        errors.push({ moduleId: id, error });
      } finally {
        const idx = this.startedIds.lastIndexOf(id);
        if (idx >= 0) this.startedIds.splice(idx, 1);
      }
    }

    if (errors.length > 0) {
      const summary = errors
        .map(
          (entry) =>
            `${entry.moduleId}: ${entry.error instanceof Error ? entry.error.message : String(entry.error)}`
        )
        .join('; ');
      throw new Error(`Modül durdurma hataları: ${summary}`);
    }
  }

  async healthCheckAll(): Promise<readonly ModuleHealth[]> {
    const results: ModuleHealth[] = [];
    for (const mod of this.modules.values()) {
      try {
        const health = await mod.healthCheck();
        results.push(health);
      } catch (error) {
        results.push({
          moduleId: mod.id,
          status: 'unhealthy',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  isStarted(id: string): boolean {
    return this.startedIds.includes(id);
  }

  isInitialized(id: string): boolean {
    return this.initializedIds.has(id);
  }
}

export { ModuleRegistry as RuntimeModuleRegistry };

export function createModuleRegistry(): ModuleRegistry {
  return new ModuleRegistry();
}
