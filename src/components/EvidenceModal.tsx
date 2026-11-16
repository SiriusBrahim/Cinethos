import React, { useState } from 'react';
import { activateOnKeyDown } from '../utils/a11y.ts';

export interface EvidenceDetailData {
  title: string;
  category?: string;
  score: number; // 0-100
  confidence?: 'high' | 'medium' | 'low';
  description?: string;
  howWeKnow?: string;
  positiveEvidence?: Array<{
    id: number | string;
    media_type: 'movie' | 'tv';
    title: string;
    poster_path?: string | null;
    year?: string | number;
    contribution: string;
  }>;
  negativeEvidence?: Array<{
    id: number | string;
    media_type: 'movie' | 'tv';
    title: string;
    poster_path?: string | null;
    year?: string | number;
    contribution: string;
  }>;
  relatedMetrics?: Array<{ id: string; name: string; score: number }>;
  userAdjustment?: 'boost' | 'reduce' | 'pin' | 'ignore' | null;
}

interface EvidenceModalProps {
  isOpen: boolean;
  data: EvidenceDetailData | null;
  onClose: () => void;
  onSelectMedia?: (item: any) => void;
  onAdjustMetric?: (metricTitle: string, action: 'boost' | 'reduce' | 'pin' | 'ignore' | 'reset') => void;
}

