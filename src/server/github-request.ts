/**
 * Faz 3 — GitHub API isteklerinin dayanıklı sarmalayıcısı.
 *
 * GitHub senkronizasyonu büyük JSON dosyalarını Contents/Git Blob API üzerinden
 * taşır. Ağ kesintisi, 5xx, birincil/ikincil rate limit ve 429 durumlarında
 * kontrollü bir exponential backoff uygulanır; `Retry-After` ve
 * `X-RateLimit-Reset` başlıklarına saygı duyulur.
 *
 * Kurallar:
 * - Yalnızca **güvenli biçimde tekrarlanabilir** hatalar yeniden denenir (ağ hatası, 408,
 *   429, 5xx, rate-limit 403). 401/404/409 yeniden denenmez (çağıran tarafta
 *   özel işlem gerekir).
 * - Üstel geri çekilme beklemesi sınırlıdır; sunucunun `Retry-After` ve reset süreleri kırpılmadan uygulanır. Jitter deterministik tohumla üretilebilir;
 *   testler saat/uyku bağımlılığını enjekte ederek hızlı koşar.
 * - İstek gövdesi yeniden kullanılabilir olmalıdır (string/Buffer) — GitHub
 *   PUT istekleri aynı içerikle idempotenttir.
 */

export interface GitHubRetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly onRetry?: (info: GitHubRetryInfo) => void;
}

export interface GitHubRetryInfo {
  readonly attempt: number;
  readonly delayMs: number;
  readonly reason: 'network' | 'rate_limit' | 'server_error';
  readonly status?: number;
}

export const GITHUB_RETRY_DEFAULTS = {
  maxAttempts: 4,
  baseDelayMs: 400,
  maxDelayMs: 8_000,
} as const;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headerNumber(headers: Headers | undefined, name: string): number | null {
  const raw = headers?.get(name);
  if (raw === null || raw === undefined || raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/** Rate limit / geçici sunucu hatası mı? */
export function isRetryableGitHubStatus(status: number, headers?: Headers): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  if (status === 403) {
    const remaining = headerNumber(headers, 'x-ratelimit-remaining');
    return remaining === 0 || headerNumber(headers, 'retry-after') !== null;
  }
  return false;
}

/**
 * Yeniden deneme öncesi beklenecek süre.
 * Öncelik: `Retry-After` → `X-RateLimit-Reset` (remaining=0) → exponential backoff.
 */
export function computeGitHubRetryDelayMs(
  attempt: number,
  response: Response | null,
  options: GitHubRetryOptions = {}
): number {
  const base = options.baseDelayMs ?? GITHUB_RETRY_DEFAULTS.baseDelayMs;
  const max = options.maxDelayMs ?? GITHUB_RETRY_DEFAULTS.maxDelayMs;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const headers = response?.headers;

  const retryAfterRaw = headers?.get('retry-after');
  if (retryAfterRaw) {
    const asSeconds = Number(retryAfterRaw);
    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.round(asSeconds * 1000);
    }
    const asDate = Date.parse(retryAfterRaw);
    if (Number.isFinite(asDate)) {
      return Math.max(0, asDate - now());
    }
  }

  const remaining = headerNumber(headers, 'x-ratelimit-remaining');
  const resetSeconds = headerNumber(headers, 'x-ratelimit-reset');
  if (remaining === 0 && resetSeconds !== null) {
    const waitMs = resetSeconds * 1000 - now();
    if (waitMs > 0) return Math.max(base, Math.round(waitMs));
  }

  const exponential = base * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(random() * Math.min(250, base));
  return Math.min(max, exponential + jitter);
}

/**
 * GitHub API isteği; geçici hatalarda yeniden dener. Başarısız olursa son
 * yanıtı döndürür (çağıran HTTP durumunu raporlar) veya ağ hatasını fırlatır.
 */
export async function githubFetch(
  url: string,
  init: RequestInit = {},
  options: GitHubRetryOptions = {}
): Promise<Response> {
  const maxAttempts = Math.max(1, Math.min(8, options.maxAttempts ?? GITHUB_RETRY_DEFAULTS.maxAttempts));
  const sleep = options.sleep ?? defaultSleep;

  let lastError: unknown = null;
  let lastResponse: Response | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!isRetryableGitHubStatus(response.status, response.headers)) {
        return response;
      }
      lastResponse = response;
      if (attempt >= maxAttempts) return response;
      const reason = response.status === 429 || response.status === 403 ? 'rate_limit' : 'server_error';
      const delayMs = computeGitHubRetryDelayMs(attempt, response, options);
      options.onRetry?.({ attempt, delayMs, reason, status: response.status });
      // Yanıt gövdesini tüketmeden bırak (bağlantı yeniden kullanılamaz ama
      // bellek şişmez); GitHub hata gövdesi çağırana gerekmiyor.
      try {
        await response.body?.cancel();
      } catch {}
      await sleep(delayMs);
      continue;
    } catch (error) {
      lastError = error;
      lastResponse = null;
      if (attempt >= maxAttempts) break;
      const delayMs = computeGitHubRetryDelayMs(attempt, null, options);
      options.onRetry?.({ attempt, delayMs, reason: 'network' });
      await sleep(delayMs);
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error
    ? lastError
    : new Error('GitHub isteği ağ hatası nedeniyle tamamlanamadı.');
}
