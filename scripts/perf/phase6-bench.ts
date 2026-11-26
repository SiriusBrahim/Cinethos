/**
 * Aşama 6 — Yerel kalıcılık, Excel önizleme ve dışa aktarma ölçüm betiği.
 *
 * Aynı fixture boyutlarıyla (1.000 / 5.000 / 10.000 kayıt) önce/sonra
 * karşılaştırması üretir. Gerçek üretim modüllerini çağırır; hiçbir değer
 * tahmin edilmez. Ölçüm sonuçları `--out` verilirse JSON olarak yazılır.
 *
 * Kullanım:
 *   ./node_modules/.bin/tsx scripts/perf/phase6-bench.ts --label before \
 *     --out docs/audits/phase6-perf-before.json
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Profile, SavedItem } from '../../src/core/cinetrack-core.ts';
import { normalizeSavedItem } from '../../src/core/cinetrack-core.ts';
import {
  StorageWriteMemo,
  applyLocalStoragePlan,
  buildLocalStoragePlan,
} from '../../src/app/persistence/persistence-plan.ts';
import * as excelBackup from '../../src/server/excel-profile-backup.ts';

const argv = process.argv.slice(2);
const argValue = (name: string): string | null => {
  const idx = argv.indexOf(name);
  return idx >= 0 && argv[idx + 1] ? argv[idx + 1] : null;
};
const label = argValue('--label') || 'run';
const outFile = argValue('--out');

const STATUSES = ['completed', 'watchlist', 'watching'] as const;

export function buildFixtureItems(count: number): SavedItem[] {
  const items: SavedItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const isTv = i % 3 === 0;
    const item = normalizeSavedItem({
      id: isTv ? 900000 + i : 100000 + i,
      media_type: isTv ? 'tv' : 'movie',
      title: `Fixture ${isTv ? 'Dizi' : 'Film'} ${i}`,
      status: STATUSES[i % STATUSES.length],
      overview: 'Sinema Künyesi ölçüm fixture açıklaması. '.repeat(6),
      poster_path: `/fixture-${i}.jpg`,
      vote_average: 7.5,
      release_date: `20${10 + (i % 15)}-0${1 + (i % 9)}-1${i % 9}`,
      genre_ids: [28, 12, 35, 18],
      addedAt: new Date(Date.UTC(2024, 0, 1) + i * 60_000).toISOString(),
      runtime: 120,
      number_of_episodes: isTv ? 24 : undefined,
      number_of_seasons: isTv ? 2 : undefined,
    });
    if (item) items.push(item);
  }
  return items;
}

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function buildProfile(items: SavedItem[]): Profile {
  return {
    id: 'PROFILE-DEFAULT',
    name: 'Ölçüm Profili',
    createdAt: '2026-01-01T00:00:00.000Z',
    preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
    items,
    favoriteActors: [],
  };
}

function timeMs(fn: () => void, iterations = 3): number {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)] * 100) / 100;
}

async function timeAsyncMs(fn: () => Promise<void>, iterations = 2): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)] * 100) / 100;
}

function rssMb(): number {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

/** Async iş boyunca 10 ms aralıkla RSS örnekleyip zirveyi döndürür. */
async function withRssPeak<T>(fn: () => Promise<T>): Promise<{ result: T; peakRssMb: number; deltaMb: number }> {
  const start = rssMb();
  let peak = start;
  const sampler = setInterval(() => {
    const current = rssMb();
    if (current > peak) peak = current;
  }, 10);
  try {
    const result = await fn();
    return { result, peakRssMb: peak, deltaMb: Math.round((peak - start) * 10) / 10 };
  } finally {
    clearInterval(sampler);
  }
}

/**
 * 50 hızlı ardışık güncelleme: her güncellemede tam listenin serileştirilip
 * yazılmasının toplam maliyeti. Debounce/scheduler varsa tek yazıma düşer.
 */
async function measureRapidUpdateBurst(items: SavedItem[]) {
  const profile = buildProfile(items);
  const snapshotWith = (list: SavedItem[]) => ({
    profiles: [{ ...profile, items: list }],
    activeProfileId: profile.id,
    profileName: profile.name,
    preferences: profile.preferences,
    favoriteActors: [],
    deletedKeys: {},
    savedItems: list,
  });
  const storage = memoryStorage();
  const memo = new StorageWriteMemo();
  const UPDATES = 50;

  type SchedulerCtor = new (options: {
    storage: ReturnType<typeof memoryStorage>;
    delayMs?: number;
  }) => {
    request: (snapshot: ReturnType<typeof snapshotWith>) => void;
    flush: () => unknown;
  };

  let schedulerModule: { StorageWriteScheduler?: SchedulerCtor } | null = null;
  try {
    schedulerModule = (await import('../../src/app/persistence/local-write-scheduler.ts')) as {
      StorageWriteScheduler?: SchedulerCtor;
    };
  } catch {
    schedulerModule = null;
  }

  const Scheduler = schedulerModule?.StorageWriteScheduler;
  const start = process.hrtime.bigint();
  let writes = 0;
  if (Scheduler) {
    const scheduler = new Scheduler({ storage, delayMs: 200 });
    for (let i = 0; i < UPDATES; i += 1) {
      scheduler.request(snapshotWith(items.slice(0, items.length - (i % 3))));
    }
    scheduler.flush();
    writes = storage.data.size;
  } else {
    for (let i = 0; i < UPDATES; i += 1) {
      applyLocalStoragePlan(storage, buildLocalStoragePlan(snapshotWith(items)), memo);
      writes = storage.data.size;
    }
  }
  const totalMs = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    updates: UPDATES,
    totalMs: Math.round(totalMs * 10) / 10,
    perUpdateMs: Math.round((totalMs / UPDATES) * 100) / 100,
    schedulerUsed: Boolean(Scheduler),
    distinctKeysWritten: writes,
  };
}

