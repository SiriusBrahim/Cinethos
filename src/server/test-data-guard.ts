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
 * 4. Dosya sistemi hataları körlemesine "yol yok" sayılmaz: yalnızca `ENOENT`
 *    beklenen "yok" durumudur. `EACCES`, `EIO`, `ENOTDIR`, `ELOOP` gibi
 *    hatalarda doğrulama durur ve yazmaya izin verilmez (fail-closed).
 * 5. Yazma, iki fazlı bir kapıdan geçer: `beginGuardedWrite` yolu doğrular ve
 *    dizin zincirinin kimliğini (dev+inode) fotoğraflar; `completeGuardedWrite`
 *    bekleyen asenkron işten hemen önce yolu ve kimliği yeniden doğrular.
 *    Böylece doğrulama ile yazma arasındaki asenkron boşlukta yapılan bir
 *    symlink/rename değişimi yakalanır.
 * 6. Üretim/CLI çalışmasında bu modül hiçbir şeyi engellemez.
 *
 * Kalan sınır: Node çekirdeği `openat`/`renameat` sunmaz; bu yüzden son
 * doğrulama ile `rename(2)` sistem çağrısı arasında kalan birkaç mikro saniyelik
 * pencere tamamen kapatılamaz. Kapatılan şey, gerçek yazma yollarındaki uzun
 * asenkron beklemelerdir (snapshot, okuma, kilit); kalan pencere belgelenmiştir.
 */

import fs from 'node:fs';
import path from 'node:path';

const MAX_SYMLINK_HOPS = 40;
const MAX_GUARD_CHAIN_DEPTH = 64;

/** Koruma ihlalleri; çağıranlar `instanceof` ile ayırt edebilir. */
export class TestDataGuardError extends Error {
  public readonly guardCode: string;

  constructor(message: string, guardCode = 'guard_violation') {
    super(`[test-guard] ${message}`);
    this.name = 'TestDataGuardError';
    this.guardCode = guardCode;
  }
}

export function isTestDataGuardError(error: unknown): error is TestDataGuardError {
  return error instanceof TestDataGuardError;
}

function guardError(message: string, guardCode?: string): TestDataGuardError {
  return new TestDataGuardError(message, guardCode);
}

function errorCodeOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

/**
 * `lstat` sonucu: yalnızca `ENOENT` "bu bileşen henüz yok" demektir.
 * Diğer hatalar (izin, I/O, döngü, dizin-değil) doğrulamayı durdurur.
 */
function lstatOrNull(candidate: string): fs.Stats | null {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if (errorCodeOf(error) === 'ENOENT') return null;
    throw guardError(
      `dosya sistemi hatası (${errorCodeOf(error)}) nedeniyle yol doğrulanamadı: ${candidate}`,
      'fs_error'
    );
  }
}

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
 * - Döngüsel/çok derin zincirler ve `ENOENT` dışı dosya sistemi hataları
 *   sessizce kabul edilmez; açık hata verir.
 */