export const EvidenceModal: React.FC<EvidenceModalProps> = ({
  isOpen,
  data,
  onClose,
  onSelectMedia,
  onAdjustMetric,
}) => {
  const [objectionSent, setObjectionSent] = useState(false);
  const [currentAdjustment, setCurrentAdjustment] = useState<'boost' | 'reduce' | 'pin' | 'ignore' | null>(
    data?.userAdjustment || null
  );

  if (!isOpen || !data) return null;

  const scoreColor =
    data.score >= 80 ? '#15803D' : data.score >= 60 ? '#C83724' : data.score >= 40 ? '#0F766E' : '#64748B';

  const circumference = 2 * Math.PI * 28;
  const strokeDashoffset = circumference - (data.score / 100) * circumference;

  const handleAction = (action: 'boost' | 'reduce' | 'pin' | 'ignore' | 'reset') => {
    if (action === 'reset') {
      setCurrentAdjustment(null);
    } else {
      setCurrentAdjustment(action);
    }
    onAdjustMetric?.(data.title, action);
  };

  const handleObjection = () => {
    setObjectionSent(true);
    try {
      const stored = JSON.parse(localStorage.getItem('cinethos_evidence_objections') || '[]');
      stored.push({ title: data.title, at: new Date().toISOString() });
      localStorage.setItem('cinethos_evidence_objections', JSON.stringify(stored));
    } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/55 backdrop-blur-md animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="evidenceModalTitle"
    >
      <div
        className="absolute inset-0"
        role="presentation"
        aria-hidden="true"
        onClick={onClose}
      />
      <div className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-xl bg-cinema-surface border border-cinema-borderStrong shadow-2xl p-6 md:p-8 text-cinema-textPrimary">
        {/* Close Button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-lg text-cinema-textMuted hover:text-cinema-textPrimary hover:bg-cinema-elevated transition-colors"
          aria-label="Kapat"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6 6 18M6 6l12 12" strokeLinecap="round" />
          </svg>
        </button>

        {/* Header: Title + Circular Score */}
        <div className="flex items-start gap-4 mb-6 pr-8">
          {/* Circular Progress Gauge */}
          <div className="relative w-16 h-16 shrink-0 flex items-center justify-center">
            <svg className="w-16 h-16 -rotate-90">
              <circle
                cx="32"
                cy="32"
                r="28"
                stroke="#E2E6ED"
                strokeWidth="5"
                fill="none"
              />
              <circle
                cx="32"
                cy="32"
                r="28"
                stroke={scoreColor}
                strokeWidth="5"
                fill="none"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                className="transition-all duration-700 ease-out"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center font-mono">
              <span className="text-sm font-bold leading-none text-cinema-textPrimary">%{data.score}</span>
              <span className="text-[9px] text-cinema-textMuted tracking-tight">UYUM</span>
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2 mb-1">
              {data.category && (
                <span className="text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded bg-cinema-elevated border border-cinema-borderSubtle text-cinema-textMuted">
                  {data.category}
                </span>
              )}
              {data.confidence && (
                <span
                  className={`text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border ${
                    data.confidence === 'high'
                      ? 'bg-emerald-50 border-emerald-200 text-cinema-success'
                      : data.confidence === 'medium'
                      ? 'bg-cinema-gold/10 border-cinema-gold/30 text-cinema-gold'
                      : 'bg-cinema-elevated border-cinema-borderSubtle text-cinema-textMuted'
                  }`}
                >
                  {data.confidence === 'high' ? 'Güçlü Kanıt' : data.confidence === 'medium' ? 'Çıkarım' : 'Az Veri'}
                </span>
              )}
            </div>
            <h2 id="evidenceModalTitle" className="text-xl md:text-2xl font-display font-bold text-cinema-textPrimary tracking-tight">
              {data.title}
            </h2>
            <p className="text-sm text-cinema-textSecondary mt-1 leading-relaxed">
              {data.description || 'Bu metrik, izleme geçmişinizdeki tematik ve ton benzerliklerinden türetilmiştir.'}
            </p>
          </div>
        </div>

        {/* "Bunu Nasıl Bildin?" Bilgi Notu */}
        <div className="mb-6 p-4 rounded-lg bg-cinema-elevated border border-cinema-cyan/30 text-xs leading-relaxed text-cinema-textSecondary">
          <div className="flex items-center gap-2 text-cinema-cyan font-semibold mb-1">
            <span>Bunu Nasıl Bildik?</span>
          </div>
          <p>
            {data.howWeKnow ||
              'İzlediğiniz, yüksek puan verdiğiniz veya listenize eklediğiniz yapımların senaryo tonu, yönetmen dili ve kavramsal etiketleri vektörel uzayda analiz edildi. Profiliniz bu temaya belirgin bir afinite gösteriyor.'}
          </p>
        </div>

        {/* Tercihini Güçlendiren İçerikler */}
        {data.positiveEvidence && data.positiveEvidence.length > 0 && (
          <div className="mb-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-cinema-success mb-2 flex items-center gap-1.5">
              Tercihini Güçlendiren Yapımlar ({data.positiveEvidence.length})
            </h3>
            <div className="space-y-2">
              {data.positiveEvidence.map((item) => (
                <div
                  key={`${item.media_type}:${item.id}`}
                  onClick={() => onSelectMedia?.(item)}
                  onKeyDown={activateOnKeyDown(() => onSelectMedia?.(item))}
                  role="button"
                  tabIndex={0}
                  className="flex items-center justify-between p-2.5 rounded-lg bg-cinema-elevated border border-cinema-borderSubtle hover:border-cinema-success/40 hover:bg-cinema-surface transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {item.poster_path ? (
                      <img
                        src={`https://image.tmdb.org/t/p/w92${item.poster_path}`}
                        alt={item.title}
                        className="w-8 h-12 object-cover rounded shrink-0 border border-cinema-borderSubtle"
                      />
                    ) : (
                      <div className="w-8 h-12 rounded bg-cinema-surface border border-cinema-borderSubtle flex items-center justify-center text-xs text-cinema-textTertiary">
                        Film
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-cinema-textPrimary group-hover:text-cinema-success transition-colors truncate">
                        {item.title}
                      </div>
                      <div className="text-[11px] text-cinema-textMuted font-mono">{item.year || '—'}</div>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-cinema-success font-mono shrink-0 pl-2">
                    {item.contribution}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Tercihini Zayıflatan İçerikler */}
        {data.negativeEvidence && data.negativeEvidence.length > 0 && (
          <div className="mb-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-cinema-danger mb-2 flex items-center gap-1.5">
              Tercihini Zayıflatan İçerikler ({data.negativeEvidence.length})
            </h3>
            <div className="space-y-2">
              {data.negativeEvidence.map((item) => (
                <div
                  key={`${item.media_type}:${item.id}`}
                  onClick={() => onSelectMedia?.(item)}
                  onKeyDown={activateOnKeyDown(() => onSelectMedia?.(item))}
                  role="button"
                  tabIndex={0}
                  className="flex items-center justify-between p-2.5 rounded-lg bg-cinema-elevated border border-cinema-borderSubtle hover:border-cinema-danger/40 hover:bg-cinema-surface transition-colors cursor-pointer group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-cinema-textPrimary group-hover:text-cinema-danger transition-colors truncate">
                        {item.title}
                      </div>
                      <div className="text-[11px] text-cinema-textMuted font-mono">{item.year || '—'}</div>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-cinema-danger font-mono shrink-0 pl-2">
                    {item.contribution}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* İlgili Metrikler */}
        {data.relatedMetrics && data.relatedMetrics.length > 0 && (
          <div className="mb-6">
            <span className="text-xs font-semibold uppercase tracking-wider text-cinema-textMuted mb-2 block">
              Bağlantılı Zevk Düğümleri
            </span>
            <div className="flex flex-wrap gap-2">
              {data.relatedMetrics.map((rm) => (
                <span
                  key={rm.id}
                  className="px-2.5 py-1 rounded bg-cinema-elevated border border-cinema-borderSubtle text-xs text-cinema-textSecondary font-mono"
                >
                  {rm.name} · %{rm.score}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Manuel Kontrol Paneli */}
        <div className="pt-4 border-t border-cinema-borderSubtle">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-cinema-textSecondary flex items-center gap-1.5">
              Bu Özelliği Yönet
            </span>
            {currentAdjustment && (
              <button
                type="button"
                onClick={() => handleAction('reset')}
                className="text-[11px] text-cinema-gold hover:underline transition-colors"
              >
                Varsayılana Sıfırla
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            <button
              type="button"
              onClick={() => handleAction('boost')}
              className={`p-2 rounded-lg text-xs font-medium border transition-all ${
                currentAdjustment === 'boost'
                  ? 'bg-emerald-50 text-cinema-success border-emerald-300'
                  : 'bg-cinema-elevated text-cinema-textSecondary border-cinema-borderSubtle hover:border-cinema-success/50 hover:text-cinema-textPrimary'
              }`}
            >
              Güçlendir
            </button>
            <button
              type="button"
              onClick={() => handleAction('reduce')}
              className={`p-2 rounded-lg text-xs font-medium border transition-all ${
                currentAdjustment === 'reduce'
                  ? 'bg-cinema-gold/10 text-cinema-gold border-cinema-gold'
                  : 'bg-cinema-elevated text-cinema-textSecondary border-cinema-borderSubtle hover:border-cinema-gold/50 hover:text-cinema-textPrimary'
              }`}
            >
              Azalt
            </button>
            <button
              type="button"
              onClick={() => handleAction('pin')}
              className={`p-2 rounded-lg text-xs font-medium border transition-all ${
                currentAdjustment === 'pin'
                  ? 'bg-teal-50 text-cinema-cyan border-teal-300'
                  : 'bg-cinema-elevated text-cinema-textSecondary border-cinema-borderSubtle hover:border-cinema-cyan/50 hover:text-cinema-textPrimary'
              }`}
            >
              Sabitle
            </button>
            <button
              type="button"
              onClick={() => handleAction('ignore')}
              className={`p-2 rounded-lg text-xs font-medium border transition-all ${
                currentAdjustment === 'ignore'
                  ? 'bg-rose-50 text-cinema-danger border-rose-300'
                  : 'bg-cinema-elevated text-cinema-textSecondary border-cinema-borderSubtle hover:border-cinema-danger/50 hover:text-cinema-textPrimary'
              }`}
            >
              İlgisiz
            </button>
          </div>

          {/* İtiraz Butonu */}
          <div className="flex items-center justify-between text-xs text-cinema-textMuted">
            {objectionSent ? (
              <span className="text-cinema-success flex items-center gap-1">
                <span>✓</span> İtirazınız kaydedildi, profil algoritması güncellendi.
              </span>
            ) : (
              <button
                type="button"
                onClick={handleObjection}
                className="text-cinema-textMuted hover:text-cinema-danger underline underline-offset-2 transition-colors"
              >
                "Bu çıkarım profilimi tam yansıtmıyor" (İtiraz et)
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-cinema-elevated border border-cinema-borderSubtle hover:border-cinema-borderStrong text-cinema-textPrimary font-medium transition-colors"
            >
              Kapat
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
