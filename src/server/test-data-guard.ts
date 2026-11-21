/**
 * Aşama 1 — Test veri yolu koruması (B-14, N-04).
 *
 * Amaç: test süreci gerçek kullanıcı veri dizinine (`<repo>/data`) yazamaz.
 * Koruma test yazarının iyi niyetine bırakılmaz; dosya sistemine yazan tüm
 * giriş noktaları (`createDataStorage`, taste store) bu modülden geçer.
 *
 * Kurallar:
 * 1. Test ortamında `dataDir` açıkça verilmek zorundadır (sessiz `cwd/data`
 *    varsayılanı yasaktır).
 * 2. Test ortamında çözümlenen yol gerçek `data/` ağacının içinde olamaz.
 * 3. `path.resolve()` tek başına yeterli değildir: sembolik bağlantılar
 *    (iç içe olanlar dâhil) bileşen bileşen çözümlenir ve gerçek hedef
 *    üzerinden karşılaştırma yapılır. Hedef henüz yoksa en yakın var olan
 *    üst dizin çözümlenir, kalan bileşenler güvenli biçimde eklenir.
 * 4. Yazma anında yol yeniden doğrulanır: doğrulamadan sonra bir dizin
 *    sembolik bağlantıya çevrilirse yazma yine reddedilir (TOCTOU).
 * 5. Üretim/CLI çalışmasında bu modül hiçbir şeyi engellemez.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_SYMLINK_HOPS = 40;

/** Node test runner alt süreçlerinde ve açıkça işaretlenmiş koşullarda true. */
export function isTestEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CINETRACK_TEST_MODE === '1') return true;
  if (env.NODE_ENV === 'test') return true;
  // `node --test` her test dosyasını ayrı alt süreçte çalıştırır ve bu değişkeni set eder.
  if (typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT.length > 0) return true;
  return false;
}

/** Test ortamında kullanılacak veri kökü: açık env değeri ya da `data`. */
export function resolveDefaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = (env.CINETRACK_DATA_DIR || '').trim();
  return envDir || 'data';
}

/** Gerçek kullanıcı veri dizini (repo kökü altındaki `data/`). */
export function realUserDataDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, 'data');
}

/**
 * Karşılaştırma biçimi: mutlak, normalleştirilmiş ve Windows'ta büyük/küçük
 * harf duyarsız. Ayırıcılar platforma göre normalize edilir.
 */
function normalizeForCompare(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = normalizeForCompare(parent);
  const normalizedChild = normalizeForCompare(child);
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(normalizedParent + path.sep)
  );
}

/**
 * Sembolik bağlantıları bileşen bileşen çözümler.
 *
 * - Var olmayan son bileşenler sözlüksel olarak korunur; en yakın var olan
 *   üst dizin gerçek hedefiyle değiştirilir.
 * - İç içe bağlantılar ve bağlantının işaret ettiği yolda kalan bileşenler de
 *   çözümlenir.
 * - Döngüsel/çok derin zincirler sessizce kabul edilmez, açık hata verir.
 */
function resolveSymlinks(absolutePath: string, hops: number): string {
  if (hops > MAX_SYMLINK_HOPS) {
    throw new Error(
      `Sembolik bağlantı zinciri çok derin veya döngüsel (${MAX_SYMLINK_HOPS} atlama sınırı): ${absolutePath}`
    );
  }

  const { root } = path.parse(absolutePath);
  const segments = absolutePath.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    const candidate = path.join(current, segments[index]);
    let stat: fs.Stats | null = null;
    try {
      stat = fs.lstatSync(candidate);
    } catch {
      stat = null;
    }

    if (!stat) {
      // Yolun bu noktadan sonrası henüz yok: çözümlenmiş öneki koru.
      return path.join(current, ...segments.slice(index));
    }

    if (stat.isSymbolicLink()) {
      let linkTarget: string;
      try {
        linkTarget = fs.readlinkSync(candidate);
      } catch {
        return path.join(current, ...segments.slice(index));
      }
      const absoluteTarget = path.resolve(path.dirname(candidate), linkTarget);
      const resolvedTarget = resolveSymlinks(absoluteTarget, hops + 1);
      const remaining = segments.slice(index + 1);
      return resolveSymlinks(path.join(resolvedTarget, ...remaining), hops + 1);
    }

    current = candidate;
  }

  return current;
}

