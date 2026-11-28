/**
 * MIA Faz 3 — Merkezi Library Manager (sunucu uygulaması).
 *
 * `ILibraryService` sözleşmesinin tek yazma hattıdır. Mevcut altyapıyı
 * yeniden kullanır; paralel repository / event sistemi oluşturmaz:
 *
 * - Birincil kullanıcı verisi: `ServerPrimaryDataRepository`
 *   (`saveForProfileOrThrow` ile iyimser kilitleme + profil doğrulaması)
 * - Profil bağlamı: mevcut `ProfileContext` (`assertWritable`, `commitRevision`)
 * - Olaylar: mevcut `AppEventBus` + `diffLibraryEvents` (yeni olay türü yok)
 * - Kayıt kuralları: `src/modules/library/operations.ts` (istemci ile ortak)
 *
 * VERİ SINIRI: Bu servis yalnızca kullanıcı kütüphanesini yazar. Ortak içerik
 * metadata'sına (katalog, `content_records`, poster deposu) YAZMAZ; bir
 * içeriğin listeden çıkarılması ortak içerik kaydını silmez. İçerik alanları
 * yalnızca `pickContentFields` allowlist'i üzerinden, Content Manager
 * sahipliğindeki metadata'dan kopyalanır.
 *
 * KURAL: Kütüphane kaydına kişisel olmayan hiçbir alan Content Manager
 * tarafından yazılamaz; kişisel alanlar (status, puan, ilerleme) yalnızca bu
 * servisin açık girdilerinden gelir.
 */

import {
  ProfileConflictError,
  StaleRevisionError,
  type AddLibraryItemInput,
  type IEventPublisher,
  type ILibraryService,
  type LibraryListId,
  type OperationOutcome,
  type ProfileRef,
  type RemoveLibraryItemInput,
  type UpdateLibraryItemInput,
  type WriteProfileRef,
} from '../../contracts/index.ts';
import {
  findSavedItem,
  normalizeDeletedKeys,
  type DataDocument,
  type Profile,
  type SavedItem,
} from '../../core/cinetrack-core.ts';
import { makeMediaKey, parseMediaKey } from '../../core/keys.ts';
import { normalizeProfileId } from '../../core/profile-id.ts';
import type { ProfileContext } from '../../shared/runtime/ProfileContext.ts';
import { diffLibraryEvents } from '../../shared/library-event-diff.ts';
import type { LibraryWriteRepository } from './ports.ts';
import {
  buildLibraryItem,
  libraryListToWatchStatus,
  pickContentFields,
  type ItemWatchStatus,
} from './operations.ts';

export interface LibraryServiceOptions {
  readonly repository: LibraryWriteRepository;
  readonly profileContext: ProfileContext;
  readonly eventPublisher?: IEventPublisher;
  /** Test/denetim için zaman kaynağı. */
  readonly now?: () => string;
}

interface CommitOutcome {
  readonly revision: number;
  readonly publishErrors: readonly string[];
}

function normalizeRating(rating: number | null | undefined): number | '' {
  if (typeof rating !== 'number' || !Number.isFinite(rating)) return '';
  if (rating < 1 || rating > 10) return '';
  return rating;
}

function failure(error: string, retryable = false): OperationOutcome {
  return { ok: false, error, retryable };
}

export class LibraryService implements ILibraryService {
  private readonly repository: LibraryWriteRepository;
  private readonly profileContext: ProfileContext;
  private readonly eventPublisher?: IEventPublisher;
  private readonly now: () => string;

