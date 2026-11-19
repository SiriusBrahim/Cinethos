// ===========================================================================
// Cinethos Taste Engine — Profil Kapsamı (Faz 5 / R2-A1)
//
// Bu modül R2-A1'in üç altyapı parçasını tek sorumluluklu bir yerde toplar:
//   1. Kanonik `profileId` doğrulama (mevcut `PROFILE_ID_PATTERN` sözleşmesi)
//      ve kayıpsız `p1-b64url` profil dizini kodlaması.
//   2. Profil id eşleme manifesti (`_profile-id-map.json`) okuma/doğrulama/
//      atomik yazma; `entries` ↔ `byDir` birebir tutarlılık denetimi.
//   3. Kapsam bazlı kilit altyapısı: atomik sahiplenme, lease + heartbeat,
//      yalnızca kanıtlanabilir stale devralma ve sahiplik doğrulamalı bırakma.
//
// A2–A5 kapsamı (profil partition IO yayılımı, adapter/rebuild/routes bağlamı,
// BackgroundManager, uçtan uca legacy geçişi) burada ele alınmaz.
// ===========================================================================

import { createHash, randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROFILE_ID_PATTERN } from "../core/cinetrack-core.ts";
import { writeJsonFileAtomicAsync } from "./atomic-json.ts";

// === Sabitler ===

/** Profil id eşleme manifestinin dosya adı (profil kökü altında). */
export const TASTE_PROFILE_ID_MAP_FILENAME = "_profile-id-map.json";
/** Profil dizini kodlama şeması kimliği. */
export const TASTE_PROFILE_ID_MAP_SCHEME = "p1-b64url";
/** Desteklenen manifest sürümü. Bilinmeyen sürüm fail-fast reddedilir. */
export const TASTE_PROFILE_ID_MAP_VERSION = 1;
/** Kanonik profil kimliği için üst sınır (trim sonrası). */
export const TASTE_PROFILE_ID_MAX_LENGTH = 128;

/** Legacy/global taste yazım kapsamı (`.taste.lock` geri uyumluluğu). */
export const TASTE_LOCK_DATA_SCOPE = "taste-data";
/** Global mapping-manifest kilidi kapsamı (PR #32 §2.1). */
export const TASTE_PROFILE_ID_MAP_SCOPE = "__profile-id-map__";
/** Shared metadata cache kilidi kapsamı (A2'de kullanılacak; sıra kuralı). */
export const TASTE_SHARED_METADATA_CACHE_SCOPE = "shared-metadata-cache";

export interface TasteLockTimings {
  /** Bekleyen prosesin kilit edinme toplam süresi. */
  acquireTimeoutMs: number;
  /** İlk yeniden deneme beklemesi. */
  backoffInitialMs: number;
  /** Backoff üst sınırı. */
  backoffMaxMs: number;
  /** Kilit lease süresi (expiresAt = heartbeat + lease). */
  leaseDurationMs: number;
  /** Sahip yenileme aralığı (lease/3). */
  heartbeatIntervalMs: number;
}

export const TASTE_LOCK_DEFAULTS: TasteLockTimings = {
  acquireTimeoutMs: 10_000,
  backoffInitialMs: 50,
  backoffMaxMs: 500,
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
};

const TASTE_FILE_NAMES = {
  taxonomy: "cinetrack-taste-taxonomy.json",
  index: "cinetrack-taste-index.json",
  events: "cinetrack-taste-events.json",
  profile: "cinetrack-taste-profile.json",
  manifest: "cinetrack-taste-manifest.json",
  objections: "cinetrack-taste-objections.json",
} as const;

// === Hatalar ===

export type TasteProfileScopeErrorCode =
  | "invalid_profile_id"
  | "invalid_profile_dir"
  | "profile_id_map_corrupt"
  | "profile_id_map_conflict"
  | "profile_path_escape";

export class TasteProfileScopeError extends Error {
  public readonly code: TasteProfileScopeErrorCode;

  constructor(code: TasteProfileScopeErrorCode, message: string) {
    super(message);
    this.name = "TasteProfileScopeError";
    this.code = code;
  }
}

export type TasteLockErrorCode =
  | "taste_lock_timeout"
  | "taste_lock_corrupt"
  | "taste_lock_lost"
  | "taste_lock_invalid_scope";

export class TasteLockError extends Error {
  public readonly code: TasteLockErrorCode;
  public readonly lockPath?: string;

  constructor(code: TasteLockErrorCode, message: string, lockPath?: string) {
    super(message);
    this.name = "TasteLockError";
    this.code = code;
    this.lockPath = lockPath;
  }
}

// === 1. Kanonik profil kimliği ve kodlama ===

