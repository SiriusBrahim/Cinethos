import { useEffect, useRef } from 'react';
import type { ModuleId } from '../app/module-registry.ts';
import { SETTINGS_SHORTCUT, SHORTCUT_TAB_MAP } from '../app/navigation.ts';
import { shouldHandleGlobalShortcut } from '../utils/overlay-guard.ts';

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
 *
 * Aşama 4 (B-29): dinleyici bir kez bağlanır — `handlers` nesnesi her render'da
 * yeniden oluşturulduğu için effect bağımlılığına konulduğunda her render'da
 * yeniden bağlanıyordu. Güncel işleyiciler ref'te tutulur. Modal açıkken veya
 * bir metin alanına yazarken kısayol tetiklenmez (tek `overlay-guard` kaynağı).
 */
export function useKeyboardShortcuts(handlers: KeyboardShortcutsHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const current = handlersRef.current;

      if (e.key === 'Escape') {
        current.onEscape?.();
        return;
      }

      if (!shouldHandleGlobalShortcut(e)) return;

      if (e.key === '/') {
        e.preventDefault();
        current.onFocusSearch?.();
        return;
      }

      const targetTab = SHORTCUT_TAB_MAP[e.key];
      if (targetTab) {
        e.preventDefault();
        current.onSelectTab?.(targetTab);
        return;
      }

      if (e.key === SETTINGS_SHORTCUT) {
        e.preventDefault();
        current.onOpenSettings?.();
        return;
      }

      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        current.onQuickSaveOrSync?.();
        return;
      }

      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        current.onOpenAddCustom?.();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
