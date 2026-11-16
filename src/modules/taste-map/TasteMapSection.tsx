import React from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary.tsx';
import { TasteMapView } from '../../components/TasteMapView.tsx';
import { lazyWithRetry } from '../../app/lazy-with-retry.ts';
import type {
  PersistentTasteMapData,
  TasteProfileSummary,
} from '../../core/cinethos-core.ts';
import type { SavedItem } from '../../core/cinethos-core.ts';
import { useShell } from '../../app/shell-context.tsx';

// Kod bölünmesi korunur: dashboard/minimal görünümleri kendi chunk'larında kalır.
const TasteProfileDashboard = lazyWithRetry(
  () => import('../../components/taste/TasteProfileDashboard.tsx')
);
const TasteProfileMinimal = lazyWithRetry(
  () => import('../../components/taste/TasteProfileMinimal.tsx')
);

/**
 * M1 — Zevkim modül bölümü.
 *
 * Görünüm modu anahtarı (kimlik/poster duvarı) ve veri girişleri kabuktan gelir;
 * detay/hızlı kaydetme/durum eylemleri `useShell()` ile çözümlenir.
 */
export interface TasteMapSectionProps {
  tasteMap: PersistentTasteMapData;
  tasteSummary: TasteProfileSummary | null;
  genresMap: Record<number, string>;
  savedItems: SavedItem[];
  displayMode: 'poster' | 'identity';
  onDisplayModeChange: (mode: 'poster' | 'identity') => void;
  isLoading: boolean;
  isDemo: boolean;
  tmdbSource: string;
  tmdbStaleReason?: string;
  isMobileViewport: boolean;
}

export const TasteMapSection: React.FC<TasteMapSectionProps> = ({
  tasteMap,
  tasteSummary,
  genresMap,
  savedItems,
  displayMode,
  onDisplayModeChange,
  isLoading,
  isDemo,
  tmdbSource,
  tmdbStaleReason,
  isMobileViewport,
}) => {
  const shell = useShell();

  return (
    <div className="taste-map-page">
      <div
        className="taste-map-view-toggle segmented-control"
        role="group"
        aria-label="Zevkim görünüm modu"
      >
        <button
          className={`segmented-btn ${displayMode === 'identity' ? 'active' : ''}`}
          type="button"
          onClick={() => onDisplayModeChange('identity')}
          aria-pressed={displayMode === 'identity'}
        >
          Zevkim
        </button>
        <button
          className={`segmented-btn ${displayMode === 'poster' ? 'active' : ''}`}
          type="button"
          onClick={() => onDisplayModeChange('poster')}
          aria-pressed={displayMode === 'poster'}
        >
          Poster Duvarı
        </button>
      </div>

      <ErrorBoundary sectionName="Zevkim">
        <React.Suspense
          fallback={
            <div className="lazy-tab-fallback" role="status">
              Zevkim yükleniyor…
            </div>
          }
        >
          {displayMode === 'poster' ? (
            <TasteMapView
              tasteMap={tasteMap}
              summary={tasteSummary}
              genresMap={genresMap}
              savedItems={savedItems}
              onOpenDetails={(item) => shell.openDetails(item)}
              onQuickSave={(item) => shell.openQuickSave(item)}
              onSetStatus={(item, status) => shell.setStatus(item, status)}
              onToggleDislike={(key) => shell.toggleDislike(key)}
              onRefreshTasteMap={() => shell.refreshTasteMap()}
              isLoading={isLoading}
              isDemo={isDemo}
              tmdbSource={tmdbSource}
              tmdbStaleReason={tmdbStaleReason}
            />
          ) : isMobileViewport ? (
            <TasteProfileDashboard />
          ) : (
            <TasteProfileMinimal />
          )}
        </React.Suspense>
      </ErrorBoundary>
    </div>
  );
};

export default TasteMapSection;
