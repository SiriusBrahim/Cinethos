import React from 'react';
import { BookmarkPlus, Play, Star } from 'lucide-react';
import { displayTitle, getPoster, imageUrl } from '../../utils/helpers.ts';

export interface HeroCardItem {
  id: number | string;
  media_type?: string;
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  overview?: string;
  poster_path?: string;
  poster_url?: string;
  backdrop_path?: string;
  vote_average?: number;
}

interface HeroCardProps {
  item: HeroCardItem | null;
  genres?: Record<number, string>;
  matchScore?: number;
  isWatching?: boolean;
  isSaved?: boolean;
  isLoading?: boolean;
  onOpen: () => void;
  onQuickSave?: () => void;
}

/**
 * Hero Card — mobil dashboard'un ana sinema kartı.
 * Büyük arka plan görseli + degrade + başlık/meta + iki ana aksiyon.
 */
export const HeroCard: React.FC<HeroCardProps> = ({
  item,
  genres = {},
  matchScore,
  isWatching = false,
  isSaved = false,
  isLoading = false,
  onOpen,
  onQuickSave,
}) => {
  if (isLoading || !item) {
    return (
      <div className="ct-hero ct-hero--skeleton" aria-hidden="true">
        <div className="ct-hero-skeleton-media" />
        <div className="ct-hero-skeleton-lines">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }

  const title = displayTitle(item);
  const year = (item.release_date || item.first_air_date || '').slice(0, 4);
  const genreName = item.genre_ids?.length ? genres[item.genre_ids[0]] : undefined;
  const backdrop = imageUrl(item.backdrop_path, 'w780') || getPoster(item, 'w780');
  const mediaLabel = item.media_type === 'tv' ? 'Dizi' : 'Film';

  return (
    <article className="ct-hero">
      <div className="ct-hero-media">
        {backdrop ? (
          <img src={backdrop} alt="" loading="lazy" decoding="async" />
        ) : (
          <div className="ct-hero-media-fallback" aria-hidden="true" />
        )}
        <span className="ct-hero-scrim" aria-hidden="true" />
      </div>

      <div className="ct-hero-body">
        <span className="ct-hero-eyebrow">
          {isWatching ? 'İZLEMEYE DEVAM ET' : 'BUGÜN NE İZLESEK?'}
        </span>
        <h2 className="ct-hero-title">{title}</h2>
        <div className="ct-hero-meta">
          <span>{mediaLabel}</span>
          {year && <span>· {year}</span>}
          {genreName && <span>· {genreName}</span>}
          <span className="ct-hero-rating">
            <Star className="ct-icon" aria-hidden="true" />
            {Number(item.vote_average || 0).toFixed(1)}
          </span>
        </div>

        {typeof matchScore === 'number' && matchScore > 0 && (
          <div className="ct-hero-match">
            <span className="ct-hero-match-value tabular-nums">%{Math.round(matchScore)}</span>
            <span className="ct-hero-match-label">Zevk uyumu</span>
            <span className="ct-hero-match-track" aria-hidden="true">
              <span style={{ width: `${Math.min(100, Math.max(4, matchScore))}%` }} />
            </span>
          </div>
        )}

        <div className="ct-hero-actions">
          <button type="button" className="ct-btn ct-btn--primary" onClick={onOpen}>
            <Play className="ct-icon" aria-hidden="true" />
            <span>İncele</span>
          </button>
          {onQuickSave && (
            <button
              type="button"
              className="ct-btn ct-btn--ghost"
              onClick={onQuickSave}
              aria-pressed={isSaved}
            >
              <BookmarkPlus className="ct-icon" aria-hidden="true" />
              <span>{isSaved ? 'Listemde' : 'Listeme Ekle'}</span>
            </button>
          )}
        </div>
      </div>
    </article>
  );
};
