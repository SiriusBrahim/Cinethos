import React from 'react';

interface MetricCardProps {
  label: string;
  value: string;
  hint?: string;
  tone?: 'gold' | 'teal' | 'violet' | 'amber';
  progress?: number;
  icon?: React.ReactNode;
}

/** Metric Card — 2×2 kompakt istatistik kartı. */
export const MetricCard: React.FC<MetricCardProps> = ({
  label,
  value,
  hint,
  tone = 'gold',
  progress,
  icon,
}) => {
  return (
    <article className={`ct-metric ct-metric--${tone}`}>
      <div className="ct-metric-head">
        <span className="ct-metric-label">{label}</span>
        {icon && <span className="ct-metric-icon" aria-hidden="true">{icon}</span>}
      </div>
      <strong className="ct-metric-value tabular-nums">{value}</strong>
      {typeof progress === 'number' && (
        <span className="ct-metric-track" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(3, progress))}%` }} />
        </span>
      )}
      {hint && <span className="ct-metric-hint">{hint}</span>}
    </article>
  );
};
