import { useEffect, useRef, type RefObject } from 'react';

/**
 * P1-03 / Aşama 4 (B-28) — Modal ve overlay erişilebilirliği (tek kaynak).
 *
 * - Açılışta odağı ilk uygun kontrole (veya verilen `initialFocusRef`'e) taşır.
 * - Tab / Shift+Tab odağını dialog içinde tutar (focus trap).
 * - Escape yalnızca en üstteki dialogu kapatır.
 * - Kapanınca odağı açan elemana geri verir.
 * - Açıkken sayfa kaydırmasını kilitler ve kabuk bölgelerini (`inert`) erişim
 *   dışı bırakır; iç içe modallarda sayaçla yönetilir.
 *
 * İki çağrı biçimi desteklenir:
 *   useDialogAccessibility({ open, containerRef, onClose, initialFocusRef })
 *   const ref = useDialogAccessibility(open, onClose)   // eski çağrılar
 *
 * Önceden `src/utils/useDialogAccessibility.ts` aynı işi ikinci kez yapıyordu;
 * o kopya kaldırıldı ve çağıranlar buraya taşındı.
 */

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Açık dialogların yığını — yalnızca en üstteki klavye olaylarını işler. */
const dialogStack: HTMLElement[] = [];
/** Kaydırma kilidi referans sayacı (iç içe modallar). */
let scrollLockCount = 0;
let scrollLockSnapshot: { overflow: string; paddingRight: string } | null = null;
/** `inert` uygulanan kabuk bölgeleri. */
const SHELL_REGIONS = ['header.app-header', 'main.shell', 'footer', 'nav.mobile-tab-bar'];

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute('aria-hidden') && element.offsetParent !== null
  );
}

function lockScroll(): void {
  if (typeof document === 'undefined') return;
  scrollLockCount += 1;
  if (scrollLockCount > 1) return;
  const body = document.body;
  scrollLockSnapshot = {
    overflow: body.style.overflow,
    paddingRight: body.style.paddingRight,
  };
  const scrollbar = window.innerWidth - document.documentElement.clientWidth;
  body.style.overflow = 'hidden';
  if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
}

function unlockScroll(): void {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount > 0 || !scrollLockSnapshot) return;
  document.body.style.overflow = scrollLockSnapshot.overflow;
  document.body.style.paddingRight = scrollLockSnapshot.paddingRight;
  scrollLockSnapshot = null;
}

function setShellInert(inert: boolean): void {
  if (typeof document === 'undefined') return;
  // İç içe modal: sayaç sıfıra inmeden kabuk yeniden etkinleştirilmez.
  if (inert && scrollLockCount > 1) return;
  for (const selector of SHELL_REGIONS) {
    document.querySelectorAll<HTMLElement>(selector).forEach((element) => {
      if (inert) {
        element.setAttribute('inert', '');
        element.setAttribute('aria-hidden', 'true');
      } else {
        element.removeAttribute('inert');
        element.removeAttribute('aria-hidden');
      }
    });
  }
}

export interface DialogAccessibilityOptions {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose?: () => void;
  closeOnEscape?: boolean;
}

export function useDialogAccessibility(options: DialogAccessibilityOptions): void;
export function useDialogAccessibility(
  open: boolean,
  onClose: () => void
): RefObject<HTMLElement | null>;
export function useDialogAccessibility(
  optionsOrOpen: DialogAccessibilityOptions | boolean,
  legacyOnClose?: () => void
): void | RefObject<HTMLElement | null> {
  const legacyRef = useRef<HTMLElement | null>(null);
  const isLegacy = typeof optionsOrOpen === 'boolean';

  const open = isLegacy ? optionsOrOpen : optionsOrOpen.open;
  const containerRef = isLegacy
    ? legacyRef
    : (optionsOrOpen.containerRef as RefObject<HTMLElement | null>);
  const initialFocusRef = isLegacy ? undefined : optionsOrOpen.initialFocusRef;
  const closeOnEscape = isLegacy ? true : (optionsOrOpen.closeOnEscape ?? true);
  const onClose = isLegacy ? legacyOnClose : optionsOrOpen.onClose;

  // Satır içi `onClose` her render'da değişir; effect'i yeniden çalıştırıp
  // odağı tekrar çalmamak için ref'te tutulur.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const initialFocusRefLatest = useRef(initialFocusRef);
  initialFocusRefLatest.current = initialFocusRef;

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Cleanup sırasında ref değişmiş olabilir; açılıştaki kapsayıcıyı sakla.
    const containerAtOpen = containerRef.current;

    const focusTarget = () => {
      const container = containerRef.current;
      if (!container) return;
      const initial =
        initialFocusRefLatest.current?.current || getFocusable(container)[0] || container;
      initial.focus?.();
    };

    const raf = requestAnimationFrame(() => {
      if (containerAtOpen) {
        dialogStack.push(containerAtOpen);
        lockScroll();
        setShellInert(true);
      }
      focusTarget();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;
      // Yalnızca en üstteki dialog klavye olaylarını işler.
      if (dialogStack[dialogStack.length - 1] !== container) return;

      if (event.key === 'Escape' && closeOnEscape) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
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
      const index = containerAtOpen ? dialogStack.lastIndexOf(containerAtOpen) : -1;
      if (index >= 0) dialogStack.splice(index, 1);
      setShellInert(false);
      unlockScroll();
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open, closeOnEscape, containerRef]);

  return isLegacy ? legacyRef : undefined;
}
