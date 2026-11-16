/**
 * MIA Faz 1 — Modüler çekirdek tip sözleşmeleri.
 *
 * Bu dosya yalnızca **tip** taşır: çalışma zamanı bağımlılığı yoktur, React yoktur.
 * Modüller birbirini import etmez; birbirini `ModuleRegistry` üzerinden yalnızca
 * dışa açılmış `api` yüzeyi ile görür.
 */

/** Başarılı/başarısız dönüş standardı. Hata fırlatmak yerine sonuç döner. */
export type Result<T, E = KernelError> = { ok: true; value: T } | { ok: false; error: E };

export type KernelErrorCode =
  | 'invalid_manifest'
  | 'duplicate_module'
  | 'unknown_module'
  | 'dependency_missing'
  | 'dependency_failed'
  | 'dependency_cycle'
  | 'already_started'
  | 'not_started'
  | 'module_failed'
  | 'invalid_argument';

export interface KernelError {
  readonly code: KernelErrorCode;
  readonly message: string;
  readonly moduleId?: string;
  readonly details?: Record<string, unknown>;
}

export function ok<T>(value: T): Result<T, KernelError> {
  return { ok: true, value };
}

export function fail(
  code: KernelErrorCode,
  message: string,
  extra: { moduleId?: string; details?: Record<string, unknown> } = {}
): Result<never, KernelError> {
  return { ok: false, error: { code, message, ...extra } };
}

/** Modül sağlık raporu. `healthy: false` modül çalışıyor ama bozuk demektir. */
export interface ModuleHealthReport {
  readonly healthy: boolean;
  readonly detail?: string;
  readonly metrics?: Readonly<Record<string, string | number>>;
}

export interface ModuleHealth extends ModuleHealthReport {
  readonly moduleId: string;
  readonly state: ModuleState;
  readonly checkedAt: string;
}

export type ModuleState =
  | 'registered'
  | 'initializing'
  | 'running'
  | 'failed'
  | 'skipped'
  | 'stopped';

/**
 * Modül tanımı — kayıt defterine verilen sözleşme.
 * `version` modül sürümü, `schemaVersion` modülün dışa açtığı veri/olay şemasıdır.
 */
export interface ModuleManifest {
  readonly id: string;
  readonly displayName: string;
  readonly version: string;
  readonly schemaVersion: number;
  /** Çalışması için önce başlamış olması gereken modüller. */
  readonly dependencies?: readonly string[];
  /** Dışa açtığı servis adları (keşif ve doğrulama için). */
  readonly provides?: readonly string[];
}

/** Modülün çalışma zamanı bağlamı. Registry'ye erişim yoktur; yalnız ortak altyapı. */
export interface ModuleContext {
  readonly moduleId: string;
  readonly events: import('./event-bus.ts').KernelEventBus;
  readonly profile: import('./profile-context.ts').ProfileContext;
  readonly logger: KernelLogger;
}

export interface KernelLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Çalışabilir modül. Yaşam döngüsü sırası: initialize → start → healthCheck* → stop.
 * Tüm adımlar isteğe bağlıdır; tanımsız adım no-op sayılır.
 */
export interface AppModule {
  readonly manifest: ModuleManifest;
  /** Modülün dışa açtığı tek yüzey. İç yardımcılar burada yer almaz. */
  readonly api?: unknown;
  initialize?(context: ModuleContext): void | Promise<void>;
  start?(context: ModuleContext): void | Promise<void>;
  healthCheck?(context: ModuleContext): ModuleHealthReport | Promise<ModuleHealthReport>;
  stop?(context: ModuleContext): void | Promise<void>;
}

export interface ModuleRegistration {
  readonly manifest: ModuleManifest;
  /** Bağımlılık API'leri çözülmüş olarak modülü üretir. */
  create(dependencies: ModuleDependencyAccess): AppModule | Promise<AppModule>;
}

/** Modülün bağımlılıklarına erişimi — yalnız `api` yüzeyi, iç uygulama değil. */
export interface ModuleDependencyAccess {
  getService<T = unknown>(moduleId: string): T;
}

export interface BootstrapReport {
  readonly started: readonly string[];
  readonly skipped: readonly string[];
  readonly failed: readonly { moduleId: string; message: string }[];
  readonly durationMs: number;
}

export interface ModuleSnapshot {
  readonly moduleId: string;
  readonly displayName: string;
  readonly version: string;
  readonly state: ModuleState;
  readonly lastError?: string;
}
