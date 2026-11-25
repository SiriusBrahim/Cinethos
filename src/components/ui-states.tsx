import React from 'react';
import { UI_COPY } from '../app/ui-copy.ts';

/**
 * F5.2-01 — Kullanıcıya gösterilen durum/aksiyon yüzeyleri.
 *
 * Bu bileşenler saf sunumdur: durum ve davranışı ebeveynlerinden alırlar.
 * Arayüz metinleri `app/ui-copy.ts` sözleşmesinden gelir; böylece testler
 * kaynak kodu taramak yerine render edilen çıktıyı doğrular.
 */

export interface ErrorRecoveryActionsProps {
  isResettingCaches: boolean;
  copied: boolean;
  onRetry: () => void;
  onResetCachesAndRetry: () => void;
  onCopy: () => void;
}

export function ErrorRecoveryActions({
  isResettingCaches,
  copied,
  onRetry,
  onResetCachesAndRetry,
  onCopy,
}: ErrorRecoveryActionsProps): React.ReactElement {
  return (
    <div className="message-actions error-diagnostic-actions">
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={onRetry}
        disabled={isResettingCaches}
      >
        {UI_COPY.errorBoundary.retry}
      </button>
      <button
        type="button"
        className="btn btn-sm"
        onClick={onResetCachesAndRetry}
        disabled={isResettingCaches}
      >
        {isResettingCaches
          ? UI_COPY.errorBoundary.resettingCaches
          : UI_COPY.errorBoundary.resetCachesAndRetry}
      </button>
      <button type="button" className="btn btn-sm" onClick={onCopy}>
        {copied ? UI_COPY.errorBoundary.copied : UI_COPY.errorBoundary.copyError}
      </button>
    </div>
  );
}

export interface StockPullButtonProps {
  replenishing: boolean;
  disabled?: boolean;
  /** `long` boş durum kartı, `short` araç çubuğu etiketini kullanır. */
  variant?: 'short' | 'long';
  className?: string;
  title?: string;
  onClick: () => void;
}

export function StockPullButton({
  replenishing,
  disabled = false,
  variant = 'short',
  className,
  title,
  onClick,
}: StockPullButtonProps): React.ReactElement {
  const label =
    variant === 'long'
      ? replenishing
        ? UI_COPY.stock.downloadBusy
        : UI_COPY.stock.download
      : replenishing
        ? UI_COPY.stock.pullBusy
        : UI_COPY.stock.pull;

  return (
    <button
      type="button"
      className={className}
      disabled={disabled || replenishing}
      onClick={onClick}
      title={title}
    >
      {label}
    </button>
  );
}

export function MapPreparingNotice(): React.ReactElement {
  return (
    <>
      <strong>{UI_COPY.maps.preparing}</strong>
      <p>
        Aday havuzunuz ve kişisel uyum halkalarınız hesaplanıyor. Bu işlem yalnızca birkaç saniye
        sürer.
      </p>
    </>
  );
}

export interface EmptyLibraryGuideProps {
  onGoDiscover: () => void;
  onOpenAddCustom?: () => void;
}

export function EmptyLibraryGuide({
  onGoDiscover,
  onOpenAddCustom,
}: EmptyLibraryGuideProps): React.ReactElement {
  return (
    <>
      <strong>{UI_COPY.library.emptyTitle}</strong>
      <span>{UI_COPY.library.emptyBody}</span>
      <div className="message-actions">
        <button className="btn btn-primary" type="button" onClick={onGoDiscover}>
          {UI_COPY.library.goDiscover}
        </button>
        {onOpenAddCustom && (
          <button className="btn" type="button" onClick={onOpenAddCustom}>
            Özel içerik ekle
          </button>
        )}
      </div>
    </>
  );
}

export interface DerivedCacheResetControlProps {
  resetting: boolean;
  message?: string;
  onReset: () => void;
}

export function DerivedCacheResetControl({
  resetting,
  message,
  onReset,
}: DerivedCacheResetControlProps): React.ReactElement {
  return (
    <div className="profile-tools-section">
      <strong className="profile-tools-heading">Önbellek Bakımı (Vektör &amp; Harita)</strong>
      <p className="cache-reset-note">
        Zevk vektörü (<code>ct:encodings</code>) ve ilişki haritası önbelleğini temizler. İzleme
        listenize, profil ayarlarınıza ve yerel stok havuzunuza (<code>ct:stock</code>)
        dokunulmaz.
      </p>
      <div className="csv-actions-row">
        <button
          type="button"
          className="btn whitespace-nowrap"
          disabled={resetting}
          onClick={onReset}
        >
          {resetting ? UI_COPY.profile.resettingDerivedCaches : UI_COPY.profile.resetDerivedCaches}
        </button>
      </div>
      {message && <p className="provider-message">{message}</p>}
    </div>
  );
}

export interface ActorsSubtabsBarProps {
  activeSubTab: 'actors' | 'recommendations';
  favoriteCount: number;
  onSubTabChange: (subTab: 'actors' | 'recommendations') => void;
}

export function ActorsSubtabsBar({
  activeSubTab,
  favoriteCount,
  onSubTabChange,
}: ActorsSubtabsBarProps): React.ReactElement {
  return (
    <div className="actors-subtabs-bar" role="tablist" aria-label={UI_COPY.actors.subtabsLabel}>
      <button
        type="button"
        role="tab"
        aria-selected={activeSubTab === 'actors'}
        className={`actors-subtab-btn ${activeSubTab === 'actors' ? 'is-active' : ''}`}
        onClick={() => onSubTabChange('actors')}
      >
        <span>{UI_COPY.actors.actorsTab}</span>{' '}
        <strong className="actors-subtab-count tabular-nums">{favoriteCount}</strong>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeSubTab === 'recommendations'}
        className={`actors-subtab-btn ${activeSubTab === 'recommendations' ? 'is-active' : ''}`}
        onClick={() => onSubTabChange('recommendations')}
      >
        <span>{UI_COPY.actors.recommendationsTab}</span>
      </button>
    </div>
  );
}
