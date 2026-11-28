import React, { useMemo } from 'react';
import type { SavedItem } from '../../core/cinetrack-core.ts';
import { displayTitle, getPoster, handleImageError } from '../../utils/helpers.ts';
import {
  ActionButton,
  Badge,
  EmptyState,
  Meter,
  Panel,
  SectionHeader,
  StatTile,
  type BadgeTone,
} from '../../components/ui/primitives.tsx';
import { buildHomeDashboard, type HomeEntry } from './dashboard.ts';

/**
 * Ana Sayfa çalışma alanı.
 *
 * Kişisel karşılama, devam eden diziler, son aktivite, sana özel seçkiler ve
 * zevk izlerini tek ekranda toplar. Tüm veri türetimi `dashboard.ts` içindeki
 * saf fonksiyondan gelir; eylemler kabuk sözleşmesiyle (`ClientLibraryService`
 * hattı) yürür.
 */

export interface HomeSectionProps {
  profileName: string;
  savedItems: SavedItem[];
  forYouItems: any[];
  genresMap: Record<number, string>;
  isDemo: boolean;
  onOpenDetails: (item: any) => void;
  onQuickSave: (item: any) => void;
  onSetStatus: (item: any, status: 'watching' | 'watchlist' | 'completed') => void;
  onIncrementEpisode: (item: any) => void;
  onGoDiscover: () => void;
  onGoTaste: () => void;
}

const STATUS_LABELS: Record<SavedItem['status'], string> = {
  watching: 'İzleniyor',
  watchlist: 'İzleyeceğim',
  completed: 'İzlendi',
};

const STATUS_TONES: Record<SavedItem['status'], BadgeTone> = {
  watching: 'info',
  watchlist: 'neutral',
  completed: 'ok',
};

function greeting(hour: number): string {
  if (hour < 6) return 'İyi geceler';
  if (hour < 12) return 'Günaydın';
  if (hour < 18) return 'İyi günler';
  return 'İyi akşamlar';
}

function formatDate(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatMinutes(total: number): string {
  if (total <= 0) return '—';
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours <= 0) return `${minutes} dk`;
  return minutes > 0 ? `${hours} sa ${minutes} dk` : `${hours} sa`;
}

const PosterThumb: React.FC<{ item: any; onOpen: () => void }> = ({ item, onOpen }) => {
  const poster = getPoster(item, 'w342');
  return (
    <button type="button" className="ws-poster" onClick={onOpen} aria-label={`${displayTitle(item)} detaylarını aç`}>
      {poster ? (
        <img
          src={poster}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={(event) => handleImageError(event, poster, 'w342')}
        />
      ) : (
        <span className="ws-poster-fallback" aria-hidden="true">
          {displayTitle(item).slice(0, 1)}
        </span>
      )}
      <span className="ws-poster-title">{displayTitle(item)}</span>
    </button>
  );
};

const ActivityRow: React.FC<{ entry: HomeEntry; onOpen: () => void }> = ({ entry, onOpen }) => (
  <li className="ws-list-row">
    <button type="button" className="ws-list-main" onClick={onOpen}>
      <span className="ws-list-title">{entry.title}</span>
      <span className="ws-list-meta">
        {entry.year ? `${entry.year} · ` : ''}
        {entry.mediaType === 'tv' ? 'Dizi' : 'Film'}
        {entry.rating ? ` · ★ ${entry.rating}` : ''}
      </span>
    </button>
    <span className="ws-list-side">
      <Badge tone={STATUS_TONES[entry.status]}>{STATUS_LABELS[entry.status]}</Badge>
      <span className="ws-list-date">{formatDate(entry.timestamp)}</span>
    </span>
  </li>
);

