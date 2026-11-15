import { useEffect } from 'react';
import type { ModuleId } from '../app/module-registry.ts';
import { getModuleByShortcut } from '../app/module-registry.ts';

export interface KeyboardShortcutsHandlers {
  onFocusSearch?: () => void;
  onSelectTab?: (tab: ModuleId) => void;
  onOpenSettings?: () => void;
  onQuickSaveOrSync?: () => void;
  onOpenAddCustom?: () => void;
  onOpenCommandPalette?: () => void;
  onEscape?: () => void;
}

export function useKeyboardShortcuts(handlers: KeyboardShortcutsHandlers): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept shortcut modifiers (Ctrl, Meta, Alt) except Escape
      if (e.key === 'Escape') {
        handlers.onEscape?.();
        return;
      }

      // Cmd+K / Ctrl+K opens the command palette from anywhere, inputs included
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.onOpenCommandPalette?.();
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

      // / focuses search bar
      if (e.key === '/') {
        e.preventDefault();
        handlers.onFocusSearch?.();
        return;
      }

      // 1-4 → kayıtlı modüller (module-registry'den), 5 → ayarlar
      const moduleByShortcut = getModuleByShortcut(e.key);
      if (moduleByShortcut) {
        e.preventDefault();
        handlers.onSelectTab?.(moduleByShortcut.id);
        return;
      }
      if (e.key === '5') {
        e.preventDefault();
        handlers.onOpenSettings?.();
        return;
      }

      // s / S triggers quick save or sync
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        handlers.onQuickSaveOrSync?.();
        return;
      }

      // n / N opens add custom item
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
