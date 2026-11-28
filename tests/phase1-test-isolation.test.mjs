/**
 * Aşama 1 — Test izolasyonu regresyonları (B-14, N-02, N-04).
 *
 * Bu testler korumanın kendisini doğrular: gerçek `data/` dizinine yazma
 * reddedilmeli, açık `dataDir` zorunlu olmalı ve test keşfi hiçbir dosyayı
 * atlamamalı.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertSafeDataDir,
  assertSafeWritePath,
  beginGuardedWrite,
  canonicalizePath,
  completeGuardedWrite,
  isRealUserDataPath,
  isTestEnvironment,
  realUserDataDir,
  runGuardedWrite,
} from '../src/server/test-data-guard.ts';
import { createDataStorage } from '../src/server/storage.ts';
import { writeTasteObjections } from '../src/server/taste-store.ts';
import { auditTestDiscovery, PROJECT_ROOT } from '../scripts/test-discovery.mjs';
import { cleanupTempDataDirs, makeTempDataDir } from './helpers/test-data.mjs';

const POSIX = process.platform !== 'win32';

function emptyDoc(revision = 0) {
  return {
    version: 3,
    schemaVersion: 3,
    engineVersion: 'test',
    activeProfileId: 'PROFILE-DEFAULT',
    profiles: [
      {
        id: 'PROFILE-DEFAULT',
        name: 'Profil',
        createdAt: '2026-01-01T00:00:00.000Z',
        items: [],
        favoriteActors: [],
      },
    ],
    revision,
  };
}

describe('Aşama 1 — test veri yolu koruması', () => {
  it('test ortamı algılanır (node --test alt süreci)', () => {
    assert.equal(isTestEnvironment(), true);
    assert.equal(isTestEnvironment({}), false);
    assert.equal(isTestEnvironment({ CINETRACK_TEST_MODE: '1' }), true);
  });

  it('gerçek data/ dizini test sırasında yasaktır', () => {
    const userDataDir = realUserDataDir();
    assert.equal(isRealUserDataPath(userDataDir), true);

    assert.throws(
      () => assertSafeDataDir(userDataDir, 'data-storage'),
      /gerçek kullanıcı veri dizinine/
    );
    assert.throws(
      () => assertSafeDataDir(path.join(userDataDir, 'backups'), 'taste-store'),
      /gerçek kullanıcı veri dizinine/
    );
  });

  it('dataDir verilmeden varsayılana düşmek yasaktır', () => {
    assert.throws(() => assertSafeDataDir(undefined, 'data-storage'), /dataDir.*zorunludur/);
    assert.throws(() => assertSafeDataDir('', 'taste-store'), /dataDir.*zorunludur/);
  });

  it('geçici dizin kabul edilir', () => {
    const dir = makeTempDataDir('ct-guard-ok-');
    assert.doesNotThrow(() => assertSafeDataDir(dir, 'data-storage'));
    assert.doesNotThrow(() => assertSafeWritePath(path.join(dir, 'cinetrack-data.json'), 'data-storage'));
  });

  it('createDataStorage eski iki argümanlı çağrıyı reddeder', () => {
    assert.throws(
      () => createDataStorage('/tmp/some-file.json', { persistentStore: {} }),
      /tek bir nesne parametresi/
    );
    assert.throws(() => createDataStorage(undefined), /tek bir nesne parametresi/);
  });

  it('createDataStorage yalnızca verilen dizine yazar', () => {
    const dir = makeTempDataDir('ct-guard-storage-');
    const storage = createDataStorage({ dataDir: dir });
    assert.equal(storage.dataDir, path.resolve(dir));
    assert.ok(storage.dataFile.startsWith(path.resolve(dir) + path.sep));
    assert.ok(!isRealUserDataPath(storage.dataDir));
  });
});

describe('Aşama 1 — sembolik bağlantı koruması (B-14)', () => {
  function linkTo(target, prefix = 'ct-symlink-') {
    const dir = makeTempDataDir(prefix);
    const linkPath = path.join(dir, 'baglanti');
    symlinkSync(target, linkPath, 'dir');
    return linkPath;
  }

  it('geçici dizinden gerçek data/ dizinine bağlantı reddedilir', { skip: !POSIX }, () => {
    const userDataDir = realUserDataDir();
    const linkPath = linkTo(userDataDir);

    assert.throws(() => assertSafeDataDir(linkPath, 'data-storage'), /sembolik bağlantı/);
    assert.throws(
      () => createDataStorage({ dataDir: linkPath }),
      /sembolik bağlantı|gerçek kullanıcı veri dizinine/
    );
  });

  it('gerçek data/ altındaki bir dizine bağlantı reddedilir', { skip: !POSIX }, () => {
    const linkPath = linkTo(path.join(realUserDataDir(), 'backups'));
    assert.throws(() => assertSafeDataDir(linkPath, 'taste-store'), /sembolik bağlantı/);
  });

  it('iç içe sembolik bağlantılar reddedilir', { skip: !POSIX }, () => {
    const first = linkTo(realUserDataDir(), 'ct-symlink-a-');
    const secondRoot = makeTempDataDir('ct-symlink-b-');
    const second = path.join(secondRoot, 'ic-ice');
    symlinkSync(first, second, 'dir');

    assert.throws(() => assertSafeDataDir(second, 'data-storage'), /sembolik bağlantı/);
  });

  it('bağlantı üzerinden data/ altına inen yol reddedilir', { skip: !POSIX }, () => {
    // Bağlantı repo köküne işaret eder; `baglanti/data` gerçek data/ olur.
    const repoRoot = path.dirname(realUserDataDir());
    const linkPath = linkTo(repoRoot);
    assert.throws(
      () => assertSafeDataDir(path.join(linkPath, 'data'), 'data-storage'),
      /sembolik bağlantı/
    );
    assert.throws(
      () => assertSafeDataDir(path.join(linkPath, 'data', 'yeni-dizin'), 'data-storage'),
      /sembolik bağlantı/
    );
  });

  it('henüz var olmayan hedef dizin üst dizin üzerinden doğrulanır', { skip: !POSIX }, () => {
    const linkPath = linkTo(realUserDataDir());
    const missing = path.join(linkPath, 'henuz-yok', 'daha-derin');
    assert.equal(existsSync(missing), false);
    assert.throws(() => assertSafeDataDir(missing, 'data-storage'), /sembolik bağlantı/);
  });

  it('sarkan (dangling) bağlantı güvenli tarafta reddedilir', { skip: !POSIX }, () => {
    const dangling = linkTo(path.join(realUserDataDir(), 'olmayan-hedef'));
    assert.throws(() => assertSafeDataDir(dangling, 'data-storage'), /sembolik bağlantı/);
    assert.equal(isRealUserDataPath(dangling), true);
  });

  it('sembolik bağlantı döngüsü sessizce kabul edilmez', { skip: !POSIX }, () => {
    const dir = makeTempDataDir('ct-symlink-loop-');
    const first = path.join(dir, 'a');
    const second = path.join(dir, 'b');
    symlinkSync(second, first, 'dir');
    symlinkSync(first, second, 'dir');
    assert.throws(() => assertSafeDataDir(first, 'data-storage'), /döngüsel|derin/);
  });

  it('yazma anında bağlantı hedefi değişirse yazma reddedilir (TOCTOU)', { skip: !POSIX }, async () => {
    const userDataDir = realUserDataDir();
    const realDataFile = path.join(userDataDir, 'cinetrack-data.json');
    // Gerçek kullanıcı dosyası varsa içeriği korunmalı. CI'da bu dosya hiç
    // bulunmayabilir (gitignore'lu); o durumda da yazma onu oluşturmamalı.
    const before = existsSync(realDataFile) ? readFileSync(realDataFile, 'utf8') : null;

    const dir = makeTempDataDir('ct-symlink-swap-');
    const storage = createDataStorage({ dataDir: dir });
    const firstWrite = await storage.saveDataSerialized(emptyDoc(0), { forceOverwrite: true });
    assert.equal(firstWrite.ok, true);

    // Doğrulamadan sonra dizini gerçek data/ dizinine çevir.
    rmSync(dir, { recursive: true, force: true });
    symlinkSync(userDataDir, dir, 'dir');

    await assert.rejects(
      () => storage.saveDataSerialized(emptyDoc(1), { forceOverwrite: true }),
      /test-guard/
    );
    assert.throws(
      () => assertSafeWritePath(path.join(dir, 'cinetrack-data.json'), 'data-storage'),
      /sembolik bağlantı|gerçek kullanıcı veri dizinine/
    );
    if (before === null) {
      assert.equal(existsSync(realDataFile), false, 'gerçek data dosyası oluşturulmamalı');
    } else {
      assert.equal(readFileSync(realDataFile, 'utf8'), before);
    }
  });

  it('taste store aynı sembolik bağlantı kuralına uyar', { skip: !POSIX }, async () => {
    const linkPath = linkTo(realUserDataDir());
    await assert.rejects(() => writeTasteObjections([], linkPath), /test-guard/);
    assert.throws(() => assertSafeDataDir(linkPath, 'taste-store'), /sembolik bağlantı/);
  });

  it('yol normalizasyonu yanlış negatif üretmez', () => {
    const userDataDir = realUserDataDir();
    const disguised = path.join(userDataDir, '..', path.basename(userDataDir), 'backups');
    assert.throws(
      () => assertSafeDataDir(disguised, 'data-storage'),
      /gerçek kullanıcı veri dizinine/
    );
  });

  it('kanonik çözümleme geçici dizini güvenli bırakır', () => {
    const dir = makeTempDataDir('ct-canonical-');
    assert.equal(canonicalizePath(dir), canonicalizePath(dir));
    assert.equal(isRealUserDataPath(dir), false);
  });
});

describe('Aşama 1 — dosya sistemi hataları ve asenkron TOCTOU', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  function sandbox() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ct-guard-root-'));
    const protectedDir = path.join(root, 'data');
    const work = path.join(root, 'calisma');
    mkdirSync(protectedDir);
    mkdirSync(work);
    return { root, protectedDir, work };
  }

  async function withCwd(root, task) {
    const previous = process.cwd();
    process.chdir(root);
    try {
      return await task();
    } finally {
      process.chdir(previous);
      rmSync(root, { recursive: true, force: true });
    }
  }

  it('ENOENT dışındaki hata (ENOTDIR) doğrulamayı durdurur', { skip: !POSIX }, () => {
    const dir = makeTempDataDir('ct-enotdir-');
    const filePath = path.join(dir, 'dosya.json');
    writeFileSync(filePath, '{}', 'utf8');

    assert.throws(() => canonicalizePath(path.join(filePath, 'alt')), /test-guard/);
    assert.throws(
      () => assertSafeDataDir(path.join(filePath, 'alt'), 'data-storage'),
      /test-guard/
    );
    // Güvenli tarafta kalan sorgu da "gerçek veri" demez; ama yazma engellenir.
    assert.throws(
      () => assertSafeWritePath(path.join(filePath, 'alt', 'x.json'), 'data-storage'),
      /test-guard/
    );
  });

  it('EACCES doğrulamayı durdurur (root değilken)', {
    skip: !POSIX || isRoot,
  }, () => {
    const dir = makeTempDataDir('ct-eacces-');
    const locked = path.join(dir, 'kilitli');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      assert.throws(() => canonicalizePath(path.join(locked, 'alt')), /test-guard/);
      assert.throws(
        () => assertSafeDataDir(path.join(locked, 'alt'), 'data-storage'),
        /test-guard/
      );
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('var olmayan bileşen ENOENT olarak güvenli biçimde çözümlenir (regresyon)', () => {
    const dir = makeTempDataDir('ct-enoent-');
    const missing = path.join(dir, 'henuz-yok', 'dosya.json');
    assert.equal(existsSync(missing), false);
    assert.equal(canonicalizePath(missing).startsWith(canonicalizePath(dir)), true);
  });

  it('doğrulama ile yazma arasındaki asenkron boşlukta dizin symlink olursa yazma reddedilir', {
    skip: !POSIX,
  }, async () => {
    const { root, protectedDir, work } = sandbox();
    await withCwd(root, async () => {
      const target = path.join(work, 'cinetrack-data.json');
      const handle = beginGuardedWrite(target, 'data-storage');
      assert.ok(handle, 'guard etkin olmalı');

      // Gerçek asenkron boşluk: bu sırada dizin symlink'e çevrilir.
      await new Promise((resolve) => setTimeout(resolve, 10));
      rmSync(work, { recursive: true, force: true });
      symlinkSync(protectedDir, work, 'dir');

      assert.throws(
        () => completeGuardedWrite(handle, 'data-storage'),
        /test-guard|gerçek kullanıcı veri dizinine|sembolik bağlantı/
      );
      assert.equal(
        existsSync(path.join(protectedDir, 'cinetrack-data.json')),
        false,
        'korunan dizine yazılmamalı'
      );
    });
  });

  it('dizin aynı yolda başka bir dizinle değiştirilirse kimlik farkı yakalanır', async () => {
    const { root, work } = sandbox();
    await withCwd(root, async () => {
      const handle = beginGuardedWrite(path.join(work, 'veri.json'), 'data-storage');
      assert.ok(handle);

      // Aynı yol, farklı inode: symlink yok ama doğrulanan dizin değişti.
      renameSync(work, path.join(root, 'calisma-eski'));
      mkdirSync(work);

      assert.throws(
        () => completeGuardedWrite(handle, 'data-storage'),
        /değişti|test-guard/
      );
    });
  });

  it('değişiklik yoksa iki fazlı kapı yazmaya izin verir', async () => {
    const { root, work } = sandbox();
    await withCwd(root, async () => {
      const target = path.join(work, 'guvenli.json');
      const result = await runGuardedWrite(target, 'data-storage', () => {
        writeFileSync(target, '{"ok":true}', 'utf8');
        return 'yazildi';
      });
      assert.equal(result, 'yazildi');
      assert.equal(readFileSync(target, 'utf8'), '{"ok":true}');
    });
  });

  it('sürmekte olan yazma sırasında dizin symlink olursa gerçek veri korunur', {
    skip: !POSIX,
  }, async () => {
    const userDataDir = realUserDataDir();
    const realDataFile = path.join(userDataDir, 'cinetrack-data.json');
    const before = existsSync(realDataFile) ? readFileSync(realDataFile, 'utf8') : null;

    const dir = makeTempDataDir('ct-inflight-swap-');
    const storage = createDataStorage({ dataDir: dir });
    const firstWrite = await storage.saveDataSerialized(emptyDoc(0), { forceOverwrite: true });
    assert.equal(firstWrite.ok, true);

    // Yazma başladıktan sonra (asenkron okuma sürerken) dizin bağlantıya çevrilir.
    const pending = storage.saveDataSerialized(emptyDoc(1), { forceOverwrite: true });
    rmSync(dir, { recursive: true, force: true });
    symlinkSync(userDataDir, dir, 'dir');

    await assert.rejects(pending, /test-guard/);
    if (before === null) {
      assert.equal(existsSync(realDataFile), false, 'gerçek data dosyası oluşturulmamalı');
    } else {
      assert.equal(readFileSync(realDataFile, 'utf8'), before);
    }
  });
});

describe('Aşama 1 — test keşfi (N-02)', () => {
  it('her test dosyası tam olarak bir grupta yer alır', () => {
    const audit = auditTestDiscovery();
    assert.deepEqual(audit.missing, [], 'Keşfedilmeyen test dosyası var');
    assert.deepEqual(audit.duplicates, [], 'Birden fazla gruba düşen test dosyası var');
    assert.ok(audit.unit.length > 0, 'Unit test dosyası bulunamadı');
    assert.ok(audit.taste.length > 0, 'Taste test dosyası bulunamadı');
    assert.equal(audit.unit.length + audit.taste.length, audit.all.length);
  });

  it('package.json test komutları elle yazılmış dosya listesi içermez', () => {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.test, 'node scripts/run-tests.mjs unit');
    assert.equal(pkg.scripts['test:taste'], 'node scripts/run-tests.mjs taste');
    assert.ok(!pkg.scripts.test.includes('tests/'));
  });

  it('test runner concurrency açıkça 1 (yarış koşulu yok)', () => {
    const runner = readFileSync(path.join(PROJECT_ROOT, 'scripts/run-tests.mjs'), 'utf8');
    assert.ok(runner.includes("'--test-concurrency=1'"));
  });
});

describe('Aşama 1 — geçici dizin temizliği', () => {
  it('temizlik, sembolik bağlantı hedefindeki gerçek veriyi silmez', { skip: !POSIX }, () => {
    const target = mkdtempSync(path.join(os.tmpdir(), 'ct-cleanup-target-'));
    writeFileSync(path.join(target, 'cinetrack.db'), 'korunmalı', 'utf8');

    const dir = makeTempDataDir('ct-cleanup-link-');
    rmSync(dir, { recursive: true, force: true });
    symlinkSync(target, dir, 'dir');

    cleanupTempDataDirs();

    try {
      assert.equal(readFileSync(path.join(target, 'cinetrack.db'), 'utf8'), 'korunmalı');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});

describe('Aşama 1 — data/ hash kapısı', () => {
  it('bütünlük betiği manifest üretir ve değişikliği yakalar', async () => {
    const { buildManifest } = await import('../scripts/check-data-integrity.mjs');
    const dir = makeTempDataDir('ct-manifest-');
    const before = buildManifest(dir);
    assert.equal(existsSync(dir), true);
    assert.deepEqual(before.files, {});
    assert.equal(before.missing, false);
  });
});