/**
 * Kanonik `profileId` doğrulaması (fail-fast).
 *
 * Mevcut `PROFILE_ID_PATTERN` sözleşmesi korunur; ek olarak trim sonrası boşluk,
 * 128 karakter üstü uzunluk, yol ayıracı ve kontrol karakterleri reddedilir.
 * Geçersiz kimlik sessizce sanitize edilmez/yeniden adlandırılmaz.
 */
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function validateCanonicalProfileId(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new TasteProfileScopeError(
      "invalid_profile_id",
      "Profil kimliği metin olmalıdır."
    );
  }
  // Kontrol karakterleri (NUL, satır sonu, DEL vb.) trim öncesi reddedilir:
  // baştaki/sondaki boşluk temizlenir ama gizli kontrol karakteri taşıyan
  // kimlik sessizce normalize edilmez.
  if (containsControlCharacter(raw)) {
    throw new TasteProfileScopeError(
      "invalid_profile_id",
      "Profil kimliği kontrol karakteri içeremez."
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new TasteProfileScopeError(
      "invalid_profile_id",
      "Profil kimliği boş olamaz."
    );
  }
  if (trimmed.length > TASTE_PROFILE_ID_MAX_LENGTH) {
    throw new TasteProfileScopeError(
      "invalid_profile_id",
      `Profil kimliği en fazla ${TASTE_PROFILE_ID_MAX_LENGTH} karakter olabilir (girilen: ${trimmed.length}).`
    );
  }
  if (/[/\\]/.test(trimmed)) {
    throw new TasteProfileScopeError(
      "invalid_profile_id",
      "Profil kimliği yol ayıracı içeremez."
    );
  }
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
    throw new TasteProfileScopeError(
      "invalid_profile_id",
      "Profil kimliği '.' / '..' segmentleri içeremez."
    );
  }
  if (!PROFILE_ID_PATTERN.test(trimmed)) {
    throw new TasteProfileScopeError(
      "invalid_profile_id",
      `Profil kimliği mevcut PROFILE_ID_PATTERN sözleşmesine uymuyor: ${JSON.stringify(trimmed)}`
    );
  }
  return trimmed;
}

/**
 * Kanonik kimliği kayıpsız `p1-b64url` dizin adına çevirir.
 * Dizin adı yalnızca depolama temsilidir; iş mantığı kanonik kimliği kullanır.
 */
export function encodeProfileIdSafe(rawProfileId: unknown): string {
  const canonical = validateCanonicalProfileId(rawProfileId);
  const lowerCanonical = canonical.toLowerCase(); // Normalize to lowercase for case-insensitive FS safety
  const encoded = Buffer.from(lowerCanonical, "utf8").toString("base64url");
  return `${TASTE_PROFILE_ID_MAP_SCHEME}-${encoded}`;
}

/**
 * `p1-b64url-*` dizin adını kanonik kimliğe geri çözer.
 * Şema öneki, alfabe ve kayıpsız round-trip doğrulanır; aksi halde fail-fast.
 */
