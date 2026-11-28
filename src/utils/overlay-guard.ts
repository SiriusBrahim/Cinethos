/**
 * Aşama 4 (B-29) — Global kısayollar için tek katman koruması.
 *
 * Modal, drawer veya mobil menü açıkken arka plan kısayolları (sekme tuşları,
 * `/` arama, `S`/`N` eylemleri) çalışmamalı. Bu kontrol tek yerde tutulur:
 * `useKeyboardShortcuts` ve Header'ın arama kısayolu aynı fonksiyonu kullanır.
 *
 * Daha önce her dinleyici kendi kontrolünü yazıyordu; iki ayrı `/` dinleyicisi
 * (Header + kabuk) aynı tuşta çakışabiliyordu.
 */

const OVERLAY_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[data-overlay-open="true"]',
].join(',');

/** Ekranda açık bir modal/overlay var mı? */
export function isOverlayOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

/** Olay hedefi metin girişi mi? (input, textarea, select, contenteditable) */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable
  );
}

/**
 * Kısayol dinleyicisinin bu olayı işleyip işlemeyeceğine karar verir.
 * Modifier tuşları, metin girişi ve açık overlay durumlarında `false` döner.
 */
export function shouldHandleGlobalShortcut(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isTypingTarget(event.target)) return false;
  if (isOverlayOpen()) return false;
  return true;
}
