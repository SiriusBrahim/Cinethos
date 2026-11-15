import React, { useMemo } from 'react';
import { ArrowUpRight, RefreshCw, Sparkles } from 'lucide-react';
import { TAXONOMY_V01 } from '../../core/taste/taxonomy.ts';
import {
  getCategoryDisplayLabel,
  getMetricDisplayTitle,
  getStatusLabelTr,
  resolveEffectiveMetricView,
} from '../../core/taste/metric-labels.ts';
import { useTasteProfile } from '../../hooks/useTasteProfile.ts';

interface ProfileIdentityCardProps {
  /** Menüdeki geniş Sinema Kimliği görünümüne geçer. */
  onOpenIdentity?: () => void;
}

interface IdentitySignal {
  id: string;
  title: string;
  categoryLabel: string;
  statusLabel: string;
  value: number;
}

const MAX_SIGNALS = 4;

/**
 * Profildeki kompakt Sinema Kimliği özeti.
 *
 * Menüdeki (Zevkim) geniş görünümle **aynı** kaynağı kullanır: `useTasteProfile`
 * taksonomi V01 metriklerini sunucudan okur ve arka plan yeniden hesaplamasında
 * canlı güncellenir. Böylece profilde eski/ikinci bir kimlik hesabı kalmaz.
 */
export const ProfileIdentityCard: React.FC<ProfileIdentityCardProps> = ({
  onOpenIdentity,
}) => {
  const { profile, status, error, reload } = useTasteProfile();

  const { signals, signalledCount, totalMetrics, coveragePercent } = useMemo(() => {
    const scored = TAXONOMY_V01.filter((def) => def.scoringEnabled);
    const rows = scored.map((def) => {
      const raw = profile?.metrics?.[def.id] ?? null;
      const view = resolveEffectiveMetricView(raw);
      return {
        id: def.id,
        title: getMetricDisplayTitle(def.id),
        categoryLabel: getCategoryDisplayLabel(def.categoryId),
        statusLabel: getStatusLabelTr(view.effectiveStatus),
        value: Math.round(view.effectiveAffinity * 100),
        effectiveStatus: view.effectiveStatus,
      };
    });

    const known = rows.filter(
      (row) =>
        row.effectiveStatus === 'directional' ||
        row.effectiveStatus === 'neutral' ||
        row.effectiveStatus === 'mixed'
    );
    const top = [...known]
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
      .slice(0, MAX_SIGNALS)
      .map<IdentitySignal>((row) => ({
        id: row.id,
        title: row.title,
        categoryLabel: row.categoryLabel,
        statusLabel: row.statusLabel,
        value: row.value,
      }));

    return {
      signals: top,
      signalledCount: known.length,
      totalMetrics: rows.length,
      coveragePercent:
        rows.length > 0 ? Math.round((known.length / rows.length) * 100) : 0,
    };
  }, [profile]);

  const isLoading = status === 'loading' || status === 'idle';
  const updatedAt = profile?.asOf ? profile.asOf.slice(0, 10) : null;

  return (
    <section className="identity-compact" aria-labelledby="identityCompactTitle">
      <header className="identity-compact-head">
        <div className="identity-compact-heading">
          <span className="identity-compact-icon" aria-hidden="true">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <h3 id="identityCompactTitle" className="identity-compact-title">
              Sinema Kimliği
            </h3>
            <p className="identity-compact-subtitle">
              {isLoading
                ? 'Zevk motorundan sinyaller okunuyor…'
                : `${signalledCount} / ${totalMetrics} ölçütte sinyal · %${coveragePercent} kapsam`}
            </p>
          </div>
        </div>
        <div className="identity-compact-actions">
          {updatedAt && !isLoading && (
            <span className="identity-compact-updated" title="Son hesaplama">
              {updatedAt}
            </span>
          )}
          {onOpenIdentity && (
            <button
              type="button"
              className="identity-compact-link"
              onClick={onOpenIdentity}
            >
              <span>Geniş görünüm</span>
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
      </header>

      {error && !isLoading ? (
        <div className="identity-compact-state" role="alert">
          <div>
            <p className="identity-compact-state-title">Kimlik yüklenemedi</p>
            <p className="identity-compact-state-text">{error}</p>
          </div>
          <button type="button" className="identity-compact-retry" onClick={() => void reload()}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Yeniden dene</span>
          </button>
        </div>
      ) : isLoading ? (
        <div className="identity-compact-skeleton" aria-hidden="true">
          {Array.from({ length: MAX_SIGNALS }).map((_, index) => (
            <span key={index} className="identity-compact-skeleton-row" />
          ))}
        </div>
      ) : signals.length === 0 ? (
        <p className="identity-compact-empty">
          Henüz yeterli sinyal yok. Birkaç yapımı tamamlayıp puanladığınızda kimliğiniz
          burada belirginleşir.
        </p>
      ) : (
        <ul className="identity-compact-list">
          {signals.map((signal) => {
            const magnitude = Math.min(100, Math.abs(signal.value));
            return (
              <li key={signal.id} className="identity-compact-item">
                <div className="identity-compact-item-head">
                  <span className="identity-compact-item-title">{signal.title}</span>
                  <span className="identity-compact-item-value tabular-nums">
                    %{signal.value}
                  </span>
                </div>
                <div className="identity-compact-track" aria-hidden="true">
                  <span
                    className={`identity-compact-fill ${signal.value < 0 ? 'is-negative' : ''}`}
                    style={{ width: `${Math.max(6, magnitude)}%` }}
                  />
                </div>
                <div className="identity-compact-item-meta">
                  <span>{signal.categoryLabel}</span>
                  <span className="identity-compact-dot" aria-hidden="true">
                    ·
                  </span>
                  <span>{signal.statusLabel}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};
