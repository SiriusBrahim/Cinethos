import React, { useState, useEffect, useRef } from 'react';
import { displayTitle, getPoster, releaseYear, handleImageError } from '../utils/helpers.ts';
import { SavedItem, makeMediaKey } from '../core/cinetrack-core.ts';
import { fetchTmdb } from '../services/api.ts';
import { TmdbItem } from '../types/tmdb.ts';
import { PWAInstallButton } from './PWAInstallButton.tsx';
import { HEADER_NAV_ITEMS } from '../app/navigation.ts';
import type { ModuleId } from '../app/module-registry.ts';
import { shouldHandleGlobalShortcut } from '../utils/overlay-guard.ts';

/**
 * MIA Faz 7 — Masaüstü üst sekmeleri uygulama yöneticisinin modül kayıt
 * defterinden türetilir (`HEADER_NAV_ITEMS`). Header kendi sekme listesini
 * TUTMAZ; geçersiz sekme kimlikleri (`identity`/`universes`) kaldırıldı.
 * Etiketler mevcut masaüstü metnini korur.
 */
const DESKTOP_LABEL_OVERRIDES: Readonly<Partial<Record<ModuleId, string>>> = {
  relationships: 'İlişkiler',
  series: 'Seriler',
  operations: 'İşlemler',
};

interface HeaderProps {
  profileName: string;
  tab: ModuleId;
  onTabChange: (tab: ModuleId) => void;
  myListCount: number;
  query: string;
  onSearchChange: (q: string) => void;
  onSearchSubmit: (q: string) => void;
  onSearchClear: () => void;
  onOpenProfile: () => void;
  onOpenAdd: () => void;
  onSelectItem: (item: TmdbItem) => void;
  getSaved: (item: TmdbItem) => SavedItem | undefined;
  tmdbSource?: string;
  tmdbStaleReason?: string;
  onOpenTvdbStock?: () => void;
  tvdbCount?: number;
}

