import { useEffect } from 'react';
import type { ModuleId } from '../app/module-registry.ts';
import { SETTINGS_SHORTCUT, SHORTCUT_TAB_MAP } from '../app/navigation.ts';

export interface KeyboardShortcutsHandlers {
  onFocusSearch?: () => void;
  onSelectTab?: (tab: ModuleId) => void;
  onOpenSettings?: () => void;
  onQuickSaveOrSync?: () => void;
  onOpenAddCustom?: () => void;
  onEscape?: () => void;
}

/**
 * Klavye kısayolları.
 *
 * Sekme kısayolları modül kayıt defterinden türetilir (`SHORTCUT_TAB_MAP`);
 * burada ikinci bir tuş↔sekme tablosu tutulmaz. `0` profil/ayarlar penceresini
 * açar, `/` aramaya odaklanır.
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutsHandlers): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handlers.onEscape?.();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (e.key === '/') {
        e.preventDefault();
        handlers.onFocusSearch?.();
        return;
      }

      const targetTab = SHORTCUT_TAB_MAP[e.key];
      if (targetTab) {
        e.preventDefault();
        handlers.onSelectTab?.(targetTab);
        return;
      }

      if (e.key === SETTINGS_SHORTCUT) {
        e.preventDefault();
        handlers.onOpenSettings?.();
        return;
      }

      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        handlers.onQuickSaveOrSync?.();
        return;
      }

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        handlers.onOpenAddCustom?.();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlers]);
}
