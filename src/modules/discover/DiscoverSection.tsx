/**
 * M1 — Keşfet modülü bölümü.
 *
 * Keşfet sekmesinin sunum katmanı: Hero (arama boşken) + filtre çubuğu
 * (kabukten slot) + ortak MediaGrid. Veri çekme/seçim mantığı yöneticide (App);
 * bir sonraki adımda katalog mantığı `useCatalog` kancasına taşınacaktır.
 */
import React from 'react';
import { Hero } from '../../components/Hero.tsx';
import { MediaGrid } from '../../components/MediaGrid.tsx';
import { ErrorBoundary } from '../../components/ErrorBoundary.tsx';

type HeroProps = React.ComponentProps<typeof Hero>;
type MediaGridProps = React.ComponentProps<typeof MediaGrid>;

export interface DiscoverSectionProps {
  /** Arama sorgusu; doluyken Hero gizlenir. */
  query: string;
  heroItem: HeroProps['heroItem'];
  featuredItems: HeroProps['featuredItems'];
  isWatching: boolean;
  onOpenDetails: (item: any) => void;
  /** Filtre çubuğu (Controls) — kabuk tarafından slot olarak verilir. */
  controls: React.ReactNode;
  /** Ortak MediaGrid propları. */
  grid: MediaGridProps;
}

/**
 * Keşfet bölümü — Hero + Controls + MediaGrid bileşimi.
 * Hem adlı hem varsayılan dışa aktarma sağlanır (lazyWithRetry uyumu).
 */
export const DiscoverSection: React.FC<DiscoverSectionProps> = ({
  query,
  heroItem,
  featuredItems,
  isWatching,
  onOpenDetails,
  controls,
  grid,
}) => {
  return (
    <>
      {!query && (
        <Hero
          heroItem={heroItem}
          featuredItems={featuredItems}
          isWatching={isWatching}
          onOpenDetails={onOpenDetails}
        />
      )}

      {controls}

      <ErrorBoundary sectionName="Katalog ve Listem">
        <MediaGrid {...grid} />
      </ErrorBoundary>
    </>
  );
};

export default DiscoverSection;
