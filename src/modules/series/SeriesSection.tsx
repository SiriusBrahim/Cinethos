import React, { useMemo } from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary.tsx';
import { UniversesView } from '../../components/UniversesView.tsx';
import { Badge, Panel, SectionHeader, StatTile } from '../../components/ui/primitives.tsx';
import type {
  FavoriteActorInfo,
  PoolCandidateItem,
  Preferences,
  SavedItem,
} from '../../core/cinetrack-core.ts';
import { computeUserSeriesUniverses } from '../../services/series-service.ts';

/**
 * Seriler ve Evrenler çalışma alanı.
 *
 * Evren grupları gerçek kütüphaneden türetilir: sahip olunan parçalar, eksik
 * parçalar ve izleme sırası `computeUserSeriesUniverses` çıktısından gelir.
 * Detaylı graf/bağlantı görünümü mevcut `UniversesView` modülünü yeniden
 * kullanır (ikinci bir kopya yok).
 */

export interface SeriesSectionProps {
  profileId: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors?: FavoriteActorInfo[];
  genreNames: Record<number, string>;
  onRefresh: (mediaFilter: any) => Promise<PoolCandidateItem[]>;
  onOpenDetails: (item: any) => void;
  onQuickSave: (item: any) => void;
}

export const SeriesSection: React.FC<SeriesSectionProps> = ({
  profileId,
  savedItems,
  preferences,
  favoriteActors,
  genreNames,
  onRefresh,
  onOpenDetails,
  onQuickSave,
}) => {
  const universes = useMemo(() => {
    try {
      return computeUserSeriesUniverses(savedItems, {
        includeStubs: true,
        dislikedKeys: preferences.disliked,
        hiddenKeys: preferences.hidden,
      });
    } catch {
      return [];
    }
  }, [savedItems, preferences.disliked, preferences.hidden]);

  const ownedCount = universes.reduce((sum, universe) => sum + universe.userOwnedParts.length, 0);
  const missingCount = universes.reduce(
    (sum, universe) => sum + universe.userMissingParts.length,
    0
  );

  return (
    <div className="ws-page ws-series">
      <Panel ariaLabel="Seri evrenleri özeti">
        <SectionHeader
          eyebrow="Seriler ve evrenler"
          title="Koleksiyonların ve eksik parçalar"
          description="Sahip olduğun seri parçaları, izleme sırası ve arşivinde eksik kalan yapımlar."
          action={
            missingCount > 0 ? (
              <Badge tone="warn" title="Eksik parça sayısı">
                {missingCount} eksik
              </Badge>
            ) : (
              <Badge tone="ok">Tamam</Badge>
            )
          }
        />
        <div className="ws-stats" role="list" aria-label="Evren istatistikleri">
          <StatTile label="Evren" value={universes.length} />
          <StatTile label="Sahip olunan parça" value={ownedCount} />
          <StatTile label="Eksik parça" value={missingCount} tone={missingCount > 0 ? 'warn' : 'ok'} />
          <StatTile
            label="Kapsam"
            value={
              ownedCount + missingCount > 0
                ? `${Math.round((ownedCount / (ownedCount + missingCount)) * 100)}%`
                : '—'
            }
          />
        </div>

        {universes.length === 0 ? (
          <p className="ws-hint ws-series-hint">
            Kütüphanende bir seriye ait yapım bulunmuyor. Bir film veya dizi eklediğinde ait olduğu
            evren otomatik olarak burada listelenir.
          </p>
        ) : (
          <ul className="ws-universe-list" aria-label="Kullanıcı evrenleri">
            {universes.slice(0, 8).map((universe) => (
              <li key={universe.collectionKey} className="ws-universe-row">
                <div className="ws-universe-copy">
                  <span className="ws-universe-name">{universe.displayName}</span>
                  <span className="ws-universe-meta">
                    {universe.userOwnedParts.length} parça sende ·{' '}
                    {universe.userMissingParts.length} parça eksik
                    {universe.isStub ? ' · kısmi veri' : ''}
                  </span>
                </div>
                <div className="ws-universe-side">
                  {universe.userMissingParts.slice(0, 3).map((part) => (
                    <Badge key={`${part.media_type}:${part.id}`} tone="warn">
                      {part.title || part.name || `#${part.id}`}
                    </Badge>
                  ))}
                  {universe.userMissingParts.length > 3 && (
                    <Badge>+{universe.userMissingParts.length - 3}</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <ErrorBoundary sectionName="Seriler ve Evrenler">
        <UniversesView
          profileId={profileId}
          savedItems={savedItems}
          preferences={preferences}
          favoriteActors={favoriteActors}
          genreNames={genreNames}
          onRefreshGraph={onRefresh}
          onOpenDetails={onOpenDetails}
          onQuickSave={onQuickSave}
        />
      </ErrorBoundary>
    </div>
  );
};

export default SeriesSection;
