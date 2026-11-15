import React from 'react';
import { Search } from 'lucide-react';
import { BRAND_NAME } from '../../shared/brand.ts';

interface MobileTopBarProps {
  profileName: string;
  streakDays: number;
  query: string;
  onSearchChange: (value: string) => void;
  onSearchSubmit: () => void;
  onOpenProfile: () => void;
}

const greeting = (): string => {
  const hour = new Date().getHours();
  if (hour < 6) return 'İyi geceler';
  if (hour < 12) return 'Günaydın';
  if (hour < 18) return 'İyi günler';
  return 'İyi seyirler';
};

/** Mobil üst bar — marka, selamlama, seri rozeti, avatar ve arama. */
export const MobileTopBar: React.FC<MobileTopBarProps> = ({
  profileName,
  streakDays,
  query,
  onSearchChange,
  onSearchSubmit,
  onOpenProfile,
}) => {
  const initial = (profileName || 'P').trim().charAt(0).toUpperCase();

  return (
    <header className="mobile-topbar">
      <div className="mobile-topbar-row">
        <div className="mobile-topbar-copy">
          <span className="mobile-topbar-brand">{BRAND_NAME.toUpperCase()}</span>
          <h1 className="mobile-topbar-greeting">
            {greeting()}, {profileName || 'sinemasever'}
          </h1>
        </div>
        <div className="mobile-topbar-actions">
          {streakDays >= 2 && (
            <span className="mobile-streak tabular-nums" title="İzleme serisi">
              🔥 {streakDays}g
            </span>
          )}
          <button
            type="button"
            className="mobile-avatar"
            onClick={onOpenProfile}
            aria-label={`Profil ve ayarlar: ${profileName || 'Profilim'}`}
            aria-haspopup="dialog"
          >
            {initial}
          </button>
        </div>
      </div>

      <form
        className="mobile-search"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          onSearchSubmit();
        }}
      >
        <Search className="mobile-search-icon" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Film veya dizi ara…"
          aria-label="Film veya dizi ara"
        />
      </form>
    </header>
  );
};
