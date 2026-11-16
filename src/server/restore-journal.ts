import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * P0-01-A: Kalıcı restore journal.
 *
 * Sunucu commit'ten önce niyetini diske yazar; süreç çökerse yeniden açılışta
 * hangi aşamada kalındığı bilinir ve önceki tutarlı belge geri yüklenebilir.
 * Snapshot RAM'de değil, izinleri kısıtlı bir dosyada ve sha256 özetiyle tutulur.
 */

export type RestoreState =
  | 'prepared'
  | 'server_committed'
  | 'client_committed'
  | 'finalized'
  | 'rollback_required'
  | 'rolled_back';

export interface RestoreJournalRecord {
  restoreId: string;
  state: RestoreState;
  createdAt: string;
  expiresAt: string;
  archiveHash: string;
  beforeDocumentHash: string;
  beforeRevision: number;
  committedRevision?: number;
  /** Önceki belge snapshot'ının sha256 özeti (bütünlük kontrolü). */
  beforeSnapshotSha256?: string;
  /** Arşiv dosyası (data/archives/...) — yalnızca tanı için. */
  archivePath?: string;
  lastError?: string;
}

const SNAPSHOT_SUFFIX = '.before.json';

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const handle = await fs.open(tmpPath, 'w', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, filePath);
}

export class RestoreJournal {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  private recordPath(restoreId: string): string {
    return path.join(this.dir, `${restoreId}.json`);
  }

  private snapshotPath(restoreId: string): string {
    return path.join(this.dir, `${restoreId}${SNAPSHOT_SUFFIX}`);
  }

  /** Önceki belgeyi atomik olarak diske yazar ve özetini döner. */
  async saveSnapshot(
    restoreId: string,
    document: unknown
  ): Promise<{ snapshotSha256: string }> {
    const serialized = JSON.stringify(document);
    const snapshotSha256 = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
    await writeFileAtomic(this.snapshotPath(restoreId), serialized);
    return { snapshotSha256 };
  }

  async readSnapshot(restoreId: string): Promise<{ document: unknown; sha256: string } | null> {
    try {
      const raw = await fs.readFile(this.snapshotPath(restoreId), 'utf8');
      const sha256 = crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
      return { document: JSON.parse(raw), sha256 };
    } catch {
      return null;
    }
  }

  async write(record: RestoreJournalRecord): Promise<void> {
    await writeFileAtomic(this.recordPath(record.restoreId), JSON.stringify(record, null, 2));
  }

  async get(restoreId: string): Promise<RestoreJournalRecord | null> {
    try {
      const raw = await fs.readFile(this.recordPath(restoreId), 'utf8');
      const parsed = JSON.parse(raw) as RestoreJournalRecord;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.restoreId !== 'string') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async update(
    restoreId: string,
    patch: Partial<RestoreJournalRecord>
  ): Promise<RestoreJournalRecord | null> {
    const current = await this.get(restoreId);
    if (!current) return null;
    const next: RestoreJournalRecord = { ...current, ...patch, restoreId };
    await this.write(next);
    return next;
  }

  async list(): Promise<RestoreJournalRecord[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const records: RestoreJournalRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith(SNAPSHOT_SUFFIX)) continue;
      const record = await this.get(name.slice(0, -'.json'.length));
      if (record) records.push(record);
    }
    return records;
  }

  /** Kaydı ve snapshot'ı siler (finalize/rolled_back sonrası). */
  async remove(restoreId: string): Promise<void> {
    await fs.rm(this.recordPath(restoreId), { force: true }).catch(() => {
      // kayıt zaten silinmiş olabilir
    });
    await fs.rm(this.snapshotPath(restoreId), { force: true }).catch(() => {
      // snapshot zaten silinmiş olabilir
    });
  }
}
