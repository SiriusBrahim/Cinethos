import React, { useRef } from 'react';
import { useDialogAccessibility } from '../hooks/useDialogAccessibility.ts';
import type {
  SqliteArchiveInspect,
  SqliteArchivePrepareResult,
} from '../services/api.ts';

interface ArchiveRestorePreviewModalProps {
  open: boolean;
  fileName: string;
  inspect: SqliteArchiveInspect | null;
  current: SqliteArchivePrepareResult['current'];
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function formatDate(raw: string): string {
  if (!raw) return '—';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('tr-TR');
}

/**
 * P1-04: SQLite arşivi geri yüklenmeden önce içeriği gösterir ve açık onay ister.
 * Dosya seçmek tek başına hiçbir veriyi değiştirmez.
 */
export const ArchiveRestorePreviewModal: React.FC<ArchiveRestorePreviewModalProps> = ({
  open,
  fileName,
  inspect,
  current,
  busy = false,
  onConfirm,
  onCancel,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useDialogAccessibility({
    open,
    containerRef: dialogRef,
    initialFocusRef: confirmRef,
    onClose: busy ? undefined : onCancel,
    closeOnEscape: !busy,
  });

  if (!open || !inspect) return null;

  const currentProfiles = current?.counts.profiles ?? 0;
  const currentItems = current?.counts.items ?? 0;
  const profileDelta = inspect.counts.profiles - currentProfiles;
  const itemDelta = inspect.counts.items - currentItems;

  return (
    <div className="auth-token-overlay">
      <div
        ref={dialogRef}
        className="auth-token-card archive-preview-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="archivePreviewTitle"
        aria-describedby="archivePreviewDesc"
      >
        <h2 id="archivePreviewTitle">Arşivi geri yüklemeden önce kontrol edin</h2>
        <p id="archivePreviewDesc" className="archive-preview-lead">
          <strong>{fileName}</strong> içeriği okundu. Onaylamadan hiçbir veri değişmez.
        </p>

        <dl className="archive-preview-grid">
          <div>
            <dt>Arşiv tarihi</dt>
            <dd>{formatDate(inspect.createdAt)}</dd>
          </div>
          <div>
            <dt>Şema sürümü</dt>
            <dd>v{inspect.schemaVersion}</dd>
          </div>
          <div>
            <dt>Profil</dt>
            <dd>
              {inspect.counts.profiles}
              <span className="archive-preview-delta">
                {' '}
                (mevcut {currentProfiles}
                {profileDelta !== 0 ? `, ${profileDelta > 0 ? '+' : ''}${profileDelta}` : ''})
              </span>
            </dd>
          </div>
          <div>
            <dt>Kayıt</dt>
            <dd>
              {inspect.counts.items}
              <span className="archive-preview-delta">
                {' '}
                (mevcut {currentItems}
                {itemDelta !== 0 ? `, ${itemDelta > 0 ? '+' : ''}${itemDelta}` : ''})
              </span>
            </dd>
          </div>
          <div>
            <dt>Stok</dt>
            <dd>
              {inspect.counts.stockMovies} film · {inspect.counts.stockTv} dizi
            </dd>
          </div>
          <div>
            <dt>Zevk haritası</dt>
            <dd>{inspect.counts.tasteMaps}</dd>
          </div>
          <div>
            <dt>Poster</dt>
            <dd>{inspect.counts.posters}</dd>
          </div>
          <div>
            <dt>Dosya</dt>
            <dd>{formatBytes(inspect.byteLength)}</dd>
          </div>
        </dl>

        <details className="archive-preview-profiles">
          <summary>Profilleri göster ({inspect.profiles.length})</summary>
          <ul>
            {inspect.profiles.map((profile) => (
              <li key={profile.id}>
                {profile.name} — {profile.items} kayıt
              </li>
            ))}
          </ul>
        </details>

        <p className="archive-preview-warning">
          Bu işlem mevcut profillerin, stok kayıtlarının ve zevk haritalarının üzerine yazar.
          Sunucu önceki belgenin anlık kopyasını alır; istemci yan verileri yazamazsa her iki
          taraf da geri alınır. İçerik özeti: <code>{inspect.documentHash.slice(0, 16)}…</code>
        </p>

        <div className="auth-token-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Vazgeç
          </button>
          <button
            type="button"
            ref={confirmRef}
            className="btn btn-primary"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Geri yükleniyor…' : 'Üzerine yaz ve geri yükle'}
          </button>
        </div>
      </div>
    </div>
  );
};
