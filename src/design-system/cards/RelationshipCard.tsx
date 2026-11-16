import React from 'react';
import { ArrowUpRight, Network } from 'lucide-react';

interface RelationshipCardProps {
  title: string;
  subtitle: string;
  meta?: string;
  confidenceLabel?: string;
  onOpen: () => void;
}

/** Relationship Card — film/dizi evrenleri ve ilişki keşfi kartı. */
export const RelationshipCard: React.FC<RelationshipCardProps> = ({
  title,
  subtitle,
  meta,
  confidenceLabel,
  onOpen,
}) => {
  return (
    <article className="ct-rel">
      <div className="ct-rel-head">
        <span className="ct-rel-icon" aria-hidden="true">
          <Network className="ct-icon" />
        </span>
        <div className="ct-rel-copy">
          <h3 className="ct-rel-title">{title}</h3>
          <p className="ct-rel-subtitle">{subtitle}</p>
        </div>
        <button
          type="button"
          className="ct-rel-open"
          onClick={onOpen}
          aria-label={`${title} görünümünü aç`}
        >
          <ArrowUpRight className="ct-icon" aria-hidden="true" />
        </button>
      </div>
      {(meta || confidenceLabel) && (
        <div className="ct-rel-meta">
          {meta && <span>{meta}</span>}
          {confidenceLabel && <span className="ct-rel-confidence">{confidenceLabel}</span>}
        </div>
      )}
    </article>
  );
};