export function decodeProfileIdSafe(dir: unknown): string {
  if (typeof dir !== "string") {
    throw new TasteProfileScopeError(
      "invalid_profile_dir",
      "Profil dizin adı metin olmalıdır."
    );
  }
  const prefix = `${TASTE_PROFILE_ID_MAP_SCHEME}-`;
  if (!dir.startsWith(prefix)) {
    throw new TasteProfileScopeError(
      "invalid_profile_dir",
      `Profil dizin adı '${prefix}' şema önekiyle başlamalıdır.`
    );
  }
  const encoded = dir.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new TasteProfileScopeError(
      "invalid_profile_dir",
      "Profil dizin adı geçersiz Base64URL alfabesi içeriyor."
    );
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  let canonical: string;
  try {
    canonical = validateCanonicalProfileId(decoded);
  } catch (err) {
    throw new TasteProfileScopeError(
      "invalid_profile_dir",
      `Profil dizin adı kanonik kimliğe çözülemedi: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  const roundTrip = `${prefix}${Buffer.from(canonical, "utf8").toString("base64url")}`;
  if (roundTrip !== dir) {
    throw new TasteProfileScopeError(
      "invalid_profile_dir",
      "Profil dizin adı kayıpsız round-trip doğrulamasından geçemedi."
    );
  }
  return canonical;
}

// === 2. Yol çözümleme ===

/** Taste kök dizini (`resolveTastePaths` ile birebir uyumlu). */
export function resolveTasteRoot(dataDir: string = "data"): string {
  const base = dataDir && dataDir.length > 0 ? dataDir : "data";
  return base === "data" ? "data/taste" : path.join(base, "taste");
}

/** Profil partition kökü: `<taste-root>/profiles`. */
export function resolveTasteProfilesRoot(dataDir: string = "data"): string {
  return path.join(resolveTasteRoot(dataDir), "profiles");
}

/** Profil id eşleme manifesti yolu. */
export function resolveTasteProfileIdMapPath(dataDir: string = "data"): string {
  return path.join(resolveTasteProfilesRoot(dataDir), TASTE_PROFILE_ID_MAP_FILENAME);
}

/** Kapsam kilidi dizini (legacy `.taste.lock` bu dizinin dışında kalır). */
export function resolveTasteLockDir(dataDir: string = "data"): string {
  return path.join(resolveTasteRoot(dataDir), ".locks");
}

export interface TasteProfileStorePaths {
  taxonomy: string;
  index: string;
  events: string;
  profile: string;
  manifest: string;
  objections: string;
}

export interface TasteProfileScopePaths {
  profileId: string;
  dir: string;
  root: string;
  paths: TasteProfileStorePaths;
}

function assertInsideTasteRoot(rootDir: string, targetPath: string): void {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new TasteProfileScopeError(
      "profile_path_escape",
      `Profil yolu taste kökünün dışına çıkıyor: ${targetPath}`
    );
  }
}

/**
 * Profil kapsamlı taste yollarını çözer (uyumluluk yüzeyi; A2'de IO'ya bağlanır).
 * Dönen yollar taste kökü içinde kalır; escape fail-fast reddedilir.
 */
export function resolveTastePathsForProfile(
  profileId: unknown,
  dataDir: string = "data"
): TasteProfileScopePaths {
  const canonical = validateCanonicalProfileId(profileId);
  const dir = encodeProfileIdSafe(canonical);
  const profilesRoot = resolveTasteProfilesRoot(dataDir);
  const root = path.join(profilesRoot, dir);
  const paths: TasteProfileStorePaths = {
    taxonomy: path.join(root, TASTE_FILE_NAMES.taxonomy),
    index: path.join(root, TASTE_FILE_NAMES.index),
    events: path.join(root, TASTE_FILE_NAMES.events),
    profile: path.join(root, TASTE_FILE_NAMES.profile),
    manifest: path.join(root, TASTE_FILE_NAMES.manifest),
    objections: path.join(root, TASTE_FILE_NAMES.objections),
  };
  assertInsideTasteRoot(profilesRoot, root);
  for (const filePath of Object.values(paths)) {
    assertInsideTasteRoot(profilesRoot, filePath);
  }
  return { profileId: canonical, dir, root, paths };
}

// === 3. Profil id eşleme manifesti ===

export interface TasteProfileIdMapEntry {
  dir: string;
  createdAt: string;
}

export interface TasteProfileIdMap {
  version: number;
  scheme: string;
  entries: Record<string, TasteProfileIdMapEntry>;
  byDir: Record<string, string>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseIsoTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `Profil id eşleme manifestinde '${field}' ISO-8601 metin olmalıdır.`
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `Profil id eşleme manifestinde '${field}' geçerli ISO-8601 değil: ${JSON.stringify(value)}`
    );
  }
  return parsed;
}

/**
 * Manifesti şema + bütünlük açısından doğrular.
 * `entries` ↔ `byDir` birebir eşleşmezse, şema/sürüm uyumsuzsa veya dizin
 * kanonik kimliğe çözülmezse fail-fast hata üretir (otomatik onarım yok).
 */
export function parseTasteProfileIdMap(raw: unknown): TasteProfileIdMap {
  if (!isPlainRecord(raw)) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      "Profil id eşleme manifesti JSON nesnesi olmalıdır."
    );
  }
  if (raw.version !== TASTE_PROFILE_ID_MAP_VERSION) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `Desteklenmeyen profil id eşleme manifest sürümü: ${JSON.stringify(raw.version)} (beklenen ${TASTE_PROFILE_ID_MAP_VERSION}).`
    );
  }
  if (raw.scheme !== TASTE_PROFILE_ID_MAP_SCHEME) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `Desteklenmeyen profil dizini şeması: ${JSON.stringify(raw.scheme)} (beklenen ${TASTE_PROFILE_ID_MAP_SCHEME}).`
    );
  }
  const rawEntries = raw.entries;
  const rawByDir = raw.byDir;
  if (!isPlainRecord(rawEntries) || !isPlainRecord(rawByDir)) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      "Profil id eşleme manifestinde 'entries' ve 'byDir' nesne olmalıdır."
    );
  }

  const entries: Record<string, TasteProfileIdMapEntry> = {};
  for (const [profileId, entry] of Object.entries(rawEntries)) {
    const canonical = validateCanonicalProfileId(profileId);
    if (canonical !== profileId) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `Manifest anahtarı kanonik değil (${JSON.stringify(profileId)} → ${JSON.stringify(canonical)}).`
      );
    }
    if (!isPlainRecord(entry)) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'entries.${profileId}' nesne olmalıdır.`
      );
    }
    let dirProfileId: string;
    try {
      dirProfileId = decodeProfileIdSafe(entry.dir);
    } catch (err) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'entries.${profileId}.dir' çözümlenemedi: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (dirProfileId.toLowerCase() !== profileId.toLowerCase()) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'entries.${profileId}.dir' farklı bir kanonik kimliğe çözülüyor (${dirProfileId} vs ${profileId}).`
      );
    }
    parseIsoTimestamp(entry.createdAt, `entries.${profileId}.createdAt`);
    entries[profileId] = {
      dir: entry.dir as string,
      createdAt: entry.createdAt as string,
    };
  }

  const byDir: Record<string, string> = {};
  for (const [dir, profileId] of Object.entries(rawByDir)) {
    if (typeof profileId !== "string") {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir.${dir}' kanonik kimlik metni olmalıdır.`
      );
    }
    const canonical = validateCanonicalProfileId(profileId);
    if (canonical !== profileId) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir.${dir}' kanonik olmayan kimliğe işaret ediyor.`
      );
    }
    let dirProfileId: string;
    try {
      dirProfileId = decodeProfileIdSafe(dir);
    } catch (err) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir' anahtarı çözümlenemedi (${dir}): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
    if (dirProfileId.toLowerCase() !== profileId.toLowerCase()) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir.${dir}' ile dizin adının çözümü uyuşmuyor (${dirProfileId} vs ${profileId}).`
      );
    }
    const entry = entries[profileId];
    if (!entry) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir.${dir}' için 'entries' kaydı yok.`
      );
    }
    if (entry.dir !== dir) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'byDir.${dir}' ile 'entries.${profileId}.dir' (${entry.dir}) uyuşmuyor.`
      );
    }
    byDir[dir] = profileId;
  }

  const entryDirs = Object.values(entries).map((entry) => entry.dir);
  if (entryDirs.length !== Object.keys(byDir).length) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `'entries' (${entryDirs.length}) ve 'byDir' (${Object.keys(byDir).length}) kardinalitesi uyuşmuyor.`
    );
  }
  for (const dir of entryDirs) {
    if (!byDir[dir]) {
      throw new TasteProfileScopeError(
        "profile_id_map_corrupt",
        `'entries' içindeki '${dir}' için 'byDir' ters kaydı yok.`
      );
    }
  }

  return {
    version: TASTE_PROFILE_ID_MAP_VERSION,
    scheme: TASTE_PROFILE_ID_MAP_SCHEME,
    entries,
    byDir,
  };
}

function createEmptyTasteProfileIdMap(): TasteProfileIdMap {
  return {
    version: TASTE_PROFILE_ID_MAP_VERSION,
    scheme: TASTE_PROFILE_ID_MAP_SCHEME,
    entries: {},
    byDir: {},
  };
}

function sortTasteProfileIdMap(map: TasteProfileIdMap): TasteProfileIdMap {
  const entries: Record<string, TasteProfileIdMapEntry> = {};
  for (const profileId of Object.keys(map.entries).sort()) {
    entries[profileId] = map.entries[profileId]!;
  }
  const byDir: Record<string, string> = {};
  for (const dir of Object.keys(map.byDir).sort()) {
    byDir[dir] = map.byDir[dir]!;
  }
  return { ...map, entries, byDir };
}

export type TasteProfileIdMapReadResult =
  | { status: "missing"; data: null }
  | { status: "ok"; data: TasteProfileIdMap };

/**
 * Manifesti okur. Dosya yoksa `missing` döner; bozuk/uyumsuz içerik fail-fast
 * hata üretir. Hiçbir onarım/yeniden eşleme/yazma yapmaz.
 */
export async function readTasteProfileIdMap(
  dataDir: string = "data"
): Promise<TasteProfileIdMapReadResult> {
  const filePath = resolveTasteProfileIdMapPath(dataDir);
  let text: string;
  try {
    text = await fsPromises.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") {
      return { status: "missing", data: null };
    }
    throw err;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new TasteProfileScopeError(
      "profile_id_map_corrupt",
      `Profil id eşleme manifesti geçerli JSON değil: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return { status: "ok", data: parseTasteProfileIdMap(raw) };
}

