/**
 * Aşama 2 (B-30) — İstemci HTTP isteklerinde sınırlı retry/backoff.
 *
 * Önceden 429 yanıtı doğrudan hataya dönüşüyordu; `Retry-After` okunmuyor,
 * backoff/jitter uygulanmıyordu. Bu yardımcı:
 *
 * - Yalnızca **güvenle tekrarlanabilir** istekleri (varsayılan GET/HEAD)
 *   yeniden dener; POST/PUT/PATCH/DELETE tek denemede kalır (çift yazma yok).
 * - 408, 429, 5xx ve ağ hatalarını geçici sayar; 400/401/403/404/409 kalıcıdır.
 * - `Retry-After` (saniye veya HTTP tarihi) ve `X-RateLimit-Reset` başlıklarına
 *   uyar; üst sınırla kırpar.
 * - Aksi halde `min(maxDelay, base * 2^(attempt-1)) + jitter` uygular.
 * - Abort sinyalini beklerken de dinler; iptal edilen istek yeniden denenmez.
 *
 * Zaman/rastgelelik enjekte edilebilir; testler gerçek süre beklemez.
 */

export interface HttpRetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly jitterMs?: number;
  readonly maxRetryAfterMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly signal?: AbortSignal;
  readonly allowNonIdempotent?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly onRetry?: (info: HttpRetryInfo) => void;
}

export interface HttpRetryInfo {
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: 'network' | 'rate_limit' | 'server_error' | 'timeout';
  readonly status?: number;
}

export const HTTP_RETRY_DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  jitterMs: 250,
  maxRetryAfterMs: 30_000,
} as const;

const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function abortError(): Error {
  const error = new Error('İstek iptal edildi.');
  error.name = 'AbortError';
  return error;
}

function headerNumber(headers: Headers | undefined, name: string): number | null {
  const raw = headers?.get(name);
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function isRetryableHttpStatus(status: number, headers?: Headers): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (status === 403) {
    return headerNumber(headers, 'x-ratelimit-remaining') === 0;
  }
  return false;
}

export function computeHttpRetryDelayMs(
  attempt: number,
  response: Response | null,
  options: HttpRetryOptions = {}
): number {
  const base = Math.max(10, options.baseDelayMs ?? HTTP_RETRY_DEFAULTS.baseDelayMs);
  const max = Math.max(base, options.maxDelayMs ?? HTTP_RETRY_DEFAULTS.maxDelayMs);
  const maxRetryAfter = Math.max(
    0,
    options.maxRetryAfterMs ?? HTTP_RETRY_DEFAULTS.maxRetryAfterMs
  );
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const headers = response?.headers;

  const retryAfterRaw = headers?.get('retry-after');
  if (retryAfterRaw) {
    const seconds = Number(retryAfterRaw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(maxRetryAfter, Math.round(seconds * 1000));
    }
    const asDate = Date.parse(retryAfterRaw);
    if (Number.isFinite(asDate)) {
      return Math.min(maxRetryAfter, Math.max(0, asDate - now()));
    }
  }

  const remaining = headerNumber(headers, 'x-ratelimit-remaining');
  const resetSeconds = headerNumber(headers, 'x-ratelimit-reset');
  if (remaining === 0 && resetSeconds !== null) {
    const waitMs = resetSeconds * 1000 - now();
    if (waitMs > 0) return Math.min(maxRetryAfter, Math.max(base, Math.round(waitMs)));
  }

  const exponential = base * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.max(0, random()) * (options.jitterMs ?? HTTP_RETRY_DEFAULTS.jitterMs));
  return Math.min(max, exponential + jitter);
}

async function waitFor(ms: number, signal: AbortSignal | undefined, sleep?: (ms: number) => Promise<void>): Promise<void> {
  if (ms <= 0) return;
  if (sleep) {
    await sleep(ms);
    if (signal?.aborted) throw abortError();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    (timer as { unref?: () => void }).unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `fetch` + sınırlı retry. Son geçici hatada son yanıtı döndürür; ağ hatasında
 * son hatayı fırlatır. Abort her zaman anında fırlatılır (retry edilmez).
 */
export async function fetchWithHttpRetry(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: HttpRetryOptions = {}
): Promise<Response> {
  const method = String(init.method || 'GET').toUpperCase();
  const idempotent = IDEMPOTENT_METHODS.has(method) || options.allowNonIdempotent === true;
  const maxAttempts = idempotent
    ? Math.max(1, Math.min(6, options.maxAttempts ?? HTTP_RETRY_DEFAULTS.maxAttempts))
    : 1;
  const doFetch = options.fetchImpl ?? fetch;
  const signal = options.signal ?? init.signal ?? undefined;

  let lastResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw abortError();
    try {
      const response = await doFetch(input, { ...init, signal });
      if (!isRetryableHttpStatus(response.status, response.headers)) {
        return response;
      }
      lastResponse = response;
      lastError = null;
      if (attempt >= maxAttempts) return response;
      const reason: HttpRetryInfo['reason'] =
        response.status === 429 || response.status === 403 ? 'rate_limit' : 'server_error';
      const delayMs = computeHttpRetryDelayMs(attempt, response, options);
      options.onRetry?.({ attempt, delayMs, reason, status: response.status });
      try {
        await response.body?.cancel();
      } catch {
        // Gövde iptal edilemezse bellek şişmesin diye yoksayılır.
      }
      await waitFor(delayMs, signal, options.sleep);
    } catch (error) {
      if ((error as Error)?.name === 'AbortError' || signal?.aborted) throw error;
      lastError = error;
      lastResponse = null;
      if (attempt >= maxAttempts) break;
      const delayMs = computeHttpRetryDelayMs(attempt, null, options);
      options.onRetry?.({ attempt, delayMs, reason: 'network' });
      await waitFor(delayMs, signal, options.sleep);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error ? lastError : new Error('Ağ isteği tamamlanamadı.');
}
