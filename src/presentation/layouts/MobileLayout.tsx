import React from 'react';
import { MODULES, type ModuleId } from '../../app/module-registry.ts';

/**
 * MIA Faz 7 — Mobil yerleşim (Yönetici 2 · `src/presentation/`).
 *
 * Mobil alt gezinme listesi ARTIK BURADA TUTULMAZ: tek doğruluk kaynağı
 * uygulama yöneticisinin modül kayıt defteridir (`src/app/module-registry.ts`).
 * Böylece yeni bir modül eklendiğinde masaüstü ve mobil gezinme birlikte
 * güncellenir; mobil kabuk ayrı bir kopya taşımaz.
 *
 * Veri işlemleri bu bileşenden YAPILMAZ; kartlar ve bölümler eylemlerini
 * uygulama yöneticisinin tek kütüphane hattından (`ClientLibraryService`)
 * alır.
 */

export interface MobileNavItem {
  readonly id: ModuleId;
  readonly label: string;
  readonly iconRef: string;
  readonly counter?: 'myList';
}

/**
 * Yalnızca görünen etiket farkı taşıyan mobil başlıklar. Kimlik, ikon ve
 * sayaç bilgisi kayıt defterinden gelir.
 */
const MOBILE_LABEL_OVERRIDES: Readonly<Partial<Record<ModuleId, string>>> = {
  relationships: 'İlişkiler',
};

export const MOBILE_NAV_ITEMS: readonly MobileNavItem[] = MODULES.map((module) => ({
  id: module.id,
  label: MOBILE_LABEL_OVERRIDES[module.id] ?? module.label,
  iconRef: module.iconRef,
  ...(module.counter ? { counter: module.counter } : {}),
}));

export interface MobileBottomNavProps {
  readonly tab: ModuleId;
  readonly myListCount: number;
  readonly onSelectTab: (tab: ModuleId) => void;
}

/** 56px yapışkan alt gezinme — modül kayıt defterinden türetilir. */
export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  tab,
  myListCount,
  onSelectTab,
}) => {
  return (
    <nav className="mobile-tab-bar" aria-label="Mobil Gezinme">
      {MOBILE_NAV_ITEMS.map((item) => {
        const isActive = tab === item.id;
        return (
          <button
            key={item.id}
            type="button"
            className={`mobile-tab-btn ${isActive ? 'active' : ''}`}
            onClick={() => onSelectTab(item.id)}
            aria-label={item.label}
            aria-current={isActive ? 'page' : undefined}
          >
            {item.counter === 'myList' ? (
              <span className="mobile-tab-icon-wrap">
                <svg className="icon" aria-hidden="true">
                  <use href={item.iconRef} />
                </svg>
                {myListCount > 0 && (
                  <span className="mobile-tab-badge tabular-nums">
                    {myListCount > 99 ? '99+' : myListCount}
                  </span>
                )}
              </span>
            ) : (
              <svg className="icon" aria-hidden="true">
                <use href={item.iconRef} />
              </svg>
            )}
            <span className="mobile-tab-label">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
};

export default MobileBottomNav;
