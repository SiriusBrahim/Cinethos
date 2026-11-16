/**
 * MIA Faz 1 — Adım 1.2 (Dilim B/F): Sunucu yaşam döngüsü yöneticisi.
 *
 * server.ts'teki kompozisyon köküne (composition root) ait başlatma ve
 * kontrollü kapatma akışını kapsüller:
 *  - Modüller ModuleRegistry üzerinden start edilir.
 *  - SIGINT/SIGTERM'de modüller ters sırada stop edilir.
 *  - SQLite birincil depo bağlantısı kapatılır.
 *  - Kayıtlı zamanlayıcılar (auto-sync, token refresh) temizlenir.
 *  - Kapatma idempotenttir; ikinci sinyal bekleyen akışı tekrar çalıştırmaz.
 */

export interface ServerLifecycleOptions {
  startRuntimeModules: () => Promise<void>;
  stopRuntimeModules: () => Promise<void>;
  closeStorage?: () => Promise<void> | void;
  /** Kapatma sırasında temizlenecek zamanlayıcı/kaynak kayıtları. */
  registerCleanup?: (dispose: () => void) => void;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
  /** Testlerde process.exit çağrısını izole etmek için. */
  exitProcess?: (code: number) => void;
  shutdownSignals?: readonly string[];
}

export interface ServerLifecycle {
  /** Modülleri başlatır; hata durumunda çağırana olduğu gibi fırlatır. */
  start: () => Promise<void>;
  /** Kontrollü kapatma; idempotenttir. */
  shutdown: (reason?: string) => Promise<void>;
  /** Gerçek sinyal dinleyicilerini kurar (yalnızca gerçek sunucuda). */
  installSignalHandlers: () => void;
  /** Kapatma sırasında çalıştırılacak zamanlayıcı/kaynak temizliği ekler. */
  addCleanup: (dispose: () => void) => void;
  isShuttingDown: () => boolean;
}

export function createServerLifecycle(options: ServerLifecycleOptions): ServerLifecycle {
  const {
    startRuntimeModules,
    stopRuntimeModules,
    closeStorage,
    logger = {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
    },
    exitProcess = (code) => process.exit(code),
    shutdownSignals = ['SIGINT', 'SIGTERM'],
  } = options;

  const cleanups: Array<() => void> = [];
  let started = false;
  let shuttingDown = false;

  const addCleanup = (dispose: () => void): void => {
    if (typeof dispose === 'function') cleanups.push(dispose);
  };

  const runCleanups = () => {
    for (const dispose of cleanups.splice(0)) {
      try {
        dispose();
      } catch (err) {
        logger.warn(`[Kapatma] Zamanlayıcı temizleme uyarısı: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  const start = async (): Promise<void> => {
    if (shuttingDown) {
      throw new Error('Sunucu kapatma aşamasında olduğu için modüller başlatılamaz.');
    }
    if (started) return;
    await startRuntimeModules();
    started = true;
    logger.info('[Runtime] Modüller başlatıldı (ModuleRegistry startAll).');
  };

  const shutdown = async (reason = 'kapatma'): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[Kapatma] Kontrollü kapatma başlatıldı (${reason}).`);

    runCleanups();

    try {
      await stopRuntimeModules();
      logger.info('[Runtime] Modüller ters sırada durduruldu (ModuleRegistry stopAll).');
    } catch (err) {
      logger.warn(
        `[Kapatma] Modül durdurma uyarısı: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (closeStorage) {
      try {
        await closeStorage();
        logger.info('[Depolama] SQLite birincil depo bağlantısı kapatıldı.');
      } catch (err) {
        logger.warn(
          `[Depolama] SQLite kapatma uyarısı: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  };

  const installSignalHandlers = (): void => {
    for (const signal of shutdownSignals) {
      process.on(signal, () => {
        void shutdown(signal)
          .catch(() => undefined)
          .finally(() => {
            exitProcess(0);
          });
      });
    }
  };

  return {
    start,
    shutdown,
    installSignalHandlers,
    addCleanup,
    isShuttingDown: () => shuttingDown,
  };
}
