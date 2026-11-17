/**
 * MIA Faz 4 — Background Manager hata sınıflandırması.
 *
 * Geçici hatalar sınırlı backoff ile yeniden denenir; kalıcı hatalar tekrar
 * çalıştırılmaz. Profil çakışması ayrı ele alınır (görev yeni profile asla
 * uygulanmaz; yeniden planlanır veya deneme tükenince `failed` olur).
 */

export class RetryableBackgroundError extends Error {
  readonly retryable = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RetryableBackgroundError';
  }
}

export class PermanentBackgroundError extends Error {
  readonly retryable = false;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentBackgroundError';
  }
}

const TRANSIENT_MESSAGE_RE =
  /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|SQLITE_BUSY|SQLITE_LOCKED|429|500|502|503|504|transient|temporar)/i;

/** Bilinmeyen hatalar yalnızca açıkça geçici görünüyorsa yeniden denenir. */
export function isRetryableBackgroundError(error: unknown): boolean {
  if (error instanceof RetryableBackgroundError) return true;
  if (error instanceof PermanentBackgroundError) return false;
  if (error && typeof error === 'object' && (error as { retryable?: unknown }).retryable === true) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return TRANSIENT_MESSAGE_RE.test(message);
}

/** Deterministik backoff: base * 2^(attempt-1), üst sınır 30 sn. */
export function resolveRetryDelayMs(attempt: number, baseDelayMs = 250): number {
  const safeAttempt = Math.max(1, Math.floor(attempt));
  return Math.min(30_000, Math.max(10, baseDelayMs) * Math.pow(2, safeAttempt - 1));
}
