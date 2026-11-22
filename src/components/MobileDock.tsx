import React, { useState } from 'react';
import { DOCK_NAV_ITEMS, MOBILE_OVERFLOW_ITEMS } from '../app/navigation.ts';
import type { ModuleId } from '../app/module-ids.ts';

interface MobileDockProps {
  tab: ModuleId;
  onTabChange: (tab: ModuleId) => void;
  myListCount: number;
  onOpenProfile: () => void;
}

export const MobileDock: React.FC<MobileDockProps> = ({ tab, onTabChange, myListCount, onOpenProfile }) => {
  const [moreOpen, setMoreOpen] = useState(false);
  const close = () => setMoreOpen(false);
  return (
    <>
      <nav className="mobile-dock" aria-label="Alt gezinme">
        {DOCK_NAV_ITEMS.map(({ id, label, Icon, counter }) => {
          const active = tab === id;
          return (
            <button key={id} type="button" className={'mobile-dock-item ' + (active ? 'is-active' : '')}
              aria-current={active ? 'page' : undefined} onClick={() => { close(); onTabChange(id); }}>
              <span className="mobile-dock-icon"><Icon aria-hidden /></span><span>{label}</span>
              {counter === 'myList' && myListCount > 0 && <i>{myListCount}</i>}
            </button>
          );
        })}
        <button type="button" className={'mobile-dock-item ' + (moreOpen ? 'is-active' : '')}
          aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}>
          <span className="mobile-dock-icon"><span className="dock-more-dots">•••</span></span><span>Daha fazla</span>
        </button>
      </nav>
      {moreOpen && (
        <div className="mobile-more-backdrop" onClick={close}>
          <section className="mobile-more-sheet" role="dialog" aria-modal="true" aria-label="Diğer bölümler" onClick={(event) => event.stopPropagation()}>
            <div className="mobile-more-heading"><strong>Diğer bölümler</strong><button type="button" onClick={close} aria-label="Kapat">✕</button></div>
            {MOBILE_OVERFLOW_ITEMS.map((item) => {
              const active = tab === item.id;
              return <button key={item.id} type="button" className={'mobile-more-item ' + (active ? 'is-active' : '')}
                onClick={() => { close(); onTabChange(item.id); }}>
                <svg className="icon" aria-hidden="true"><use href={item.iconRef} /></svg><span>{item.label}</span>
              </button>;
            })}
            <button type="button" className="mobile-more-item" onClick={() => { close(); onOpenProfile(); }}>
              <svg className="icon" aria-hidden="true"><use href="#icon-user" /></svg><span>Profil ve Ayarlar</span>
            </button>
          </section>
        </div>
      )}
    </>
  );
};
