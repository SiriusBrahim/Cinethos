import React from 'react';

/**
 * Ortak arayüz ilkelleri.
 *
 * Yeni çalışma alanları (Ana Sayfa, Seriler, İşlem Merkezi) kart/panel/rozet/
 * ölçer tasarımlarını buradan alır. Tekrar eden `div` yığınları yerine tek
 * kaynak; görsel dil `src/styles/workspace.css` içindeki token tabanlı
 * sınıflarla yönetilir.
 */

export const Panel: React.FC<{
  children: React.ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'article';
  ariaLabel?: string;
}> = ({ children, className = '', as = 'section', ariaLabel }) => {
  const Element = as;
  return (
    <Element className={`ws-panel ${className}`.trim()} aria-label={ariaLabel}>
      {children}
    </Element>
  );
};

export const SectionHeader: React.FC<{
  title: string;
  description?: string;
  eyebrow?: string;
  action?: React.ReactNode;
  id?: string;
}> = ({ title, description, eyebrow, action, id }) => (
  <div className="ws-section-head">
    <div className="ws-section-copy">
      {eyebrow && <span className="ws-eyebrow">{eyebrow}</span>}
      <h2 className="ws-section-title" id={id}>
        {title}
      </h2>
      {description && <p className="ws-section-desc">{description}</p>}
    </div>
    {action && <div className="ws-section-action">{action}</div>}
  </div>
);

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

export const Badge: React.FC<{
  children: React.ReactNode;
  tone?: BadgeTone;
  title?: string;
}> = ({ children, tone = 'neutral', title }) => (
  <span className={`ws-badge ws-badge--${tone}`} title={title}>
    {children}
  </span>
);

export const StatTile: React.FC<{
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: BadgeTone;
}> = ({ label, value, hint, tone = 'neutral' }) => (
  <div className={`ws-stat ws-stat--${tone}`}>
    <span className="ws-stat-label">{label}</span>
    <span className="ws-stat-value tabular-nums">{value}</span>
    {hint && <span className="ws-stat-hint">{hint}</span>}
  </div>
);

export const Meter: React.FC<{
  value: number;
  max?: number;
  label: string;
  hint?: string;
}> = ({ value, max = 100, label, hint }) => {
  const safeMax = max > 0 ? max : 100;
  const percent = Math.max(0, Math.min(100, Math.round((value / safeMax) * 100)));
  return (
    <div className="ws-meter">
      <div className="ws-meter-head">
        <span>{label}</span>
        <span className="tabular-nums">{percent}%</span>
      </div>
      <div
        className="ws-meter-track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <span className="ws-meter-fill" style={{ width: `${percent}%` }} />
      </div>
      {hint && <span className="ws-meter-hint">{hint}</span>}
    </div>
  );
};

export const EmptyState: React.FC<{
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}> = ({ title, description, action, icon }) => (
  <div className="ws-empty" role="status">
    {icon && <span className="ws-empty-icon" aria-hidden="true">{icon}</span>}
    <p className="ws-empty-title">{title}</p>
    {description && <p className="ws-empty-desc">{description}</p>}
    {action && <div className="ws-empty-action">{action}</div>}
  </div>
);

export const Toolbar: React.FC<{
  children: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
}> = ({ children, label, trailing }) => (
  <div className="ws-toolbar" role="group" aria-label={label}>
    <div className="ws-toolbar-main">{children}</div>
    {trailing && <div className="ws-toolbar-trailing">{trailing}</div>}
  </div>
);

export const SkeletonRows: React.FC<{ rows?: number; label?: string }> = ({
  rows = 4,
  label = 'Yükleniyor',
}) => (
  <div className="ws-skeleton-list" role="status" aria-label={label}>
    {Array.from({ length: rows }).map((_, index) => (
      <span key={index} className="ws-skeleton-row" />
    ))}
  </div>
);

export const ActionButton: React.FC<{
  children: React.ReactNode;
  onClick: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  ariaLabel?: string;
  type?: 'button' | 'submit';
}> = ({ children, onClick, variant = 'ghost', disabled, ariaLabel, type = 'button' }) => (
  <button
    type={type}
    className={`ws-btn ws-btn--${variant}`}
    onClick={onClick}
    disabled={disabled}
    aria-label={ariaLabel}
  >
    {children}
  </button>
);
