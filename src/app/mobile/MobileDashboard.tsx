import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BookmarkPlus,
  ChevronDown,
  ChevronUp,
  Compass,
  Eye,
  EyeOff,
  Film,
  Library,
  Pencil,
  Plus,
  Sparkles,
  Tv,
} from 'lucide-react';
import { TAXONOMY_V01 } from '../../core/taste/taxonomy.ts';
import {
  getCategoryDisplayLabel,
  getMetricDisplayTitle,
  getStatusLabelTr,
  resolveEffectiveMetricView,
} from '../../core/taste/metric-labels.ts';
import { useTasteProfile } from '../../hooks/useTasteProfile.ts';
import {
  calculateItemWatchMinutes,
  displayTitle,
  getPoster,
  getTvShowEpisodesCount,
} from '../../utils/helpers.ts';
import type { SavedItem } from '../../core/cinetrack-core.ts';
import { makeMediaKey } from '../../core/cinetrack-core.ts';
import type { MainTab } from '../MobileTabBar.tsx';
import { HeroCard, type HeroCardItem } from '../../design-system/cards/HeroCard.tsx';
import { StackDeck, type StackDeckEntry } from '../../design-system/cards/StackDeck.tsx';
import { ProgressCard } from '../../design-system/cards/ProgressCard.tsx';
import { MetricCard } from '../../design-system/cards/MetricCard.tsx';
import { DiscoveryCard } from '../../design-system/cards/DiscoveryCard.tsx';
import { RelationshipCard } from '../../design-system/cards/RelationshipCard.tsx';
import { MOOD_PILLS } from '../../components/MoodPillsBar.tsx';

export interface MobileDashboardProps {
  profileName: string;
  /** Kişiselleştirme anahtarı (profil bazlı). */
  personalizationKey?: string;
  heroItem: HeroCardItem | null;
  heroMatch?: number;
  heroSaved?: boolean;
  isLoading?: boolean;
  savedItems: SavedItem[];
  recommendations: HeroCardItem[];
  reasons?: Map<string, string> | null;
  genresMap: Record<number, string>;
  universeCount?: number;
  /** Aktif ruh hali filtresi (preferences.mood). */
  mood?: string;
  onMoodChange?: (mood: string) => void;
  onOpenItem: (item: HeroCardItem) => void;
  onQuickSave: (item: HeroCardItem) => void;
  onIncrementEpisode?: (item: SavedItem) => void;
  onNavigate: (tab: MainTab) => void;
  onOpenIdentity: () => void;
}

type SectionId = 'continue' | 'deck' | 'discovery' | 'metrics' | 'taste' | 'universes';

const DEFAULT_ORDER: SectionId[] = ['continue', 'deck', 'discovery', 'metrics', 'taste', 'universes'];

const SECTION_LABELS: Record<SectionId, string> = {
  continue: 'İzlemeye devam et',
  deck: 'Sana özel destesi',
  discovery: 'Keşif rafı',
  metrics: 'Arşiv metrikleri',
  taste: 'Zevk DNA',
  universes: 'Evrenler',
};

interface DashboardLayout {
  order: SectionId[];
  hidden: SectionId[];
}

const DEFAULT_LAYOUT: DashboardLayout = { order: DEFAULT_ORDER, hidden: [] };

