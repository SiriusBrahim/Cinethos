/**
 * Aşama 1 — GitHub token dosyasının atomik ve güvenli yazımı (B-31).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeFileAtomicSecure } from '../src/server/atomic-env-file.ts';
import { refreshEnvGitHubPat } from '../src/server/github-token-refresh.ts';

const POSIX = process.platform !== 'win32';

describe('Aşama 1 — atomik .env yazımı', () => {
  let dir;
  let envPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ct-atomic-env-'));
    envPath = path.join(dir, '.env');
    writeFileSync(envPath, 'CINETRACK_GITHUB_PAT=eski-token\nDIGER=1\n', 'utf8');
  });

  afterEach(() => {
    try {
      chmodSync(dir, 0o700);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  function tempFiles() {
    return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  }

  it('içeriği atomik olarak değiştirir ve geçici dosya bırakmaz', async () => {
    await writeFileAtomicSecure(envPath, 'CINETRACK_GITHUB_PAT=yeni-token\nDIGER=2\n');
    assert.equal(readFileSync(envPath, 'utf8'), 'CINETRACK_GITHUB_PAT=yeni-token\nDIGER=2\n');
    assert.deepEqual(tempFiles(), []);
  });

  it('POSIX’te dosya izni 0600 olur', { skip: !POSIX }, async () => {
    await writeFileAtomicSecure(envPath, 'CINETRACK_GITHUB_PAT=yeni\n');
    const mode = statSync(envPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('mevcut daha kısıtlayıcı izni genişletmez', { skip: !POSIX }, async () => {
    chmodSync(envPath, 0o400);
    await writeFileAtomicSecure(envPath, 'CINETRACK_GITHUB_PAT=yeni\n');
    const mode = statSync(envPath).mode & 0o777;
    assert.equal(mode, 0o400, `izin genişletildi: ${mode.toString(8)}`);
  });

  it('eşzamanlı yazmalarda dosya hiçbir zaman yarım kalmaz', async () => {
    const payloads = Array.from(
      { length: 12 },
      (_, index) => `CINETRACK_GITHUB_PAT=token-${index}-${'x'.repeat(500)}\n`
    );
    await Promise.all(payloads.map((payload) => writeFileAtomicSecure(envPath, payload)));
    const content = readFileSync(envPath, 'utf8');
    assert.ok(payloads.includes(content), 'dosya yazmalardan birinin tam içeriği değil');
    assert.deepEqual(tempFiles(), []);
  });

  it('yazma başarısız olursa eski içerik korunur ve geçici dosya kalmaz', { skip: !POSIX }, async () => {
    const before = readFileSync(envPath, 'utf8');
    chmodSync(dir, 0o500); // yeni dosya oluşturmayı engelle
    let failed = false;
    try {
      await writeFileAtomicSecure(envPath, 'CINETRACK_GITHUB_PAT=sızmamalı\n');
    } catch {
      failed = true;
    } finally {
      chmodSync(dir, 0o700);
    }
    assert.equal(failed, true, 'yazma beklenen şekilde başarısız olmadı');
    assert.equal(readFileSync(envPath, 'utf8'), before);
    assert.deepEqual(tempFiles(), []);
  });

  it('symlink hedefi sessizce değiştirilmez', { skip: !POSIX }, async () => {
    const realPath = path.join(dir, 'gercek-env');
    writeFileSync(realPath, 'CINETRACK_GITHUB_PAT=korunan\n', 'utf8');
    const linkPath = path.join(dir, '.env-link');
    symlinkSync(realPath, linkPath);

    await assert.rejects(() => writeFileAtomicSecure(linkPath, 'CINETRACK_GITHUB_PAT=zararli\n'));
    assert.equal(readFileSync(realPath, 'utf8'), 'CINETRACK_GITHUB_PAT=korunan\n');
  });

  it('hedef dizin yoksa oluşturur', async () => {
    const nested = path.join(dir, 'nested', 'deep', '.env');
    mkdirSync(path.dirname(nested), { recursive: true });
    await writeFileAtomicSecure(nested, 'A=1\n');
    assert.equal(readFileSync(nested, 'utf8'), 'A=1\n');
  });
});

describe('Aşama 1 — atomik yazma hata senaryoları (B-31)', () => {
  let dir;
  let envPath;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ct-atomic-fail-'));
    envPath = path.join(dir, '.env');
    writeFileSync(envPath, 'CINETRACK_GITHUB_PAT=eski-token\n', 'utf8');
  });

  afterEach(() => {
    try {
      chmodSync(dir, 0o700);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  function tempFiles() {
    return readdirSync(dir).filter((name) => name.includes('.tmp'));
  }

  it('rename aşamasındaki hata eski dosyayı korur ve geçici dosyayı temizler', async () => {
    const before = readFileSync(envPath, 'utf8');
    let tempPath = null;

    await assert.rejects(
      () =>
        writeFileAtomicSecure(envPath, 'CINETRACK_GITHUB_PAT=yeni-token\n', {
          beforeRename: (info) => {
            tempPath = info.tempPath;
            assert.equal(existsSync(info.tempPath), true, 'geçici dosya yazılmamış');
            throw new Error('rename simülasyonu');
          },
        }),
      /rename simülasyonu/
    );

    assert.ok(tempPath, 'geçici dosya yolu bildirilmedi');
    assert.equal(existsSync(tempPath), false, 'geçici dosya temizlenmedi');
    assert.equal(readFileSync(envPath, 'utf8'), before);
    assert.deepEqual(tempFiles(), []);
  });

  it('hedef dosya yokken hata yarım dosya bırakmaz', async () => {
    const target = path.join(dir, 'yeni.env');
    await assert.rejects(
      () =>
        writeFileAtomicSecure(target, 'TOKEN=gizli\n', {
          beforeRename: () => {
            throw new Error('rename simülasyonu');
          },
        }),
      /rename simülasyonu/
    );
    assert.equal(existsSync(target), false, 'yarım hedef dosya bırakıldı');
    assert.deepEqual(tempFiles(), []);
  });

  it('gerçek dosya sistemi hatasında hedef dizin içeriği bozulmaz', async () => {
    const targetDir = path.join(dir, 'hedef-dizin');
    mkdirSync(targetDir);
    writeFileSync(path.join(targetDir, 'ic.txt'), 'korunan', 'utf8');

    await assert.rejects(() => writeFileAtomicSecure(targetDir, 'TOKEN=zararli\n'));
    assert.equal(readFileSync(path.join(targetDir, 'ic.txt'), 'utf8'), 'korunan');
    assert.deepEqual(tempFiles(), []);
  });

  it('hata mesajı token değerini sızdırmaz', async () => {
    const token = 'ghp_cok-gizli-token-degeri';
    let message = '';
    try {
      await writeFileAtomicSecure(envPath, `CINETRACK_GITHUB_PAT=${token}\n`, {
        beforeRename: () => {
          throw new Error('yazma hatası');
        },
      });
    } catch (error) {
      message = String(error?.message || '');
    }
    assert.ok(message, 'hata bekleniyordu');
    assert.equal(message.includes(token), false, 'token hata mesajında göründü');
    assert.equal(readFileSync(envPath, 'utf8').includes(token), false);
  });

  it('başarısız yazmadan sonra aynı yol tekrar yazılabilir (kuyruk kilitlenmez)', async () => {
    const before = readFileSync(envPath, 'utf8');
    let fail = true;
    await assert.rejects(() =>
      writeFileAtomicSecure(envPath, 'TOKEN=ilk\n', {
        beforeRename: () => {
          if (fail) throw new Error('ilk yazma hatası');
        },
      })
    );
    assert.equal(readFileSync(envPath, 'utf8'), before);

    fail = false;
    await writeFileAtomicSecure(envPath, 'TOKEN=ikinci\n');
    assert.equal(readFileSync(envPath, 'utf8'), 'TOKEN=ikinci\n');
    assert.deepEqual(tempFiles(), []);
  });

  it('farklı hedeflere eşzamanlı yazmalar birbirini bozmaz', async () => {
    const targets = Array.from({ length: 6 }, (_, index) => path.join(dir, `env-${index}`));
    await Promise.all(
      targets.map((target, index) => writeFileAtomicSecure(target, `TOKEN=${index}\n`))
    );
    targets.forEach((target, index) => {
      assert.equal(readFileSync(target, 'utf8'), `TOKEN=${index}\n`);
    });
    assert.deepEqual(tempFiles(), []);
  });
});

describe('Aşama 1 — token yenileme akışı', () => {
  it('kalıcı token (ghp_) dosyayı yeniden yazmaz', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ct-token-flow-'));
    try {
      const envPath = path.join(dir, '.env');
      const content = 'CINETRACK_GITHUB_PAT=ghp_kalici-token\n';
      writeFileSync(envPath, content, 'utf8');
      const result = await refreshEnvGitHubPat({
        envFilePath: envPath,
        currentToken: 'ghp_kalici-token',
        username: 'test',
        timeoutMs: 50,
      });
      assert.equal(result, null);
      assert.equal(readFileSync(envPath, 'utf8'), content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