export const Header: React.FC<HeaderProps> = ({
  profileName,
  tab,
  onTabChange,
  myListCount,
  query,
  onSearchChange,
  onSearchSubmit,
  onSearchClear,
  onOpenProfile,
  onOpenAdd,
  onSelectItem,
  getSaved,
  tmdbSource = 'live',
  tmdbStaleReason,
  onOpenTvdbStock,
  tvdbCount,
}) => {
  const [dropdownItems, setDropdownItems] = useState<TmdbItem[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  const searchRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const moreRef = useRef<HTMLDetailsElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);

  const cancelTypeahead = () => {
    requestIdRef.current += 1;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
        setActiveIndex(-1);
        setIsSearchFocused(false);
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, []);

  // Global keyboard shortcuts: 'k' or '/' opens search. Metin girişinde,
  // modifier tuşlarıyla ve açık bir modal varken tetiklenmez (B-29).
  useEffect(() => {
    const handleGlobalShortcuts = (event: KeyboardEvent) => {
      if (!shouldHandleGlobalShortcut(event)) return;
      if (event.key === 'k' || event.key === '/') {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', handleGlobalShortcuts);
    return () => window.removeEventListener('keydown', handleGlobalShortcuts);
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      requestControllerRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    if (activeIndex >= 0 && optionRefs.current[activeIndex]) {
      optionRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    onSearchChange(val);

    const requestId = ++requestIdRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    requestControllerRef.current?.abort();

    if (!val.trim()) {
      setDropdownOpen(false);
      setDropdownItems([]);
      setActiveIndex(-1);
      return;
    }

    // 350ms debounce with AbortController (Section 4 & Section 14)
    debounceRef.current = setTimeout(async () => {
      const controller = new AbortController();
      requestControllerRef.current = controller;

      try {
        const res = await fetchTmdb(
          '/search/multi',
          { query: val.trim(), page: '1' },
          controller.signal
        );

        if (requestId !== requestIdRef.current) return;

        const results = (res?.results || [])
          .filter((item: any) => item && (item.media_type === 'movie' || item.media_type === 'tv'))
          .slice(0, 7);

        setDropdownItems(results);
        setDropdownOpen(true);
        setActiveIndex(-1);
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        if (requestId === requestIdRef.current) {
          setDropdownItems([]);
          setDropdownOpen(true);
        }
      }
    }, 350);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!dropdownOpen && dropdownItems.length > 0) {
        setDropdownOpen(true);
        setActiveIndex(0);
        return;
      }
      setActiveIndex((prev) => (prev < dropdownItems.length - 1 ? prev + 1 : 0));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!dropdownOpen) return;
      setActiveIndex((prev) => (prev > 0 ? prev - 1 : dropdownItems.length - 1));
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (dropdownOpen && activeIndex >= 0 && dropdownItems[activeIndex]) {
        const chosen = dropdownItems[activeIndex];
        cancelTypeahead();
        setDropdownOpen(false);
        setActiveIndex(-1);
        onSelectItem(chosen);
        return;
      }
      cancelTypeahead();
      setDropdownOpen(false);
      setActiveIndex(-1);
      onSearchSubmit(query);
    } else if (e.key === 'Escape') {
      cancelTypeahead();
      setDropdownOpen(false);
      setActiveIndex(-1);
      inputRef.current?.blur();
    }
  };

  const handleSearchClear = () => {
    cancelTypeahead();
    setDropdownOpen(false);
    setDropdownItems([]);
    setActiveIndex(-1);
    onSearchClear();
  };

  const activeOptionId =
    dropdownOpen && activeIndex >= 0 && dropdownItems[activeIndex]
      ? `search-opt-${activeIndex}`
      : undefined;

  const avatarInitial = (profileName || 'P').trim().charAt(0).toUpperCase();

  return (
    <header className="app-header">
      <div className="shell topbar">
        {/* Brand Zone — gerçek buton: klavye ve ekran okuyucu ile erişilebilir. */}
        <button
          type="button"
          className="brand"
          onClick={() => onTabChange('discover')}
          aria-label="Cinethos ana sayfa"
        >
          <span className="brand-icon" aria-hidden="true">
            <svg className="icon">
              <use href="#icon-film"></use>
            </svg>
          </span>
          <span className="brand-title">Cinethos</span>
        </button>

        {/* Primary Desktop Nav Tabs (Section 4) — kayıt defterinden türetilir */}
        <nav className="header-nav-tabs" role="tablist" aria-label="Ana Gezinme">
          {HEADER_NAV_ITEMS.map((item) => {
            const isActive = tab === item.id;
            const label = DESKTOP_LABEL_OVERRIDES[item.id] ?? item.label;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-current={isActive ? 'page' : undefined}
                aria-label={label}
                aria-description={
                  item.counter === 'myList' && myListCount > 0
                    ? `${myListCount} kayıt`
                    : undefined
                }
                title={label}
                className={`nav-tab-btn ${isActive ? 'is-active' : ''}`}
                onClick={() => onTabChange(item.id)}
              >
                <svg className="nav-tab-icon" aria-hidden="true">
                  <use href={item.iconRef} />
                </svg>
                <span className="nav-tab-label">{label}</span>
                {item.counter === 'myList' && myListCount > 0 && (
                  <span
                    className="nav-tab-badge tabular-nums"
                    data-count={myListCount > 99 ? '99+' : String(myListCount)}
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {/* Expandable Search Area (k / /) */}
        <div className={`search ${isSearchFocused ? 'is-focused' : ''}`} ref={searchRef}>
          <svg className="icon search-icon" aria-hidden="true">
            <use href="#icon-search"></use>
          </svg>
          <input
            ref={inputRef}
            id="searchInput"
            className="search-input"
            type="search"
            role="combobox"
            aria-expanded={dropdownOpen}
            aria-controls="searchDropdown"
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => !dropdownOpen && setIsSearchFocused(false)}
            placeholder="Film veya dizi ara… (Kısayol: k veya /)"
            autoComplete="off"
            aria-label="Film veya dizi ara"
          />
          {query && (
            <button
              id="searchClear"
              className="search-clear"
              type="button"
              onClick={handleSearchClear}
              aria-label="Aramayı temizle"
            >
              <svg className="icon" aria-hidden="true">
                <use href="#icon-close"></use>
              </svg>
            </button>
          )}

          {dropdownOpen && (
            <div
              id="searchDropdown"
              className="search-dropdown"
              role="listbox"
              aria-label="Anlık arama önerileri"
            >
              {dropdownItems.length === 0 ? (
                <div className="search-dropdown-footer" role="status">
                  &ldquo;{query}&rdquo; için anlık eşleşme bulunamadı
                </div>
              ) : (
                <>
                  {dropdownItems.map((item, idx) => {
                    const title = displayTitle(item);
                    const saved = getSaved(item);
                    const kind = item.media_type === 'tv' ? 'Dizi' : 'Film';
                    const poster = getPoster(item);
                    const year = releaseYear(item);
                    const rating = Number(item.vote_average || 0);
                    const isActive = idx === activeIndex;

                    const statusLabel =
                      saved?.status === 'watching'
                        ? 'İzleniyor'
                        : saved?.status === 'completed'
                        ? 'İzlendi'
                        : saved?.status === 'watchlist'
                        ? 'Listede'
                        : '';

                    return (
                      <button
                        key={makeMediaKey(item)}
                        id={`search-opt-${idx}`}
                        ref={(el) => {
                          optionRefs.current[idx] = el;
                        }}
                        role="option"
                        aria-selected={isActive}
                        className={`search-dropdown-item ${isActive ? 'is-active' : ''}`}
                        type="button"
                        onMouseEnter={() => setActiveIndex(idx)}
                        onClick={() => {
                          setDropdownOpen(false);
                          setActiveIndex(-1);
                          onSelectItem(item);
                        }}
                      >
                        {poster ? (
                          <img
                            className="search-dropdown-thumb"
                            src={poster}
                            alt=""
                            referrerPolicy="no-referrer"
                            onError={(e) => handleImageError(e, poster, 'w92')}
                          />
                        ) : (
                          <div className="search-dropdown-thumb search-dropdown-thumb-fallback">
                            <svg className="icon">
                              <use href="#icon-film"></use>
                            </svg>
                          </div>
                        )}
                        <div className="search-dropdown-info">
                          <span className="search-dropdown-title">{title}</span>
                          <div className="search-dropdown-meta">
                            <span className="search-dropdown-badge">{kind}</span>
                            <span className="tabular-nums">{year || ''}</span>
                            {rating > 0 && <span className="tabular-nums">★ {rating.toFixed(1)}</span>}
                            {saved && (
                              <span className={`search-dropdown-badge search-dropdown-badge-saved status-${saved.status}`}>
                                {statusLabel}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  <button
                    className="search-dropdown-footer"
                    type="button"
                    onClick={() => {
                      setDropdownOpen(false);
                      setActiveIndex(-1);
                      onSearchSubmit(query);
                    }}
                  >
                    &ldquo;{query}&rdquo; için tüm sonuçları gör (Enter)
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Right Actions Zone: kaynak etiketi, ikincil menü, profil, ekle */}
        <div className="topbar-actions">
          {tmdbSource && tmdbSource !== 'live' && (
            <span
              className={`topbar-source-badge ${
                tmdbSource === 'stale-cache' ? 'source-stale' : 'source-demo'
              }`}
              title={
                tmdbSource === 'stale-cache'
                  ? `TMDB canlı servisi kapalı; önbellek sunuluyor${tmdbStaleReason ? ` (${tmdbStaleReason})` : ''}`
                  : 'Örnek katalog aktif'
              }
            >
              <span>{tmdbSource === 'stale-cache' ? 'Önbellek' : 'Demo'}</span>
            </span>
          )}

          <span className="header-secondary">
            <PWAInstallButton />
          </span>

          {onOpenTvdbStock && (
            <button
              type="button"
              className="btn tvdb-stock-btn header-secondary"
              onClick={onOpenTvdbStock}
              title={`TheTVDB v4 Stoğu: ${tvdbCount ?? 0} Yapım • İçe/Dışa Aktar`}
              aria-label={`TVDB stoğu: ${tvdbCount ?? 0} yapım, içe dışa aktar`}
            >
              <span className="tvdb-dot" aria-hidden="true" />
              <span className="tvdb-label">TVDB</span>
              <span
                className="tvdb-count tabular-nums"
                data-count={String(tvdbCount ?? 0)}
                aria-hidden="true"
              />
            </button>
          )}

          {/* Profile Switcher Button with Avatar Initial */}
          <button
            id="profileButton"
            className="btn profile-btn"
            type="button"
            onClick={onOpenProfile}
            aria-haspopup="dialog"
            aria-label={`Profil: ${profileName || 'Profilim'}`}
            title="Profil yönetimi ve ayarlar"
          >
            <span
              className="profile-avatar-circle"
              data-initial={avatarInitial}
              aria-hidden="true"
            />
            <span id="profileButtonLabel" className="profile-name-text">
              {profileName || 'Profilim'}
            </span>
          </button>

          <button
            id="addButton"
            className="btn btn-primary add-custom-btn"
            type="button"
            onClick={onOpenAdd}
            title="Özel film veya dizi ekle"
            aria-label="Özel yapım ekle"
          >
            <svg className="icon" aria-hidden="true">
              <use href="#icon-plus"></use>
            </svg>
            <span className="add-btn-text">Ekle</span>
          </button>

          {/* Mobil ikincil eylemler — dar ekranda asıl eylemleri gizlemeden menü. */}
          <details className="header-more" ref={moreRef}>
            <summary className="header-more-trigger" aria-label="Diğer işlemler ve kısayollar">
              <svg className="icon" aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="12" cy="5" r="1.9" fill="currentColor" />
                <circle cx="12" cy="12" r="1.9" fill="currentColor" />
                <circle cx="12" cy="19" r="1.9" fill="currentColor" />
              </svg>
            </summary>
            <div className="header-more-panel">
              {onOpenTvdbStock && (
                <button
                  type="button"
                  className="header-more-item"
                  onClick={() => {
                    if (moreRef.current) moreRef.current.open = false;
                    onOpenTvdbStock();
                  }}
                >
                  <span>TVDB Stoğu</span>
                  <span className="tabular-nums">{tvdbCount ?? 0}</span>
                </button>
              )}
              <div className="header-more-meta">
                <span>Katalog</span>
                <strong>
                  {tmdbSource === 'stale-cache'
                    ? 'Eski önbellek'
                    : tmdbSource === 'demo'
                    ? 'Örnek katalog'
                    : 'Canlı TMDB'}
                </strong>
              </div>
              <p className="header-more-hint">
                Kısayollar: <kbd>1-7</kbd> bölümler · <kbd>0</kbd> profil · <kbd>/</kbd> ara ·{' '}
                <kbd>N</kbd> ekle
              </p>
            </div>
          </details>
        </div>
      </div>
    </header>
  );
};
