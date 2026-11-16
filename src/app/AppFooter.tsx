import React from 'react';
import { BRAND_NAME } from '../shared/brand.ts';

interface AppFooterProps {
  tmdbSource: string;
}

export const AppFooter: React.FC<AppFooterProps> = ({ tmdbSource }) => {
  const sourceLabel =
    tmdbSource === 'live'
      ? 'Canlı TMDB API'
      : tmdbSource === 'stale-cache'
        ? 'Eski Önbellek (Çevrimdışı)'
        : tmdbSource === 'demo'
          ? 'Örnek Katalog'
          : 'Bağlantı Bekleniyor';

  return (
    <footer className="app-footer">
      <div className="shell footer-shell">
        <div className="footer-brand-note">
          <strong className="footer-brand-name">{BRAND_NAME}</strong>
          <span className="footer-sep" aria-hidden="true">·</span>
          <span>
            Kişisel listen bu tarayıcıda saklanır. Katalog kaynağı:{' '}
            <a
              href="https://www.themoviedb.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-link"
            >
              TMDB
            </a>
          </span>
        </div>

        <div className="footer-right-group">
          <div className="footer-source-status">
            <span className={`footer-source-dot ${tmdbSource === 'live' ? 'is-live' : ''}`} aria-hidden="true" />
            <span>{sourceLabel}</span>
          </div>

          <div className="footer-shortcuts-hint">
            <kbd className="footer-kbd">1-4</kbd> Sekme
            <span className="footer-sep" aria-hidden="true">·</span>
            <kbd className="footer-kbd">/</kbd> Ara
            <span className="footer-sep" aria-hidden="true">·</span>
            <kbd className="footer-kbd">S</kbd> Eşitle
            <span className="footer-sep" aria-hidden="true">·</span>
            <kbd className="footer-kbd">N</kbd> Ekle
            <span className="footer-sep" aria-hidden="true">·</span>
            <kbd className="footer-kbd">Esc</kbd> Kapat
          </div>
        </div>
      </div>
    </footer>
  );
};
