/**
 * Content Intelligence Manager — modül uygulaması.
 *
 * Alt modüller (Faz 3'te ayrı dosyalara bölünür, burada tek modül içinde tutulur):
 * - Ingestion: `ingest` → doğrulama, kimlik, tekilleştirme
 * - Metadata Normalizer: `identity.ts` (kanonik anahtar) + `features.ts`
 * - Content Repository: enjekte edilen `ContentRecordRepository`
 * - Feature Extractor: `deriveFeatures`
 * - Relationship Processor: Faz 5'te bağlanır (sözleşme: `DerivedFeatures`)
 * - Processing Coordinator: `processing` durumu + `reprocess`
 *
 * Profil bağımsızlığı: kayıtlarda `profileId` yoktur; içerik olayları `system`
 * profiliyle yayınlanır ve profil bazlı iş Faz 4 işleyicisinde üretilir.
 */

import {
  createInMemoryRepository,
  type RepositoryResult,
} from '../kernel/repository-contracts.ts';
import {
  CONTENT_FEATURE_VERSION,
  CONTENT_INTELLIGENCE_SERVICE,
  type ContentError,
  type ContentIntelligenceApi,
  type ContentIntelligenceStats,
  type ContentProcessingStatus,
  type ContentRecord,
  type ContentRecordRepository,
  type ContentResult,
  type DerivedFeatures,
  type IngestResult,
  type SourceMetadata,
} from './contracts.ts';
import { canonicalContentKey, decideDedupe, validateSourceMetadata } from './identity.ts';
import { deriveFeatures } from './features.ts';
import type { ModuleContext, ModuleRegistration } from '../kernel/types.ts';

export interface ContentIntelligenceModuleOptions {
  readonly repository?: ContentRecordRepository;
  readonly now?: () => Date;
  readonly featureVersion?: number;
  /** Test/alternatif sağlayıcı için özellik çıkarıcı enjeksiyonu. */
  readonly extractFeatures?: (source: SourceMetadata, now: () => Date) => DerivedFeatures;
  /** İçerik yazıldığında çağrılır; olay yayını modül yaşam döngüsünde bağlanır. */
  readonly onIngest?: (info: { readonly action: 'inserted' | 'updated'; readonly record: ContentRecord }) => void;
}

const SYSTEM_PROFILE = 'system';

function contentError(code: ContentError['code'], message: string): ContentResult<never> {
  return { ok: false, error: { code, message } };
}

function storageError(error: { message: string }): ContentResult<never> {
  return contentError('storage_unavailable', error.message);
}

function unwrap<T>(result: RepositoryResult<T>): ContentResult<T> {
  if (!result.ok) return storageError(result.error);
  return { ok: true, value: result.value };
}

