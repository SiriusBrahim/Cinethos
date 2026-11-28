/**
 * Dış veri sınırı doğrulaması (F5-09).
 *
 * GitHub / TMDB / TVDB yanıtları, yedek dosyaları ve senkronizasyon yükleri
 * güvenilir TypeScript tipleri DEĞİLDİR. Bu modül, projedeki mevcut
 * `normalize*` yaklaşımını yeniden kullanarak dış değerleri daraltan küçük
 * type guard'lar sağlar; yeni bir bağımlılık eklemez.
 *
 * İlkeler:
 * - Agresif normalizasyon yok: geçersiz değer `undefined` olur, sessizce
 *   varsayılana dönüştürülmez (çağıran karar verir).
 * - Kullanıcı verisi silinmez: yalnızca tip daraltma yapılır.
 */

/** Düz nesne (array/null hariç) kontrolü. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Dış yükü düz nesne olarak doğrular.
 * Geçersizse `null` döner; çağıran "veri yok" davranışını korur (throw etmez).
 */
export function asExternalRecord(value: unknown): Record<string, unknown> | null {
  return isPlainRecord(value) ? value : null;
}

/** Kırpılmış, boş olmayan ve `maxLength` sınırında bir metin döner. */
export function readString(value: unknown, maxLength = 4000): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** Pozitif güvenli tam sayı döner (id alanları için). */
export function readPositiveInteger(value: unknown): number | undefined {
  const num = Number(value);
  if (!Number.isSafeInteger(num) || num <= 0) return undefined;
  return num;
}

/** Sonlu sayı döner (puan/popülerlik alanları için). */
export function readFiniteNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

/** Yalnızca geçerli pozitif tam sayıları içeren bir dizi döner. */
export function readPositiveIntegerArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const entry of value) {
    const num = readPositiveInteger(entry);
    if (num !== undefined) out.push(num);
  }
  return out;
}
