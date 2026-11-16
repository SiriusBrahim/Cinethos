/**
 * SQLite birincil depolama (Faz 7).
 *
 * `CINETHOS_STORAGE=sqlite` iken veri dokümanının asıl kaynağı
 * `data/cinethos.db` olur; JSON dosyası yedek/taşınabilirlik için aynen
 * yazılmaya devam eder. Böylece migration geri alınabilir kalır:
 * `CINETHOS_STORAGE=json` ile eski davranışa dönülür.
 *
 * Node 22.5+ `node:sqlite` (DatabaseSync) kullanılır. Modül yoksa veya
 * veritabanı açılamazsa depo sessizce devre dışı kalır ve JSON akışı sürer.
 */

import { createRequire } from 'node:module';

export type StorageDriver = 'json' | 'sqlite';

const nodeRequire = createRequire(import.meta.url);

export interface SqliteDocumentRow {
  document: unknown;
  revision: number;
  updatedAt: string;
}

export interface SqlitePrimaryStore {
  enabled: boolean;
  available: boolean;
  filePath: string;
  read(): SqliteDocumentRow | null;
  write(document: unknown, revision: number): boolean;
  status(): {
    driver: StorageDriver;
    enabled: boolean;
    available: boolean;
    revision: number | null;
    updatedAt: string | null;
    filePath: string;
    lastError: string | null;
  };
  close(): void;
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => unknown;
  };
  close(): void;
}

export function resolveStorageDriver(env: NodeJS.ProcessEnv = process.env): StorageDriver {
  const raw = String(env.CINETHOS_STORAGE || '').trim().toLowerCase();
  return raw === 'sqlite' ? 'sqlite' : 'json';
}

function loadDatabaseSync(): (new (file: string) => DatabaseLike) | null {
  try {
    const mod = nodeRequire('node:sqlite') as { DatabaseSync?: new (file: string) => DatabaseLike };
    return mod.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

export interface CreateSqlitePrimaryStoreOptions {
  dataDir: string;
  enabled?: boolean;
}

export function createSqlitePrimaryStore(
  options: CreateSqlitePrimaryStoreOptions
): SqlitePrimaryStore {
  const filePath = `${options.dataDir}/cinethos.db`;
  const enabled = options.enabled ?? resolveStorageDriver() === 'sqlite';
  let db: DatabaseLike | null = null;
  let available = false;
  let lastError: string | null = null;
  let cachedRevision: number | null = null;
  let cachedUpdatedAt: string | null = null;

  if (enabled) {
    const DatabaseSync = loadDatabaseSync();
    if (!DatabaseSync) {
      lastError = "node:sqlite bu Node sürümünde bulunamadı (Node >= 22.5 gerekir).";
    } else {
      try {
        db = new DatabaseSync(filePath);
        db.exec('PRAGMA journal_mode = WAL;');
        db.exec('PRAGMA synchronous = NORMAL;');
        db.exec(
          `CREATE TABLE IF NOT EXISTS documents (
             id TEXT PRIMARY KEY,
             revision INTEGER NOT NULL,
             updated_at TEXT NOT NULL,
             payload TEXT NOT NULL
           );`
        );
        db.exec(
          `CREATE TABLE IF NOT EXISTS meta (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
           );`
        );
        available = true;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        try {
          db?.close();
        } catch {
          /* kapanmayan bağlantı yoksayılır */
        }
        db = null;
        available = false;
      }
    }
  }

  function read(): SqliteDocumentRow | null {
    if (!db) return null;
    try {
      const row = db
        .prepare('SELECT revision, updated_at, payload FROM documents WHERE id = ?')
        .get('primary') as { revision?: number; updated_at?: string; payload?: string } | undefined;
      if (!row || typeof row.payload !== 'string') return null;
      const parsed = JSON.parse(row.payload) as unknown;
      cachedRevision = Number(row.revision) || 0;
      cachedUpdatedAt = String(row.updated_at || '');
      return {
        document: parsed,
        revision: cachedRevision,
        updatedAt: cachedUpdatedAt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      return null;
    }
  }

  function write(document: unknown, revision: number): boolean {
    if (!db) return false;
    try {
      const updatedAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO documents (id, revision, updated_at, payload) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET revision = excluded.revision,
                                       updated_at = excluded.updated_at,
                                       payload = excluded.payload`
      ).run('primary', revision, updatedAt, JSON.stringify(document));
      db.prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run('last_write_at', updatedAt);
      cachedRevision = revision;
      cachedUpdatedAt = updatedAt;
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  return {
    enabled,
    get available() {
      return available;
    },
    filePath,
    read,
    write,
    status: () => ({
      driver: enabled ? 'sqlite' : 'json',
      enabled,
      available,
      revision: cachedRevision,
      updatedAt: cachedUpdatedAt,
      filePath,
      lastError,
    }),
    close: () => {
      try {
        db?.close();
      } catch {
        /* yoksay */
      }
      db = null;
      available = false;
    },
  };
}
