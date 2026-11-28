/**
 * B-20 — Tem bel bileşen yükleyici.
 *
 * Dinamik import geçici bir ağ hatasıyla başarısız olursa bir kez yeniden
 * denenir; ikinci başarısızlıkta hata React'e iletilir ve mevcut
 * `ErrorBoundary` devreye girer (uygulama çökmez).
 */

import React from 'react';

export interface LazyWithRetryOptions {
  /** Yeniden denemeden önce beklenecek süre (ms). */
  retryDelayMs?: number;
  /** Testlerde zamanlayıcı enjeksiyonu. */
  wait?: (delayMs: number) => Promise<void>;
}

/**
 * Dinamik import'u bir kez yeniden dener. İkinci deneme de başarısız olursa
 * ilk hata yeniden fırlatılır (React bunu ErrorBoundary'ye iletir).
 */
export async function loadWithRetry<T>(
  importer: () => Promise<T>,
  options: LazyWithRetryOptions = {}
): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? 250;
  const wait =
    options.wait ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  try {
    return await importer();
  } catch (firstError) {
    await wait(retryDelayMs);
    try {
      return await importer();
    } catch {
      throw firstError;
    }
  }
}

export function lazyWithRetry<T extends React.ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
  options: LazyWithRetryOptions = {}
): React.LazyExoticComponent<T> {
  return React.lazy(() => loadWithRetry(importer, options));
}
