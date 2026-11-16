import React from 'react';
import { Play, Plus } from 'lucide-react';
import { displayTitle, getPoster } from '../../utils/helpers.ts';

interface ProgressCardProps {
  title?: string;
  poster?: string;
  detail?: string;
  percent: number;
  onOpen: () => void;
  onIncrement?: () => void;
}

/** Progress Card — yarım kalan film/dizi için ilerleme kartı. */
export const ProgressCard: React.FC<ProgressCardProps> = ({
  title,
  poster,
  detail,
  percent,
  onOpen,
  onIncrement,
}) => {
  const clamped = Math.min(100, Math.max(0, Math.round(percent)));

  return (
    <article className="ct-progress">
      <button type="button" className="ct-progress-hit" onClick={onOpen}>
        <span className="ct-progress-poster">
          {poster ? (
            <img src={poster} alt="" loading="lazy" decoding="async" />
          ) : (
            <span className="ct-progress-poster-fallback" aria-hidden="true" />
          )}
        </span>
        <span className="ct-progress-body">
          <span className="ct-progress-title">{title}</span>
          {detail && <span className="ct-progress-detail">{detail}</span>}
          <span className="ct-progress-track" aria-hidden="true">
            <span style={{ width: `${Math.max(4, clamped)}%` }} />
          </span>
          <span className="ct-progress-percent tabular-nums">%{clamped}</span>
        </span>
      </button>
      {onIncrement && (
        <button
          type="button"
          className="ct-progress-increment"
          onClick={onIncrement}
          aria-label={`${title} için sonraki bölümü işaretle`}
        >
          {clamped >= 100 ? <Play className="ct-icon" aria-hidden="true" /> : <Plus className="ct-icon" aria-hidden="true" />}
        </button>
      )}
    </article>
  );
};

/** Poster URL'i güvenli biçimde üretir (liste dışı görseller için boş döner). */
export function progressPoster(item: Parameters<typeof getPoster>[0]): string {
  return getPoster(item, 'w342');
}

export function progressTitle(item: Parameters<typeof displayTitle>[0]): string {
  return displayTitle(item);
}
