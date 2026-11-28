/**
 * Kalıcı store durum dosyası (`data/sync-state.json`) — F5.1-02.
 *
 * `PersistentDataStore` içinden çıkarılan, yan etkisi olmayan (dosya dışında)
 * sorumluluk: durum şablonu okuma/yazma ve yarıda kalan `syncing` kayıtlarının
 * kurtarılması. Davranış birebir korunur:
 *  - gelecek şema sürümü yok sayılır (dosya okunmaz),
 *  - bozuk JSON sessizce yok sayılır (veri dosyalarına dokunulmaz),
 *  - yazma atomiktir,
 *  - `syncing` kayıtları `pending`e çevrilir ve kesinti raporlanır.
 */

import type { BidirectionalSyncReport, SyncComparisonSummary, SyncSideSummary } from '../../core/sync-display.ts';
import type { SyncFileStateRecord } from './contracts.ts';
import { STAGE_LABELS, SYNC_STATE_VERSION, isPlainRecordObject } from './contracts.ts';
import { tryParseValidJson, writeJsonFileAtomic } from '../atomic-json.ts';
import { stringifyDeterministic } from '../persistent-store-utils.ts';

export interface SyncStateSnapshot {
  lastSyncAt: string | null;
  lastError: string | null;
  repoVisibilityWarning?: string;
  persistedInitialReconcile: boolean;
  persistedPublicPersonalConsent?: boolean;
  publicConsentUpdatedAt: string | null;
  persistedPublicCatalogConsent?: boolean;
  publicCatalogConsentUpdatedAt: string | null;
  lastObservedRemotePublic?: boolean;
  lastRemoteSummary: SyncSideSummary | null;
  lastComparison: SyncComparisonSummary | null;
  lastSyncReport: Omit<BidirectionalSyncReport, 'updatedDataDocument'> | null;
  fileStates: Record<string, SyncFileStateRecord>;
}

interface RawSyncStateFile {
  lastSyncAt?: string | null;
  lastError?: string | null;
  repoVisibilityWarning?: string;
  persistedInitialReconcile?: boolean;
  persistedPublicPersonalConsent?: boolean;
  publicConsentUpdatedAt?: string | null;
  persistedPublicCatalogConsent?: boolean;
  publicCatalogConsentUpdatedAt?: string | null;
  lastObservedRemotePublic?: boolean;
  lastRemoteSummary?: SyncSideSummary | null;
  lastComparison?: SyncComparisonSummary | null;
  lastSyncReport?: Omit<BidirectionalSyncReport, 'updatedDataDocument'> | null;
  fileStates?: Record<string, SyncFileStateRecord>;
  syncStateVersion?: number;
}

/**
 * Durum dosyasını okur. Dosya yoksa, bozuksa veya sürüm gelecekteyse `null`.
 * Çağıran bu durumda varsayılan değerleri korur.
 */
export function loadSyncStateSnapshot(filePath: string): SyncStateSnapshot | null {
  const parsed = tryParseValidJson<RawSyncStateFile>(filePath, (raw) =>
    isPlainRecordObject(raw) ? raw : null
  );
  if (!parsed.ok) return null;
  // Gelecek şema sürümü bu sürüm tarafından yorumlanamaz; sessizce yanlış
  // okumak yerine dosya yok sayılır (veri dosyalarına dokunulmaz).
  if (
    typeof parsed.data.syncStateVersion === 'number' &&
    parsed.data.syncStateVersion > SYNC_STATE_VERSION
  ) {
    return null;
  }

  return {
    lastSyncAt: parsed.data.lastSyncAt ?? null,
    lastError: parsed.data.lastError ?? null,
    repoVisibilityWarning: parsed.data.repoVisibilityWarning,
    persistedInitialReconcile: Boolean(parsed.data.persistedInitialReconcile),
    ...(typeof parsed.data.persistedPublicPersonalConsent === 'boolean'
      ? { persistedPublicPersonalConsent: parsed.data.persistedPublicPersonalConsent }
      : {}),
    publicConsentUpdatedAt: parsed.data.publicConsentUpdatedAt ?? null,
    ...(typeof parsed.data.persistedPublicCatalogConsent === 'boolean'
      ? { persistedPublicCatalogConsent: parsed.data.persistedPublicCatalogConsent }
      : {}),
    publicCatalogConsentUpdatedAt: parsed.data.publicCatalogConsentUpdatedAt ?? null,
    ...(typeof parsed.data.lastObservedRemotePublic === 'boolean'
      ? { lastObservedRemotePublic: parsed.data.lastObservedRemotePublic }
      : {}),
    lastRemoteSummary: parsed.data.lastRemoteSummary ?? null,
    lastComparison: parsed.data.lastComparison ?? null,
    lastSyncReport: parsed.data.lastSyncReport ?? null,
    fileStates: isPlainRecordObject(parsed.data.fileStates)
      ? { ...parsed.data.fileStates }
      : {},
  };
}