export const HomeSection: React.FC<HomeSectionProps> = ({
  profileName,
  savedItems,
  forYouItems,
  genresMap,
  isDemo,
  onOpenDetails,
  onQuickSave,
  onSetStatus,
  onIncrementEpisode,
  onGoDiscover,
  onGoTaste,
}) => {
  const dashboard = useMemo(
    () => buildHomeDashboard({ savedItems, forYouItems, genresMap, limit: 10 }),
    [savedItems, forYouItems, genresMap]
  );
  const heroGreeting = greeting(new Date().getHours());
  const hasPicks = dashboard.picks.length > 0;

  return (
    <div className="ws-page ws-home">
      <section className="ws-hero" aria-labelledby="ws-home-title">
        <div className="ws-hero-copy">
          <span className="ws-eyebrow">{isDemo ? 'Demo katalog · kişisel arşiv' : 'Kişisel sinema arşivi'}</span>
          <h1 className="ws-hero-title" id="ws-home-title">
            {heroGreeting}, {profileName || 'sinemasever'}.
          </h1>
          <p className="ws-hero-desc">
            {dashboard.hasLibrary
              ? `${dashboard.stats.watching} yapım izleniyor, ${dashboard.stats.watchlist} yapım sırada. Kaldığın yerden devam et ya da yeni bir keşfe çık.`
              : 'Arşivin boş. Keşfet sekmesinden ilk filmini veya dizini ekle; öneri motoru zevkine göre şekillensin.'}
          </p>
          <div className="ws-hero-actions">
            <ActionButton variant="primary" onClick={onGoDiscover}>
              Keşfet
            </ActionButton>
            <ActionButton onClick={onGoTaste}>Zevk haritam</ActionButton>
          </div>
        </div>
        <div className="ws-hero-stats" role="group" aria-label="Kütüphane özeti">
          <StatTile label="İzleniyor" value={dashboard.stats.watching} tone="info" />
          <StatTile label="İzleyeceğim" value={dashboard.stats.watchlist} />
          <StatTile label="İzlendi" value={dashboard.stats.completed} tone="ok" />
          <StatTile
            label="Ortalama puan"
            value={dashboard.stats.averageRating ?? '—'}
            hint={`${dashboard.stats.rated} puan`}
          />
        </div>
      </section>

      <Panel className="ws-continue" ariaLabel="Devam eden diziler">
        <SectionHeader
          eyebrow="Kaldığın yerden"
          title="Devam eden diziler"
          description="Bölüm ilerlemesini buradan artırabilirsin."
          action={
            dashboard.continueWatching.length > 0 ? (
              <span className="ws-hint tabular-nums">{dashboard.continueWatching.length} yapım</span>
            ) : undefined
          }
        />
        {dashboard.continueWatching.length === 0 ? (
          <EmptyState
            title="Şu anda izlediğin bir dizi yok"
            description="Bir diziyi “İzleniyor” durumuna aldığında burada görünür."
            action={
              <ActionButton variant="primary" onClick={onGoDiscover}>
                Dizi keşfet
              </ActionButton>
            }
          />
        ) : (
          <ul className="ws-rail" aria-label="Devam eden diziler listesi">
            {dashboard.continueWatching.map((entry) => (
              <li key={entry.key} className="ws-rail-item">
                <PosterThumb item={entry.item} onOpen={() => onOpenDetails(entry.item)} />
                <div className="ws-rail-body">
                  <span className="ws-rail-title">{entry.title}</span>
                  <Badge tone="info">{STATUS_LABELS[entry.status]}</Badge>
                  {entry.progress && entry.progress.total > 0 ? (
                    <Meter
                      label="Bölüm ilerlemesi"
                      value={entry.progress.watched}
                      max={entry.progress.total}
                      hint={`${entry.progress.watched}/${entry.progress.total} bölüm`}
                    />
                  ) : (
                    <span className="ws-hint">Bölüm bilgisi henüz yok</span>
                  )}
                  <div className="ws-rail-actions">
                    {entry.mediaType === 'tv' && (
                      <ActionButton onClick={() => onIncrementEpisode(entry.item)} ariaLabel={`${entry.title} için bir bölüm ilerlet`}>
                        +1 bölüm
                      </ActionButton>
                    )}
                    <ActionButton onClick={() => onSetStatus(entry.item, 'completed')}>Bitirdim</ActionButton>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="ws-columns">
        <Panel className="ws-column" ariaLabel="Son aktivite">
          <SectionHeader eyebrow="Kronoloji" title="Son aktiviteler" />
          {dashboard.recentActivity.length === 0 ? (
            <EmptyState title="Henüz aktivite yok" description="İlk kaydını eklediğinde burada listelenir." />
          ) : (
            <ul className="ws-list">
              {dashboard.recentActivity.map((entry) => (
                <ActivityRow key={entry.key} entry={entry} onOpen={() => onOpenDetails(entry.item)} />
              ))}
            </ul>
          )}
        </Panel>

        <Panel className="ws-column" ariaLabel="Zevk izleri">
          <SectionHeader
            eyebrow="Zevk profili"
            title="Zevk izlerin"
            description="Yüksek puanladığın yapımlardan çıkarılan tür eğilimleri."
            action={<ActionButton onClick={onGoTaste}>Tümü</ActionButton>}
          />
          {dashboard.genres.length === 0 ? (
            <EmptyState
              title="Zevk profili için veri bekleniyor"
              description="İzlediklerini puanladıkça tür eğilimlerin burada oluşur."
            />
          ) : (
            <ul className="ws-chips" aria-label="Tür eğilimleri">
              {dashboard.genres.map((genre) => (
                <li key={genre.id}>
                  <Badge tone="info" title={`Ağırlık: ${genre.score}`}>
                    {genre.name} · {genre.score}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="ws-mini-stats">
            <span>Tahmini izleme süresi</span>
            <strong className="tabular-nums">{formatMinutes(dashboard.stats.estimatedMinutes)}</strong>
          </div>
        </Panel>
      </div>

      <Panel className="ws-picks" ariaLabel="Sana özel seçkiler">
        <SectionHeader
          eyebrow="Sana özel"
          title="Bugünün seçkileri"
          description="Zevk profiline göre sıralanmış adaylar."
          action={<ActionButton onClick={onGoDiscover}>Daha fazla</ActionButton>}
        />
        {!hasPicks ? (
          <EmptyState
            title="Öneri için birkaç kayıt gerekiyor"
            description="Birkaç yapımı izleyip puanladığında kişisel seçkiler burada belirir."
            action={
              <ActionButton variant="primary" onClick={onGoDiscover}>
                Keşfet
              </ActionButton>
            }
          />
        ) : (
          <ul className="ws-poster-grid" aria-label="Sana özel seçkiler listesi">
            {dashboard.picks.map((item) => (
              <li key={`${item.media_type}:${item.id}`} className="ws-poster-cell">
                <PosterThumb item={item} onOpen={() => onOpenDetails(item)} />
                <div className="ws-poster-actions">
                  <ActionButton onClick={() => onQuickSave(item)}>Kaydet</ActionButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
};

export default HomeSection;
