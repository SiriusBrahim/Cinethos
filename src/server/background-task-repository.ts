/**
 * MIA Faz 4 — Background Task Repository (SQLite kalıcı katman).
 *
 * Onaylanan şema (docs/mia/faz4-background-manager-tasarim.md §2):
 * - `background_events` : kalıcı olay defteri (eventId PK).
 * - `background_tasks`  : işleyici başına görev; `(event_id, handler_id)` UNIQUE.
 *
 * KURALLAR:
 * - Aynı SQLite dosyası (`data/cinetrack.db`) kullanılır; mevcut `content_*`
 *   tablolarına ALTER/veri taşıma YAPILMAZ. DDL yalnızca `IF NOT EXISTS`.
 * - Olay kabulü ile görev kaydı TEK transaction içinde yazılır; yazım
 *   başarısızsa `AppEventBus.publish()` reddeder (sessiz yutma yok).
 * - Payload repository'ye sanitize edilmiş olarak gelir; repository ek olarak
 *   yalnızca JSON serileştirme yapar.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeProfileId } from '../core/profile-id.ts';
import type {
  AcceptBackgroundEventResult,
  BackgroundEventInput,
  BackgroundEventRecord,
  BackgroundTaskListOptions,
  BackgroundTaskRecord,
  BackgroundTaskStats,
  BackgroundTaskStatus,
  BackgroundTaskStoreStatus,
} from '../contracts/index.ts';
import { BACKGROUND_TASK_STATUSES } from '../contracts/index.ts';

const nodeRequire = createRequire(import.meta.url);

interface StatementLike {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => { changes?: number };
}

interface DatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): StatementLike;
  close(): void;
}

function loadDatabaseSync(): (new (file: string) => DatabaseLike) | null {
  try {
    const mod = nodeRequire('node:sqlite') as { DatabaseSync?: new (file: string) => DatabaseLike };
    return mod.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

interface EventRow {
  event_id: string;
  event_type: string;
  profile_id: string;
  entity_id: string | null;
  schema_version: number;
  source_revision: number;
  occurred_at: string;
  received_at: string;
  payload_json: string;
}

interface TaskRow {
  task_id: string;
  event_id: string;
  handler_id: string;
  profile_id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface BackgroundTaskRepositoryOptions {
  readonly dataDir?: string;
  readonly dbPath?: string;
  readonly defaultMaxAttempts?: number;
  readonly now?: () => string;
}

export type BackgroundTaskRepositoryStatus = BackgroundTaskStoreStatus;
export type ListBackgroundTasksOptions = BackgroundTaskListOptions;

function parsePayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapEvent(row: EventRow): BackgroundEventRecord {
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    profileId: row.profile_id,
    entityId: row.entity_id,
    schemaVersion: row.schema_version,
    sourceRevision: row.source_revision,
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    payload: parsePayload(row.payload_json),
  };
}

function mapTask(row: TaskRow): BackgroundTaskRecord {
  const status = BACKGROUND_TASK_STATUSES.includes(row.status as BackgroundTaskStatus)
    ? (row.status as BackgroundTaskStatus)
    : 'failed';
  return {
    taskId: row.task_id,
    eventId: row.event_id,
    handlerId: row.handler_id,
    profileId: row.profile_id,
    status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextRetryAt: row.next_retry_at,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export class BackgroundTaskRepository {
  private readonly filePath: string;
  private readonly defaultMaxAttempts: number;
  private readonly now: () => string;
  private db: DatabaseLike | null = null;
  private lastError: string | null = null;

  constructor(options: BackgroundTaskRepositoryOptions = {}) {
    const dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
    this.filePath = options.dbPath
      ? path.resolve(options.dbPath)
      : path.join(dataDir, 'cinetrack.db');
    this.defaultMaxAttempts = Math.max(1, Math.min(10, Math.floor(options.defaultMaxAttempts ?? 3)));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  getDbPath(): string {
    return this.filePath;
  }

  ensureInitialized(): void {
    if (this.db) return;
    const DatabaseSync = loadDatabaseSync();
    if (!DatabaseSync) {
      this.lastError = 'node:sqlite bu Node çalışma zamanında yüklenemedi.';
      throw new Error(this.lastError);
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    let instance: DatabaseLike | null = null;
    try {
      instance = new DatabaseSync(this.filePath);
      instance.exec('PRAGMA journal_mode = WAL;');
      instance.exec('PRAGMA synchronous = NORMAL;');
      instance.exec('PRAGMA busy_timeout = 5000;');
      instance.exec('PRAGMA foreign_keys = ON;');

      // Onaylanan additive şema — mevcut tablolara dokunmaz.
      instance.exec(`
        CREATE TABLE IF NOT EXISTS background_events (
          event_id        TEXT PRIMARY KEY,
          event_type      TEXT NOT NULL,
          profile_id      TEXT NOT NULL,
          entity_id       TEXT,
          schema_version  INTEGER NOT NULL,
          source_revision INTEGER NOT NULL,
          occurred_at     TEXT NOT NULL,
          received_at     TEXT NOT NULL,
          payload_json    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_bg_events_type_time
          ON background_events(event_type, received_at);

        CREATE TABLE IF NOT EXISTS background_tasks (
          task_id       TEXT PRIMARY KEY,
          event_id      TEXT NOT NULL REFERENCES background_events(event_id) ON DELETE CASCADE,
          handler_id    TEXT NOT NULL,
          profile_id    TEXT NOT NULL,
          status        TEXT NOT NULL CHECK (status IN
                          ('pending','processing','completed','retry_wait','failed','cancelled')),
          attempts      INTEGER NOT NULL DEFAULT 0,
          max_attempts  INTEGER NOT NULL DEFAULT 3,
          next_retry_at TEXT,
          lease_until   TEXT,
          last_error    TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          completed_at  TEXT,
          UNIQUE (event_id, handler_id)
        );
        CREATE INDEX IF NOT EXISTS idx_bg_tasks_ready
          ON background_tasks(status, next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_bg_tasks_profile
          ON background_tasks(profile_id, status);
      `);

      this.db = instance;
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      try {
        instance?.close();
      } catch {
        /* açılış hatasında bağlantı kapatılamazsa yoksay */
      }
      throw error;
    }
  }

  private requireDb(): DatabaseLike {
    this.ensureInitialized();
    if (!this.db) {
      throw new Error(this.lastError || 'Background task SQLite bağlantısı hazır değil.');
    }
    return this.db;
  }

  isAvailable(): boolean {
    try {
      this.ensureInitialized();
      return Boolean(this.db);
    } catch {
      return false;
    }
  }

  getStatus(): BackgroundTaskStoreStatus {
    return {
      available: this.isAvailable(),
      filePath: this.filePath,
      lastError: this.lastError,
    };
  }

  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      /* kapanış sırasında oluşan ikincil hata yoksayılır */
    }
    this.db = null;
  }

  /**
   * Olayı ve (varsa) işleyici görevlerini TEK transaction içinde yazar.
   * Aynı eventId ikinci kez gelirse hiçbir yeni kayıt üretilmez.
   */
  acceptEvent(input: BackgroundEventInput, nowIso = this.now()): AcceptBackgroundEventResult {
    const db = this.requireDb();
    const handlerIds = [...new Set((input.handlerIds ?? []).filter(Boolean))];

    db.exec('BEGIN IMMEDIATE');
    try {
      const insertEvent = db
        .prepare(
          `INSERT OR IGNORE INTO background_events
             (event_id, event_type, profile_id, entity_id, schema_version,
              source_revision, occurred_at, received_at, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.eventId,
          input.eventType,
          input.profileId,
          input.entityId ?? null,
          input.schemaVersion,
          input.sourceRevision,
          input.occurredAt,
          nowIso,
          JSON.stringify(input.payload ?? {})
        );

      const eventInserted = (insertEvent.changes ?? 0) > 0;
      let tasksCreated = 0;

      if (eventInserted) {
        const insertTask = db.prepare(
          `INSERT OR IGNORE INTO background_tasks
             (task_id, event_id, handler_id, profile_id, status, attempts,
              max_attempts, next_retry_at, lease_until, last_error,
              created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL)`
        );
        for (const handlerId of handlerIds) {
          const result = insertTask.run(
            crypto.randomUUID(),
            input.eventId,
            handlerId,
            input.profileId,
            this.defaultMaxAttempts,
            nowIso,
            nowIso
          );
          if ((result.changes ?? 0) > 0) tasksCreated += 1;
        }
      }

      db.exec('COMMIT');
      return {
        eventInserted,
        tasksCreated,
        deduplicated: !eventInserted,
      };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* rollback hatası asıl hatayı gizlemesin */
      }
      throw error;
    }
  }


  /**
   * Adds a missing task for an event already persisted by acceptEvent.
   * Used when a profile switch races with the live Taste subscriber.
   */
  ensureTaskForEvent(
    eventId: string,
    handlerId: string,
    profileId: string,
    nowIso = this.now()
  ): boolean {
    const db = this.requireDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const event = db
        .prepare('SELECT profile_id FROM background_events WHERE event_id = ?')
        .get(eventId) as { profile_id?: string } | undefined;
      if (!event) {
        throw new Error(`Background olayı bulunamadı: ${eventId}`);
      }
      if (normalizeProfileId(event.profile_id) !== normalizeProfileId(profileId)) {
        throw new Error(`Background görev profili olayla uyuşmuyor: ${eventId}`);
      }
      const result = db
        .prepare(
          `INSERT OR IGNORE INTO background_tasks
             (task_id, event_id, handler_id, profile_id, status, attempts,
              max_attempts, next_retry_at, lease_until, last_error,
              created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL, ?, ?, NULL)`
        )
        .run(
          crypto.randomUUID(),
          eventId,
          handlerId,
          profileId,
          this.defaultMaxAttempts,
          nowIso,
          nowIso
        );
      db.exec('COMMIT');
      return (result.changes ?? 0) > 0;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* rollback hatası asıl hatayı gizlemesin */
      }
      throw error;
    }
  }

  getEvent(eventId: string): BackgroundEventRecord | null {
    const row = this.requireDb()
      .prepare('SELECT * FROM background_events WHERE event_id = ?')
      .get(eventId) as EventRow | undefined;
    return row ? mapEvent(row) : null;
  }

  hasEvent(eventId: string): boolean {
    const row = this.requireDb()
      .prepare('SELECT 1 AS found FROM background_events WHERE event_id = ?')
      .get(eventId) as { found?: number } | undefined;
    return Boolean(row?.found);
  }

  getTask(taskId: string): BackgroundTaskRecord | null {
    const row = this.requireDb()
      .prepare('SELECT * FROM background_tasks WHERE task_id = ?')
      .get(taskId) as TaskRow | undefined;
    return row ? mapTask(row) : null;
  }

  listTasks(options: BackgroundTaskListOptions = {}): BackgroundTaskRecord[] {
    const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const filters: string[] = [];
    const params: unknown[] = [];
    if (options.status) {
      filters.push('status = ?');
      params.push(options.status);
    }
    if (options.profileId) {
      filters.push('profile_id = ?');
      params.push(options.profileId);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = this.requireDb()
      .prepare(
        `SELECT * FROM background_tasks ${where}
         ORDER BY created_at ASC, task_id ASC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as TaskRow[];
    return rows.map(mapTask);
  }

  /**
   * İşlenmeye hazır ilk görevi kiralar: `attempts` artırılır, `lease_until`
   * yazılır. Yarım kalan `processing` görevleri `recoverInterrupted` ile geri
   * alınmadan yeniden kiralanmaz.
   */
  claimNextTask(
    leaseMs = 60_000,
    nowIso = this.now(),
    profileId?: string
  ): BackgroundTaskRecord | null {
    const db = this.requireDb();
    const leaseUntil = new Date(new Date(nowIso).getTime() + Math.max(1_000, leaseMs)).toISOString();
    // R2-A4: profil filtresi verilirse yalnızca o profile ait hazır görev
    // kiralanır; diğer profillerin görevleri beklemede kalır (kaybolmaz).
    const profileFilter = profileId ? ' AND profile_id = ?' : '';
    const profileParams = profileId ? [profileId] : [];
    const candidate = db
      .prepare(
        `SELECT task_id FROM background_tasks
         WHERE (status = 'pending'
            OR (status = 'retry_wait' AND next_retry_at IS NOT NULL AND next_retry_at <= ?))${profileFilter}
         ORDER BY created_at ASC, task_id ASC
         LIMIT 1`
      )
      .get(nowIso, ...profileParams) as { task_id?: string } | undefined;
    if (!candidate?.task_id) return null;

    const updated = db
      .prepare(
        `UPDATE background_tasks
            SET status = 'processing',
                attempts = attempts + 1,
                lease_until = ?,
                next_retry_at = NULL,
                updated_at = ?
          WHERE task_id = ?
            AND (status = 'pending'
                 OR (status = 'retry_wait' AND next_retry_at IS NOT NULL AND next_retry_at <= ?))`
      )
      .run(leaseUntil, nowIso, candidate.task_id, nowIso);

    if ((updated.changes ?? 0) === 0) return null;
    return this.getTask(candidate.task_id);
  }

  /**
   * R2-A4: hedef profil aktif değilken görevi `pending` durumuna geri alır ve
   * tüketilen deneme hakkını iade eder. Böylece bekleyen iş ne kaybolur ne de
   * profil aktif olmadan başarısız sayılır.
   */
  deferTask(taskId: string, reason: string, nowIso = this.now()): void {
    this.requireDb()
      .prepare(
        `UPDATE background_tasks
            SET status = 'pending',
                attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
                lease_until = NULL,
                next_retry_at = NULL,
                last_error = ?,
                updated_at = ?
          WHERE task_id = ? AND status = 'processing'`
      )
      .run(reason, nowIso, taskId);
  }

  markCompleted(taskId: string, nowIso = this.now()): void {
    this.requireDb()
      .prepare(
        `UPDATE background_tasks
            SET status = 'completed', completed_at = ?, lease_until = NULL,
                next_retry_at = NULL, last_error = NULL, updated_at = ?
          WHERE task_id = ?`
      )
      .run(nowIso, nowIso, taskId);
  }

  scheduleRetry(taskId: string, nextRetryAt: string, error: string, nowIso = this.now()): void {
    this.requireDb()
      .prepare(
        `UPDATE background_tasks
            SET status = 'retry_wait', next_retry_at = ?, lease_until = NULL,
                last_error = ?, updated_at = ?
          WHERE task_id = ?`
      )
      .run(nextRetryAt, error, nowIso, taskId);
  }

  markFailed(taskId: string, error: string, nowIso = this.now()): void {
    this.requireDb()
      .prepare(
        `UPDATE background_tasks
            SET status = 'failed', last_error = ?, lease_until = NULL,
                next_retry_at = NULL, updated_at = ?
          WHERE task_id = ?`
      )
      .run(error, nowIso, taskId);
  }

  cancelTask(taskId: string, reason: string, nowIso = this.now()): boolean {
    const result = this.requireDb()
      .prepare(
        `UPDATE background_tasks
            SET status = 'cancelled', last_error = ?, lease_until = NULL,
                next_retry_at = NULL, updated_at = ?
          WHERE task_id = ? AND status NOT IN ('completed', 'cancelled')`
      )
      .run(reason, nowIso, taskId);
    return (result.changes ?? 0) > 0;
  }

  /**
   * Çökme kurtarması: lease süresi dolmuş `processing` görevleri yeniden
   * `pending` olur; deneme hakkı tükendiyse `failed` işaretlenir.
   */
  recoverInterrupted(nowIso = this.now()): { requeued: number; failed: number } {
    const db = this.requireDb();
    const expired = db
      .prepare(
        `SELECT task_id, attempts, max_attempts FROM background_tasks
          WHERE status = 'processing' AND (lease_until IS NULL OR lease_until <= ?)`
      )
      .all(nowIso) as Array<{ task_id: string; attempts: number; max_attempts: number }>;

    let requeued = 0;
    let failed = 0;
    const update = db.prepare(
      `UPDATE background_tasks
          SET status = ?, lease_until = NULL,
              last_error = COALESCE(last_error, 'interrupted'),
              updated_at = ?
        WHERE task_id = ? AND status = 'processing'`
    );
    for (const row of expired) {
      const exhausted = row.attempts >= row.max_attempts;
      const result = update.run(exhausted ? 'failed' : 'pending', nowIso, row.task_id);
      if ((result.changes ?? 0) > 0) {
        if (exhausted) failed += 1;
        else requeued += 1;
      }
    }
    return { requeued, failed };
  }

  getStats(nowIso = this.now()): BackgroundTaskStats {
    const db = this.requireDb();
    const eventCount = db.prepare('SELECT COUNT(*) AS c FROM background_events').get() as {
      c?: number;
    };
    const taskCount = db.prepare('SELECT COUNT(*) AS c FROM background_tasks').get() as {
      c?: number;
    };
    const statusRows = db
      .prepare('SELECT status, COUNT(*) AS c FROM background_tasks GROUP BY status')
      .all() as Array<{ status: string; c: number }>;
    const dueRetries = db
      .prepare(
        `SELECT COUNT(*) AS c FROM background_tasks
          WHERE status = 'retry_wait' AND next_retry_at IS NOT NULL AND next_retry_at <= ?`
      )
      .get(nowIso) as { c?: number };

    const byStatus = Object.fromEntries(
      BACKGROUND_TASK_STATUSES.map((status) => [status, 0])
    ) as Record<BackgroundTaskStatus, number>;
    for (const row of statusRows) {
      if (BACKGROUND_TASK_STATUSES.includes(row.status as BackgroundTaskStatus)) {
        byStatus[row.status as BackgroundTaskStatus] = Number(row.c);
      }
    }

    return {
      events: Number(eventCount.c ?? 0),
      tasks: Number(taskCount.c ?? 0),
      byStatus,
      dueRetries: Number(dueRetries.c ?? 0),
    };
  }
}

export function createBackgroundTaskRepository(
  options: BackgroundTaskRepositoryOptions = {}
): BackgroundTaskRepository {
  return new BackgroundTaskRepository(options);
}
