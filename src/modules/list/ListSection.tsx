/**
 * M1 — Listem modülü bölümü.
 *
 * Listem sekmesinin sunum katmanı: istatistikler + filtre çubuğu (kabukten
 * slot) + ortak MediaGrid. Veri/filtre mantığı yöneticide (App); bir sonraki
 * adımda katalog mantığı `useCatalog` kancasına taşınacaktır.
 */
import React from 'react';
import { Stats } from '../../components/Stats.tsx';
import { MediaGrid } from '../../components/MediaGrid.tsx';
import { ErrorBoundary } from '../../components/ErrorBoundary.tsx';

type StatsProps = React.ComponentProps<typeof Stats>;
type MediaGridProps = React.ComponentProps<typeof MediaGrid>;

export interface ListSectionProps {
  /** İstatistik bloğu propları (items, profileName, onSelectItem...). */
  stats: StatsProps;
  /** Filtre çubuğu (Controls) — kabuk tarafından slot olarak verilir. */
  controls: React.ReactNode;
  /** Ortak MediaGrid propları. */
  grid: MediaGridProps;
}

/**
 * Listem bölümü — Stats + Controls + MediaGrid bileşimi.
 * Hem adlı hem varsayılan dışa aktarma sağlanır (lazyWithRetry uyumu).
 */
export const ListSection: React.FC<ListSectionProps> = ({ stats, controls, grid }) => {
  return (
    <>
      <Stats {...stats} />

      {controls}

      <ErrorBoundary sectionName="Katalog ve Listem">
        <MediaGrid {...grid} />
      </ErrorBoundary>
    </>
  );
};

export default ListSection;
