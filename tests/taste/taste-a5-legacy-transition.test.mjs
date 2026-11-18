/**
 * MIA Faz 5 R2-A5 — Legacy taste verisi geçiş politikası (salt okunur).
 *
 * Doğrulananlar:
 *  - Legacy dosya yokken sınıflandırma `null`, yan etki yok.
 *  - Yalnızca legacy dosyalar varken `S1` (atanmamış aday) ve dosyalar
 *    DEĞİŞTİRİLMEZ (salt okunur).
 *  - Legacy + profil partition birlikteyken `S3` (çakışan/belirsiz).
 *  - Bozuk eşleme manifesti `mappingUnreadable` olarak raporlanır; hata
 *    fırlatılmaz ve onarım yapılmaz.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describeTasteLegacyState } from '../../src/server/taste-legacy-status.ts';
import { resolveTastePaths, resolveTasteProfileIdMapPath } from '../../src/server/taste-store.ts';

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ct-taste-a5-legacy-'));
}

test('R2-A5 legacy veri yoksa sınıflandırma null ve dosya yazılmaz', async () => {
  const tmpDir = await makeTempDir();
  try {
    const status = await describeTasteLegacyState(tmpDir);
    assert.equal(status.present, false);
    assert.equal(status.scenario, null);
    assert.deepEqual(status.legacyFiles, []);
    assert.equal(status.profilePartitions, 0);
    await assert.rejects(fs.access(path.join(tmpDir, 'taste')), 'salt okunur olmalı: taste dizini oluşturulmamalı');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('R2-A5 yalnızca legacy dosya varsa S1 adayı; içerik değişmez', async () => {
  const tmpDir = await makeTempDir();
  try {
    const paths = resolveTastePaths(tmpDir);
    await fs.mkdir(path.dirname(paths.events), { recursive: true });
    const payload = '{"version":1,"events":[{"eventId":"legacy-1"}]}';
    await fs.writeFile(paths.events, payload, 'utf8');

    const status = await describeTasteLegacyState(tmpDir);
    assert.equal(status.present, true);
    assert.equal(status.scenario, 'S1');
    assert.ok(status.legacyFiles.includes(paths.events));
    assert.equal(await fs.readFile(paths.events, 'utf8'), payload, 'legacy dosya değişmemeli');

    // Profil dizini oluşturulmamış olmalı (otomatik taşıma/atama yok).
    await assert.rejects(fs.access(path.join(tmpDir, 'taste', 'profiles')));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('R2-A5 legacy veri + profil partition birlikteyse S3 olarak işaretlenir', async () => {
  const tmpDir = await makeTempDir();
  try {
    const paths = resolveTastePaths(tmpDir);
    await fs.mkdir(path.dirname(paths.profile), { recursive: true });
    await fs.writeFile(paths.profile, '{"metrics":{}}', 'utf8');
    await fs.mkdir(path.join(tmpDir, 'taste', 'profiles', 'p1-b64url-cHJvZmlsZS1h'), { recursive: true });

    const status = await describeTasteLegacyState(tmpDir);
    assert.equal(status.present, true);
    assert.equal(status.scenario, 'S3');
    assert.equal(status.profilePartitions, 1);
    assert.match(status.policy, /otomatik bağlanmaz/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('R2-A5 bozuk eşleme manifesti hata fırlatmaz, mappingUnreadable raporlar', async () => {
  const tmpDir = await makeTempDir();
  try {
    const mapPath = resolveTasteProfileIdMapPath(tmpDir);
    await fs.mkdir(path.dirname(mapPath), { recursive: true });
    await fs.writeFile(mapPath, '{ not-json', 'utf8');
    const before = await fs.readFile(mapPath, 'utf8');

    const status = await describeTasteLegacyState(tmpDir);
    assert.equal(status.present, false);
    assert.equal(status.mappingUnreadable, true);
    assert.equal(await fs.readFile(mapPath, 'utf8'), before, 'bozuk manifest onarılmamalı');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});


test('R2-A5 bozuk eşleme manifesti profil partition dizinleri varken de görünür olmalı', async () => {
  const tmpDir = await makeTempDir();
  try {
    const paths = resolveTastePaths(tmpDir);
    const mapPath = resolveTasteProfileIdMapPath(tmpDir);
    const partitionDir = path.join(
      tmpDir,
      'taste',
      'profiles',
      'p1-b64url-cHJvZmlsZS1h'
    );

    await fs.mkdir(path.dirname(paths.profile), { recursive: true });
    await fs.writeFile(paths.profile, '{"metrics":{}}', 'utf8');
    await fs.mkdir(partitionDir, { recursive: true });
    await fs.writeFile(mapPath, '{ not-json', 'utf8');

    const status = await describeTasteLegacyState(tmpDir);
    assert.equal(status.profilePartitions, 1);
    assert.equal(
      status.mappingUnreadable,
      true,
      'profil dizinleri bulunsa da bozuk mapping manifesti sessizce göz ardı edilmemeli'
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
