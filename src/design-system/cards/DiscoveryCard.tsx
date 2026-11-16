import React from 'react';
import { BookmarkPlus } from 'lucide-react';
import { displayTitle, getPoster } from '../../utils/helpers.ts';
import type { HeroCardItem } from './HeroCard.tsx';

interface DiscoveryCardProps {
  item: HeroCardItem;
  reason?: string;
  matchScore?: number;
  onOpen: () => void;
  onQuickSave?: () => void;
}

/** Discovery Card — yatay raflarda kullanılan kompakt keşif kartı. */
export const DiscoveryCard: React.FC<DiscoveryCardProps> = ({
  item,
  reason,
  matchScore,
  onOpen,
  onQuickSave,
}) => {
  const poster = getPoster(item, 'w342');
  const title = displayTitle(item);

  return (
    <article className="ct-discovery">
      <button type="button" className="ct-discovery-hit" onClick={onOpen}>
        <span className="ct-discovery-poster">
          {poster ? (
            <img src={poster} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="ct-discovery-poster-fallback" aria-hidden="true" />
          )}
          {typeof matchScore === 'number' && matchScore > 0 && (
            <span className="ct-discovery-score tabular-nums">%{Math.round(matchScore)}</span>
          )}
        </span>
        <span className="ct-discovery-title">{title}</span>
        {reason && <span className="ct-discovery-reason">{reason}</span>}
      </button>
      {onQuickSave && (
        <button
          type="button"
          className="ct-discovery-save"
          onClick={onQuickSave}
          aria-label={`${title} listeme ekle`}
        >
          <BookmarkPlus className="ct-icon" aria-hidden="true" />
        </button>
      )}
    </article>
  );
};