export interface TasteProfileIdMapLookupResult {
  profileId: string;
  dir: string;
  createdAt: string;
}

/** Kanonik kimliğin manifest kaydını döner (salt okuma, yazma yok). */
export async function readTasteProfileIdMapEntry(
  profileId: unknown,
  dataDir: string = "data"
): Promise<TasteProfileIdMapLookupResult | null> {
  const canonical = validateCanonicalProfileId(profileId);
  const current = await readTasteProfileIdMap(dataDir);
  if (current.status === "missing") return null;
  const entry = current.data.entries[canonical];
  if (!entry) return null;
  return { profileId: canonical, dir: entry.dir, createdAt: entry.createdAt };
}

async function writeTasteProfileIdMapUnlocked(
  map: TasteProfileIdMap,
  dataDir: string
): Promise<void> {
  const filePath = resolveTasteProfileIdMapPath(dataDir);
  const payload = `${JSON.stringify(sortTasteProfileIdMap(map), null, 2)}\n`;
  await writeJsonFileAtomicAsync(filePath, payload, {
    validateParsed: (raw) => {
      try {
        parseTasteProfileIdMap(raw);
        return true;
      } catch {
        return false;
      }
    },
  });
}

/**
 * Manifesti doğrulayıp global manifest kilidi altında atomik yazar.
 * `entries`/`byDir` tutarsızsa yazım hiç başlamaz.
 */
