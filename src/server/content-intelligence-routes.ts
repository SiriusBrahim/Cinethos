/**
 * MIA Faz 2 — Content Intelligence HTTP API Rotaları (/api/content-intelligence/*)
 */

import { Router, type Response } from 'express';
import type { MediaKind, TypedAppEvent } from '../contracts/index.ts';
import type {
  ContentIntelligenceRecord,
  ContentProcessingStatus,
} from '../modules/content/types.ts';
import type { ContentProcessingCoordinator } from './content-processing-coordinator.ts';

function parseRecordView(row: ContentIntelligenceRecord) {
  const safeParse = (raw: string) => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  };
  return {
    media_key: row.media_key,
    media_type: row.media_type,
    tmdb_id: row.tmdb_id,
    imdb_id: row.imdb_id,
    source_revision: row.source_revision,
    data_hash: row.data_hash,
    processed_at: row.processed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    processing_version: row.processing_version,
    processing_status: row.processing_status,
    processing_error: row.processing_error,
    normalized_metadata: safeParse(row.normalized_metadata_json),
    feature_vector: safeParse(row.feature_vector_json),
    mood_vector: safeParse(row.mood_vector_json),
    semantic_data: safeParse(row.semantic_data_json),
  };
}

function handleError(res: Response, err: unknown, fallback: string) {
  return res.status(500).json({
    ok: false,
    error: err instanceof Error ? err.message : fallback,
  });
}

export function createContentIntelligenceRouter(
  coordinator: ContentProcessingCoordinator
): Router {
  const router = Router();

  router.get('/status', (_req, res) => {
    try {
      res.json({ ok: true, stale: coordinator.countStaleRecords(), ...coordinator.getStatus() });
    } catch (err) {
      handleError(res, err, 'Content Intelligence durumu okunamadı.');
    }
  });

  router.get('/stats', (_req, res) => {
    try {
      res.json({ ok: true, stats: coordinator.getAnonymizedAggregateStats() });
    } catch (err) {
      handleError(res, err, 'Anonim istatistikler hesaplanamadı.');
    }
  });

  router.get('/items', (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const mediaType: MediaKind | undefined =
        req.query.mediaType === 'movie' || req.query.mediaType === 'tv'
          ? req.query.mediaType
          : undefined;
      const validStatuses: ContentProcessingStatus[] = [
        'pending',
        'processing',
        'completed',
        'failed',
        'skipped',
      ];
      const status =
        typeof req.query.status === 'string' &&
        validStatuses.includes(req.query.status as ContentProcessingStatus)
          ? (req.query.status as ContentProcessingStatus)
          : undefined;

      const page = coordinator.listRecords({ limit, offset, mediaType, status });
      res.json({
        ok: true,
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        items: page.items.map(parseRecordView),
      });
    } catch (err) {
      handleError(res, err, 'İçerik zekâsı listesi okunamadı.');
    }
  });

  router.get('/compare', (req, res) => {
    try {
      const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
      const target = typeof req.query.target === 'string' ? req.query.target.trim() : '';
      if (!source || !target) {
        return res.status(400).json({ ok: false, error: 'source ve target parametreleri zorunludur.' });
      }
      const comparison = coordinator.compareStored(source, target);
      if (!comparison) {
        return res.status(404).json({
          ok: false,
          error: 'Karşılaştırma için tamamlanmış kaynak/hedef kayıt bulunamadı.',
        });
      }
      res.json({ ok: true, comparison });
    } catch (err) {
      handleError(res, err, 'Karşılaştırma hesaplanamadı.');
    }
  });

  router.get('/items/:mediaKey', (req, res) => {
    try {
      const mediaKey = String(req.params.mediaKey || '').trim();
      if (!/^(movie|tv):\d+$/.test(mediaKey)) {
        return res.status(400).json({ ok: false, error: 'Geçersiz mediaKey formatı.' });
      }
      const record = coordinator.getByMediaKey(mediaKey);
      if (!record) {
        return res.status(404).json({ ok: false, error: 'Kayıt bulunamadı.' });
      }
      res.json({ ok: true, item: parseRecordView(record) });
    } catch (err) {
      handleError(res, err, 'Kayıt okunamadı.');
    }
  });

  router.get('/items/:mediaKey/related', (req, res) => {
    try {
      const mediaKey = String(req.params.mediaKey || '').trim();
      const limit = req.query.limit ? Number(req.query.limit) : 10;
      const related = coordinator.getRelated(mediaKey, limit);
      res.json({ ok: true, mediaKey, related });
    } catch (err) {
      handleError(res, err, 'İlişkili içerikler hesaplanamadı.');
    }
  });

  router.post('/ingest', async (req, res) => {
    try {
      const sync = req.query.sync === '1' || req.body?.sync === true;
      const rawItems = Array.isArray(req.body?.items)
        ? (req.body.items as Record<string, unknown>[])
        : req.body?.item && typeof req.body.item === 'object'
          ? [req.body.item as Record<string, unknown>]
          : req.body && typeof req.body === 'object' && !Array.isArray(req.body)
            ? [req.body as Record<string, unknown>]
            : [];

      if (rawItems.length === 0) {
        return res.status(400).json({ ok: false, error: 'En az bir içerik gönderilmelidir.' });
      }

      if (sync && rawItems.length === 1) {
        const outcome = await coordinator.processImmediate(rawItems[0]);
        return res.json({ ok: outcome.status !== 'failed', outcome });
      }

      const batchResult = await coordinator.enqueueLibraryItemsBatch(rawItems);
      if (sync) {
        await coordinator.drain();
      }
      res.status(sync ? 200 : 202).json({
        ok: true,
        ...batchResult,
      });
    } catch (err) {
      handleError(res, err, 'İçerik kuyruğa alınamadı.');
    }
  });

  router.get('/stale', (req, res) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 100;
      res.json({
        ok: true,
        total: coordinator.countStaleRecords(),
        items: coordinator.listStaleRecords(limit),
      });
    } catch (err) {
      handleError(res, err, 'Yeniden işlenecek kayıtlar okunamadı.');
    }
  });

  router.post('/reprocess', async (req, res) => {
    try {
      const limit = req.body?.limit ? Number(req.body.limit) : 100;
      const result = await coordinator.reprocessStale({ limit });
      res.status(202).json({ ok: true, stale: coordinator.countStaleRecords(), ...result });
    } catch (err) {
      handleError(res, err, 'Yeniden işleme kuyruğa alınamadı.');
    }
  });

  router.post('/drain', async (_req, res) => {
    try {
      await coordinator.drain();
      res.json({ ok: true, ...coordinator.getStatus() });
    } catch (err) {
      handleError(res, err, 'Kuyruk boşaltılamadı.');
    }
  });

  router.post('/events', async (req, res) => {
    try {
      const body = req.body as
        | TypedAppEvent
        | { event?: TypedAppEvent; metadata?: Record<string, unknown> };
      const event = body && 'event' in body && body.event ? body.event : (body as TypedAppEvent);
      if (!event || !event.eventId || !event.eventType) {
        return res.status(400).json({ ok: false, error: 'Geçersiz olay yükü.' });
      }
      const metadata =
        body && 'metadata' in body && body.metadata && typeof body.metadata === 'object'
          ? body.metadata
          : undefined;
      const result = await coordinator.eventSubscriber.handleEvent(event, metadata);
      res.json({ ok: true, result });
    } catch (err) {
      handleError(res, err, 'Olay işlenemedi.');
    }
  });

  return router;
}
