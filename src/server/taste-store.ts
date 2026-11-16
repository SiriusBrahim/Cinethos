// ===========================================================================
// Cinethos Taste Engine — Taste Store (v1.5)
// data/taste/ ağacının sahibi, atomik yazım, manifest (TP-008/TP-027)
// ===========================================================================

import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  CorruptJsonFileError,
  writeJsonFileAtomicAsync,
  readJsonFileWithRecoveryAsync,
} from "./atomic-json.ts";
import type {
  TasteEvent,
  TasteProfile,
  ContentTasteIndex,
  TasteManifest,
  TasteFeatureObjection,
} from "../core/taste/types.ts";
import {
  ALGORITHM_VERSION,
  TAXONOMY_VERSION,
  CONFIG_VERSION,
} from "../core/taste/constants.ts";

export const TASTE_DATA_DIR = "data/taste";
export const TASTE_ARCHIVE_DIR = "data/taste/archive/taste-events";

export interface TasteStorePaths {
  taxonomy: string;
  index: string;
  events: string;
  profile: string;
  manifest: string;
  objections: string;
}

export function resolveTastePaths(dataDir: string = "data"): TasteStorePaths {
  if (dataDir === "data") {
    return {
      taxonomy: `${TASTE_DATA_DIR}/cinetrack-taste-taxonomy.json`,
      index: `${TASTE_DATA_DIR}/cinetrack-taste-index.json`,
      events: `${TASTE_DATA_DIR}/cinetrack-taste-events.json`,
      profile: `${TASTE_DATA_DIR}/cinetrack-taste-profile.json`,
      manifest: `${TASTE_DATA_DIR}/cinetrack-taste-manifest.json`,
      objections: `${TASTE_DATA_DIR}/cinetrack-taste-objections.json`,
    };
  }
  const base = path.join(dataDir, "taste");
  return {
    taxonomy: path.join(base, "cinetrack-taste-taxonomy.json"),
    index: path.join(base, "cinetrack-taste-index.json"),
    events: path.join(base, "cinetrack-taste-events.json"),
    profile: path.join(base, "cinetrack-taste-profile.json"),
    manifest: path.join(base, "cinetrack-taste-manifest.json"),
    objections: path.join(base, "cinetrack-taste-objections.json"),
  };
}

export const TASTE_PATHS: TasteStorePaths = resolveTastePaths("data");

function backupPathFor(filePath: string): string {
  return `${filePath}.bak`;
}

function isValidTasteEventsArray(raw: unknown): TasteEvent[] | null {
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { eventId?: unknown }).eventId !== "string" ||
      typeof (entry as { contentId?: unknown }).contentId !== "string" ||
      typeof (entry as { eventType?: unknown }).eventType !== "string"
    ) {
      return null;
    }
  }
  return raw as TasteEvent[];
}

function isValidTasteObjectionsArray(raw: unknown): TasteFeatureObjection[] | null {
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { contentId?: unknown }).contentId !== "string" ||
      typeof (entry as { metricId?: unknown }).metricId !== "string"
    ) {
      return null;
    }
  }
  return raw as TasteFeatureObjection[];
}

function isValidJsonRecord<T extends object>(raw: unknown): T | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as T;
}

// === Yazma Serileştirme Kilidi (Faz 1B — süreç içi FIFO kuyruk + süreçler arası .taste.lock) ===
const tasteWriteChains = new Map<string, Promise<unknown>>();
const TASTE_FILE_LOCK_STALE_MS = 15_000;
const TASTE_FILE_LOCK_TIMEOUT_MS = 10_000;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as { code?: string })?.code === "EPERM";
  }
}

async function withCrossProcessTasteLock<T>(
  dataDir: string,
  task: () => Promise<T>
): Promise<T> {
  const tasteDir =
    dataDir === "data" ? TASTE_DATA_DIR : path.join(dataDir || "data", "taste");
  await fsPromises.mkdir(tasteDir, { recursive: true });
  const lockPath = path.join(tasteDir, ".taste.lock");
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`;
  const deadline = Date.now() + TASTE_FILE_LOCK_TIMEOUT_MS;
  let backoffMs = 4;

  while (true) {
    try {
      const handle = await fsPromises.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(token, "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code !== "EEXIST") {
        throw err;
      }

      try {
        const [stat, content] = await Promise.all([
          fsPromises.stat(lockPath),
          fsPromises.readFile(lockPath, "utf8").catch(() => ""),
        ]);
        const holderPid = Number(content.split(":")[0]);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > TASTE_FILE_LOCK_STALE_MS || (holderPid > 0 && !isProcessAlive(holderPid))) {
          await fsPromises.unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        // Kilit başka bir işlem tarafından az önce serbest bırakılmış olabilir
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Taste store dosya kilidi zaman aşımına uğradı (${lockPath}).`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      backoffMs = Math.min(25, Math.round(backoffMs * 1.5));
    }
  }

  try {
    return await task();
  } finally {
    try {
      const current = await fsPromises.readFile(lockPath, "utf8").catch(() => "");
      if (!current || current === token) {
        await fsPromises.unlink(lockPath).catch(() => undefined);
      }
    } catch {
      // Temizleme hatası asıl iş sonucunu maskelememelidir
    }
  }
}

