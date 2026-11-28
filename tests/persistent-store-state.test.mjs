/**
 * Aşama 5.1 — F5.1-02: kalıcı store durum dosyası davranış testleri.
 *
 * Kritik güvenceler: atomik yazma, bozuk JSON'da güvenli davranış, gelecek şema
 * sürümünün yok sayılması ve yarıda kalan `syncing` kayıtlarının kurtarılması.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadSyncStateSnapshot,
  recoverInterruptedFileStates,
  saveSyncStateSnapshot,
} from '../src/server/persistent-store/store-state.ts';
import { STAGE_LABELS, SYNC_STATE_VERSION } from '../src/server/persistent-store/contracts.ts';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-store-state-'));
}

function snapshot(overrides = {}) {
  return {
    lastSyncAt: '2026-11-24T10:00:00.000Z',
    lastError: null,
    persistedInitialReconcile: true,
    publicConsentUpdatedAt: null,
    publicCatalogConsentUpdatedAt: null,
    lastRemoteSummary: null,
    lastComparison: null,
    lastSyncReport: null,
    fileStates: {},
    ...overrides,
  };
}

test('F5.1-02 durum dosyası: atomik yazma ve geri okuma alanları korur', () => {
  const dir = tempDir();
  const file = path.join(dir, 'sync-state.json');
  const state = snapshot({
    lastError: 'ağ hatası',
    persistedPublicPersonalConsent: false,
    lastObservedRemotePublic: true,
    fileStates: {
      'data/cinetrack-data.json': {
        repoPath: 'data/cinetrack-data.json',
        status: 'pending',
        statusLabel: STAGE_LABELS.pending,
        updatedAt: '2026-11-24T10:00:00.000Z',
      },
    },
  });

  saveSyncStateSnapshot(file, state);
  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.tmp`), false, 'geçici dosya kalmamalı');

  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.syncStateVersion, SYNC_STATE_VERSION);
  assert.equal(raw.lastError, 'ağ hatası');
  assert.equal(raw.persistedPublicPersonalConsent, false);
  assert.equal(raw.lastObservedRemotePublic, true);

  assert.deepEqual(loadSyncStateSnapshot(file), { ...state, repoVisibilityWarning: undefined });
});

test('F5.1-02 durum dosyası: bozuk JSON ve eksik dosya null döner, veri dosyalarına dokunulmaz', () => {
  const dir = tempDir();
  const missing = path.join(dir, 'yok.json');
  assert.equal(loadSyncStateSnapshot(missing), null);

  const corrupt = path.join(dir, 'bozuk.json');
  fs.writeFileSync(corrupt, '{ bozuk json');
  assert.equal(loadSyncStateSnapshot(corrupt), null);
  assert.equal(fs.readFileSync(corrupt, 'utf8'), '{ bozuk json', 'bozuk dosya değiştirilmemeli');
});

test('F5.1-02 durum dosyası: gelecek şema sürümü yok sayılır, eşit sürüm okunur', () => {
  const dir = tempDir();
  const future = path.join(dir, 'gelecek.json');
  fs.writeFileSync(
    future,
    JSON.stringify({ syncStateVersion: SYNC_STATE_VERSION + 1, lastError: 'ileri sürüm' })
  );
  assert.equal(loadSyncStateSnapshot(future), null);

  const current = path.join(dir, 'guncel.json');
  fs.writeFileSync(
    current,
    JSON.stringify({ syncStateVersion: SYNC_STATE_VERSION, lastSyncAt: '2026-01-01T00:00:00.000Z' })
  );
  const loaded = loadSyncStateSnapshot(current);
  assert.equal(loaded.lastSyncAt, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(loaded.fileStates, {});
});

test('F5.1-02 kesinti kurtarma: yalnızca syncing kayıtları pending olur ve raporlanır', () => {
  const now = '2026-11-25T00:00:00.000Z';
  const settled = {
    repoPath: 'data/catalog/movies.json',
    status: 'uploaded',
    statusLabel: STAGE_LABELS.uploaded,
    updatedAt: '2026-11-24T00:00:00.000Z',
  };
  const interrupted = {
    repoPath: 'data/cinetrack-data.json',
    status: 'syncing',
    statusLabel: STAGE_LABELS.syncing,
    sha: 'abc',
    updatedAt: '2026-11-24T00:00:00.000Z',
  };

  const result = recoverInterruptedFileStates(
    {
      'data/catalog/movies.json': settled,
      'data/cinetrack-data.json': interrupted,
    },
    now
  );

  assert.deepEqual(result.recovered, ['data/cinetrack-data.json']);
  assert.deepEqual(result.fileStates['data/catalog/movies.json'], settled, 'tamamlanmış kayıt değişmemeli');
  const recovered = result.fileStates['data/cinetrack-data.json'];
  assert.equal(recovered.status, 'pending');
  assert.equal(recovered.statusLabel, STAGE_LABELS.pending);
  assert.equal(recovered.noop, false);
  assert.equal(recovered.errorCategory, 'network_error');
  assert.equal(recovered.updatedAt, now);
  assert.match(recovered.error, /Kesinti/);
  assert.equal(recovered.sha, 'abc');

  // Girdi nesnesi değiştirilmez (saf fonksiyon).
  assert.equal(interrupted.status, 'syncing');

  assert.deepEqual(recoverInterruptedFileStates({}, now), { fileStates: {}, recovered: [] });
});