  constructor(options: LibraryServiceOptions) {
    this.repository = options.repository;
    this.profileContext = options.profileContext;
    this.eventPublisher = options.eventPublisher;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async addItem(input: AddLibraryItemInput): Promise<OperationOutcome> {
    try {
      this.profileContext.assertWritable(input.ref);
      const parsed = parseMediaKey(input.mediaKey);
      if (!parsed || parsed.type !== input.mediaType) {
        return failure('Geçersiz medya anahtarı: kanonik "movie:<id>" / "tv:<id>" bekleniyor.');
      }
      const status = libraryListToWatchStatus(input.list);
      if (!status) {
        return failure(
          '"not-interested" bir kütüphane durumu değildir; gizleme/ilgilenmiyorum akışını kullanın.'
        );
      }

      const document = await this.loadDocument();
      const before = this.cloneDocument(document);
      const profile = this.requireProfile(document, input.ref.profileId);
      const existing = findSavedItem(profile.items, {
        id: parsed.id,
        media_type: input.mediaType,
      });

      const built = buildLibraryItem({
        existing,
        incoming: {
          ...pickContentFields(input.metadata),
          id: parsed.id,
          media_type: input.mediaType,
          ...(existing || input.metadata ? {} : { title: '' }),
        },
        status,
        rating: normalizeRating(input.rating) || existing?.personal_rating || '',
        nowIso: this.now(),
      });
      if (!built) {
        return failure('Kütüphane kaydı doğrulanamadı; içerik kimliği geçersiz.');
      }

      if (existing) {
        profile.items = profile.items.map((item) =>
          item === existing ? built : item
        );
      } else {
        profile.items = [built, ...profile.items];
      }
      profile.deleted_keys = this.withoutTombstone(profile.deleted_keys, input.mediaKey);

      const commit = await this.commit(before, document, input.ref);
      return this.outcome(commit, 'kütüphane kaydı yazıldı');
    } catch (error) {
      return this.mapError(error);
    }
  }

  async updateItem(input: UpdateLibraryItemInput): Promise<OperationOutcome> {
    try {
      this.profileContext.assertWritable(input.ref);
      const parsed = parseMediaKey(input.mediaKey);
      if (!parsed) {
        return failure('Geçersiz medya anahtarı: kanonik "movie:<id>" / "tv:<id>" bekleniyor.');
      }

      const document = await this.loadDocument();
      const before = this.cloneDocument(document);
      const profile = this.requireProfile(document, input.ref.profileId);
      const existing = findSavedItem(profile.items, {
        id: parsed.id,
        media_type: parsed.type,
      });
      if (!existing) {
        return failure('Kütüphane öğesi bulunamadı.');
      }

      const nextStatus: ItemWatchStatus = input.list
        ? this.requireStatus(input.list)
        : existing.status;
      const rating =
        input.rating !== undefined ? normalizeRating(input.rating) : existing.personal_rating;

      const built = buildLibraryItem({
        existing,
        incoming: pickContentFields(input.metadata),
        status: nextStatus,
        rating,
        tracking: this.progressToTracking(input.progress),
        nowIso: this.now(),
        forceRatedAt: input.rating !== undefined && rating !== '',
      });
      if (!built) {
        return failure('Kütüphane güncellemesi doğrulanamadı.');
      }

      profile.items = profile.items.map((item) => (item === existing ? built : item));

      const commit = await this.commit(before, document, input.ref);
      return this.outcome(commit, 'kütüphane kaydı güncellendi');
    } catch (error) {
      return this.mapError(error);
    }
  }

  async removeItem(input: RemoveLibraryItemInput): Promise<OperationOutcome> {
    try {
      this.profileContext.assertWritable(input.ref);
      const parsed = parseMediaKey(input.mediaKey);
      if (!parsed) {
        return failure('Geçersiz medya anahtarı: kanonik "movie:<id>" / "tv:<id>" bekleniyor.');
      }

      const document = await this.loadDocument();
      const before = this.cloneDocument(document);
      const profile = this.requireProfile(document, input.ref.profileId);
      const mediaKey = makeMediaKey(parsed.type, parsed.id);
      const existing = findSavedItem(profile.items, {
        id: parsed.id,
        media_type: parsed.type,
      });
      if (!existing) {
        return failure('Kütüphane öğesi bulunamadı.');
      }

      // Yalnızca kullanıcı kaydı silinir; ortak içerik metadata'sına dokunulmaz.
      profile.items = profile.items.filter((item) => item !== existing);
      profile.deleted_keys = normalizeDeletedKeys({
        ...(profile.deleted_keys ?? {}),
        [mediaKey]: this.now(),
      });

      const commit = await this.commit(before, document, input.ref);
      return this.outcome(commit, 'kütüphane kaydı kaldırıldı');
    } catch (error) {
      return this.mapError(error);
    }
  }

  async getItem(
    ref: ProfileRef,
    mediaKey: string
  ): Promise<{ list: LibraryListId; rating: number | null } | null> {
    const parsed = parseMediaKey(mediaKey);
    if (!parsed) return null;
    const document = await this.loadDocument();
    const expectedProfileId = normalizeProfileId(ref?.profileId);
    const profile = expectedProfileId
      ? document.profiles.find((entry) => normalizeProfileId(entry.id) === expectedProfileId)
      : undefined;
    if (!profile) return null;
    const item = findSavedItem(profile.items, { id: parsed.id, media_type: parsed.type });
    if (!item) return null;
    return {
      list: this.statusToList(item.status),
      rating:
        typeof item.personal_rating === 'number' && Number.isFinite(item.personal_rating)
          ? item.personal_rating
          : null,
    };
  }

  private async loadDocument(): Promise<DataDocument> {
    const raw = await this.repository.readRaw();
    if (raw.corrupt) {
      throw new Error('Birincil veri kaynağı bozuk; kütüphane işlemi yapılamadı.');
    }
    return raw.document;
  }

  private cloneDocument(document: DataDocument): DataDocument {
    return JSON.parse(JSON.stringify(document)) as DataDocument;
  }

  private requireProfile(document: DataDocument, profileId: string): Profile {
    const expectedProfileId = normalizeProfileId(profileId);
    const profile = expectedProfileId
      ? document.profiles.find((entry) => normalizeProfileId(entry.id) === expectedProfileId)
      : undefined;
    if (!profile) {
      throw new ProfileConflictError('profile-not-found', {
        message: `Profil bulunamadı: ${profileId}`,
      });
    }
    return profile;
  }

  private requireStatus(list: LibraryListId): ItemWatchStatus {
    const status = libraryListToWatchStatus(list);
    if (!status) {
      throw new Error(
        '"not-interested" bir kütüphane durumu değildir; gizleme/ilgilenmiyorum akışını kullanın.'
      );
    }
    return status;
  }

  private statusToList(status: SavedItem['status']): LibraryListId {
    if (status === 'completed') return 'watched';
    if (status === 'watching') return 'watching';
    return 'watchlist';
  }

  private withoutTombstone(
    tombstones: Record<string, string> | undefined,
    mediaKey: string
  ): Record<string, string> | undefined {
    if (!tombstones || !(mediaKey in tombstones)) return tombstones;
    const next = { ...tombstones };
    delete next[mediaKey];
    return next;
  }

  private progressToTracking(
    progress: UpdateLibraryItemInput['progress']
  ): Record<string, unknown> {
    if (!progress) return {};
    const tracking: Record<string, unknown> = {};
    if (progress.episodesWatched !== undefined) {
      tracking.episodes_watched = progress.episodesWatched;
    }
    if (progress.currentSeason !== undefined) {
      tracking.current_season = progress.currentSeason;
    }
    if (progress.seasonProgress !== undefined) {
      tracking.season_progress = progress.seasonProgress;
    }
    return tracking;
  }

  /**
   * Yazım + profil bağlamı + olay yayımı. Olay yayımı başarısız olursa kayıt
   * yine de kalıcıdır; sonuç bunu açıkça bildirir (sessiz yutma yok).
   */
  private async commit(
    before: DataDocument,
    after: DataDocument,
    ref: WriteProfileRef
  ): Promise<CommitOutcome> {
    after.updatedAt = this.now();
    const revision = await this.repository.saveForProfileOrThrow(after, ref, 'library-service');
    after.revision = revision;
    this.profileContext.commitRevision(revision, ref.profileId);

    const publishErrors: string[] = [];
    if (this.eventPublisher) {
      for (const event of diffLibraryEvents(before, after)) {
        try {
          await this.eventPublisher.publish(event);
        } catch (error) {
          publishErrors.push(
            `${String(event.eventType)} (${event.eventId}): ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    return { revision, publishErrors };
  }

  private outcome(commit: CommitOutcome, done: string): OperationOutcome {
    if (commit.publishErrors.length > 0) {
      return failure(
        `${done} (rev ${commit.revision}) ancak olay yayımı başarısız: ${commit.publishErrors.join('; ')}`,
        true
      );
    }
    return { ok: true };
  }

  private mapError(error: unknown): OperationOutcome {
    if (error instanceof ProfileConflictError) {
      return failure(error.message, false);
    }
    if (error instanceof StaleRevisionError) {
      return failure(error.message, false);
    }
    return failure(
      error instanceof Error ? error.message : 'Kütüphane işlemi tamamlanamadı.',
      true
    );
  }
}

export function createLibraryService(options: LibraryServiceOptions): LibraryService {
  return new LibraryService(options);
}