/** Durum şablonunu atomik olarak yazar. Hata yutulur (opsiyonel adım). */
export function saveSyncStateSnapshot(filePath: string, snapshot: SyncStateSnapshot): void {
  try {
    const payload = {
      syncStateVersion: SYNC_STATE_VERSION,
      lastSyncAt: snapshot.lastSyncAt,
      lastError: snapshot.lastError,
      persistedInitialReconcile: snapshot.persistedInitialReconcile,
      ...(snapshot.persistedPublicPersonalConsent !== undefined
        ? { persistedPublicPersonalConsent: snapshot.persistedPublicPersonalConsent }
        : {}),
      ...(snapshot.publicConsentUpdatedAt
        ? { publicConsentUpdatedAt: snapshot.publicConsentUpdatedAt }
        : {}),
      ...(snapshot.persistedPublicCatalogConsent !== undefined
        ? { persistedPublicCatalogConsent: snapshot.persistedPublicCatalogConsent }
        : {}),
      ...(snapshot.publicCatalogConsentUpdatedAt
        ? { publicCatalogConsentUpdatedAt: snapshot.publicCatalogConsentUpdatedAt }
        : {}),
      ...(snapshot.lastObservedRemotePublic !== undefined
        ? { lastObservedRemotePublic: snapshot.lastObservedRemotePublic }
        : {}),
      ...(snapshot.repoVisibilityWarning
        ? { repoVisibilityWarning: snapshot.repoVisibilityWarning }
        : {}),
      ...(snapshot.lastRemoteSummary ? { lastRemoteSummary: snapshot.lastRemoteSummary } : {}),
      ...(snapshot.lastComparison ? { lastComparison: snapshot.lastComparison } : {}),
      ...(snapshot.lastSyncReport ? { lastSyncReport: snapshot.lastSyncReport } : {}),
      fileStates: snapshot.fileStates,
    };
    writeJsonFileAtomic(filePath, stringifyDeterministic(payload), {
      validateParsed: isPlainRecordObject,
    });
  } catch {
    /* opsiyonel adım: hata ana akışı etkilemez */
  }
}

/**
 * Aşama 2 (B-10): Önceki süreç `syncing` durumunda çöktüyse dosya durumu
 * sonsuza dek "gönderiliyor" görünmemeli. Kayıt `pending`e çevrilir ve
 * kesinti açıkça raporlanır; hiçbir iş başarılı sayılmaz.
 */
export function recoverInterruptedFileStates(
  fileStates: Record<string, SyncFileStateRecord>,
  nowIso: string
): { fileStates: Record<string, SyncFileStateRecord>; recovered: string[] } {
  const next = { ...fileStates };
  const recovered: string[] = [];
  for (const [repoPath, state] of Object.entries(fileStates)) {
    if (!state || state.status !== 'syncing') continue;
    next[repoPath] = {
      ...state,
      status: 'pending',
      statusLabel: STAGE_LABELS.pending,
      noop: false,
      error: 'Kesinti: önceki süreçte yarıda kaldı; sonraki senkronizasyonda yeniden denenecek.',
      errorCategory: 'network_error',
      updatedAt: nowIso,
    };
    recovered.push(repoPath);
  }
  return { fileStates: next, recovered };
}
