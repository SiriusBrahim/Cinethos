import { useEffect, type RefObject } from 'react';

/**
 * P1-03: Modal/dialog erişilebilirliği.
 *
 * - Açılışta odağı ilk uygun kontrole taşır.
 * - Tab / Shift+Tab odağını dialog içinde tutar (focus trap).
 * - Escape ile kapatır.
 * - Kapanınca odağı açan elemana geri verir.
 *
 * Projedeki diğer modallar `role="dialog" aria-modal="true"` kullanıyor; ortak
 * davranış burada tek yerde tutuluyor ki her modal kendi kopyasını yazmasın.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hasAttribute('aria-hidden') &&
      element.offsetParent !== null
  );
}

export interface DialogAccessibilityOptions {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose?: () => void;
  closeOnEscape?: boolean;
}

export function useDialogAccessibility({
  open,
  containerRef,
  initialFocusRef,
  onClose,
  closeOnEscape = true,
}: DialogAccessibilityOptions): void {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusTarget = () => {
      const container = containerRef.current;
      if (!container) return;
      const initial = initialFocusRef?.current || getFocusable(container)[0] || container;
      initial.focus?.();
    };

    // Dialog DOM'a girdikten sonra odaklan.
    const raf = requestAnimationFrame(focusTarget);

    const onKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;

      if (event.key === 'Escape' && closeOnEscape) {
        event.preventDefault();
        onClose?.();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus?.();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (!active || !container.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }

      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', onKeyDown, true);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open, containerRef, initialFocusRef, onClose, closeOnEscape]);
}