export async function writeTasteProfileIdMap(
  map: TasteProfileIdMap,
  dataDir: string = "data"
): Promise<TasteProfileIdMap> {
  const validated = parseTasteProfileIdMap(map);
  return withScopedTasteLock(
    { dataDir, scope: TASTE_PROFILE_ID_MAP_SCOPE },
    async () => {
      await writeTasteProfileIdMapUnlocked(validated, dataDir);
      return validated;
    }
  );
}

export interface EnsureTasteProfileIdMapResult extends TasteProfileIdMapLookupResult {
  /** Bu çağrı yeni kayıt oluşturduysa true. */
  created: boolean;
}

/**
 * Kanonik kimlik için eşleme kaydını garanti eder.
 *
 * Global manifest kilidi altında `oku → doğrula → hesapla → atomik yaz`
 * sırası uygulanır; eşzamanlı ilk erişimde tek yazar/yarışsız oluşturma
 * sağlanır. Çakışma tespit edilirse hiçbir yazma yapılmaz (fail-fast).
 */
export async function ensureTasteProfileIdMapEntry(
  profileId: unknown,
  dataDir: string = "data"
): Promise<EnsureTasteProfileIdMapResult> {
  const canonical = validateCanonicalProfileId(profileId);
  const dir = encodeProfileIdSafe(canonical);
  return withScopedTasteLock(
    { dataDir, scope: TASTE_PROFILE_ID_MAP_SCOPE },
    async () => {
      const current = await readTasteProfileIdMap(dataDir);
      const map = current.status === "ok" ? current.data : createEmptyTasteProfileIdMap();

      const existing = map.entries[canonical];
      if (existing) {
        if (existing.dir !== dir) {
          throw new TasteProfileScopeError(
            "profile_id_map_conflict",
            `'${canonical}' için manifest dizini beklenen kodlamayla uyuşmuyor (${existing.dir} ≠ ${dir}).`
          );
        }
        return {
          profileId: canonical,
          dir: existing.dir,
          createdAt: existing.createdAt,
          created: false,
        };
      }

      const ownerOfDir = map.byDir[dir];
      if (ownerOfDir !== undefined && ownerOfDir !== canonical) {
        throw new TasteProfileScopeError(
          "profile_id_map_conflict",
          `'${dir}' dizini başka bir kanonik kimliğe kayıtlı (${ownerOfDir}).`
        );
      }

      const createdAt = new Date().toISOString();
      const next = sortTasteProfileIdMap({
        version: TASTE_PROFILE_ID_MAP_VERSION,
        scheme: TASTE_PROFILE_ID_MAP_SCHEME,
        entries: { ...map.entries, [canonical]: { dir, createdAt } },
        byDir: { ...map.byDir, [dir]: canonical },
      });
      await writeTasteProfileIdMapUnlocked(next, dataDir);
      return { profileId: canonical, dir, createdAt, created: true };
    }
  );
}

// === 4. Kapsam kilidi (lease + heartbeat) ===

export interface TasteLockRecord {
  lockId: string;
  scope: string;
  pid: number;
  hostname: string;
  createdAt: string;
  expiresAt: string;
  heartbeatAt: string;
  ownerToken: string;
  /** Eski (`pid:ts:uuid`) `.taste.lock` biçiminden okunduysa true — lease yok. */
  legacy?: boolean;
}

/** Eski sürümün `.taste.lock` token biçimi: `pid:timestamp:uuid`. */
const LEGACY_LOCK_TOKEN_PATTERN = /^(\d+):(\d+):([0-9a-fA-F-]{8,64})$/;

export interface TasteScopedLockRequest {
  dataDir?: string;
  scope: string;
  timings?: Partial<TasteLockTimings>;
}

export interface TasteLockHandle {
  readonly record: TasteLockRecord;
  readonly lockPath: string;
  /** Sahiplik heartbeat ile doğrulanamadıysa true (fail-safe sonlandırma). */
  readonly lost: boolean;
  renew(): Promise<void>;
  release(): Promise<void>;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as { code?: string })?.code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function backoffDelay(attempt: number, timings: TasteLockTimings): number {
  const base = Math.min(
    timings.backoffMaxMs,
    Math.round(timings.backoffInitialMs * 2 ** Math.min(attempt, 10))
  );
  const jitter = Math.round(base * 0.25 * Math.random());
  return Math.max(1, base + jitter);
}

function sanitizeScopeForFileName(scope: string): string {
  if (typeof scope !== "string" || scope.trim().length === 0) {
    throw new TasteLockError(
      "taste_lock_invalid_scope",
      "Taste kilidi için kapsam adı zorunludur."
    );
  }
  const readable = scope.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "scope";
  const digest = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 12);
  return `${readable}-${digest}`;
}

/**
 * Kilit dosyası yolu. Legacy global yazım kapsamı geri uyumluluk için
 * `<taste-root>/.taste.lock` kullanır; diğer kapsamlar ayrı `.locks/` altındadır.
 */
export function resolveTasteLockPath(
  dataDir: string = "data",
  scope: string = TASTE_LOCK_DATA_SCOPE
): string {
  if (scope === TASTE_LOCK_DATA_SCOPE) {
    return path.join(resolveTasteRoot(dataDir), ".taste.lock");
  }
  return path.join(resolveTasteLockDir(dataDir), `${sanitizeScopeForFileName(scope)}.lock`);
}

