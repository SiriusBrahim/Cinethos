import React, { useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { BookmarkPlus, RotateCcw, X } from 'lucide-react';
import { displayTitle, getPoster } from '../../utils/helpers.ts';
import type { HeroCardItem } from './HeroCard.tsx';

export interface StackDeckEntry {
  item: HeroCardItem;
  reason?: string;
  matchScore?: number;
}

interface StackDeckProps {
  entries: StackDeckEntry[];
  onOpen: (item: HeroCardItem) => void;
  onQuickSave?: (item: HeroCardItem) => void;
  emptyLabel?: string;
}

const VISIBLE = 3;

/**
 * Stack Card — öneri destesi. En üstteki kart öne çıkar, tap/buton ile
 * arkadaki kart yüzeye gelir. `prefers-reduced-motion` açıkken geçiş yoktur.
 */
export const StackDeck: React.FC<StackDeckProps> = ({
  entries,
  onOpen,
  onQuickSave,
  emptyLabel = 'Öneri destesi hazırlanıyor…',
}) => {
  const [offset, setOffset] = useState(0);
  const [skipped, setSkipped] = useState<StackDeckEntry[]>([]);
  const reduceMotion = useReducedMotion();
  const deck = entries.slice(0, 8).filter(
    (entry) => !skipped.some((s) => s.item.id === entry.item.id && s.item.media_type === entry.item.media_type)
  );

  if (deck.length === 0) {
    return (
      <div className="ct-deck ct-deck--empty" role="status">
        <p>{emptyLabel}</p>
      </div>
    );
  }

  const ordered = [...deck.slice(offset % deck.length), ...deck.slice(0, offset % deck.length)];
  const visible = ordered.slice(0, VISIBLE);
  const active = ordered[0];

  const advance = () => setOffset((prev) => (prev + 1) % deck.length);
  const current = ordered[0];

  const skipCurrent = () => {
    if (!current) return;
    setSkipped((prev) => [...prev, current]);
    setOffset(0);
  };

  const undoSkip = () => {
    setSkipped((prev) => (prev.length === 0 ? prev : prev.slice(0, -1)));
    setOffset(0);
  };

  return (
    <div className="ct-deck" role="group" aria-label="Sana özel öneri destesi">
      <div className="ct-deck-stage">
        {visible
          .map((entry, index) => {
            const isTop = index === 0;
            return (
              <motion.article
                key={`${entry.item.media_type}:${entry.item.id}`}
                className={`ct-deck-card ${isTop ? 'is-top' : ''}`}
                style={{ zIndex: VISIBLE - index }}
                initial={false}
                animate={{
                  y: reduceMotion ? 0 : index * -10,
                  scale: reduceMotion ? 1 : 1 - index * 0.05,
                  opacity: isTop ? 1 : 1 - index * 0.22,
                }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                aria-hidden={!isTop}
                drag={isTop && !reduceMotion ? 'x' : false}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.18}
                onDragEnd={(_event, info) => {
                  if (!isTop) return;
                  if (info.offset.x < -72) skipCurrent();
                  else if (info.offset.x > 72 && onQuickSave) onQuickSave(current.item);
                }}
              >
                <div className="ct-deck-poster">
                  {getPoster(entry.item, 'w500') ? (
                    <img src={getPoster(entry.item, 'w500')} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <span className="ct-deck-poster-fallback" aria-hidden="true" />
                  )}
                  {typeof entry.matchScore === 'number' && entry.matchScore > 0 && (
                    <span className="ct-deck-badge tabular-nums">%{Math.round(entry.matchScore)}</span>
                  )}
                </div>
                <div className="ct-deck-body">
                  <h3 className="ct-deck-title">{displayTitle(entry.item)}</h3>
                  {entry.reason ? (
                    <p className="ct-deck-reason">{entry.reason}</p>
                  ) : (
                    <p className="ct-deck-reason">Zevk haritandan önerildi</p>
                  )}
                  <div className="ct-deck-actions">
                    <button
                      type="button"
                      className="ct-btn ct-btn--primary ct-btn--sm"
                      onClick={() => onOpen(entry.item)}
                    >
                      İncele
                    </button>
                    {onQuickSave && (
                      <button
                        type="button"
                        className="ct-btn ct-btn--ghost ct-btn--sm"
                        onClick={() => onQuickSave(entry.item)}
                        aria-label={`${displayTitle(entry.item)} listeme ekle`}
                      >
                        <BookmarkPlus className="ct-icon" aria-hidden="true" />
                      </button>
                    )}
                    {deck.length > 1 && (
                      <button
                        type="button"
                        className="ct-btn ct-btn--quiet ct-btn--sm"
                        onClick={advance}
                        aria-label="Sonraki öneri"
                      >
                        Sonraki
                      </button>
                    )}
                    {deck.length > 1 && (
                      <button
                        type="button"
                        className="ct-btn ct-btn--quiet ct-btn--sm ct-deck-skip"
                        onClick={skipCurrent}
                        aria-label="Bu öneriyi geç"
                      >
                        <X className="ct-icon" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              </motion.article>
            );
          })
          .reverse()}
      </div>
      <p className="ct-deck-counter">
        <span className="tabular-nums">{(offset % deck.length) + 1}</span>
        <span aria-hidden="true"> / </span>
        <span className="tabular-nums">{deck.length}</span>
        <span className="ct-deck-counter-owner">· {displayTitle(active.item)}</span>
      </p>

      {skipped.length > 0 && (
        <div className="ct-deck-undo" role="status">
          <span>
            {skipped.length} öneri geçildi
            {skipped.length > 0 && ` · son: ${displayTitle(skipped[skipped.length - 1].item)}`}
          </span>
          <button type="button" className="ct-deck-undo-btn" onClick={undoSkip}>
            <RotateCcw className="ct-icon" aria-hidden="true" />
            <span>Geri al</span>
          </button>
        </div>
      )}
    </div>
  );
};
