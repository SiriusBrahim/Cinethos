import type { KeyboardEvent } from 'react';

/**
 * Tıklanabilir kapsayıcıları klavyeden de etkinleştirir (Enter/Space).
 * P1-08: `jsx-a11y/click-events-have-key-events` uyarısını gerçek davranışla çözer.
 */
export function activateOnKeyDown(handler: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handler();
  };
}
