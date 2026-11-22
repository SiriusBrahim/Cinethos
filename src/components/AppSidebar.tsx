import React from 'react';
import { SIDEBAR_NAV_GROUPS } from '../app/navigation.ts';
import type { ModuleId } from '../app/module-ids.ts';

interface AppSidebarProps {
  tab: ModuleId;
  onTabChange: (tab: ModuleId) => void;
  profileName: string;
  myListCount: number;
  onOpenProfile: () => void;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({ tab, onTabChange, profileName, myListCount, onOpenProfile }) => {
  const initial = (profileName || 'P').trim().charAt(0).toUpperCase();
  return (
    <aside className="app-sidebar" aria-label="Ana gezinme">
      <button className="sidebar-brand" type="button" onClick={() => onTabChange('home')} aria-label="Cinethos ana sayfa">
        <span className="brand-icon" aria-hidden="true"><svg className="icon"><use href="#icon-film" /></svg></span>
        <span><strong>Cinethos</strong><small>PERSONAL CINEMA</small></span>
      </button>
      <nav className="sidebar-navigation" aria-label="Çalışma alanları">
        {SIDEBAR_NAV_GROUPS.map((group) => (
          <section className="sidebar-nav-group" key={group.id}>
            <h2>{group.label}</h2>
            {group.items.map((item) => {
              const active = tab === item.id;
              return (
                <button key={item.id} type="button" className={'sidebar-nav-item ' + (active ? 'is-active' : '')}
                  aria-current={active ? 'page' : undefined} onClick={() => onTabChange(item.id)}>
                  <svg className="icon" aria-hidden="true"><use href={item.iconRef} /></svg>
                  <span>{item.label}</span>
                  {item.counter === 'myList' && myListCount > 0 && <span className="sidebar-nav-count">{myListCount}</span>}
                </button>
              );
            })}
          </section>
        ))}
      </nav>
      <button className="sidebar-profile" type="button" onClick={onOpenProfile}>
        <span className="profile-avatar-circle">{initial}</span>
        <span className="sidebar-profile-copy"><strong>{profileName || 'Profilim'}</strong><small>Profil ve ayarlar</small></span>
        <span className="sidebar-profile-chevron" aria-hidden="true">···</span>
      </button>
    </aside>
  );
};
