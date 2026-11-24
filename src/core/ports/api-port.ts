/**
 * Çekirdek API portu (F5-04).
 *
 * Çekirdek katmanı somut istemci API'sine (`src/services/api-client.ts`)
 * bağımlı olmaz. Uygulama katmanı bu portu kaydeder; çekirdek yalnızca portu
 * çağırır. Böylece core → services bağımlılığı kalkar, davranış (LAN token'ı,
 * 401/503 bildirimi, HTTP retry) adaptörde aynen korunur.
 */

/** `apiFetch` ile birebir aynı çağrı yüzeyi (retry seçenekleri dahil). */
export type CoreApiFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
  retryOptions?: Record<string, unknown>
) => Promise<Response>;

let activeFetch: CoreApiFetch | null = null;

/** Uygulama katmanındaki adaptörü kaydeder (idempotent). */
export function registerApiFetchPort(fetchImpl: CoreApiFetch): void {
  activeFetch = fetchImpl;
}

export function getApiFetchPort(): CoreApiFetch | null {
  return activeFetch;
}

/** Test izolasyonu: kayıtlı portu temizler. */
export function resetApiFetchPortForTests(): void {
  activeFetch = null;
}

/**
 * Port üzerinden istek atar. Port kayıtlı değilse sessizce yutmaz; çağıranın
 * hatayı görünür biçimde alması için açık bir hata fırlatır.
 */
export function coreApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  retryOptions?: Record<string, unknown>
): Promise<Response> {
  if (!activeFetch) {
    throw new Error(
      'Çekirdek API portu kayıtlı değil: uygulama katmanı registerApiFetchPort() çağırmalı.'
    );
  }
  return activeFetch(input, init, retryOptions);
}
