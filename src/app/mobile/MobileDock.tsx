import React from 'react';
import { Home, UserRound } from 'lucide-react';
import type { MainTab } from '../../app/module-registry.ts';
import { DOCK_NAV_ITEMS } from '../../app/navigation.ts';

interface MobileDockProps {
  homeOpen: boolean;
  tab: MainTab;
  myListCount: number;
  onSelectHome: () => void;
  onSelectTab: (tab: MainTab) => void;
  onOpenProfile: () => void;
}

/**
 * Mobile Dock — yüzen kapsül alt gezinme.
 * `Ana` dashboard'u, diğer üç öğe mevcut sekmeleri açar; Profil modalı ayrı tetikler.
 */
export const MobileDock: React.FC<MobileDockProps> = ({
  homeOpen,
  tab,
  myListCount,
  onSelectHome,
  onSelectTab,
  onOpenProfile,
}) => {
  return (
    <nav className="mobile-dock" aria-label="Mobil Ana Gezinme">
      <div className="mobile-dock-pill">
        <button
          type="button"
          className={`mobile-dock-btn ${homeOpen ? 'is-active' : ''}`}
          onClick={onSelectHome}
          aria-current={homeOpen ? 'page' : undefined}
        >
          <Home className="mobile-dock-icon" aria-hidden={true} />
          <span>Ana</span>
        </button>

        {DOCK_NAV_ITEMS.map(({ id, label, Icon, counter }) => {
          const isActive = !homeOpen && tab === id;
          return (
            <button
              key={id}
              type="button"
              className={`mobile-dock-btn ${isActive ? 'is-active' : ''}`}
              onClick={() => onSelectTab(id)}
              aria-current={isActive ? 'page' : undefined}
            >
              <span className="mobile-dock-icon-wrap">
                <Icon className="mobile-dock-icon" aria-hidden={true} />
                {counter === 'myList' && myListCount > 0 && (
                  <span className="mobile-dock-badge tabular-nums">
                    {myListCount > 99 ? '99+' : myListCount}
                  </span>
                )}
              </span>
              <span>{label}</span>
            </button>
          );
        })}

        <button
          type="button"
          className="mobile-dock-btn mobile-dock-btn--profile"
          onClick={onOpenProfile}
          aria-haspopup="dialog"
          aria-label="Profil ve ayarlar"
        >
          <UserRound className="mobile-dock-icon" aria-hidden={true} />
          <span>Profil</span>
        </button>
      </div>
    </nav>
  );
};
