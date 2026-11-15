import React from 'react';

export type MainTab = 'discover' | 'list' | 'taste-map' | 'relationships';

interface MobileTabBarProps {
  tab: MainTab;
  allListCount: number;
  onSelectTab: (tab: MainTab) => void;
}

export const MobileTabBar: React.FC<MobileTabBarProps> = ({
  tab,
  allListCount,
  onSelectTab,
}) => {
  return (
    <nav className="mobile-tab-bar" aria-label="Mobil Gezinme">
      <button
        type="button"
        className={`mobile-tab-btn ${tab === 'discover' ? 'active' : ''}`}
        onClick={() => onSelectTab('discover')}
        aria-label="Keşfet"
        aria-current={tab === 'discover' ? 'page' : undefined}
      >
        <svg className="icon" aria-hidden="true">
          <use href="#icon-film" />
        </svg>
        <span className="mobile-tab-label">Keşfet</span>
      </button>

      <button
        type="button"
        className={`mobile-tab-btn ${tab === 'list' ? 'active' : ''}`}
        onClick={() => onSelectTab('list')}
        aria-label="Listem"
        aria-current={tab === 'list' ? 'page' : undefined}
      >
        <span className="mobile-tab-icon-wrap">
          <svg className="icon" aria-hidden="true">
            <use href="#icon-bookmark" />
          </svg>
          {allListCount > 0 && (
            <span className="mobile-tab-badge tabular-nums">
              {allListCount > 99 ? '99+' : allListCount}
            </span>
          )}
        </span>
        <span className="mobile-tab-label">Listem</span>
      </button>

      <button
        type="button"
        className={`mobile-tab-btn ${tab === 'taste-map' ? 'active' : ''}`}
        onClick={() => onSelectTab('taste-map')}
        aria-label="Zevkim"
        aria-current={tab === 'taste-map' ? 'page' : undefined}
      >
        <svg className="icon" aria-hidden="true">
          <use href="#icon-dna" />
        </svg>
        <span className="mobile-tab-label">Zevkim</span>
      </button>

      <button
        type="button"
        className={`mobile-tab-btn ${tab === 'relationships' ? 'active' : ''}`}
        onClick={() => onSelectTab('relationships')}
        aria-label="Evrenler"
        aria-current={tab === 'relationships' ? 'page' : undefined}
      >
        <svg className="icon" aria-hidden="true">
          <use href="#icon-network" />
        </svg>
        <span className="mobile-tab-label">Evrenler</span>
      </button>
    </nav>
  );
};
