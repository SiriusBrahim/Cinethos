import React, { useCallback, useRef, useState } from 'react';
import { MODULES, type ModuleId } from '../../app/module-registry.ts';
import { DOCK_NAV_ITEMS, MOBILE_OVERFLOW_ITEMS } from '../../app/navigation.ts';
import { useDialogAccessibility } from '../../hooks/useDialogAccessibility.ts';

/**
 * MIA Faz 7 — Mobil yerleşim (Yönetici 2 · `src/presentation/`).
 *
 * Mobil alt gezinme listesi ARTIK BURADA TUTULMAZ: tek doğruluk kaynağı
 * uygulama yöneticisinin modül kayıt defteridir (`src/app/module-registry.ts`).
 *
 * Dar ekranda dört birincil sekme dock'ta kalır; kalan modüller (Seriler,
 * İlişki Keşfi, İşlem Merkezi) ve profil/ayarlar "Daha fazla" sayfasında
 * listelenir. Alt gezinme içerik alanını kapatmaz: sayfa alt boşluğu
 * `workspace.css` içinde dock yüksekliği kadar ayrılır.
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

/** Dock'ta gösterilen modüller — kayıt defterinden türetilir. */
export const MOBILE_NAV_ITEMS: readonly MobileNavItem[] = DOCK_NAV_ITEMS.flatMap((item) => {
  const module = MODULES.find((entry) => entry.id === item.id);
  if (!module) return [];
  return [
    {
      id: module.id,
      label: item.label,
      iconRef: module.iconRef,
      ...(item.counter ? { counter: item.counter } : {}),
    },
  ];
});

export interface MobileBottomNavProps {
  readonly tab: ModuleId;
  readonly myListCount: number;
  readonly onSelectTab: (tab: ModuleId) => void;
  /** Profil ve Ayarlar penceresini açar; verilmezse satır gizlenir. */
  readonly onOpenProfile?: () => void;
}

/** 56px yapışkan alt gezinme — dört dock sekmesi + taşma sayfası. */
export const MobileBottomNav: React.FC<MobileBottomNavProps> = ({
  tab,
  myListCount,
  onSelectTab,
  onOpenProfile,
}) => {
  const [moreOpen, setMoreOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const closeSheet = useCallback(() => {
    setMoreOpen(false);
    moreButtonRef.current?.focus();
  }, []);

  // Aşama 4 (B-28): odak tuzağı, Escape, kaydırma kilidi ve odak dönüşü
  // paylaşılan dialog hook'undan gelir — burada ikinci bir kopya yok.
  useDialogAccessibility({
    open: moreOpen,
    containerRef: sheetRef,
    initialFocusRef: closeButtonRef,
    onClose: closeSheet,
  });

  const selectFromSheet = (id: ModuleId) => {
    onSelectTab(id);
    setMoreOpen(false);
    moreButtonRef.current?.focus();
  };

  return (
    <>
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
              aria-description={
                item.counter === 'myList' && myListCount > 0
                  ? `${myListCount} kayıt`
                  : undefined
              }
              aria-current={isActive ? 'page' : undefined}
            >
              {item.counter === 'myList' ? (
                <span className="mobile-tab-icon-wrap">
                  <svg className="icon" aria-hidden="true">
                    <use href={item.iconRef} />
                  </svg>
                  {myListCount > 0 && (
                    <span
                      className="mobile-tab-badge tabular-nums"
                      data-count={myListCount > 99 ? '99+' : String(myListCount)}
                      aria-hidden="true"
                    />
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

        <button
          ref={moreButtonRef}
          type="button"
          className={`mobile-tab-btn ${moreOpen ? 'active' : ''}`}
          onClick={() => setMoreOpen((open) => !open)}
          aria-label="Daha fazla bölüm"
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          aria-controls="mobile-more-sheet"
        >
          <svg className="icon" aria-hidden="true">
            <use href="#icon-layers" />
          </svg>
          <span className="mobile-tab-label">Daha fazla</span>
        </button>
      </nav>

      {moreOpen && (
        <div
          className="mobile-more-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) closeSheet();
          }}
        >
          <div
            className="mobile-more-sheet"
            id="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-more-title"
            ref={sheetRef}
          >
            <div className="mobile-more-head">
              <h2 id="mobile-more-title">Tüm bölümler</h2>
              <button
                ref={closeButtonRef}
                type="button"
                className="mobile-more-close"
                onClick={closeSheet}
                aria-label="Menüyü kapat"
              >
                <svg className="icon" aria-hidden="true">
                  <use href="#icon-close" />
                </svg>
              </button>
            </div>

            <ul className="mobile-more-list">
              {MOBILE_OVERFLOW_ITEMS.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={`mobile-more-item ${tab === item.id ? 'is-active' : ''}`}
                    onClick={() => selectFromSheet(item.id)}
                    aria-current={tab === item.id ? 'page' : undefined}
                  >
                    <svg className="icon" aria-hidden="true">
                      <use href={item.iconRef} />
                    </svg>
                    <span>{item.label}</span>
                  </button>
                </li>
              ))}
              {onOpenProfile && (
                <li>
                  <button
                    type="button"
                    className="mobile-more-item"
                    onClick={() => {
                      setMoreOpen(false);
                      onOpenProfile();
                    }}
                  >
                    <svg className="icon" aria-hidden="true">
                      <use href="#icon-user" />
                    </svg>
                    <span>Profil ve Ayarlar</span>
                  </button>
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </>
  );
};

export default MobileBottomNav;