function resolveSymlinks(absolutePath: string, hops: number): string {
  if (hops > MAX_SYMLINK_HOPS) {
    throw guardError(
      `Sembolik bağlantı zinciri çok derin veya döngüsel (${MAX_SYMLINK_HOPS} atlama sınırı): ${absolutePath}`,
      'symlink_loop'
    );
  }

  const { root } = path.parse(absolutePath);
  const segments = absolutePath.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;

  for (let index = 0; index < segments.length; index += 1) {
    const candidate = path.join(current, segments[index]);
    const stat = lstatOrNull(candidate);

    if (!stat) {
      // Yolun bu noktadan sonrası henüz yok: çözümlenmiş öneki koru.
      return path.join(current, ...segments.slice(index));
    }

    if (stat.isSymbolicLink()) {
      let linkTarget: string;
      try {
        linkTarget = fs.readlinkSync(candidate);
      } catch (error) {
        // lstat bağlantı gördüyse okuma da başarılı olmalıydı; burada "yok"
        // varsayımı üretmek güvenli değildir.
        throw guardError(
          `sembolik bağlantı okunamadı (${errorCodeOf(error)}): ${candidate}`,
          'symlink_read_failed'
        );
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
    throw guardError(
      `${kind}: test ortamında 'dataDir' zorunludur. ` +
        `Geçici bir dizin verin (ör. fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-'))).`,
      'missing_data_dir'
    );
  }

  const lexical = path.resolve(raw);
  const userDataDir = realUserDataDir();

  // 1) Sözlüksel kontrol (hızlı yol).
  if (isInside(userDataDir, lexical)) {
    throw guardError(
      `${kind}: gerçek kullanıcı veri dizinine (${userDataDir}) test sırasında yazılamaz. ` +
        `Çözümlenen yol: ${lexical}. Geçici bir dizin kullanın.`,
      'real_data_dir'
    );
  }

  // 2) Sembolik bağlantıların gerçek hedefi üzerinden kontrol.
  let realCandidate: string;
  let realUserData: string;
  try {
    realUserData = canonicalizePath(userDataDir);
    realCandidate = canonicalizePath(lexical);
  } catch (error: any) {
    if (error instanceof TestDataGuardError) throw error;
    throw guardError(
      `${kind}: veri dizini yolu güvenli biçimde çözümlenemedi. ` +
        `Yol: ${lexical}. Neden: ${error?.message || 'bilinmeyen hata'}`,
      'resolution_failed'
    );
  }

  if (isInside(realUserData, realCandidate)) {
    throw guardError(
      `${kind}: gerçek kullanıcı veri dizinine (${realUserData}) sembolik bağlantı ` +
        `üzerinden dahi test sırasında yazılamaz. Verilen yol: ${lexical}. ` +
        `Gerçek hedef: ${realCandidate}. Geçici bir dizin kullanın.`,
      'symlink_to_real_data'
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

// === İki fazlı yazma kapısı ================================================

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

export interface GuardedWriteHandle {
  targetPath: string;
  dirPath: string;
  /** Doğrulanmış en derin var olan dizin. */
  anchorPath: string;
  /** Kökten `anchorPath`e doğru dizin kimlikleri. */
  chain: DirectoryIdentity[];
}

function directoryIdentity(entryPath: string, stat: fs.Stats): DirectoryIdentity {
  return { path: entryPath, dev: stat.dev, ino: stat.ino };
}

/**
 * En yakın var olan dizini bulur, ondan köke kadar (kök dâhil) dizin
 * kimliklerini toplar. `ENOENT` dışındaki hata ve symlink/dizin-değil
 * durumları fail-closed davranışla hata verir.
 */
function snapshotDirectoryChain(dirPath: string): { anchorPath: string; chain: DirectoryIdentity[] } {
  // Sembolik bağlantılar burada da çözülür. Kimlik zinciri gerçek dizinler
  // üzerinde tutulur; böylece `/tmp` gibi meşru bağlantılı üst dizinler yanlış
  // pozitif üretmez, buna karşılık hedefin kendisi sonradan bağlantıya
  // çevrilirse `completeGuardedWrite` bunu yakalar.
  let current = canonicalizePath(dirPath);

  for (let depth = 0; depth <= MAX_GUARD_CHAIN_DEPTH; depth += 1) {
    const stat = lstatOrNull(current);
    if (!stat) {
      const parent = path.dirname(current);
      if (parent === current) {
        throw guardError(`kök dizin bulunamadı: ${dirPath}`, 'no_root');
      }
      current = parent;
      continue;
    }

    if (stat.isSymbolicLink()) {
      // Kanonik çözümlemeden sonra bağlantı görmek yarış işaretidir: fail-closed.
      throw guardError(
        `yazma hedefi dizini sembolik bağlantı: ${current}`,
        'dir_is_symlink'
      );
    }
    if (!stat.isDirectory()) {
      throw guardError(`yazma hedefi dizini bir dizin değil: ${current}`, 'dir_not_directory');
    }

    const chain: DirectoryIdentity[] = [];
    let walker = current;
    let walkerStat: fs.Stats | null = stat;
    for (let level = 0; level <= MAX_GUARD_CHAIN_DEPTH && walkerStat; level += 1) {
      chain.push(directoryIdentity(walker, walkerStat));
      const parent = path.dirname(walker);
      if (parent === walker) break;
      walker = parent;
      walkerStat = lstatOrNull(walker);
      if (!walkerStat) {
        throw guardError(`üst dizin kayboldu: ${walker}`, 'chain_broken');
      }
    }
    chain.reverse();
    return { anchorPath: current, chain };
  }

  throw guardError(`dizin zinciri çok derin: ${dirPath}`, 'chain_too_deep');
}

function chainsEqual(left: DirectoryIdentity[], right: DirectoryIdentity[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.path !== b.path || a.dev !== b.dev || a.ino !== b.ino) return false;
  }
  return true;
}

/**
 * `before` zinciri (kökten anchor'a), `after` zincirinin başında aynen korunmuş mu?
 * Yazma yeni alt dizinler oluşturabileceği için `after` daha derin olabilir.
 */
function chainPrefixPreserved(before: DirectoryIdentity[], after: DirectoryIdentity[]): boolean {
  if (after.length < before.length) return false;
  for (let index = 0; index < before.length; index += 1) {
    const a = before[index];
    const b = after[index];
    if (a.path !== b.path || a.dev !== b.dev || a.ino !== b.ino) return false;
  }
  return true;
}

/**
 * Faz 1 — yolu doğrula ve dizin zincirinin kimliğini fotoğrafla.
 * Üretimde `null` döner ve hiçbir maliyet oluşturmaz.
 */
export function beginGuardedWrite(
  targetPath: string,
  kind: DataDirGuardKind
): GuardedWriteHandle | null {
  if (!isTestEnvironment()) return null;
  const absolute = path.resolve(targetPath);
  const dirPath = path.dirname(absolute);
  assertSafeDataDir(dirPath, kind);
  const { anchorPath, chain } = snapshotDirectoryChain(dirPath);
  return { targetPath: absolute, dirPath, anchorPath, chain };
}

/**
 * Faz 2 — yazmadan hemen önce yolu ve dizin kimliğini yeniden doğrula.
 * Asenkron bekleme sırasında dizin symlink'e çevrildiyse veya başka bir
 * dizinle değiştirildiyse (inode farkı) yazma reddedilir.
 */
export function completeGuardedWrite(
  handle: GuardedWriteHandle | null,
  kind: DataDirGuardKind
): void {
  if (!handle) return;
  assertSafeDataDir(handle.dirPath, kind);
  const after = snapshotDirectoryChain(handle.dirPath);
  if (after.anchorPath !== handle.anchorPath || !chainsEqual(handle.chain, after.chain)) {
    throw guardError(
      `${kind}: doğrulama ile yazma arasında hedef dizin değişti; yazma reddedildi: ${handle.dirPath}`,
      'dir_identity_changed'
    );
  }
}

function verifyGuardedWriteAfter(
  handle: GuardedWriteHandle | null,
  kind: DataDirGuardKind
): void {
  if (!handle) return;
  const after = snapshotDirectoryChain(handle.dirPath);
  if (!chainPrefixPreserved(handle.chain, after.chain)) {
    throw guardError(
      `${kind}: yazma sırasında hedef dizin zinciri değişti; yazma sonucu güvenilir değil: ${handle.dirPath}`,
      'dir_changed_during_write'
    );
  }
}

/** Senkron yazma: doğrula → kimliği kontrol et → yaz → yazma sonrası kontrol. */
export function runGuardedWriteSync<T>(
  targetPath: string,
  kind: DataDirGuardKind,
  write: () => T
): T {
  const handle = beginGuardedWrite(targetPath, kind);
  completeGuardedWrite(handle, kind);
  const result = write();
  verifyGuardedWriteAfter(handle, kind);
  return result;
}

/** Asenkron yazma: aynı kapı; bekleme sonrası kimlik kontrolü korunur. */
export async function runGuardedWrite<T>(
  targetPath: string,
  kind: DataDirGuardKind,
  write: () => Promise<T> | T
): Promise<T> {
  const handle = beginGuardedWrite(targetPath, kind);
  completeGuardedWrite(handle, kind);
  const result = await write();
  verifyGuardedWriteAfter(handle, kind);
  return result;
}
