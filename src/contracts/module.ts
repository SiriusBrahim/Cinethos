/**
 * MIA Faz 1A ② — Modül yaşam döngüsü ve kayıt sözleşmeleri.
 *
 * KURAL (kullanıcı planı §4): Yalnızca YÖNETİCİ seviyesindeki modüller
 * `IApplicationModule` uygular. Alt modüller ve yardımcı bileşenler bu
 * arayüzü uygulamak zorunda değildir.
 */

import type { ModuleHealth } from './common.ts';

/** Yönetici modülün çalışma katmanı. */
export type ModuleLayer = 'foreground' | 'background' | 'both';

/**
 * Modüle başlatma sırasında verilen bağlam.
 *
 * Modüller birbirlerinin iç dosyalarına erişemez; yalnızca bu bağlam
 * üzerinden sunulan sözleşmelere (servisler, olaylar, profil) ulaşır.
 */
export interface ModuleContext {
  /** Aktif profil bağlamı — profil izolasyonu için zorunlu. */
  readonly profile: import('./profile.ts').IProfileContext;
  /** Olay yayınlama — kalıcı Outbox'a (Faz 4) bağlanır. */
  readonly events: import('./events.ts').IEventPublisher;
  /** Olay dinleme. */
  readonly subscribe: import('./events.ts').IEventSubscriber;
  /** Ortak kayıt/sorgu günlüğü — Sistem Yönetimi Paneli (§6) veri kaynağı. */
  readonly logger: {
    info(moduleId: string, message: string, data?: Record<string, unknown>): void;
    warn(moduleId: string, message: string, data?: Record<string, unknown>): void;
    error(moduleId: string, message: string, data?: Record<string, unknown>): void;
  };
}

/**
 * IApplicationModule — bütün yöneticilerin ortak yaşam döngüsü.
 *
 * Sıra: initialize(context) → start() → [çalışma] → stop().
 * `initialize` bir kez çağrılır; `start`/`stop` uygulama ömründe birden çok
 * kez çağrılabilir (örn. sekme görünürlüğü değişimi).
 */
export interface IApplicationModule {
  /** Modül kimliği — kayıt defterinde tekil olmalı. */
  readonly id: string;
  /** Modül sürümü — semver. */
  readonly version: string;
  /** Çalışma katmanı (ön plan / arka plan / her ikisi). */
  readonly layer: ModuleLayer;

  /** Bir kez: bağlamı al, kaynakları hazırla. Kullanıcı etkileşimi başlatma. */
  initialize(context: ModuleContext): Promise<void>;
  /** Çalışmaya başla (abonelikler, zamanlanmış görevler). */
  start(): Promise<void>;
  /** Temiz dur: abonelikleri kapat, zamanlayıcıları durdur, kaynağı bırak. */
  stop(): Promise<void>;
  /** Sağlık raporu — Sistem Yönetimi Paneli (§6) bunu okur. */
  healthCheck(): Promise<ModuleHealth>;
}

/**
 * IModuleRegistry — yöneticilerin kaydı, bulunması ve yaşam döngüsü
 * koordinasyonu.
 *
 * Not: Mevcut `src/app/module-registry.ts` UI modül tanımları (M1) içindir
 * ve ayrıdır; bu sözleşme yönetici modüllerin çalışma zamanı kaydıdır.
 */
export interface IModuleRegistry {
  /** Modülü kaydeder. Aynı `id` ile ikinci kayıt hatadır. */
  register(module: IApplicationModule): void;
  /** Kayıtlı modülü kimlikle bulur. */
  get(id: string): IApplicationModule | undefined;
  /** Tüm kayıtlı modüller (kayıt sırasıyla). */
  list(): readonly IApplicationModule[];
  /** Tüm modülleri sırayla başlatır (initialize → start). */
  startAll(context: ModuleContext): Promise<void>;
  /** Tüm modülleri ters sırayla durdurur. */
  stopAll(): Promise<void>;
  /** Tüm modüllerin sağlık raporunu toplar. */
  healthCheckAll(): Promise<readonly ModuleHealth[]>;
}
