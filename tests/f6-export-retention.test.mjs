/**
 * Aşama 6 / B-37 — Dışa aktarma dosyaları saklama (retention) testleri.
 *
 * Gerçek modül geçici dizinlerde çalışır; kullanıcı verisine dokunulmaz.
 * Kapsam: yaş, adet ve boyut sınırları, son başarılı dosyanın korunması,
 * yönetilmeyen dosyaların ve `data/backups` yedeğinin kapsam dışı kalması,
 * dizin dışına taşan adların reddedilmesi, silme hatasının raporlanması.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_EXPORT_RETENTION_POLICY,
  applyExportRetention,
  isManagedExportFileName,
  selectExportsForRetention,
} from '../src/server/export-retention.ts';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 26, 12, 0, 0);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-retention-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeExport(dir, name, { ageDays = 0, sizeBytes = 1024 } = {}) {
  const fullPath = path.join(dir, name);
  fs.writeFileSync(fullPath, Buffer.alloc(sizeBytes, 1));
  const mtime = new Date(NOW - ageDays * DAY);
  fs.utimesSync(fullPath, mtime, mtime);
  return fullPath;
}

function exportName(dayOffset) {
  const date = new Date(NOW - dayOffset * DAY);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `Cinethos_Profile_${yyyy}-${mm}-${dd}_1200.xlsx`;
}

const policy = (overrides = {}) => ({ ...DEFAULT_EXPORT_RETENTION_POLICY, ...overrides });

test('B-37 yalnızca uygulamanın ürettiği dışa aktarma adları yönetilir', () => {
  assert.equal(isManagedExportFileName('Cinethos_Profile_2026-11-26_1200.xlsx'), true);
  assert.equal(isManagedExportFileName('CineTrack_Profile_2025-01-02_0930.json'), true);
  assert.equal(isManagedExportFileName('Cinethos_Profile_2026-11-26_1200_02.xlsx'), true);
  assert.equal(isManagedExportFileName('cinetrack-data.json'), false);
  assert.equal(isManagedExportFileName('backup-2026.json'), false);
  assert.equal(isManagedExportFileName('../Cinethos_Profile_2026-11-26_1200.xlsx'), false);
  assert.equal(isManagedExportFileName('Cinethos_Profile_2026-11-26_1200.xlsx.bak'), false);
});

test('B-37 yaş sınırı: eski dosyalar silinir, en yeni her zaman korunur', async (t) => {
  const dir = tempDir(t);
  const fresh = writeExport(dir, exportName(1), { ageDays: 1 });
  const old = writeExport(dir, exportName(200), { ageDays: 200 });

  const report = await applyExportRetention(dir, {
    policy: policy({ maxAgeDays: 180 }),
    nowMs: NOW,
  });

  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(report.removed.length, 1);
  assert.equal(report.removed[0].reason, 'age');
  assert.equal(report.kept.length, 1);
  assert.equal(report.kept[0].protectedReason, 'latest');
});

test('B-37 adet sınırı: en yeni N dosya kalır, kalanı temizlenir', async (t) => {
  const dir = tempDir(t);
  const files = [];
  for (let i = 0; i < 20; i += 1) {
    files.push(writeExport(dir, exportName(i), { ageDays: i }));
  }

  const report = await applyExportRetention(dir, {
    policy: policy({ maxFiles: 5, maxAgeDays: 3650, maxTotalBytes: 10 ** 9 }),
    nowMs: NOW,
  });

  const remaining = fs.readdirSync(dir).sort();
  assert.equal(remaining.length, 5);
  assert.equal(remaining.includes(path.basename(files[0])), true, 'en yeni dosya korunmalı');
  assert.equal(report.removed.length, 15);
  assert.ok(report.removed.every((entry) => entry.reason === 'count'));
});

test('B-37 toplam boyut sınırı: en eski dosyalar boyut için silinir', async (t) => {
  const dir = tempDir(t);
  writeExport(dir, exportName(0), { ageDays: 0, sizeBytes: 400 });
  writeExport(dir, exportName(1), { ageDays: 1, sizeBytes: 400 });
  writeExport(dir, exportName(2), { ageDays: 2, sizeBytes: 400 });
  writeExport(dir, exportName(3), { ageDays: 3, sizeBytes: 400 });

  const report = await applyExportRetention(dir, {
    policy: policy({ maxFiles: 100, maxAgeDays: 3650, maxTotalBytes: 1000 }),
    nowMs: NOW,
  });

  assert.equal(report.removed.length, 2);
  assert.ok(report.removed.every((entry) => entry.reason === 'size'));
  assert.equal(report.totalBytesAfter <= 1000, true);
  assert.equal(fs.readdirSync(dir).length, 2);
});

test('B-37 son başarılı dışa aktarma (keepFileName) her koşulda korunur', async (t) => {
  const dir = tempDir(t);
  for (let i = 0; i < 5; i += 1) writeExport(dir, exportName(i), { ageDays: i });
  const justWritten = exportName(4);

  const report = await applyExportRetention(dir, {
    policy: policy({ maxFiles: 2, maxAgeDays: 0, maxTotalBytes: 1 }),
    nowMs: NOW,
    keepFileName: justWritten,
  });

  assert.equal(fs.existsSync(path.join(dir, justWritten)), true);
  assert.ok(report.kept.some((entry) => entry.name === justWritten));
});

test('B-37 yönetilmeyen dosyalar ve backups dizini kapsam dışıdır', async (t) => {
  const dir = tempDir(t);
  writeExport(dir, exportName(0), { ageDays: 0 });
  writeExport(dir, exportName(400), { ageDays: 400 });
  const userFile = path.join(dir, 'kullanici-notlari.txt');
  fs.writeFileSync(userFile, 'silinmemeli');
  const backupsDir = path.join(dir, 'backups');
  fs.mkdirSync(backupsDir);
  const oldBackup = path.join(backupsDir, exportName(500));
  fs.writeFileSync(oldBackup, 'yedek');

  const report = await applyExportRetention(dir, {
    policy: policy({ maxAgeDays: 180 }),
    nowMs: NOW,
  });

  assert.equal(fs.existsSync(userFile), true, 'kullanıcı dosyası silinmemeli');
  assert.equal(fs.existsSync(oldBackup), true, 'yedek dosyası silinmemeli');
  assert.equal(fs.existsSync(path.join(dir, exportName(400))), false);
  assert.ok(report.skipped.some((entry) => entry.name === 'kullanici-notlari.txt'));
  assert.ok(report.skipped.some((entry) => entry.name === 'backups'));
});

test('B-37 dizin dışına taşan adlar aday listesine giremez', () => {
  const decision = selectExportsForRetention(
    [
      { name: '../Cinethos_Profile_2026-01-01_1200.xlsx', sizeBytes: 10, mtimeMs: NOW - 400 * DAY },
      { name: 'Cinethos_Profile_2026-01-01_1200.xlsx', sizeBytes: 10, mtimeMs: NOW - 300 * DAY },
      { name: 'Cinethos_Profile_2026-11-01_1200.xlsx', sizeBytes: 10, mtimeMs: NOW - 5 * DAY },
    ],
    policy({ maxAgeDays: 30 }),
    NOW
  );

  assert.deepEqual(
    decision.keep.map((file) => file.name),
    ['Cinethos_Profile_2026-11-01_1200.xlsx']
  );
  assert.equal(decision.remove.length, 1);
  assert.equal(decision.remove[0].file.name, 'Cinethos_Profile_2026-01-01_1200.xlsx');
});

test('B-37 dryRun silmez, silinecekleri raporlar', async (t) => {
  const dir = tempDir(t);
  writeExport(dir, exportName(0), { ageDays: 0 });
  const oldFile = writeExport(dir, exportName(300), { ageDays: 300 });

  const report = await applyExportRetention(dir, {
    policy: policy({ maxAgeDays: 30 }),
    nowMs: NOW,
    dryRun: true,
  });

  assert.equal(fs.existsSync(oldFile), true);
  assert.equal(report.removed.length, 1);
  assert.equal(report.totalBytesAfter < report.totalBytesBefore, true);
});

test('B-37 silme hatası raporlanır, kalan dosyalar korunur', async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip('root kullanıcıda dizin izinleri silmeyi engellemez');
    return;
  }
  const dir = tempDir(t);
  writeExport(dir, exportName(0), { ageDays: 0 });
  writeExport(dir, exportName(400), { ageDays: 400 });
  fs.chmodSync(dir, 0o500);
  t.after(() => {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore
    }
  });

  const report = await applyExportRetention(dir, {
    policy: policy({ maxAgeDays: 180 }),
    nowMs: NOW,
  });

  assert.ok(report.errors.length >= 1, 'silme hatası raporlanmalı');
  fs.chmodSync(dir, 0o700);
  assert.equal(fs.readdirSync(dir).length, 2, 'hiçbir dosya kaybolmamalı');
});

test('B-37 olmayan dizin güvenli biçimde boş rapor döner', async () => {
  const report = await applyExportRetention(path.join(os.tmpdir(), 'cinethos-yok-boyle-dizin'), {
    nowMs: NOW,
  });
  assert.equal(report.examined, 0);
  assert.deepEqual(report.removed, []);
});