function parseTasteLockRecord(raw: unknown, lockPath: string): TasteLockRecord {
  if (!isPlainRecord(raw)) {
    throw new TasteLockError(
      "taste_lock_corrupt",
      `Kilit dosyası bozuk (JSON nesnesi bekleniyordu): ${lockPath}`,
      lockPath
    );
  }
  const record = raw as Partial<TasteLockRecord>;
  const stringFields: Array<keyof TasteLockRecord> = [
    "lockId",
    "scope",
    "hostname",
    "ownerToken",
    "createdAt",
    "expiresAt",
    "heartbeatAt",
  ];
  for (const field of stringFields) {
    const value = record[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new TasteLockError(
        "taste_lock_corrupt",
        `Kilit dosyasında '${field}' alanı eksik/geçersiz: ${lockPath}`,
        lockPath
      );
    }
  }
  if (!Number.isInteger(record.pid) || (record.pid as number) <= 0) {
    throw new TasteLockError(
      "taste_lock_corrupt",
      `Kilit dosyasında 'pid' alanı geçersiz: ${lockPath}`,
      lockPath
    );
  }
  for (const field of ["createdAt", "expiresAt", "heartbeatAt"] as const) {
    if (!Number.isFinite(Date.parse(record[field] as string))) {
      throw new TasteLockError(
        "taste_lock_corrupt",
        `Kilit dosyasında '${field}' geçerli ISO-8601 değil: ${lockPath}`,
        lockPath
      );
    }
  }
  return record as TasteLockRecord;
}

/**
 * Eski token biçimini kayda çevirir (yalnızca geri uyumluluk okuması).
 * Bu kayıtta lease/hostname yoktur; bu nedenle yaş bazlı stale kararı
 * **verilmez** — stale yalnızca PID ölüyse kabul edilir.
 */
function parseLegacyLockToken(text: string): TasteLockRecord | null {
  const match = LEGACY_LOCK_TOKEN_PATTERN.exec(text.trim());
  if (!match) return null;
  const pid = Number(match[1]);
  const createdAtMs = Number(match[2]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(createdAtMs)) {
    return null;
  }
  const createdAt = new Date(createdAtMs).toISOString();
  return {
    lockId: `legacy-${pid}-${createdAtMs}`,
    scope: TASTE_LOCK_DATA_SCOPE,
    pid,
    hostname: os.hostname(),
    createdAt,
    expiresAt: createdAt,
    heartbeatAt: createdAt,
    ownerToken: match[3]!,
    legacy: true,
  };
}

function parseTasteLockContent(text: string, lockPath: string): TasteLockRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    const legacy = parseLegacyLockToken(text);
    if (legacy) return legacy;
    throw new TasteLockError(
      "taste_lock_corrupt",
      `Kilit dosyası geçerli JSON/eski token biçiminde değil: ${lockPath}`,
      lockPath
    );
  }
  return parseTasteLockRecord(raw, lockPath);
}

/**
 * Kilit kaydını okur. Yoksa null; bozuksa fail-closed hata (stale sayılmaz,
 * otomatik silme/onarım yok).
 */
export async function readTasteLockState(
  dataDir: string = "data",
  scope: string = TASTE_LOCK_DATA_SCOPE
): Promise<TasteLockRecord | null> {
  const lockPath = resolveTasteLockPath(dataDir, scope);
  let text: string;
  try {
    text = await fsPromises.readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return null;
    throw err;
  }
  return parseTasteLockContent(text, lockPath);
}

function makeTasteLockRecord(
  scope: string,
  nowMs: number,
  timings: TasteLockTimings
): TasteLockRecord {
  const nowIso = new Date(nowMs).toISOString();
  return {
    lockId: randomUUID(),
    scope,
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: nowIso,
    expiresAt: new Date(nowMs + timings.leaseDurationMs).toISOString(),
    heartbeatAt: nowIso,
    ownerToken: randomUUID(),
  };
}

/** Kilit kaydının sahibi bu süreç mi? */
export function isTasteLockOwnedBy(record: TasteLockRecord | null, owner: {
  lockId: string;
  ownerToken: string;
  scope: string;
}): boolean {
  return (
    !!record &&
    record.lockId === owner.lockId &&
    record.ownerToken === owner.ownerToken &&
    record.scope === owner.scope
  );
}

/**
 * Stale kararı yalnızca kanıtlanabilir koşullarda verilir:
 * lease dolmuş olmalı **ve** sahiplik doğrulanamamalı (aynı host'ta PID ölü;
 * farklı host'ta PID sinyali yok → lease dolumu tek kanıt).
 * Lease dolmadıysa kilit canlıdır ve asla stale sayılmaz.
 */
