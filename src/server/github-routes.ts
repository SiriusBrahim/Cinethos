/**
 * F5.3-06 — GitHub geliştirme senkronizasyonu HTTP uçları.
 *
 * Bu uçlar uygulamanın kullanıcı özellikleri değil, geliştirme sırasında veri
 * taşımak için kullanılan geçici araçlardır. Tek bir route modülünde toplanır ve
 * yalnızca `githubDevSyncEnabled === true` iken bağlanır. Yerel veri API'leri
 * (`/api/catalog`, `/api/stock`, `/api/data`, yedekleme uçları) bu modülden
 * bağımsızdır; modül hiç bağlanmasa da çalışır.
 *
 * GitHub entegrasyonu kaldırılacağında bu dosya silinir ve `app.ts` içindeki
 * tek `registerGitHubSyncRoutes(...)` çağrısı kaldırılır.
 */

import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { redactSecrets, type PersistentDataStore } from './persistent-store.ts';

export interface GitHubSyncRouteDeps {
  app: Express;
  persistentStore: PersistentDataStore;
  githubDevSyncEnabled?: boolean;
  githubToken?: string;
  originGuard: RequestHandler;
  tokenGuard: RequestHandler;
  syncStatusGuard: RequestHandler;
}

export function buildSyncFailure(
  error: unknown,
  operation: string,
  fallback: string,
  secrets: Array<string | undefined>
): { status: 409 | 500; body: Record<string, unknown> } {
  const code =
    error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
      ? String((error as { code?: string }).code)
      : '';
  const contention =
    code === 'sync_lease_busy' ||
    code === 'sync_queue_full' ||
    code === 'sync_queue_timeout' ||
    code === 'sync_aborted';
  const message = redactSecrets(
    error instanceof Error && error.message ? error.message : fallback,
    secrets
  );
  if (contention) {
    return {
      status: 409,
      body: {
        ok: false,
        operation,
        code,
        verifiedEqual: false,
        errors: [{ category: 'sync_in_progress', message }],
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      operation,
      verifiedEqual: false,
      errors: [{ category: 'http_error', message }],
    },
  };
}

function busyResponse(res: Response, operation: string): void {
  res.status(409).json({
    ok: false,
    operation,
    code: 'sync_in_progress',
    verifiedEqual: false,
    errors: [
      {
        category: 'sync_in_progress',
        message: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
      },
    ],
  });
}

export function registerGitHubSyncRoutes(deps: GitHubSyncRouteDeps): void {
  const {
    app,
    persistentStore,
    githubDevSyncEnabled,
    githubToken,
    originGuard,
    tokenGuard,
    syncStatusGuard,
  } = deps;

  app.get('/api/sync/status', syncStatusGuard, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(persistentStore.getSyncStatus());
  });

  // Geliştirme kapısı: aşağıdaki tüm uçlar yalnızca açıkça etkinleştirilirse çalışır.
  app.use('/api/sync', (_req: Request, res: Response, next: NextFunction) => {
    if (githubDevSyncEnabled === true) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).json({
      ok: false,
      code: 'github_dev_sync_disabled',
      status_message: 'GitHub senkronizasyonu yalnızca geliştirme ortamında kullanılabilir.',
    });
  });

  app.post('/api/sync/inspect', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      busyResponse(res, 'inspect');
      return;
    }
    try {
      const report = await persistentStore.inspectGitHub();
      res.json(report);
    } catch (e: any) {
      const failure = buildSyncFailure(e, 'inspect', 'GitHub durum denetimi başarısız oldu.', [
        githubToken,
      ]);
      res.status(failure.status).json(failure.body);
    }
  });

  app.post('/api/sync/pull', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      busyResponse(res, 'pull');
      return;
    }
    try {
      const rawStrategy = req.body?.conflictStrategy;
      const conflictStrategy: 'ask' | 'merge' | 'overwrite_with_remote' =
        rawStrategy === 'merge' || rawStrategy === 'overwrite_with_remote' ? rawStrategy : 'ask';
      const report = await persistentStore.pullFromGitHub({ conflictStrategy });
      if (typeof report.serverRevision === 'number') {
        res.setHeader('ETag', `"rev-${report.serverRevision}"`);
      }
      res.json(report);
    } catch (e: any) {
      const failure = buildSyncFailure(e, 'pull', 'GitHub indirme işlemi başarısız oldu.', [
        githubToken,
      ]);
      res.status(failure.status).json(failure.body);
    }
  });

  app.post('/api/sync/push', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      busyResponse(res, 'push');
      return;
    }
    try {
      const report = await persistentStore.pushToGitHub();
      res.json(report);
    } catch (e: any) {
      const failure = buildSyncFailure(e, 'push', 'GitHub yükleme işlemi başarısız oldu.', [
        githubToken,
      ]);
      res.status(failure.status).json(failure.body);
    }
  });

  app.post('/api/sync/reconcile', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      busyResponse(res, 'reconcile');
      return;
    }
    try {
      const report = await persistentStore.reconcileWithGitHub();
      if (typeof report.serverRevision === 'number') {
        res.setHeader('ETag', `"rev-${report.serverRevision}"`);
      }
      res.json(report);
    } catch (e: any) {
      const failure = buildSyncFailure(
        e,
        'reconcile',
        'İki yönlü eşitleme işlemi başarısız oldu.',
        [githubToken]
      );
      res.status(failure.status).json(failure.body);
    }
  });

  app.post('/api/sync/trigger', originGuard, tokenGuard, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const syncResult = await persistentStore.runExclusiveSyncToGitHub();
      res.json(syncResult);
    } catch (e: any) {
      res.status(500).json({
        ok: false,
        error: redactSecrets(e?.message || 'Sync failed', [githubToken]),
      });
    }
  });

  app.post(
    '/api/sync/test-connection',
    originGuard,
    tokenGuard,
    async (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const forceWriteProbe = Boolean(req.body?.forceWriteProbe);
        const probeResult = await persistentStore.runExclusiveSafeConnectionProbe({
          forceWriteProbe,
        });
        res.json(probeResult);
      } catch (e: any) {
        res.status(500).json({
          ok: false,
          error: redactSecrets(e?.message || 'Bağlantı testi başarısız oldu.', [githubToken]),
        });
      }
    }
  );

  app.post('/api/sync/token', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const rawToken = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!rawToken) {
      res.status(400).json({ ok: false, error: 'Token boş olamaz.' });
      return;
    }
    persistentStore.updateGitHubToken(rawToken, 'env:CINETRACK_GITHUB_PAT');
    res.json({ ok: true, status: persistentStore.getSyncStatus() });
  });

  app.post('/api/sync/public-consent', originGuard, tokenGuard, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const allow =
      typeof req.body?.allowPersonalDataInPublicRepo === 'boolean'
        ? req.body.allowPersonalDataInPublicRepo
        : typeof req.body?.allow === 'boolean'
          ? req.body.allow
          : undefined;
    if (typeof allow !== 'boolean') {
      res.status(400).json({
        ok: false,
        status_message: 'allowPersonalDataInPublicRepo alanı boolean (true/false) olmalıdır.',
      });
      return;
    }
    if (allow && req.body?.confirmPublicVisibility !== true) {
      res.status(400).json({
        ok: false,
        status_message:
          'Açık depoya kişisel veri senkronizasyonu için confirmPublicVisibility=true onayı zorunludur.',
      });
      return;
    }
    const updated = persistentStore.setPublicPersonalSyncConsent(allow);
    res.json({
      ok: true,
      ...updated,
      status: persistentStore.getSyncStatus(),
    });
  });

  app.post(
    '/api/sync/public-catalog-consent',
    originGuard,
    tokenGuard,
    (req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      const allow =
        typeof req.body?.allowCatalogInPublicRepo === 'boolean'
          ? req.body.allowCatalogInPublicRepo
          : typeof req.body?.allow === 'boolean'
            ? req.body.allow
            : undefined;
      if (typeof allow !== 'boolean') {
        res.status(400).json({
          ok: false,
          status_message: 'allowCatalogInPublicRepo alanı boolean (true/false) olmalıdır.',
        });
        return;
      }
      if (allow && req.body?.confirmTmdbAttribution !== true) {
        res.status(400).json({
          ok: false,
          status_message:
            'Açık depoya TMDB katalog verisi yüklemek için confirmTmdbAttribution=true onayı zorunludur.',
        });
        return;
      }
      const updated = persistentStore.setPublicCatalogSyncConsent(allow);
      res.json({
        ok: true,
        ...updated,
        status: persistentStore.getSyncStatus(),
      });
    }
  );

  app.post('/api/sync/staged', originGuard, tokenGuard, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.body?.rejectIfBusy === true && persistentStore.isSyncBusy()) {
      res.status(409).json({
        ok: false,
        code: 'sync_in_progress',
        error: 'Başka bir GitHub senkronizasyon işlemi devam ediyor.',
      });
      return;
    }
    try {
      const forceWriteProbe =
        typeof req.body?.forceWriteProbe === 'boolean' ? req.body.forceWriteProbe : true;
      const allowOverride =
        typeof req.body?.allowPersonalDataInPublicRepo === 'boolean'
          ? req.body.allowPersonalDataInPublicRepo
          : undefined;
      const allowCatalogOverride =
        typeof req.body?.allowCatalogInPublicRepo === 'boolean'
          ? req.body.allowCatalogInPublicRepo
          : undefined;
      const stagedReport = await persistentStore.runExclusiveStagedFullSync({
        forceWriteProbe,
        ...(allowOverride !== undefined ? { allowPersonalDataInPublicRepo: allowOverride } : {}),
        ...(allowCatalogOverride !== undefined ? { allowCatalogInPublicRepo: allowCatalogOverride } : {}),
      });
      if (typeof stagedReport.bidirectionalReport?.serverRevision === 'number') {
        res.setHeader('ETag', `"rev-${stagedReport.bidirectionalReport.serverRevision}"`);
      }
      res.json(stagedReport);
    } catch (e: any) {
      const code =
        e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
          ? String((e as { code?: string }).code)
          : '';
      const status = code.startsWith('sync_') ? 409 : 500;
      res.status(status).json({
        ok: false,
        ...(code ? { code } : {}),
        error: redactSecrets(e?.message || 'Aşamalı senkronizasyon başarısız oldu.', [githubToken]),
      });
    }
  });
}