function readLayout(key: string): DashboardLayout {
  try {
    const raw = localStorage.getItem(`ct:mobile-dashboard:${key}`);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<DashboardLayout>;
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((id): id is SectionId => DEFAULT_ORDER.includes(id as SectionId))
      : [];
    const hidden = Array.isArray(parsed.hidden)
      ? parsed.hidden.filter((id): id is SectionId => DEFAULT_ORDER.includes(id as SectionId))
      : [];
    return {
      order: [...order, ...DEFAULT_ORDER.filter((id) => !order.includes(id))],
      hidden,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function watchingPercent(item: SavedItem): number {
  if (item.status === 'completed') return 100;
  const total = Number(item.number_of_episodes) || 0;
  const watched = getTvShowEpisodesCount(item);
  if (item.media_type === 'tv' && total > 0) {
    return Math.min(100, Math.round((watched / total) * 100));
  }
  if (item.media_type === 'tv' && watched > 0) return 60;
  return item.status === 'watching' ? 35 : 10;
}

function watchingDetail(item: SavedItem): string {
  if (item.media_type === 'tv') {
    const watched = getTvShowEpisodesCount(item);
    const total = Number(item.number_of_episodes) || 0;
    return total > 0 ? `${watched} / ${total} bölüm` : `${watched} bölüm izlendi`;
  }
  return item.status === 'completed' ? 'Tamamlandı' : 'Film · izlemeye devam';
}

/**
 * Mobil ana ekran — dinamik kart dashboard'u.
 * Bölümler düzenlenebilir: gizle/göster + yukarı/aşağı taşı, profil bazında yerelde saklanır.
 */
export const MobileDashboard: React.FC<MobileDashboardProps> = ({
  profileName,
  personalizationKey = 'default',
  heroItem,
  heroMatch,
  heroSaved = false,
  isLoading = false,
  savedItems,
  recommendations,
  reasons,
  genresMap,
  universeCount = 0,
  mood = '',
  onMoodChange,
  onOpenItem,
  onQuickSave,
  onIncrementEpisode,
  onNavigate,
  onOpenIdentity,
}) => {
  const { profile } = useTasteProfile();
  const [editing, setEditing] = useState(false);
  const [layout, setLayout] = useState<DashboardLayout>(() => readLayout(personalizationKey));

  useEffect(() => {
    setLayout(readLayout(personalizationKey));
  }, [personalizationKey]);

  const persist = useCallback(
    (next: DashboardLayout) => {
      setLayout(next);
      try {
        localStorage.setItem(`ct:mobile-dashboard:${personalizationKey}`, JSON.stringify(next));
      } catch {
        /* depolama kapalıysa düzen yalnızca bu oturumda geçerli */
      }
    },
    [personalizationKey]
  );

  const toggleHidden = (id: SectionId) => {
    const hidden = layout.hidden.includes(id)
      ? layout.hidden.filter((entry) => entry !== id)
      : [...layout.hidden, id];
    persist({ ...layout, hidden });
  };

  const move = (id: SectionId, direction: -1 | 1) => {
    const index = layout.order.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= layout.order.length) return;
    const order = [...layout.order];
    [order[index], order[target]] = [order[target], order[index]];
    persist({ ...layout, order });
  };

  const stats = useMemo(() => {
    let movies = 0;
    let tv = 0;
    let completed = 0;
    let minutes = 0;
    for (const item of savedItems) {
      if (item.media_type === 'tv') tv += 1;
      else movies += 1;
      if (item.status === 'completed') completed += 1;
      minutes += calculateItemWatchMinutes(item);
    }
    return { movies, tv, completed, hours: Math.round(minutes / 60) };
  }, [savedItems]);

  const continueWatching = useMemo(
    () => savedItems.filter((item) => item.status === 'watching').slice(0, 6),
    [savedItems]
  );

  const tasteSignals = useMemo(() => {
    const scored = TAXONOMY_V01.filter((def) => def.scoringEnabled);
    return scored
      .map((def) => {
        const view = resolveEffectiveMetricView(profile?.metrics?.[def.id] ?? null);
        return {
          id: def.id,
          title: getMetricDisplayTitle(def.id),
          category: getCategoryDisplayLabel(def.categoryId),
          status: getStatusLabelTr(view.effectiveStatus),
          state: view.effectiveStatus,
          value: Math.round(view.effectiveAffinity * 100),
        };
      })
      .filter((row) => row.state === 'directional' || row.state === 'neutral' || row.state === 'mixed')
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, 4);
  }, [profile]);

  const deckEntries = useMemo<StackDeckEntry[]>(
    () =>
      recommendations.slice(0, 6).map((item) => ({
        item,
        reason: reasons?.get(makeMediaKey(item)) || undefined,
      })),
    [recommendations, reasons]
  );

  const discoveryItems = useMemo(() => recommendations.slice(6, 14), [recommendations]);

  const sections: Record<SectionId, React.ReactNode> = {
    continue: (
      <section className="mobile-section" aria-labelledby="mobileContinueTitle">
        <div className="mobile-section-head">
          <h2 id="mobileContinueTitle" className="mobile-section-title">
            İzlemeye devam et
          </h2>
          <button type="button" className="mobile-section-link" onClick={() => onNavigate('list')}>
            Tümü
          </button>
        </div>
        {continueWatching.length === 0 ? (
          <div className="mobile-empty-card">
            <Plus className="ct-icon" aria-hidden="true" />
            <div>
              <p className="mobile-empty-title">Henüz izlemeye başladığın bir yapım yok</p>
              <p className="mobile-empty-text">
                Listene eklediğin diziler burada ilerlemesiyle görünür.
              </p>
            </div>
            <button
              type="button"
              className="ct-btn ct-btn--ghost ct-btn--sm"
              onClick={() => onNavigate('discover')}
            >
              Keşfet
            </button>
          </div>
        ) : (
          <div className="mobile-rail">
            {continueWatching.map((item) => (
              <div key={makeMediaKey(item)} className="mobile-rail-item">
                <ProgressCard
                  title={displayTitle(item)}
                  poster={getPoster(item, 'w342')}
                  detail={watchingDetail(item)}
                  percent={watchingPercent(item)}
                  onOpen={() => onOpenItem(item)}
                  onIncrement={
                    item.media_type === 'tv' && onIncrementEpisode
                      ? () => onIncrementEpisode(item)
                      : undefined
                  }
                />
              </div>
            ))}
          </div>
        )}
      </section>
    ),
    deck: (
      <section className="mobile-section" aria-labelledby="mobileDeckTitle">
        <div className="mobile-section-head">
          <h2 id="mobileDeckTitle" className="mobile-section-title">
            Sana özel
          </h2>
          <button type="button" className="mobile-section-link" onClick={() => onNavigate('discover')}>
            Tümü
          </button>
        </div>
        {onMoodChange && (
          <div className="mobile-mood-rail" role="group" aria-label="Ruh hali filtresi">
            {MOOD_PILLS.map((option) => {
              const isActive = mood === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`mobile-mood-chip ${isActive ? 'is-active' : ''}`}
                  aria-pressed={isActive}
                  onClick={() => onMoodChange(isActive ? '' : option.id)}
                  title={option.description}
                >
                  <span aria-hidden="true">{option.icon}</span>
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>
        )}
        <StackDeck
          entries={deckEntries}
          onOpen={onOpenItem}
          onQuickSave={onQuickSave}
          emptyLabel="Sana özel öneriler hazırlanıyor…"
        />
      </section>
    ),
    discovery:
      discoveryItems.length === 0 ? null : (
        <section className="mobile-section" aria-labelledby="mobileDiscoveryTitle">
          <h2 id="mobileDiscoveryTitle" className="mobile-section-title">
            Keşif rafı
          </h2>
          <div className="mobile-rail">
            {discoveryItems.map((item) => (
              <div key={makeMediaKey(item)} className="mobile-rail-item mobile-rail-item--poster">
                <DiscoveryCard
                  item={item}
                  reason={reasons?.get(makeMediaKey(item))}
                  onOpen={() => onOpenItem(item)}
                  onQuickSave={() => onQuickSave(item)}
                />
              </div>
            ))}
          </div>
        </section>
      ),
    metrics: (
      <section className="mobile-section" aria-labelledby="mobileMetricsTitle">
        <h2 id="mobileMetricsTitle" className="mobile-section-title">
          Arşiv metrikleri
        </h2>
        <div className="mobile-metric-grid">
          <MetricCard
            label="Film"
            value={String(stats.movies)}
            hint="arşivdeki film"
            tone="gold"
            icon={<Film className="ct-icon" />}
          />
          <MetricCard
            label="Dizi"
            value={String(stats.tv)}
            hint="arşivdeki dizi"
            tone="teal"
            icon={<Tv className="ct-icon" />}
          />
          <MetricCard
            label="Tamamlanan"
            value={String(stats.completed)}
            hint="bitirilen yapım"
            tone="violet"
            progress={
              stats.movies + stats.tv > 0
                ? (stats.completed / (stats.movies + stats.tv)) * 100
                : 0
            }
          />
          <MetricCard
            label="İzleme süresi"
            value={`${stats.hours} sa`}
            hint="tahmini toplam"
            tone="amber"
          />
        </div>
      </section>
    ),
    taste: (
      <section className="mobile-section" aria-labelledby="mobileTasteTitle">
        <div className="mobile-section-head">
          <h2 id="mobileTasteTitle" className="mobile-section-title">
            Zevk DNA
          </h2>
          <button type="button" className="mobile-section-link" onClick={onOpenIdentity}>
            Detay
          </button>
        </div>
        {tasteSignals.length === 0 ? (
          <p className="mobile-empty-text">
            Yeterli sinyal oluşmadı. Birkaç yapımı tamamlayıp puanladığında zevk DNA’n burada
            belirir.
          </p>
        ) : (
          <div className="mobile-taste-grid">
            {tasteSignals.map((signal) => (
              <article key={signal.id} className="mobile-taste-card">
                <span className="mobile-taste-label">{signal.title}</span>
                <strong className="mobile-taste-value tabular-nums">{signal.value}</strong>
                <span className="mobile-taste-track" aria-hidden="true">
                  <span
                    className={signal.value < 0 ? 'is-negative' : ''}
                    style={{ width: `${Math.max(6, Math.min(100, Math.abs(signal.value)))}%` }}
                  />
                </span>
                <span className="mobile-taste-meta">
                  {signal.category} · {signal.status}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
    ),
    universes: (
      <section className="mobile-section">
        <RelationshipCard
          title="Evrenler"
          subtitle={`${universeCount} bağlı evren · ilişki haritası`}
          meta="Ortak kavram, atmosfer ve ekip eşleşmeleri"
          confidenceLabel="Canlı grafik"
          onOpen={() => onNavigate('relationships')}
        />
      </section>
    ),
  };

  const visibleSections = layout.order.filter(
    (id) => sections[id] !== null && (editing || !layout.hidden.includes(id))
  );

  return (
    <div className="mobile-dashboard">
      <HeroCard
        item={heroItem}
        genres={genresMap}
        matchScore={heroMatch}
        isSaved={heroSaved}
        isLoading={isLoading && !heroItem}
        onOpen={() => heroItem && onOpenItem(heroItem)}
        onQuickSave={heroItem ? () => onQuickSave(heroItem) : undefined}
      />

      <section className="mobile-section" aria-labelledby="mobileQuickTitle">
        <h2 id="mobileQuickTitle" className="mobile-section-title">
          Hızlı erişim
        </h2>
        <div className="mobile-quick-actions">
          <button type="button" className="mobile-quick" onClick={() => onNavigate('list')}>
            <span className="mobile-quick-icon">
              <Library className="ct-icon" aria-hidden="true" />
            </span>
            <span>Kütüphane</span>
          </button>
          <button type="button" className="mobile-quick" onClick={() => onNavigate('discover')}>
            <span className="mobile-quick-icon">
              <Compass className="ct-icon" aria-hidden="true" />
            </span>
            <span>Keşfet</span>
          </button>
          <button type="button" className="mobile-quick" onClick={() => onNavigate('taste-map')}>
            <span className="mobile-quick-icon">
              <Sparkles className="ct-icon" aria-hidden="true" />
            </span>
            <span>Zevkim</span>
          </button>
          <button type="button" className="mobile-quick" onClick={onOpenIdentity}>
            <span className="mobile-quick-icon">
              <BookmarkPlus className="ct-icon" aria-hidden="true" />
            </span>
            <span>Kimliğim</span>
          </button>
        </div>
      </section>

      <div className="mobile-dashboard-toolbar">
        <button
          type="button"
          className={`mobile-edit-btn ${editing ? 'is-active' : ''}`}
          onClick={() => setEditing((prev) => !prev)}
          aria-pressed={editing}
        >
          <Pencil className="ct-icon" aria-hidden="true" />
          <span>{editing ? 'Düzenlemeyi bitir' : 'Dashboard’u düzenle'}</span>
        </button>
      </div>

      {editing && (
        <div className="mobile-edit-panel" role="group" aria-label="Dashboard bölümlerini düzenle">
          <p className="mobile-edit-hint">
            Bölümleri gizle/göster ve sırala. Düzen bu profil için cihazda saklanır.
          </p>
          <ul className="mobile-edit-list">
            {layout.order.map((id, index) => {
              const hidden = layout.hidden.includes(id);
              return (
                <li key={id} className={`mobile-edit-row ${hidden ? 'is-hidden' : ''}`}>
                  <span className="mobile-edit-name">{SECTION_LABELS[id]}</span>
                  <span className="mobile-edit-actions">
                    <button
                      type="button"
                      className="mobile-edit-icon"
                      onClick={() => move(id, -1)}
                      disabled={index === 0}
                      aria-label={`${SECTION_LABELS[id]} bölümünü yukarı taşı`}
                    >
                      <ChevronUp className="ct-icon" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="mobile-edit-icon"
                      onClick={() => move(id, 1)}
                      disabled={index === layout.order.length - 1}
                      aria-label={`${SECTION_LABELS[id]} bölümünü aşağı taşı`}
                    >
                      <ChevronDown className="ct-icon" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="mobile-edit-icon"
                      onClick={() => toggleHidden(id)}
                      aria-pressed={!hidden}
                      aria-label={`${SECTION_LABELS[id]} bölümünü ${hidden ? 'göster' : 'gizle'}`}
                    >
                      {hidden ? (
                        <EyeOff className="ct-icon" aria-hidden="true" />
                      ) : (
                        <Eye className="ct-icon" aria-hidden="true" />
                      )}
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {visibleSections.map((id) => (
        <React.Fragment key={id}>{sections[id]}</React.Fragment>
      ))}

      <p className="mobile-dashboard-footnote">
        {profileName} profili · kartlar mevcut arşiv ve zevk motorundan beslenir
      </p>
    </div>
  );
};

export default MobileDashboard;