function serializeTasteWrite<T>(dataDir: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(dataDir || "data");
  const prev = tasteWriteChains.get(key) ?? Promise.resolve();
  const next = prev.then(
    () => withCrossProcessTasteLock(dataDir, task),
    () => withCrossProcessTasteLock(dataDir, task)
  );
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  tasteWriteChains.set(key, settled);
  void settled.finally(() => {
    if (tasteWriteChains.get(key) === settled) {
      tasteWriteChains.delete(key);
    }
  });
  return next;
}

// === Event Store ===

/**
 * Olay ekle (append-only, idempotent, kilitli — TP-005 / Faz 1B).
 * Yeni eklenip eklenmediğini döndüren ayrıntılı sürüm.
 */
export async function appendTasteEventIdempotent(
  event: TasteEvent,
  dataDir: string = "data"
): Promise<{ added: boolean; total: number }> {
  return serializeTasteWrite(dataDir, async () => {
    const paths = resolveTastePaths(dataDir);
    const events = await readTasteEvents(dataDir);
    if (events.some((e) => e.eventId === event.eventId)) {
      return { added: false, total: events.length };
    }
    events.push(event);
    await writeJsonFileAtomicAsync(paths.events, JSON.stringify(events, null, 2), {
      backupPath: backupPathFor(paths.events),
      validateParsed: (raw) => isValidTasteEventsArray(raw) !== null,
    });
    return { added: true, total: events.length };
  });
}

/**
 * Olay ekle (append-only, idempotent — TP-005)
 */
export async function appendTasteEvent(
  event: TasteEvent,
  dataDir: string = "data"
): Promise<void> {
  await appendTasteEventIdempotent(event, dataDir);
}

/**
 * Olay listesini oku — bozuksa önce `.bak` yedeğinden kurtarır; kurtarılamazsa açık hata fırlatır.
 */
export async function readTasteEvents(dataDir: string = "data"): Promise<TasteEvent[]> {
  const paths = resolveTastePaths(dataDir);
  const result = await readJsonFileWithRecoveryAsync<TasteEvent[]>(paths.events, {
    backupPaths: [backupPathFor(paths.events)],
    validate: isValidTasteEventsArray,
    label: "cinetrack-taste-events.json",
  });
  if (result.status === "ok" || result.status === "recovered") {
    return Array.isArray(result.data) ? result.data : [];
  }
  if (result.status === "missing") {
    return [];
  }
  throw new CorruptJsonFileError(paths.events, result.error);
}

/**
 * Tüm olayları toplu yaz (migration sonrası)
 */
export async function writeTasteEvents(
  events: TasteEvent[],
  dataDir: string = "data"
): Promise<void> {
  return serializeTasteWrite(dataDir, async () => {
    const paths = resolveTastePaths(dataDir);
    await writeJsonFileAtomicAsync(paths.events, JSON.stringify(events, null, 2), {
      backupPath: backupPathFor(paths.events),
      validateParsed: (raw) => isValidTasteEventsArray(raw) !== null,
    });
  });
}

// === Profile Store ===

/**
 * Profili yaz (atomik, kilitli, manifest güncelle)
 */
export async function writeTasteProfile(
  profile: TasteProfile,
  dataDir: string = "data",
  eventWatermark?: string
): Promise<void> {
  return serializeTasteWrite(dataDir, async () => {
    const paths = resolveTastePaths(dataDir);
    await writeJsonFileAtomicAsync(paths.profile, JSON.stringify(profile, null, 2), {
      backupPath: backupPathFor(paths.profile),
      validateParsed: (raw) => isValidJsonRecord<TasteProfile>(raw) !== null,
    });
    await writeManifestUnlocked(dataDir, eventWatermark);
  });
}

/**
 * Profili oku
 */
export async function readTasteProfile(
  dataDir: string = "data"
): Promise<TasteProfile | null> {
  const paths = resolveTastePaths(dataDir);
  const result = await readJsonFileWithRecoveryAsync<TasteProfile>(paths.profile, {
    backupPaths: [backupPathFor(paths.profile)],
    validate: isValidJsonRecord<TasteProfile>,
    label: "cinetrack-taste-profile.json",
  });
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  if (result.status === "missing") {
    return null;
  }
  throw new CorruptJsonFileError(paths.profile, result.error);
}

