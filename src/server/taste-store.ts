// ===========================================================================
// Cinethos Taste Engine — Taste Store (v1.5)
// data/taste/ ağacının sahibi, atomik yazım, manifest (TP-008/TP-027)
// ===========================================================================

import { randomUUID } from "node:crypto";
import path from "node:path";
import { writeJsonFileAtomicAsync, readJsonFileWithRecoveryAsync } from "./atomic-json.ts";
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

// === Yazma Serileştirme Kilidi (Faz 1B — eşzamanlı .tmp / bozulma önleme) ===
const tasteWriteChains = new Map<string, Promise<unknown>>();

function serializeTasteWrite<T>(dataDir: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(dataDir || "data");
  const prev = tasteWriteChains.get(key) ?? Promise.resolve();
  const next = prev.then(task, task);
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
    await writeJsonFileAtomicAsync(paths.events, JSON.stringify(events, null, 2));
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
 * Olay listesini oku
 */
export async function readTasteEvents(dataDir: string = "data"): Promise<TasteEvent[]> {
  const paths = resolveTastePaths(dataDir);
  const result = await readJsonFileWithRecoveryAsync<TasteEvent[]>(paths.events);
  if (result.status === "ok" || result.status === "recovered") {
    return Array.isArray(result.data) ? result.data : [];
  }
  return [];
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
    await writeJsonFileAtomicAsync(paths.events, JSON.stringify(events, null, 2));
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
    await writeJsonFileAtomicAsync(paths.profile, JSON.stringify(profile, null, 2));
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
  const result = await readJsonFileWithRecoveryAsync<TasteProfile>(paths.profile);
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  return null;
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
    await writeJsonFileAtomicAsync(paths.index, JSON.stringify(index, null, 2));
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
  const result = await readJsonFileWithRecoveryAsync<ContentTasteIndex>(paths.index);
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  return null;
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
  const previous = eventWatermark === undefined ? await readTasteManifest(dataDir) : null;
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
  await writeJsonFileAtomicAsync(paths.manifest, JSON.stringify(manifest, null, 2));
}

/**
 * Manifest'i oku
 */
export async function readTasteManifest(
  dataDir: string = "data"
): Promise<TasteManifest | null> {
  const paths = resolveTastePaths(dataDir);
  const result = await readJsonFileWithRecoveryAsync<TasteManifest>(paths.manifest);
  if (result.status === "ok" || result.status === "recovered") {
    return result.data;
  }
  return null;
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
    paths.objections
  );
  if (result.status === "ok" || result.status === "recovered") {
    return Array.isArray(result.data) ? result.data : [];
  }
  return [];
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
      JSON.stringify(objections, null, 2)
    );
  });
}
