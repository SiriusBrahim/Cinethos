import React from 'react';
import { ErrorBoundary } from '../../components/ErrorBoundary.tsx';
import { RelationshipExplorer } from '../../components/RelationshipExplorer.tsx';
import type {
  FavoriteActorInfo,
  PoolCandidateItem,
  Preferences,
  SavedItem,
} from '../../core/cinetrack-core.ts';
import type { MediaFilter } from '../../core/relationship-semantics.ts';
import { useShell } from '../../app/shell-context.tsx';

/**
 * M1 — İlişki Keşfi modül bölümü.
 *
 * Veri girişleri kabuktan gelir; detay/hızlı kaydetme eylemleri `useShell()` ile
 * çözümlenir. Bileşen, profil değişiminde `key` ile sıfırdan monte edilir.
 */
export interface RelationshipsSectionProps {
  profileId: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors?: FavoriteActorInfo[];
  genreNames: Record<number, string>;
  onRefresh: (mediaFilter: MediaFilter) => Promise<PoolCandidateItem[]>;
  initialSourceKey: string;
}

export const RelationshipsSection: React.FC<RelationshipsSectionProps> = ({
  profileId,
  savedItems,
  preferences,
  favoriteActors,
  genreNames,
  onRefresh,
  initialSourceKey,
}) => {
  const shell = useShell();

  return (
    <ErrorBoundary sectionName="İlişki Keşfi">
      <React.Suspense
        fallback={
          <div className="lazy-tab-fallback" role="status">
            İlişki Keşfi görünümü yükleniyor…
          </div>
        }
      >
        <RelationshipExplorer
          key={`${profileId}-relationships`}
          mode="relationships"
          profileId={profileId}
          savedItems={savedItems}
          preferences={preferences}
          candidates={[]}
          favoriteActors={favoriteActors}
          genreNames={genreNames}
          onRefresh={onRefresh}
          onOpenDetails={(item) => shell.openDetails(item as SavedItem)}
          onQuickSave={(item) => shell.openQuickSave(item as SavedItem)}
          initialSourceKey={initialSourceKey}
        />
      </React.Suspense>
    </ErrorBoundary>
  );
};

export default RelationshipsSection;