// === Index Store ===

/**
 * İndeksi yaz (atomik, kilitli, manifest güncelle)
 */
export async function writeTasteIndex(
  index: ContentTasteIndex,
  dataDir: string = "data"
): Promise<void> {
  return serializeTasteWrite(dataDir, async () => {
    const paths = resolveTastePaths(dataDir);
    await writeJsonFileAtomicAsync(paths.index, JSON.stringify(index, null, 2), {
      backupPath: backupPathFor(paths.index),
      validateParsed: (raw) => isValidJsonRecord<ContentTasteIndex>(raw) !== null,
    });
    await writeManifestUnlocked(dataDir);
  });
}

/**
 * İndeksi oku
 */
export async function readTasteIndex(
  dataDir: string = "data"
): Promise<ContentTasteIndex | null> {
  const paths = resolveTastePaths(dataDir);
  const result = await readJsonFileWithRecoveryAsync<ContentTasteIndex>(paths.index, {
    backupPaths: [backupPathFor(paths.index)],
    validate: isValidJsonRecord<ContentTasteIndex>,
    label: "cinetrack-taste-index.json",
  });
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  if (result.status === "missing") {
    return null;
  }
  throw new CorruptJsonFileError(paths.index, result.error);
}

// === Manifest ===

/**
 * Manifest'i güncelle (TP-027) — iç yardımcı (kilit altından çağrılır).
 */
async function writeManifestUnlocked(
  dataDir: string = "data",
  eventWatermark?: string
): Promise<void> {
  const paths = resolveTastePaths(dataDir);
  const previous =
    eventWatermark === undefined
      ? await readTasteManifest(dataDir).catch((err) => {
          if (err instanceof CorruptJsonFileError) return null;
          throw err;
        })
      : null;
  const manifest: TasteManifest = {
    generationId: randomUUID(),
    taxonomyVersion: TAXONOMY_VERSION,
    algorithmVersion: ALGORITHM_VERSION,
    configVersion: CONFIG_VERSION,
    asOf: new Date().toISOString(),
    files: {
      taxonomy: paths.taxonomy,
      index: paths.index,
      events: paths.events,
      profile: paths.profile,
    },
    eventWatermark: eventWatermark ?? previous?.eventWatermark ?? "",
  };
  await writeJsonFileAtomicAsync(paths.manifest, JSON.stringify(manifest, null, 2), {
    backupPath: backupPathFor(paths.manifest),
    validateParsed: (raw) => isValidJsonRecord<TasteManifest>(raw) !== null,
  });
}

/**
 * Manifest'i oku
 */
export async function readTasteManifest(
  dataDir: string = "data"
): Promise<TasteManifest | null> {
  const paths = resolveTastePaths(dataDir);
  const result = await readJsonFileWithRecoveryAsync<TasteManifest>(paths.manifest, {
    backupPaths: [backupPathFor(paths.manifest)],
    validate: isValidJsonRecord<TasteManifest>,
    label: "cinetrack-taste-manifest.json",
  });
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  if (result.status === "missing") {
    return null;
  }
  throw new CorruptJsonFileError(paths.manifest, result.error);
}

// === V1.5 İtiraz (Objection) Deposu ===

/**
 * Kullanıcının "Bu içerikte bu özellik yok" itirazlarını oku
 */
export async function readTasteObjections(
  dataDir: string = "data"
): Promise<TasteFeatureObjection[]> {
  const paths = resolveTastePaths(dataDir);
  const result = await readJsonFileWithRecoveryAsync<TasteFeatureObjection[]>(
    paths.objections,
    {
      backupPaths: [backupPathFor(paths.objections)],
      validate: isValidTasteObjectionsArray,
      label: "cinetrack-taste-objections.json",
    }
  );
  if (result.status === "ok" || result.status === "recovered") {
    return Array.isArray(result.data) ? result.data : [];
  }
  if (result.status === "missing") {
    return [];
  }
  throw new CorruptJsonFileError(paths.objections, result.error);
}

/**
 * İtiraz listesini atomik olarak yaz
 */
export async function writeTasteObjections(
  objections: TasteFeatureObjection[],
  dataDir: string = "data"
): Promise<void> {
  return serializeTasteWrite(dataDir, async () => {
    const paths = resolveTastePaths(dataDir);
    await writeJsonFileAtomicAsync(
      paths.objections,
      JSON.stringify(objections, null, 2),
      {
        backupPath: backupPathFor(paths.objections),
        validateParsed: (raw) => isValidTasteObjectionsArray(raw) !== null,
      }
    );
  });
}
