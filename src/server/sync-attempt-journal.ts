/**
 * Aşama 2 (B-10) — Senkronizasyon denemesi günlüğü.
 *
 * GitHub senkronizasyonu başladığında `data/sync-attempt.json` dosyasına
 * "uçuşta" kaydı yazılır; işlem bittiğinde (başarı veya hata) kayıt silinir.
 * Süreç çökerse kayıt kalır. Bir sonraki süreç önce süreçler-arası lease'i
 * alabilirse kayıt "interrupted" olarak raporlanır ve temizlenir; aktif bir
 * lease sahibi varsa journal'a dokunulmaz.
 *
 * Amaç: "çalışıyor" durumunda çöküp yeniden açıldığında durumun sonsuza dek
 * `running` görünmesini engellemek. Kuyruk bellekte olduğu için işlem yeniden
 * başlatılmaz; kullanıcıya açık bir kesinti kaydı sunulur ve yeni işlem
 * başlatılabilir.
 *
 * Yazma yolu Aşama 1 kapısından (`runGuardedWrite`) geçer; test ortamında
 * gerçek `data/` dizinine yazılamaz.
 */

import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFileAtomicAsync } from './atomic-json.ts';
import { runGuardedWrite } from './test-data-guard.ts';

export interface SyncAttemptRecord {
  readonly operation: string;
  readonly startedAt: string;
  readonly pid: number;
  readonly hostname: string;
  readonly leaseToken?: string;
}

export interface SyncAttemptJournalOptions {
  readonly dataDir: string;
  readonly fileName?: string;
  readonly now?: () => string;
  readonly pid?: number;
  readonly hostname?: string;
}

function parseAttempt(raw: unknown): SyncAttemptRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.operation !== 'string' || !record.operation) return null;
  if (typeof record.startedAt !== 'string' || !record.startedAt) return null;
  return {
    operation: record.operation,
    startedAt: record.startedAt,
    pid: typeof record.pid === 'number' ? record.pid : 0,
    hostname: typeof record.hostname === 'string' ? record.hostname : '',
    ...(typeof record.leaseToken === 'string' ? { leaseToken: record.leaseToken } : {}),
  };
}

export class SyncAttemptJournal {
  private readonly filePath: string;
  private readonly now: () => string;
  private readonly pid: number;
  private readonly hostname: string;

  constructor(options: SyncAttemptJournalOptions) {
    this.filePath = path.join(
      path.resolve(options.dataDir),
      options.fileName || 'sync-attempt.json'
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? 'localhost';
  }

  getFilePath(): string {
    return this.filePath;
  }

  read(): SyncAttemptRecord | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      return parseAttempt(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async begin(operation: string, leaseToken?: string): Promise<SyncAttemptRecord> {
    const record: SyncAttemptRecord = {
      operation,
      startedAt: this.now(),
      pid: this.pid,
      hostname: this.hostname,
      ...(leaseToken ? { leaseToken } : {}),
    };
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    await runGuardedWrite(this.filePath, 'data-storage', () =>
      writeJsonFileAtomicAsync(this.filePath, JSON.stringify(record, null, 2), {
        validateParsed: (parsed) => parseAttempt(parsed) !== null,
      })
    );
    return record;
  }

  async complete(expectedLeaseToken?: string): Promise<boolean> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    return runGuardedWrite(this.filePath, 'data-storage', async () => {
      const current = this.read();
      if (!current) return false;
      if (expectedLeaseToken && current.leaseToken !== expectedLeaseToken) return false;
      try {
        await fs.promises.unlink(this.filePath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
        throw error;
      }
    });
  }

  /** Salt okunur: silme işlemi yalnızca caller süreçler-arası lease'i aldıktan sonra yapılır. */
  async recoverInterrupted(): Promise<SyncAttemptRecord | null> {
    return this.read();
  }
}

export function createSyncAttemptJournal(
  options: SyncAttemptJournalOptions
): SyncAttemptJournal {
  return new SyncAttemptJournal(options);
}