/** Bir yolu, sembolik bağlantıları çözerek kanonik hâline getirir. */
export function canonicalizePath(target: string, cwd: string = process.cwd()): string {
  return resolveSymlinks(path.resolve(cwd, target), 0);
}

export type DataDirGuardKind = 'data-storage' | 'taste-store';

/**
 * Test ortamında veri dizini politikasını zorunlu kılar.
 * Üretimde no-op'tur; testte ihlalde açık hata fırlatır.
 */
export function assertSafeDataDir(
  dataDir: string | undefined | null,
  kind: DataDirGuardKind
): void {
  if (!isTestEnvironment()) return;

  const raw = typeof dataDir === 'string' ? dataDir.trim() : '';
  if (!raw) {
    throw new Error(
      `[test-guard] ${kind}: test ortamında 'dataDir' zorunludur. ` +
        `Geçici bir dizin verin (ör. fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-'))).`
    );
  }

  const lexical = path.resolve(raw);
  const userDataDir = realUserDataDir();

  // 1) Sözlüksel kontrol (hızlı yol).
  if (isInside(userDataDir, lexical)) {
    throw new Error(
      `[test-guard] ${kind}: gerçek kullanıcı veri dizinine (${userDataDir}) test sırasında yazılamaz. ` +
        `Çözümlenen yol: ${lexical}. Geçici bir dizin kullanın.`
    );
  }

  // 2) Sembolik bağlantıların gerçek hedefi üzerinden kontrol.
  let realCandidate: string;
  let realUserData: string;
  try {
    realUserData = canonicalizePath(userDataDir);
    realCandidate = canonicalizePath(lexical);
  } catch (error: any) {
    throw new Error(
      `[test-guard] ${kind}: veri dizini yolu güvenli biçimde çözümlenemedi. ` +
        `Yol: ${lexical}. Neden: ${error?.message || 'bilinmeyen hata'}`
    );
  }

  if (isInside(realUserData, realCandidate)) {
    throw new Error(
      `[test-guard] ${kind}: gerçek kullanıcı veri dizinine (${realUserData}) sembolik bağlantı ` +
        `üzerinden dahi test sırasında yazılamaz. Verilen yol: ${lexical}. ` +
        `Gerçek hedef: ${realCandidate}. Geçici bir dizin kullanın.`
    );
  }
}

/**
 * Yazma anında yeniden doğrulama (TOCTOU).
 *
 * `createDataStorage` gibi kurucular yolu bir kez doğrular; ancak doğrulamadan
 * sonra bir dizin sembolik bağlantıyla değiştirilebilir. Her yazmadan hemen
 * önce hedef dosyanın üst dizini yeniden çözümlenir ve gerçek hedef kontrol
 * edilir. Üretimde no-op'tur.
 */
export function assertSafeWritePath(targetPath: string, kind: DataDirGuardKind): void {
  if (!isTestEnvironment()) return;
  const absolute = path.resolve(targetPath);
  assertSafeDataDir(path.dirname(absolute), kind);
}

/** Test yardımcıları için: verilen yol gerçek veri ağacında mı? */
export function isRealUserDataPath(target: string, cwd: string = process.cwd()): boolean {
  const userDataDir = realUserDataDir(cwd);
  const absolute = path.resolve(cwd, target);
  if (isInside(userDataDir, absolute)) return true;
  try {
    return isInside(canonicalizePath(userDataDir), canonicalizePath(absolute));
  } catch {
    return true; // Çözümlenemeyen yollar güvenli tarafta kalır.
  }
}
