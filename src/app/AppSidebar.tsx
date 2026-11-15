import React, { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { BRAND_NAME } from '../shared/brand.ts';
import {
  getStoredTheme,
  setStoredTheme,
  subscribeThemeChange,
  type ThemeMode,
} from '../utils/theme.ts';
import { handleTabListKeyDown } from '../utils/tabListKeyboard.ts';
import type { MainTab } from './MobileTabBar.tsx';

interface AppSidebarProps {
  tab: MainTab | 'identity' | 'universes';
  onTabChange: (tab: MainTab) => void;
  myListCount: number;
  profileName: string;
  streakDays: number;
  tmdbSource?: string;
  tmdbStaleReason?: string;
  onOpenProfile: () => void;
  onOpenAdd: () => void;
  onOpenCommandPalette: () => void;
}

export const AppSidebar: React.FC<AppSidebarProps> = ({
  tab,
  onTabChange,
  myListCount,
  profileName,
  streakDays,
  tmdbSource = 'live',
  tmdbStaleReason,
  onOpenProfile,
  onOpenAdd,
  onOpenCommandPalette,
}) => {
  const avatarInitial = (profileName || 'P').trim().charAt(0).toUpperCase();
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getStoredTheme());

  useEffect(() => subscribeThemeChange(setThemeMode), []);

  const themeOptions: ReadonlyArray<{
    id: ThemeMode;
    label: string;
    Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  }> = [
    { id: 'light', label: 'Açık', Icon: Sun },
    { id: 'dark', label: 'Koyu', Icon: Moon },
    { id: 'system', label: 'Sistem', Icon: Monitor },
  ];
  const sourceText =
    tmdbSource === 'live'
      ? 'Canlı TMDB'
      : tmdbSource === 'stale-cache'
        ? 'Önbellek'
        : tmdbSource === 'demo'
          ? 'Demo Katalog'
          : 'Bağlanıyor';

  return (
    <aside className="app-sidebar" aria-label="Çalışma Alanı Kenar Çubuğu">
      {/* Editorial Brand Header */}
      <div className="sidebar-brand-block">
        <button
          type="button"
          className="sidebar-brand-btn"
          onClick={() => onTabChange('discover')}
          aria-label={`${BRAND_NAME} Keşfet sayfasına dön`}
        >
          <span className="brand-icon" aria-hidden="true">
            <svg className="icon">
              <use href="#icon-film" />
            </svg>
          </span>
          <span className="sidebar-brand-copy">
            <span className="brand-title">
              <span className="brand-title-lead">{BRAND_NAME.slice(0, 4)}</span>
              <span className="brand-title-accent">{BRAND_NAME.slice(4)}</span>
            </span>
            <span className="sidebar-brand-subtitle">KİŞİSEL SİNEMA ARŞİVİ</span>
          </span>
        </button>
      </div>

      {/* Primary Workspace Navigation */}
      <div className="sidebar-section">
        <span className="sidebar-section-label">ARŞİV VE KEŞİF</span>
        <nav
          className="sidebar-nav-list"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Ana Çalışma Alanı Sekmeleri"
          onKeyDown={handleTabListKeyDown}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'discover'}
            className={`sidebar-nav-btn ${tab === 'discover' ? 'is-active' : ''}`}
            onClick={() => onTabChange('discover')}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-film" />
            </svg>
            <span className="sidebar-nav-label">Keşfet</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'list'}
            className={`sidebar-nav-btn ${tab === 'list' ? 'is-active' : ''}`}
            onClick={() => onTabChange('list')}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-bookmark" />
            </svg>
            <span className="sidebar-nav-label">Listem</span>
            {myListCount > 0 && (
              <span className="sidebar-nav-count tabular-nums">{myListCount}</span>
            )}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'taste-map' || tab === 'identity'}
            className={`sidebar-nav-btn ${tab === 'taste-map' || tab === 'identity' ? 'is-active' : ''}`}
            onClick={() => onTabChange('taste-map')}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-dna" />
            </svg>
            <span className="sidebar-nav-label">Zevkim</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={tab === 'relationships' || tab === 'universes'}
            className={`sidebar-nav-btn ${tab === 'relationships' || tab === 'universes' ? 'is-active' : ''}`}
            onClick={() => onTabChange('relationships')}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-network" />
            </svg>
            <span className="sidebar-nav-label">Evrenler</span>
          </button>
        </nav>
      </div>

      {/* Quick Actions */}
      <div className="sidebar-section">
        <span className="sidebar-section-label">HIZLI ARAÇLAR</span>
        <div className="sidebar-quick-actions">
          <button
            type="button"
            className="sidebar-action-btn"
            onClick={onOpenCommandPalette}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-search" />
            </svg>
            <span className="sidebar-action-label">Komut Paleti</span>
            <kbd className="sidebar-kbd">⌘K</kbd>
          </button>

          <button
            type="button"
            className="sidebar-action-btn sidebar-action-btn--accent"
            onClick={onOpenAdd}
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-plus" />
            </svg>
            <span className="sidebar-action-label">Özel Yapım Ekle</span>
          </button>
        </div>
      </div>

      {/* Curator Footer */}
      <div className="sidebar-footer">
        <div className="sidebar-theme-row" role="group" aria-label="Tema seçimi">
          <span className="sidebar-theme-label">GÖRÜNÜM</span>
          <div className="sidebar-theme-toggle">
            {themeOptions.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className={`sidebar-theme-btn ${themeMode === id ? 'is-active' : ''}`}
                onClick={() => setStoredTheme(id)}
                aria-pressed={themeMode === id}
                aria-label={`${label} tema`}
              >
                <Icon className="sidebar-theme-icon" aria-hidden={true} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>

        <div
          className="sidebar-source-row"
          title={
            tmdbSource === 'stale-cache' && tmdbStaleReason
              ? `Önbellek nedeni: ${tmdbStaleReason}`
              : undefined
          }
        >
          <span className="sidebar-source-label">Katalog</span>
          <span className={`sidebar-source-value source-${tmdbSource}`}>{sourceText}</span>
        </div>

        <button
          type="button"
          className="sidebar-profile-btn"
          onClick={onOpenProfile}
          aria-haspopup="dialog"
          aria-label={`Profil yönetimi: ${profileName || 'Profilim'}`}
        >
          <span className="profile-avatar-circle" aria-hidden="true">
            {avatarInitial}
          </span>
          <span className="sidebar-profile-meta">
            <span className="sidebar-profile-name">{profileName || 'Profilim'}</span>
            <span className="sidebar-profile-role">Küratör Profili & Eşitleme</span>
          </span>
          {streakDays >= 2 && (
            <span
              className="sidebar-profile-streak tabular-nums"
              title={`İzleme serisi: ${streakDays} gün`}
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-fire" />
              </svg>
              {streakDays}g
            </span>
          )}
        </button>
      </div>
    </aside>
  );
};