export function isTasteLockProvablyStale(
  record: TasteLockRecord,
  nowMs: number = Date.now()
): boolean {
  if (record.legacy) {
    // Eski token biçiminde lease yok: yaş asla tek başına stale kanıtı değildir,
    // yalnızca PID'in ölü olduğu kanıtı devralmaya izin verir.
    if (record.pid === process.pid) return true;
    return !isProcessAlive(record.pid);
  }
  const expiresAtMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs) return false;
  if (record.hostname !== os.hostname()) return true;
  if (record.pid === process.pid) return true;
  return !isProcessAlive(record.pid);
}

async function tryCreateLockFile(
  lockPath: string,
  record: TasteLockRecord
): Promise<boolean> {
  const dir = path.dirname(lockPath);
  await fsPromises.mkdir(dir, { recursive: true });
  const tempPath = `${lockPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  const handle = await fsPromises.open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // link() atomik "varsa oluşturma" garantisi verir; içerik tam yazılmış olur.
    await fsPromises.link(tempPath, lockPath);
    return true;
  } catch (err) {
    if ((err as { code?: string })?.code === "EEXIST") return false;
    throw err;
  } finally {
    await fsPromises.unlink(tempPath).catch(() => undefined);
  }
}

async function restoreQuarantinedLock(
  quarantinePath: string,
  lockPath: string
): Promise<void> {
  try {
    await fsPromises.link(quarantinePath, lockPath);
  } catch {
    // Kilit yolu yeniden doldurulduysa taşınan kayıt zaten geçersizdir.
  }
  await fsPromises.unlink(quarantinePath).catch(() => undefined);
}

/**
 * Kanıtlanabilir stale kilidi atomik devralır.
 *
 * Kilit dosyası önce benzersiz bir karantina adına `rename` edilir (atomik,
 * tek kazanan). Taşınan kaydın `lockId`'si doğrulanır: beklediğimiz stale kayıt
 * değilse canlı bir kilit taşınmış olabilir → kayıt geri konur ve devralma
 * yapılmaz. Böylece "stale okuma → koşulsuz unlink" yarışı ortadan kalkar.
 */
async function reclaimProvablyStaleTasteLock(
  lockPath: string,
  expectedLockId: string
): Promise<boolean> {
  const quarantinePath = `${lockPath}.stale.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await fsPromises.rename(lockPath, quarantinePath);
  } catch (err) {
    // Başka bir bekleyen kilidi bizden önce devraldı/aldı: yeniden dene.
    if ((err as { code?: string })?.code === "ENOENT") return true;
    throw err;
  }

  let moved: TasteLockRecord | null;
  try {
    moved = await readTasteLockRecordAt(quarantinePath);
  } catch (err) {
    await restoreQuarantinedLock(quarantinePath, lockPath).catch(() => undefined);
    throw err;
  }

  if (!moved || moved.lockId !== expectedLockId) {
    await restoreQuarantinedLock(quarantinePath, lockPath).catch(() => undefined);
    return false;
  }

  await fsPromises.unlink(quarantinePath).catch(() => undefined);
  return true;
}

async function readTasteLockRecordAt(lockPath: string): Promise<TasteLockRecord | null> {
  let text: string;
  try {
    text = await fsPromises.readFile(lockPath, "utf8");
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return null;
    throw err;
  }
  return parseTasteLockContent(text, lockPath);
}

function resolveTimings(overrides?: Partial<TasteLockTimings>): TasteLockTimings {
  const merged: TasteLockTimings = { ...TASTE_LOCK_DEFAULTS, ...overrides };
  if (merged.heartbeatIntervalMs > merged.leaseDurationMs) {
    throw new Error("Taste kilidi heartbeat aralığı lease süresini aşamaz.");
  }
  return merged;
}

/**
 * Kapsam kilidini edinir.
 *
 * - Canlı kilit (lease dolmamış) asla çalınmaz; timeout ile teşhis edilebilir
 *   hata döner.
 * - Stale devralma yalnızca `isTasteLockProvablyStale` kanıtıyla ve atomik
 *   karantina + `lockId` doğrulamasıyla yapılır.
 * - Bozuk kilit fail-closed'dur.
 */
export async function acquireTasteLock(
  request: TasteScopedLockRequest
): Promise<TasteLockHandle> {
  const scope = request.scope;
  const dataDir = request.dataDir ?? "data";
  const timings = resolveTimings(request.timings);
  const lockPath = resolveTasteLockPath(dataDir, scope);
  const deadline = Date.now() + timings.acquireTimeoutMs;
  let attempt = 0;

  while (true) {
    const record = makeTasteLockRecord(scope, Date.now(), timings);
    if (await tryCreateLockFile(lockPath, record)) {
      return createTasteLockHandle(lockPath, record, timings);
    }

    // Bozuk kilit fail-closed: hata yukarı taşınır, stale sayılmaz.
    const existing = await readTasteLockRecordAt(lockPath);

    if (existing && isTasteLockProvablyStale(existing)) {
      const reclaimed = await reclaimProvablyStaleTasteLock(lockPath, existing.lockId);
      if (reclaimed) continue;
    }

    if (Date.now() >= deadline) {
      throw new TasteLockError(
        "taste_lock_timeout",
        `Taste kilidi zaman aşımına uğradı (kapsam: ${scope}, dosya: ${lockPath}).` +
          (existing
            ? ` Mevcut sahip pid=${existing.pid}, host=${existing.hostname}, expiresAt=${existing.expiresAt}.`
            : ""),
        lockPath
      );
    }
    await sleep(backoffDelay(attempt, timings));
    attempt += 1;
  }
}

