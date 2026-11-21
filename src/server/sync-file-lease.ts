/**
 * Aşama 2 (B-38) — Süreçler arası senkronizasyon kilidi (advisory file lease).
 *
 * Uygulama normalde tek Node süreci olarak çalışır; bu kilit yine de aynı
 * `data/` dizinini paylaşan iki süreç (ör. yanlışlıkla ikinci bir `npm start`,
 * bir bakım betiği) aynı anda GitHub'a yazmaya çalışırsa ikinciyi engeller.
 *
 * Tasarım:
 * - `open(lockPath, 'wx', 0o600)` ile atomik oluşturma; içerik `{token, pid,
 *   hostname, acquiredAt}`.
 * - Kilit doluysa: aynı makinede PID yaşamıyorsa veya `staleMs` geçtiyse
 *   **bayat** kabul edilir. Bayat kilit önce `rename` ile kenara alınır
 *   (yarışta taze kilidi silmemek için), sonra açılır.
 * - `release()` yalnızca kendi token'ı dosyada yazıyorsa siler; başka sürecin
 *   kilidini asla kaldırmaz.
 *
 * SINIR: Bu bir *advisory* kilittir. Kilidi tanımayan üçüncü taraf yazımlarını
 * engellemez; NFS/geneş ağ dosya sistemlerinde `O_EXCL` semantiği garanti
 * değildir. SQLite tabanlı background kuyruğu kendi transaction/lease
 * mekanizmasını kullanır.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SyncFileLeaseInfo {
  readonly token: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

export interface SyncFileLeaseOptions {
  readonly staleMs?: number;
  readonly now?: () => number;
  readonly pid?: number;
  readonly hostname?: string;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly maxTakeoverAttempts?: number;
}

export class SyncLeaseBusyError extends Error {
  readonly code = 'sync_lease_busy';
  readonly holder: SyncFileLeaseInfo | null;
  constructor(lockPath: string, holder: SyncFileLeaseInfo | null) {
    const holderText = holder
      ? ` (pid=${holder.pid}, host=${holder.hostname}, alındı=${holder.acquiredAt})`
      : '';
    super(`Başka bir süreç senkronizasyon kilidini tutuyor: ${lockPath}${holderText}`);
    this.name = 'SyncLeaseBusyError';
    this.holder = holder;
  }
}

export function isSyncLeaseBusyError(error: unknown): error is SyncLeaseBusyError {
  return error instanceof SyncLeaseBusyError;
}

const DEFAULT_STALE_MS = 10 * 60_000;

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function readLeaseInfo(lockPath: string): SyncFileLeaseInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SyncFileLeaseInfo>;
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.acquiredAt !== 'string'
    ) {
      return null;
    }
    return {
      token: parsed.token,
      pid: parsed.pid,
      hostname: parsed.hostname,
      acquiredAt: parsed.acquiredAt,
    };
  } catch {
    return null;
  }
}

function fileAgeMs(lockPath: string, nowMs: number): number | null {
  try {
    return Math.max(0, nowMs - fs.statSync(lockPath).mtimeMs);
  } catch {
    return null;
  }
}

function isStale(
  lockPath: string,
  info: SyncFileLeaseInfo | null,
  options: Required<Pick<SyncFileLeaseOptions, 'staleMs' | 'now' | 'hostname' | 'isProcessAlive'>>
): boolean {
  const age = fileAgeMs(lockPath, options.now());
  if (age !== null && age >= options.staleMs) return true;
  if (!info) {
    // Bozuk/okunamayan kilit: yaşı bilinemiyorsa temkinli davran (bayat sayma).
    return age !== null && age >= options.staleMs;
  }
  if (info.hostname !== options.hostname) return false;
  return !options.isProcessAlive(info.pid);
}

function takeoverStaleLock(lockPath: string, nowMs: number): void {
  const asidePath = `${lockPath}.stale-${process.pid}-${nowMs}-${crypto
    .randomBytes(4)
    .toString('hex')}`;
  try {
    fs.renameSync(lockPath, asidePath);
  } catch {
    // Başka bir süreç bizden önce temizlediyse yarış kaybedilmiş sayılmaz.
    return;
  }
  try {
    fs.rmSync(asidePath, { force: true });
  } catch {
    // Kenara alınan dosya silinemezse ana kilit yine de serbest bırakıldı.
  }
}

function writeLease(lockPath: string, info: SyncFileLeaseInfo): void {
  const fd = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export interface SyncFileLease {
  readonly token: string;
  readonly path: string;
  readonly info: SyncFileLeaseInfo;
  release(): void;
  renew(): boolean;
}

/**
 * Kilidi almayı dener; başka canlı süreç tutuyorsa `null` döner.
 * `staleMs` geçmiş veya sahibi ölmüş kilit devralınır.
 */
export function tryAcquireSyncFileLease(
  lockPath: string,
  options: SyncFileLeaseOptions = {}
): SyncFileLease | null {
  const resolved = path.resolve(lockPath);
  const resolvedOptions = {
    staleMs: Math.max(100, Math.floor(options.staleMs ?? DEFAULT_STALE_MS)),
    now: options.now ?? Date.now,
    hostname: options.hostname ?? os.hostname(),
    isProcessAlive: options.isProcessAlive ?? defaultIsProcessAlive,
  };
  const maxAttempts = Math.max(1, Math.min(5, options.maxTakeoverAttempts ?? 3));
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const info: SyncFileLeaseInfo = {
      token: crypto.randomUUID(),
      pid: options.pid ?? process.pid,
      hostname: resolvedOptions.hostname,
      acquiredAt: new Date(resolvedOptions.now()).toISOString(),
    };
    try {
      writeLease(resolved, info);
      return buildLease(resolved, info);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    }

    const holder = readLeaseInfo(resolved);
    if (!isStale(resolved, holder, resolvedOptions)) {
      return null;
    }
    takeoverStaleLock(resolved, resolvedOptions.now());
  }
  return null;
}

export function acquireSyncFileLease(
  lockPath: string,
  options: SyncFileLeaseOptions = {}
): SyncFileLease {
  const lease = tryAcquireSyncFileLease(lockPath, options);
  if (lease) return lease;
  throw new SyncLeaseBusyError(path.resolve(lockPath), readLeaseInfo(path.resolve(lockPath)));
}

function buildLease(lockPath: string, info: SyncFileLeaseInfo): SyncFileLease {
  const owns = (): boolean => readLeaseInfo(lockPath)?.token === info.token;
  return {
    token: info.token,
    path: lockPath,
    info,
    release(): void {
      if (!owns()) return;
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        // Kilit zaten kaldırılmışsa yoksay.
      }
    },
    renew(): boolean {
      if (!owns()) return false;
      try {
        const now = new Date();
        fs.utimesSync(lockPath, now, now);
        return true;
      } catch {
        return false;
      }
    },
  };
}
