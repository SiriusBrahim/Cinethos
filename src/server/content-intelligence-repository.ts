/**
 * MIA Faz 2 — Content Intelligence Repository (SQLite Kalıcı Katman)
 *
 * KURALLAR:
 * - Mevcut `node:sqlite` (`DatabaseSync`) altyapısı üzerinden `cinetrack.db` içinde
 *   yalnızca ortak, profilden bağımsız `content_intelligence`,
 *   `content_processing_queue` ve `content_processed_events` tablolarını yönetir.
 * - `media_key` PRIMARY KEY / UNIQUE'tir; farklı kullanıcılar aynı içeriği
 *   eklese bile tek ortak kayıt tutulur.
 * - Poster/backdrop görselleri ve profileId/personal_rating/status gibi kişisel
 *   veriler BU DEPOYA ASLA YAZILMAZ (ikinci savunma katmanı).
 * - Kullanıcı bir içeriği listesinden çıkarsa (`LibraryItemRemoved`) buradaki
 *   ortak içerik zekâsı kaydı SİLİNMEZ.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { MediaKind } from '../contracts/index.ts';
import { sanitizeRawContentInput } from '../modules/content/content-metadata-processor.ts';
import { createContentSemanticAnalyzer } from '../modules/content/content-semantic-analyzer.ts';
import {
  CANONICAL_MOOD_IDS,
  CONTENT_INTELLIGENCE_VERSION,
  type AnonymizedAggregateStats,
  type CanonicalMoodId,
  type ContentFeatureBundle,
  type ContentIntelligenceRecord,
  type ContentMoodVector,
  type ContentPipelineResult,
  type ContentProcessingStatus,
  type ContentRelationshipLink,
  type ContentSemanticProfile,
  type NormalizedContentMetadata,
} from '../modules/content/types.ts';

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

export interface ContentQueueJobRow {
  readonly media_key: string;
  readonly media_type: MediaKind;
  readonly tmdb_id: number;
  readonly source_revision: string | null;
  readonly payload_json: string | null;
  readonly trigger_event_id: string | null;
  readonly status: 'pending' | 'processing' | 'completed' | 'failed';
  readonly attempts: number;
  readonly max_attempts: number;
  readonly next_retry_at: string | null;
  readonly last_error: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ContentRepositoryStatus {
  readonly available: boolean;
  readonly filePath: string;
  readonly lastError: string | null;
  readonly recordsCount: number;
  readonly queuePending: number;
  readonly queueProcessing: number;
  readonly queueFailed: number;
}

function loadDatabaseSync(): (new (file: string) => DatabaseLike) | null {
  try {
    const mod = nodeRequire('node:sqlite') as { DatabaseSync?: new (file: string) => DatabaseLike };
    return mod.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

export class ContentIntelligenceRepository {
  private readonly dataDir: string;
  private readonly filePath: string;
  private db: DatabaseLike | null = null;
  private lastError: string | null = null;
  private readonly semanticAnalyzer = createContentSemanticAnalyzer();

  constructor(options: { dataDir?: string; dbPath?: string } = {}) {
    this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
    this.filePath = options.dbPath
      ? path.resolve(options.dbPath)
      : path.join(this.dataDir, 'cinetrack.db');
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

      instance.exec(`
        CREATE TABLE IF NOT EXISTS content_intelligence (
          media_key TEXT PRIMARY KEY,
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
          tmdb_id INTEGER NOT NULL,
          imdb_id TEXT,
          source_revision TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          normalized_metadata_json TEXT NOT NULL,
          feature_vector_json TEXT NOT NULL,
          mood_vector_json TEXT NOT NULL,
          semantic_data_json TEXT NOT NULL,
          data_hash TEXT NOT NULL,
          processed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          processing_version TEXT NOT NULL,
          processing_status TEXT NOT NULL CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed', 'skipped')),
          processing_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ci_media_type ON content_intelligence(media_type);
        CREATE INDEX IF NOT EXISTS idx_ci_status ON content_intelligence(processing_status);
        CREATE INDEX IF NOT EXISTS idx_ci_data_hash ON content_intelligence(data_hash);
        CREATE INDEX IF NOT EXISTS idx_ci_updated_at ON content_intelligence(updated_at);

        CREATE TABLE IF NOT EXISTS content_processing_queue (
          media_key TEXT PRIMARY KEY,
          media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
          tmdb_id INTEGER NOT NULL,
          source_revision TEXT,
          payload_json TEXT,
          trigger_event_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          next_retry_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cpq_status_retry ON content_processing_queue(status, next_retry_at);

        CREATE TABLE IF NOT EXISTS content_processed_events (
          event_id TEXT PRIMARY KEY,
          event_type TEXT NOT NULL,
          media_key TEXT,
          processed_at TEXT NOT NULL
        );
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
      throw new Error(this.lastError || 'Content Intelligence SQLite bağlantısı hazır değil.');
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

  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
    } catch {
      /* kapanış sırasında oluşan ikincil hata yoksayılır */
    }
    this.db = null;
  }

  getByMediaKey(mediaKey: string): ContentIntelligenceRecord | null {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT * FROM content_intelligence WHERE media_key = ?')
      .get(mediaKey) as ContentIntelligenceRecord | undefined;
    return row ?? null;
  }

  upsertCompletedResult(result: ContentPipelineResult): ContentIntelligenceRecord {
    if (!result.ok || !result.mediaKey || !result.mediaType || !result.tmdbId) {
      throw new Error('Tamamlanmamış boru hattı sonucu upsertCompletedResult ile yazılamaz.');
    }
    const db = this.requireDb();
    const nowIso = new Date().toISOString();
    const processedAt = result.processedAt || nowIso;

    // İkinci savunma katmanı: görselleri ve kişisel alanları kesin olarak arındır
    const sanitizedRaw = sanitizeRawContentInput(result.validation.sanitizedRawMetadata).sanitized;
    const sanitizedNormalized = result.validation.normalized
      ? sanitizeRawContentInput(result.validation.normalized).sanitized
      : {};

    const metadataJson = JSON.stringify(sanitizedRaw);
    const normalizedMetadataJson = JSON.stringify(sanitizedNormalized);
    const featureVectorJson = JSON.stringify(result.featureBundle ?? {});
    const moodVectorJson = JSON.stringify(result.moodVector ?? {});
    const semanticDataJson = JSON.stringify(result.semanticProfile ?? {});

    db.prepare(
      `INSERT INTO content_intelligence (
         media_key, media_type, tmdb_id, imdb_id, source_revision,
         metadata_json, normalized_metadata_json, feature_vector_json,
         mood_vector_json, semantic_data_json, data_hash,
         processed_at, created_at, updated_at,
         processing_version, processing_status, processing_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_key) DO UPDATE SET
         media_type = excluded.media_type,
         tmdb_id = excluded.tmdb_id,
         imdb_id = COALESCE(excluded.imdb_id, content_intelligence.imdb_id),
         source_revision = excluded.source_revision,
         metadata_json = excluded.metadata_json,
         normalized_metadata_json = excluded.normalized_metadata_json,
         feature_vector_json = excluded.feature_vector_json,
         mood_vector_json = excluded.mood_vector_json,
         semantic_data_json = excluded.semantic_data_json,
         data_hash = excluded.data_hash,
         processed_at = excluded.processed_at,
         updated_at = excluded.updated_at,
         processing_version = excluded.processing_version,
         processing_status = excluded.processing_status,
         processing_error = NULL`
    ).run(
      result.mediaKey,
      result.mediaType,
      result.tmdbId,
      result.imdbId,
      result.sourceRevision,
      metadataJson,
      normalizedMetadataJson,
      featureVectorJson,
      moodVectorJson,
      semanticDataJson,
      result.dataHash,
      processedAt,
      nowIso,
      nowIso,
      result.processingVersion,
      'completed',
      null
    );

    const saved = this.getByMediaKey(result.mediaKey);
    if (!saved) {
      throw new Error(`Kayıt yazıldıktan sonra okunamadı: ${result.mediaKey}`);
    }
    return saved;
  }

  upsertFailedResult(params: {
    mediaKey: string;
    mediaType: MediaKind;
    tmdbId: number;
    imdbId?: string | null;
    sourceRevision?: string;
    sanitizedMetadata?: Record<string, unknown>;
    dataHash?: string;
    processingVersion?: string;
    error: string;
  }): ContentIntelligenceRecord {
    const db = this.requireDb();
    const nowIso = new Date().toISOString();
    const sanitizedRaw = sanitizeRawContentInput(params.sanitizedMetadata ?? {}).sanitized;
    const version = params.processingVersion || CONTENT_INTELLIGENCE_VERSION;

    db.prepare(
      `INSERT INTO content_intelligence (
         media_key, media_type, tmdb_id, imdb_id, source_revision,
         metadata_json, normalized_metadata_json, feature_vector_json,
         mood_vector_json, semantic_data_json, data_hash,
         processed_at, created_at, updated_at,
         processing_version, processing_status, processing_error
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(media_key) DO UPDATE SET
         processing_status = 'failed',
         processing_error = excluded.processing_error,
         processing_version = excluded.processing_version,
         updated_at = excluded.updated_at`
    ).run(
      params.mediaKey,
      params.mediaType,
      params.tmdbId,
      params.imdbId ?? null,
      params.sourceRevision || 'unknown',
      JSON.stringify(sanitizedRaw),
      '{}',
      '{}',
      '{}',
      '{}',
      params.dataHash || '',
      null,
      nowIso,
      nowIso,
      version,
      'failed',
      params.error
    );

    const saved = this.getByMediaKey(params.mediaKey);
    if (!saved) {
      throw new Error(`Hata kaydı yazılamadı: ${params.mediaKey}`);
    }
    return saved;
  }

  upsertPendingStub(params: {
    mediaKey: string;
    mediaType: MediaKind;
    tmdbId: number;
    sourceRevision?: string;
    sanitizedMetadata?: Record<string, unknown>;
    processingVersion?: string;
  }): void {
    const db = this.requireDb();
    const nowIso = new Date().toISOString();
    const sanitizedRaw = sanitizeRawContentInput(params.sanitizedMetadata ?? {}).sanitized;
    db.prepare(
      `INSERT INTO content_intelligence (
         media_key, media_type, tmdb_id, imdb_id, source_revision,
         metadata_json, normalized_metadata_json, feature_vector_json,
         mood_vector_json, semantic_data_json, data_hash,
         processed_at, created_at, updated_at,
         processing_version, processing_status, processing_error
       ) VALUES (?, ?, ?, NULL, ?, ?, '{}', '{}', '{}', '{}', '', NULL, ?, ?, ?, 'pending', NULL)
       ON CONFLICT(media_key) DO UPDATE SET
         metadata_json = CASE
           WHEN content_intelligence.processing_status = 'pending'
                AND excluded.metadata_json != '{}'
           THEN excluded.metadata_json
           ELSE content_intelligence.metadata_json
         END,
         updated_at = excluded.updated_at`
    ).run(
      params.mediaKey,
      params.mediaType,
      params.tmdbId,
      params.sourceRevision || 'pending',
      JSON.stringify(sanitizedRaw),
      nowIso,
      nowIso,
      params.processingVersion || CONTENT_INTELLIGENCE_VERSION
    );
  }

  listRecords(
    options: {
      limit?: number;
      offset?: number;
      mediaType?: MediaKind;
      status?: ContentProcessingStatus;
    } = {}
  ): {
    items: ContentIntelligenceRecord[];
    total: number;
    limit: number;
    offset: number;
  } {
    const db = this.requireDb();
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));

    const whereParts: string[] = [];
    const params: unknown[] = [];
    if (options.mediaType) {
      whereParts.push('media_type = ?');
      params.push(options.mediaType);
    }
    if (options.status) {
      whereParts.push('processing_status = ?');
      params.push(options.status);
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    const countRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM content_intelligence ${whereSql}`)
      .get(...params) as { cnt?: number } | undefined;
    const total = Number(countRow?.cnt ?? 0);

    const rows = db
      .prepare(
        `SELECT * FROM content_intelligence ${whereSql} ORDER BY updated_at DESC, media_key ASC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as ContentIntelligenceRecord[];

    return { items: rows, total, limit, offset };
  }

  countRecords(): {
    total: number;
    completed: number;
    failed: number;
    pending: number;
    processing: number;
    skipped: number;
    movie: number;
    tv: number;
  } {
    const db = this.requireDb();
    const rows = db
      .prepare(
        `SELECT media_type, processing_status, COUNT(*) AS cnt
         FROM content_intelligence
         GROUP BY media_type, processing_status`
      )
      .all() as Array<{ media_type: string; processing_status: string; cnt: number }>;

    const counts = {
      total: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      processing: 0,
      skipped: 0,
      movie: 0,
      tv: 0,
    };

    for (const r of rows) {
      const c = Number(r.cnt ?? 0);
      counts.total += c;
      if (r.media_type === 'movie') counts.movie += c;
      if (r.media_type === 'tv') counts.tv += c;
      if (r.processing_status === 'completed') counts.completed += c;
      else if (r.processing_status === 'failed') counts.failed += c;
      else if (r.processing_status === 'pending') counts.pending += c;
      else if (r.processing_status === 'processing') counts.processing += c;
      else if (r.processing_status === 'skipped') counts.skipped += c;
    }

    return counts;
  }

  findRelated(mediaKey: string, limit = 10): ContentRelationshipLink[] {
    const sourceRow = this.getByMediaKey(mediaKey);
    if (!sourceRow || sourceRow.processing_status !== 'completed') {
      return [];
    }
    const db = this.requireDb();
    const candidateRows = db
      .prepare(
        `SELECT * FROM content_intelligence
         WHERE media_key != ? AND processing_status = 'completed'
         ORDER BY updated_at DESC
         LIMIT 250`
      )
      .all(mediaKey) as ContentIntelligenceRecord[];

    if (candidateRows.length === 0) return [];

    let sourceNorm: NormalizedContentMetadata;
    let sourceFeat: ContentFeatureBundle;
    let sourceMood: ContentMoodVector;
    let sourceSem: ContentSemanticProfile;

    try {
      sourceNorm = JSON.parse(sourceRow.normalized_metadata_json) as NormalizedContentMetadata;
      sourceFeat = JSON.parse(sourceRow.feature_vector_json) as ContentFeatureBundle;
      sourceMood = JSON.parse(sourceRow.mood_vector_json) as ContentMoodVector;
      sourceSem = JSON.parse(sourceRow.semantic_data_json) as ContentSemanticProfile;
    } catch {
      return [];
    }

    const links: ContentRelationshipLink[] = [];
    for (const cand of candidateRows) {
      try {
        const tgtNorm = JSON.parse(cand.normalized_metadata_json) as NormalizedContentMetadata;
        const tgtFeat = JSON.parse(cand.feature_vector_json) as ContentFeatureBundle;
        const tgtMood = JSON.parse(cand.mood_vector_json) as ContentMoodVector;
        const tgtSem = JSON.parse(cand.semantic_data_json) as ContentSemanticProfile;

        links.push(
          this.semanticAnalyzer.compareAnalyzed(
            sourceNorm,
            sourceFeat,
            sourceMood,
            sourceSem,
            tgtNorm,
            tgtFeat,
            tgtMood,
            tgtSem
          )
        );
      } catch {
        /* bozuk komşu kaydı karşılaştırmadan elenir */
      }
    }

    links.sort((a, b) => {
      const scoreA = Math.max(a.cosineSimilarity, a.atmosphereSimilarity, a.conceptSimilarity);
      const scoreB = Math.max(b.cosineSimilarity, b.atmosphereSimilarity, b.conceptSimilarity);
      return scoreB - scoreA;
    });

    return links.slice(0, Math.max(1, Math.min(50, limit)));
  }

  /**
   * İleride farklı kullanıcılardan gelen anonimleştirilmiş toplu istatistik
   * havuzunu beslemek için profilden arındırılmış genişletme noktası.
   */
  getAnonymizedAggregateStats(): AnonymizedAggregateStats {
    const db = this.requireDb();
    const counts = this.countRecords();
    const completedRows = db
      .prepare(
        `SELECT normalized_metadata_json, feature_vector_json, mood_vector_json, semantic_data_json
         FROM content_intelligence
         WHERE processing_status = 'completed'`
      )
      .all() as Array<{
      normalized_metadata_json: string;
      feature_vector_json: string;
      mood_vector_json: string;
      semantic_data_json: string;
    }>;

    const genreCounts = new Map<string, number>();
    const conceptCounts = new Map<string, { label: string; count: number }>();
    const moodSums: Record<CanonicalMoodId, number> = {
      dark: 0,
      thoughtful: 0,
      'feel-good': 0,
      'mind-bending': 0,
      cheerful: 0,
      deep: 0,
      thrilling: 0,
      romantic: 0,
    };
    let completenessSum = 0;
    let validCompleted = 0;

    for (const row of completedRows) {
      try {
        const norm = JSON.parse(row.normalized_metadata_json) as Partial<NormalizedContentMetadata>;
        const feat = JSON.parse(row.feature_vector_json) as Partial<ContentFeatureBundle>;
        const mood = JSON.parse(row.mood_vector_json) as Partial<ContentMoodVector>;
        const sem = JSON.parse(row.semantic_data_json) as Partial<ContentSemanticProfile>;

        for (const g of norm.genres || []) {
          genreCounts.set(g, (genreCounts.get(g) ?? 0) + 1);
        }
        for (const c of sem.concepts || []) {
          const prev = conceptCounts.get(c.id);
          conceptCounts.set(c.id, {
            label: c.label,
            count: (prev?.count ?? 0) + 1,
          });
        }
        if (typeof feat.completeness === 'number' && Number.isFinite(feat.completeness)) {
          completenessSum += feat.completeness;
        }
        if (mood.moods) {
          for (const mId of CANONICAL_MOOD_IDS) {
            const val = Number(mood.moods[mId]);
            if (Number.isFinite(val)) moodSums[mId] += val;
          }
        }
        validCompleted += 1;
      } catch {
        /* okunamayan JSON agregasyona dahil edilmez */
      }
    }

    const moodAverages: Record<CanonicalMoodId, number> = {
      dark: 0,
      thoughtful: 0,
      'feel-good': 0,
      'mind-bending': 0,
      cheerful: 0,
      deep: 0,
      thrilling: 0,
      romantic: 0,
    };
    if (validCompleted > 0) {
      for (const mId of CANONICAL_MOOD_IDS) {
        moodAverages[mId] = Math.round((moodSums[mId] / validCompleted) * 1000) / 1000;
      }
    }

    const topGenres = [...genreCounts.entries()]
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre))
      .slice(0, 15);

    const topConcepts = [...conceptCounts.entries()]
      .map(([id, info]) => ({ id, label: info.label, count: info.count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
      .slice(0, 15);

    return {
      generatedAt: new Date().toISOString(),
      processingVersion: CONTENT_INTELLIGENCE_VERSION,
      totalRecords: counts.total,
      completedRecords: counts.completed,
      failedRecords: counts.failed,
      pendingOrProcessingRecords: counts.pending + counts.processing,
      byMediaType: {
        movie: counts.movie,
        tv: counts.tv,
      },
      averageCompleteness:
        validCompleted > 0 ? Math.round((completenessSum / validCompleted) * 100) / 100 : 0,
      topGenres,
      topConcepts,
      moodAverages,
    };
  }

  // =========================================================================
  // Kalıcı İş Kuyruğu (`content_processing_queue`)
  // =========================================================================

  enqueueJob(job: {
    mediaKey: string;
    mediaType: MediaKind;
    tmdbId: number;
    sourceRevision?: string | null;
    payload?: Record<string, unknown> | null;
    triggerEventId?: string | null;
    maxAttempts?: number;
  }): { enqueued: boolean; status: string } {
    const db = this.requireDb();
    const nowIso = new Date().toISOString();
    const sanitizedPayload = job.payload
      ? JSON.stringify(sanitizeRawContentInput(job.payload).sanitized)
      : null;
    const maxAttempts = Math.max(1, Math.min(10, Math.floor(job.maxAttempts ?? 3)));

    const existing = db
      .prepare('SELECT status, payload_json FROM content_processing_queue WHERE media_key = ?')
      .get(job.mediaKey) as { status?: string; payload_json?: string | null } | undefined;

    if (existing?.status === 'processing') {
      // Uçuştaki iş varken yeni yük varsa sakla ama ikinci processing kaydı açma
      if (sanitizedPayload) {
        db.prepare(
          `UPDATE content_processing_queue
           SET payload_json = ?, source_revision = COALESCE(?, source_revision), updated_at = ?
           WHERE media_key = ?`
        ).run(sanitizedPayload, job.sourceRevision ?? null, nowIso, job.mediaKey);
      }
      return { enqueued: false, status: 'processing' };
    }

    if (existing?.status === 'pending' && sanitizedPayload === existing.payload_json) {
      return { enqueued: false, status: 'pending' };
    }

    db.prepare(
      `INSERT INTO content_processing_queue (
         media_key, media_type, tmdb_id, source_revision, payload_json,
         trigger_event_id, status, attempts, max_attempts, next_retry_at,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)
       ON CONFLICT(media_key) DO UPDATE SET
         media_type = excluded.media_type,
         tmdb_id = excluded.tmdb_id,
         source_revision = COALESCE(excluded.source_revision, content_processing_queue.source_revision),
         payload_json = COALESCE(excluded.payload_json, content_processing_queue.payload_json),
         trigger_event_id = COALESCE(excluded.trigger_event_id, content_processing_queue.trigger_event_id),
         status = 'pending',
         attempts = 0,
         max_attempts = excluded.max_attempts,
         next_retry_at = NULL,
         last_error = NULL,
         updated_at = excluded.updated_at`
    ).run(
      job.mediaKey,
      job.mediaType,
      job.tmdbId,
      job.sourceRevision ?? null,
      sanitizedPayload,
      job.triggerEventId ?? null,
      maxAttempts,
      nowIso,
      nowIso
    );

    return { enqueued: true, status: 'pending' };
  }

  claimNextJobs(limit = 5, nowIso = new Date().toISOString()): ContentQueueJobRow[] {
    const db = this.requireDb();
    const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const candidates = db
      .prepare(
        `SELECT * FROM content_processing_queue
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY created_at ASC, media_key ASC
         LIMIT ?`
      )
      .all(nowIso, safeLimit) as ContentQueueJobRow[];

    const claimed: ContentQueueJobRow[] = [];
    const updateStmt = db.prepare(
      `UPDATE content_processing_queue
       SET status = 'processing', attempts = attempts + 1, updated_at = ?
       WHERE media_key = ? AND status = 'pending'`
    );

    for (const row of candidates) {
      const res = updateStmt.run(nowIso, row.media_key);
      if ((res.changes ?? 0) > 0) {
        claimed.push({
          ...row,
          status: 'processing',
          attempts: row.attempts + 1,
          updated_at: nowIso,
        });
      }
    }

    return claimed;
  }

  hasReadyJobs(nowIso = new Date().toISOString()): boolean {
    const db = this.requireDb();
    const row = db
      .prepare(
        `SELECT 1 AS ok FROM content_processing_queue
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
         LIMIT 1`
      )
      .get(nowIso) as { ok?: number } | undefined;
    return Boolean(row?.ok);
  }

  recoverInterruptedJobs(): number {
    const db = this.requireDb();
    const nowIso = new Date().toISOString();
    const res = db
      .prepare(
        `UPDATE content_processing_queue
         SET status = 'pending', next_retry_at = NULL, updated_at = ?
         WHERE status = 'processing'`
      )
      .run(nowIso);
    return Number(res.changes ?? 0);
  }

  markJobCompleted(mediaKey: string): void {
    const db = this.requireDb();
    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE content_processing_queue
       SET status = 'completed', next_retry_at = NULL, last_error = NULL, updated_at = ?
       WHERE media_key = ?`
    ).run(nowIso, mediaKey);
  }

  scheduleJobRetry(mediaKey: string, nextRetryAt: string, error: string): void {
    const db = this.requireDb();
    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE content_processing_queue
       SET status = 'pending', next_retry_at = ?, last_error = ?, updated_at = ?
       WHERE media_key = ?`
    ).run(nextRetryAt, error, nowIso, mediaKey);
  }

  markJobFailed(mediaKey: string, error: string): void {
    const db = this.requireDb();
    const nowIso = new Date().toISOString();
    db.prepare(
      `UPDATE content_processing_queue
       SET status = 'failed', next_retry_at = NULL, last_error = ?, updated_at = ?
       WHERE media_key = ?`
    ).run(error, nowIso, mediaKey);
  }

  getQueueStats(): {
    pending: number;
    processing: number;
    completed: number;
    failed: number;
  } {
    const db = this.requireDb();
    const rows = db
      .prepare('SELECT status, COUNT(*) AS cnt FROM content_processing_queue GROUP BY status')
      .all() as Array<{ status: string; cnt: number }>;

    const stats = { pending: 0, processing: 0, completed: 0, failed: 0 };
    for (const r of rows) {
      const c = Number(r.cnt ?? 0);
      if (r.status === 'pending') stats.pending = c;
      else if (r.status === 'processing') stats.processing = c;
      else if (r.status === 'completed') stats.completed = c;
      else if (r.status === 'failed') stats.failed = c;
    }
    return stats;
  }

  // =========================================================================
  // Olay Idempotency Kaydı (`content_processed_events`)
  // =========================================================================

  hasProcessedEvent(eventId: string): boolean {
    const db = this.requireDb();
    const row = db
      .prepare('SELECT event_id FROM content_processed_events WHERE event_id = ?')
      .get(eventId) as { event_id?: string } | undefined;
    return Boolean(row?.event_id);
  }

  markEventProcessed(
    eventId: string,
    eventType: string,
    mediaKey?: string | null
  ): boolean {
    const db = this.requireDb();
    const nowIso = new Date().toISOString();
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO content_processed_events (event_id, event_type, media_key, processed_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(eventId, eventType, mediaKey ?? null, nowIso);
    return (res.changes ?? 0) > 0;
  }

  /**
   * MIA Faz 2 — Adım 2.3 (Dilim E): Transactional outbox kabulü.
   *
   * Olay kabul kaydı (`content_processed_events`) ve kuyruk kaydı
   * (`content_intelligence` stub + `content_processing_queue`) TEK SQLite
   * transaction içinde oluşturulur. Enqueue yarıda başarısız olursa
   * transaction geri alınır ve event kalıcı olarak "processed" işaretlenmez;
   * böylece olay tekrar denenebilir durumda kalır.
   */
  acceptEventTransactionally(input: {
    eventId: string;
    eventType: string;
    mediaKey: string | null;
    job: {
      mediaKey: string;
      mediaType: MediaKind;
      tmdbId: number;
      sourceRevision?: string | null;
      payload?: Record<string, unknown> | null;
      triggerEventId?: string | null;
      maxAttempts?: number;
    };
  }): { accepted: boolean; deduplicated: boolean; enqueued: boolean; status: string } {
    const db = this.requireDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const nowIso = new Date().toISOString();
      const eventRes = db
        .prepare(
          `INSERT OR IGNORE INTO content_processed_events (event_id, event_type, media_key, processed_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(input.eventId, input.eventType, input.mediaKey ?? null, nowIso);

      if ((eventRes.changes ?? 0) === 0) {
        db.exec('ROLLBACK');
        return { accepted: false, deduplicated: true, enqueued: false, status: 'deduplicated' };
      }

      this.upsertPendingStub({
        mediaKey: input.job.mediaKey,
        mediaType: input.job.mediaType,
        tmdbId: input.job.tmdbId,
        ...(input.job.sourceRevision ? { sourceRevision: input.job.sourceRevision } : {}),
        ...(input.job.payload ? { sanitizedMetadata: input.job.payload } : {}),
      });

      const enq = this.enqueueJob(input.job);

      db.exec('COMMIT');
      return {
        accepted: true,
        deduplicated: false,
        enqueued: enq.enqueued,
        status: enq.status,
      };
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // transaction zaten kapalı olabilir; kurtarma yok, hata yukarı taşınır
      }
      throw err;
    }
  }

  getStatus(): ContentRepositoryStatus {
    if (!this.db) {
      return {
        available: false,
        filePath: this.filePath,
        lastError: this.lastError,
        recordsCount: 0,
        queuePending: 0,
        queueProcessing: 0,
        queueFailed: 0,
      };
    }
    const counts = this.countRecords();
    const q = this.getQueueStats();
    return {
      available: true,
      filePath: this.filePath,
      lastError: this.lastError,
      recordsCount: counts.total,
      queuePending: q.pending,
      queueProcessing: q.processing,
      queueFailed: q.failed,
    };
  }
}

export function createContentIntelligenceRepository(
  options: { dataDir?: string; dbPath?: string } = {}
): ContentIntelligenceRepository {
  return new ContentIntelligenceRepository(options);
}
