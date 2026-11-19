/**
 * MIA Faz 6 — Discover state boundary.
 *
 * The Discover module owns its filters, catalog pages, recommendation results,
 * loading flags and request gate. App remains the shell/composition root and
 * supplies profile, navigation and service dependencies.
 */
import { useRef, useState } from 'react';
import { createRequestGate } from '../../core/cinetrack-core.ts';

export function useDiscoverState(options: { initialHideListedItems?: () => boolean } = {}) {
  const [category, setCategory] = useState<string>('trending');
  const [forYouSubTab, setForYouSubTab] = useState<'recommendations' | 'series'>('recommendations');
  const [selectedGenre, setSelectedGenre] = useState<string>('');
  const [selectedType, setSelectedType] = useState<string>('all');
  const [selectedSort, setSelectedSort] = useState<string>('popular');
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [hideListedItems, setHideListedItems] = useState<boolean>(
    options.initialHideListedItems ?? (() => false)
  );
  const [genresMap, setGenresMap] = useState<Record<number, string>>({});
  const [catalogItems, setCatalogItems] = useState<any[]>([]);
  const [trendingTop, setTrendingTop] = useState<any | null>(null);
  const [catalogPage, setCatalogPage] = useState<number>(1);
  const [catalogTotalPages, setCatalogTotalPages] = useState<number>(1);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [forYouItems, setForYouItems] = useState<any[]>([]);
  const [forYouReasons, setForYouReasons] = useState<Map<string, string>>(new Map());
  const [forYouExplanation, setForYouExplanation] = useState<string>('');
  const [forYouProgressStep, setForYouProgressStep] = useState<string>('');
  const requestGateRef = useRef(createRequestGate());

  return {
    category, setCategory,
    forYouSubTab, setForYouSubTab,
    selectedGenre, setSelectedGenre,
    selectedType, setSelectedType,
    selectedSort, setSelectedSort,
    selectedProvider, setSelectedProvider,
    hideListedItems, setHideListedItems,
    genresMap, setGenresMap,
    catalogItems, setCatalogItems,
    trendingTop, setTrendingTop,
    catalogPage, setCatalogPage,
    catalogTotalPages, setCatalogTotalPages,
    isLoading, setIsLoading,
    loadingMore, setLoadingMore,
    forYouItems, setForYouItems,
    forYouReasons, setForYouReasons,
    forYouExplanation, setForYouExplanation,
    forYouProgressStep, setForYouProgressStep,
    requestGateRef,
  };
}
