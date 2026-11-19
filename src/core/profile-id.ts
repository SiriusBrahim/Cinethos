/**
 * Canonical profile identity shared by core, server, persistence and UI.
 *
 * Identity is deliberately ASCII after transliteration so directory names and
 * comparisons are stable across case-sensitive and case-insensitive systems.
 */
export const PROFILE_ID_PATTERN =
  /^(?:PROFILE-[A-Z0-9_-]{1,60}|PROFIL-[A-Z0-9_-]{1,60}|P\d{1,10})$/i;

const LATIN_TRANSLITERATION: Record<string, string> = {
  ß: "ss",
  ẞ: "ss",
  æ: "ae",
  Æ: "ae",
  œ: "oe",
  Œ: "oe",
  ø: "o",
  Ø: "o",
  ł: "l",
  Ł: "l",
  đ: "d",
  Đ: "d",
  ð: "d",
  Ð: "d",
  þ: "th",
  Þ: "th",
  ı: "i",
  İ: "i",
};

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function normalizeProfileId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (hasControlCharacter(value) || value.includes("/") || value.includes("\\")) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || trimmed.includes("..")) return null;

  let transliterated = "";
  for (const char of trimmed) {
    transliterated += LATIN_TRANSLITERATION[char] ?? char;
  }

  const canonical = transliterated
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toUpperCase();

  // Unsupported scripts/symbols are rejected, never silently stripped.
  if (!/^[A-Z0-9_-]+$/.test(canonical)) return null;
  if (canonical.length > 128 || !PROFILE_ID_PATTERN.test(canonical)) return null;
  return canonical;
}