export function createContentIntelligenceApi(
  options: ContentIntelligenceModuleOptions = {}
): { api: ContentIntelligenceApi; repository: ContentRecordRepository } {
  const now = options.now ?? (() => new Date());
  const featureVersion = options.featureVersion ?? CONTENT_FEATURE_VERSION;
  const repository: ContentRecordRepository =
    options.repository ??
    createInMemoryRepository<ContentRecord, string>({
      name: 'content-intelligence',
      keyOf: (record) => record.identity.key,
      now,
    });
  const extract = options.extractFeatures ?? ((source: SourceMetadata, clock: () => Date) =>
    deriveFeatures(source, { now: clock, featureVersion }));

  const status = (
    state: ContentProcessingStatus['state'],
    attempts: number,
    lastError?: string
  ): ContentProcessingStatus => ({
    state,
    attempts,
    updatedAt: now().toISOString(),
    ...(lastError ? { lastError } : {}),
  });

  const api: ContentIntelligenceApi = {
    async ingest(source) {
      const invalid = validateSourceMetadata(source);
      if (invalid) return contentError('invalid_input', invalid);

      const key = canonicalContentKey(source.mediaType, source.tmdbId);
      const existingResult = await repository.get(key);
      const existing = unwrap(existingResult);
      if (!existing.ok) return existing;

      const decision = decideDedupe(existing.value?.value ?? null, source);
      if (decision.action === 'skipped' && existing.value) {
        return {
          ok: true,
          value: {
            action: 'skipped',
            reason: decision.reason,
            record: existing.value.value,
          },
        };
      }

      let derived: DerivedFeatures;
      try {
        derived = extract(source, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedRecord: ContentRecord = {
          identity: { mediaType: source.mediaType, tmdbId: source.tmdbId, key },
          source,
          processing: status('failed', (existing.value?.value.processing.attempts ?? 0) + 1, message),
        };
        await repository.put(failedRecord);
        return contentError('processing_failed', message);
      }

      const record: ContentRecord = {
        identity: { mediaType: source.mediaType, tmdbId: source.tmdbId, key },
        source,
        derived,
        processing: status('features_ready', (existing.value?.value.processing.attempts ?? 0) + 1),
      };

      const saved = await repository.put(record, {
        expectedRevision: existing.value?.revision,
      });
      if (!saved.ok) {
        return saved.error.code === 'conflict'
          ? contentError('conflict', saved.error.message)
          : storageError(saved.error);
      }

      if (decision.action === 'inserted' || decision.action === 'updated') {
        options.onIngest?.({ action: decision.action, record: saved.value.value });
      }

      return {
        ok: true,
        value: {
          action: decision.action,
          reason: decision.reason,
          record: saved.value.value,
        } satisfies IngestResult,
      };
    },

    async getRecord(key) {
      const result = unwrap(await repository.get(key));
      if (!result.ok) return result;
      return { ok: true, value: result.value?.value ?? null };
    },

    async getFeatures(key) {
      const result = unwrap(await repository.get(key));
      if (!result.ok) return result;
      const record = result.value?.value;
      // Öneri motoru yalnız `features_ready` kayıtlardan özellik okur.
      if (!record || record.processing.state !== 'features_ready' || !record.derived) {
        return { ok: true, value: null };
      }
      return { ok: true, value: record.derived };
    },

    async getFeaturesBatch(keys) {
      const features: DerivedFeatures[] = [];
      for (const key of keys) {
        const result = unwrap(await repository.get(key));
        if (!result.ok) return result;
        const record = result.value?.value;
        if (record?.processing.state === 'features_ready' && record.derived) {
          features.push(record.derived);
        }
      }
      return { ok: true, value: features };
    },

    async getStatus(key) {
      const result = unwrap(await repository.get(key));
      if (!result.ok) return result;
      return { ok: true, value: result.value?.value.processing ?? null };
    },

    async reprocess(key) {
      const existing = unwrap(await repository.get(key));
      if (!existing.ok) return existing;
      if (!existing.value) return contentError('invalid_input', `İçerik bulunamadı: ${key}`);

      const record = existing.value.value;
      try {
        const derived = extract(record.source, now);
        const saved = await repository.put(
          {
            ...record,
            derived,
            processing: status('features_ready', record.processing.attempts + 1),
          },
          { expectedRevision: existing.value.revision }
        );
        if (!saved.ok) {
          return saved.error.code === 'conflict'
            ? contentError('conflict', saved.error.message)
            : storageError(saved.error);
        }
        return { ok: true, value: saved.value.value };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await repository.put(
          {
            ...record,
            processing: status('failed', record.processing.attempts + 1, message),
          },
          { expectedRevision: existing.value.revision }
        );
        return contentError('processing_failed', message);
      }
    },

    async stats() {
      const all = unwrap(await repository.list());
      if (!all.ok) return all;
      const records = all.value.map((entry) => entry.value);
      const summary: ContentIntelligenceStats = {
        total: records.length,
        ready: records.filter((record) => record.processing.state === 'features_ready').length,
        failed: records.filter((record) => record.processing.state === 'failed').length,
        pending: records.filter((record) => record.processing.state === 'pending').length,
        featureVersion,
      };
      return { ok: true, value: summary };
    },
  };

  return { api, repository };
}

/**
 * Modül kaydı: yaşam döngüsü + sağlık + olay aboneliği.
 * `content.removed` geldiğinde katalog kaydı düşürülür (kullanıcı verisi değil).
 */
export function createContentIntelligenceModule(
  options: ContentIntelligenceModuleOptions = {}
): ModuleRegistration {
  return {
    manifest: {
      id: CONTENT_INTELLIGENCE_SERVICE,
      displayName: 'Content Intelligence Manager',
      version: '1.0.0',
      schemaVersion: 1,
      dependencies: [],
      provides: [CONTENT_INTELLIGENCE_SERVICE],
    },
    create() {
      const bridge: {
        publish: ((info: { action: 'inserted' | 'updated'; record: ContentRecord }) => void) | null;
      } = { publish: null };
      const { api, repository } = createContentIntelligenceApi({
        ...options,
        onIngest: (info) => bridge.publish?.(info),
      });
      let unsubscribe: (() => void) | null = null;

      return {
        manifest: {
          id: CONTENT_INTELLIGENCE_SERVICE,
          displayName: 'Content Intelligence Manager',
          version: '1.0.0',
          schemaVersion: 1,
          dependencies: [],
          provides: [CONTENT_INTELLIGENCE_SERVICE],
        },
        api,

        initialize(context: ModuleContext) {
          // Depo erişilebilirliği ilk sağlık kontrolünde doğrulanır; ağ çağrısı yok.
          // İçerik olayları profilsizdir: kullanıcı verisi taşımaz (`system`).
          bridge.publish = (info) => {
            const meta = { profileId: SYSTEM_PROFILE, entityId: info.record.identity.key };
            if (info.action === 'inserted') {
              context.events.publish(
                'content.added',
                {
                  contentKey: info.record.identity.key,
                  mediaType: info.record.identity.mediaType,
                  title: info.record.source.title,
                },
                meta
              );
              return;
            }
            context.events.publish(
              'content.updated',
              {
                contentKey: info.record.identity.key,
                changed: ['source', 'derived'],
              },
              meta
            );
          };
        },

        start(context: ModuleContext) {
          unsubscribe = context.events.subscribe('content.removed', (event) => {
            void repository.delete(event.payload.contentKey);
          });
        },

        async healthCheck() {
          const all = await repository.list();
          if (!all.ok) {
            return { healthy: false, detail: all.error.message };
          }
          const records = all.value.map((entry) => entry.value);
          const failed = records.filter((record) => record.processing.state === 'failed').length;
          return {
            healthy: failed === 0,
            ...(failed > 0 ? { detail: `${failed} içerik işlenemedi` } : {}),
            metrics: {
              total: records.length,
              failed,
              featureVersion: options.featureVersion ?? CONTENT_FEATURE_VERSION,
            },
          };
        },

        stop() {
          unsubscribe?.();
          unsubscribe = null;
        },
      };
    },
  };
}