async function measureLocalStorage(items: SavedItem[]) {
  const profile = buildProfile(items);
  const snapshot = {
    profiles: [profile],
    activeProfileId: profile.id,
    profileName: profile.name,
    preferences: profile.preferences,
    favoriteActors: [],
    deletedKeys: {},
    savedItems: items,
  };
  const plan = buildLocalStoragePlan(snapshot);
  const listValue =
    (plan.list as { value?: string }).value ??
    (plan.list as { primary?: string }).primary ??
    '';
  const payloadBytes = Buffer.byteLength(listValue, 'utf8');
  const serializationMs = timeMs(() => {
    buildLocalStoragePlan(snapshot);
  });

  const storage = memoryStorage();
  const memo = new StorageWriteMemo();
  const firstWriteMs = timeMs(() => {
    applyLocalStoragePlan(storage, plan, memo);
  }, 1);
  const repeatWriteMs = timeMs(() => {
    applyLocalStoragePlan(storage, plan, memo);
  });

  const compactFallbackSupported = Boolean(
    (plan.list as { compactFallback?: string }).compactFallback
  );

  return {
    payloadBytes,
    serializationMs,
    firstWriteMs,
    repeatWriteMs,
    compactFallbackSupported,
  };
}

async function measurePreview(items: SavedItem[], tmpDir: string) {
  const profile = buildProfile(items);
  const posterCacheDir = path.join(tmpDir, 'posters');
  const datasetMs = await timeAsyncMs(async () => {
    await excelBackup.buildProfileBackupDataset({ profile });
  }, 2);
  const datasetPeak = await withRssPeak(async () => excelBackup.buildProfileBackupDataset({ profile }));
  const dataset = datasetPeak.result;
  const serializedBytes = Buffer.byteLength(JSON.stringify(dataset), 'utf8');

  const previewPageFn = (
    excelBackup as unknown as Record<string, unknown>
  ).buildProfileBackupPreviewPage as
    | ((options: Record<string, unknown>) => Promise<unknown>)
    | undefined;

  let paginated: { ms: number; bytes: number } | null = null;
  if (previewPageFn) {
    const pageMs = await timeAsyncMs(async () => {
      await previewPageFn({ profile, page: 1, pageSize: 50 });
    }, 2);
    const page = (await previewPageFn({ profile, page: 1, pageSize: 50 })) as object;
    paginated = { ms: pageMs, bytes: Buffer.byteLength(JSON.stringify(page), 'utf8') };
  }

  return {
    fullDatasetMs: datasetMs,
    fullDatasetJsonBytes: serializedBytes,
    rssDeltaMb: datasetPeak.deltaMb,
    paginatedPreview: paginated,
    peakRssMb: datasetPeak.peakRssMb,
    posterCacheDirExists: existsSync(posterCacheDir),
  };
}

async function measureExcelExport(items: SavedItem[], tmpDir: string) {
  const profile = buildProfile(items);
  const posterCacheDir = path.join(tmpDir, 'export-posters');
  let sizeBytes = 0;
  const run = async () => {
    const built = await excelBackup.generateProfileExcelBuffer({
      profile,
      posterCacheDir,
      posterFetcher: async () => ({ status: 404, contentType: null, buffer: Buffer.alloc(0) }),
      posterConcurrency: 8,
      includeTasteDnaSheet: false,
    });
    sizeBytes = built.sizeBytes;
    return built;
  };
  const start = process.hrtime.bigint();
  const peak = await withRssPeak(run);
  const ms = Math.round((Number(process.hrtime.bigint() - start) / 1e6) * 100) / 100;
  return { ms, sizeBytes, peakRssMb: peak.peakRssMb, rssDeltaMb: peak.deltaMb };
}

async function main() {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'cinethos-phase6-bench-'));
  const results: Record<string, unknown> = {
    label,
    generatedAt: new Date().toISOString(),
    node: process.version,
    scale: {},
  };

  try {
    for (const size of [1000, 5000, 10000]) {
      const items = buildFixtureItems(size);
      results.scale[String(size)] = {
        localStorage: await measureLocalStorage(items),
        rapidUpdateBurst: await measureRapidUpdateBurst(items),
        preview: await measurePreview(items, tmpDir),
      };
    }
    const exportItems = buildFixtureItems(1000);
    results.excelExport1000 = await measureExcelExport(exportItems, tmpDir);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  const text = JSON.stringify(results, null, 2);
  console.log(text);
  if (outFile) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path.resolve(outFile), `${text}\n`);
    console.error(`[phase6-bench] yazıldı: ${outFile}`);
  }
}

void main();