function createTasteLockHandle(
  lockPath: string,
  record: TasteLockRecord,
  timings: TasteLockTimings
): TasteLockHandle {
  let current: TasteLockRecord = record;
  let lost = false;
  let released = false;
  let heartbeat: NodeJS.Timeout | null = null;
  let renewalChain: Promise<void> = Promise.resolve();

  const renewOnce = async (): Promise<void> => {
    if (released) return;
    const onDisk = await readTasteLockRecordAt(lockPath);
    if (
      !onDisk ||
      onDisk.lockId !== current.lockId ||
      onDisk.ownerToken !== current.ownerToken ||
      onDisk.scope !== current.scope
    ) {
      lost = true;
      throw new TasteLockError(
        "taste_lock_lost",
        `Taste kilidi sahipliği kaybedildi (kapsam: ${current.scope}, dosya: ${lockPath}).`,
        lockPath
      );
    }
    const nowMs = Date.now();
    const next: TasteLockRecord = {
      ...current,
      heartbeatAt: new Date(nowMs).toISOString(),
      expiresAt: new Date(nowMs + timings.leaseDurationMs).toISOString(),
    };
    await writeJsonFileAtomicAsync(lockPath, `${JSON.stringify(next, null, 2)}\n`, {
      validateParsed: (raw) => {
        try {
          parseTasteLockRecord(raw, lockPath);
          return true;
        } catch {
          return false;
        }
      },
    });
    current = next;
  };

  const renew = (): Promise<void> => {
    const next = renewalChain.catch(() => undefined).then(() => renewOnce());
    renewalChain = next.catch(() => undefined);
    return next;
  };

  heartbeat = setInterval(() => {
    void renew().catch(() => undefined);
  }, timings.heartbeatIntervalMs);
  heartbeat.unref?.();

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    const releasePath = `${lockPath}.release.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    try {
      await fsPromises.rename(lockPath, releasePath);
    } catch (err) {
      // Kilit zaten yok: bırakma tamam.
      if ((err as { code?: string })?.code === "ENOENT") return;
      return;
    }

    let moved: TasteLockRecord | null = null;
    try {
      moved = await readTasteLockRecordAt(releasePath);
    } catch {
      await restoreQuarantinedLock(releasePath, lockPath).catch(() => undefined);
      return;
    }

    if (
      moved &&
      moved.lockId === current.lockId &&
      moved.ownerToken === current.ownerToken &&
      moved.scope === current.scope
    ) {
      await fsPromises.unlink(releasePath).catch(() => undefined);
      return;
    }
    // Sahibimiz olmayan (canlı) bir kayıt taşındı: geri bırak, devretme.
    await restoreQuarantinedLock(releasePath, lockPath).catch(() => undefined);
  };

  return {
    get record() {
      return current;
    },
    lockPath,
    get lost() {
      return lost;
    },
    renew,
    release,
  };
}

// === 5. Süreç içi FIFO + kapsam kilidi sarmalayıcısı ===

const scopedLockChains = new Map<string, Promise<unknown>>();

function enqueueScopedLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = scopedLockChains.get(key) ?? Promise.resolve();
  const run = (): Promise<T> => task();
  const next = previous.then(run, run);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  scopedLockChains.set(key, settled);
  void settled.finally(() => {
    if (scopedLockChains.get(key) === settled) {
      scopedLockChains.delete(key);
    }
  });
  return next;
}

/**
 * Kapsam kilidi altında görev çalıştırır (süreç içi FIFO + süreçler arası
 * lease/heartbeat'li kilit). Heartbeat sahipliği kaybederse görev sonucu
 * başarı sayılmaz: `taste_lock_lost` fırlatılır (fail-safe).
 */
export async function withScopedTasteLock<T>(
  request: TasteScopedLockRequest,
  task: () => Promise<T>
): Promise<T> {
  const key = `${path.resolve(request.dataDir ?? "data")}::${request.scope}`;
  return enqueueScopedLock(key, async () => {
    const handle = await acquireTasteLock(request);
    let taskError: unknown;
    let result: T | undefined;
    let succeeded = false;
    try {
      result = await task();
      succeeded = true;
    } catch (err) {
      taskError = err;
    } finally {
      await handle.release().catch(() => undefined);
    }
    if (handle.lost) {
      throw new TasteLockError(
        "taste_lock_lost",
        `Taste kilidi kritik bölüm sırasında kaybedildi (kapsam: ${request.scope}); sonuç güvenilir değil.`,
        handle.lockPath
      );
    }
    if (!succeeded) throw taskError;
    return result as T;
  });
}
