/**
 * Tema yönetimi — açık / koyu / sistem.
 *
 * Tema `document.documentElement[data-theme]` üzerinden uygulanır; token
 * katmanı (`src/styles/tokens.css`) bu attribute'a göre renkleri değiştirir.
 * Mobil kabuk ise kendi `data-theme="dark"` kapsamını taşır.
 */

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'ct:theme';
const EVENT_NAME = 'cinetrack:theme-change';

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function getStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return isThemeMode(raw) ? raw : 'light';
  } catch {
    return 'light';
  }
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  }
  return mode;
}

export function applyTheme(mode: ThemeMode): ResolvedTheme {
  const resolved = resolveTheme(mode);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }
  return resolved;
}

export function setStoredTheme(mode: ThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* depolama kapalıysa tema yalnızca bu oturumda geçerli */
  }
  applyTheme(mode);
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { mode } }));
}

export function subscribeThemeChange(listener: (mode: ThemeMode) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => listener(getStoredTheme());
  window.addEventListener(EVENT_NAME, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(EVENT_NAME, handler);
    window.removeEventListener('storage', handler);
  };
}

/** Uygulama açılışında çağrılır; sistem teması seçiliyse değişiklikleri izler. */
export function initTheme(): void {
  if (typeof window === 'undefined') return;
  applyTheme(getStoredTheme());
  if (typeof window.matchMedia !== 'function') return;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (getStoredTheme() === 'system') applyTheme('system');
  };
  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange);
  }
}
