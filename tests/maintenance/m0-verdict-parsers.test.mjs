// Cinethos — M0 bağımsız denetim: verdict semantiği, çıktı ayrıştırma ve risk
// sınıflandırması birim testleri (Agent 1 test/CI doğrulaması).
//
// Kapsam: Görev başlıkları C (hata/durum yönetimi) ve D (risk sınıflandırması)
// için Agent 2'nin tests/maintenance/maintenance-bot.test.mjs dosyasında
// bulunmayan boşluklar:
//   - INFO (non-blocking) başarısızlığın verdict'i düşürmemesi,
//   - INCOMPLETE durumunun zorunlu kontrolde yayılması,
//   - parseNodeTest TAP/spec biçemleri, "not ok" bulgu toplama,
//   - risk sınıflandırmasının determinizmi,
//   - R2'nin politika değişikliğiyle sessizce düşürülememesi,
//   - bozuk/eksik risk politikasında sessiz boş politika yerine varsayılanlar.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeVerdict, parseNodeTest } from '../../scripts/maintenance/analyze.mjs';
import { classifyFinding, loadRiskPolicy, summarizeRisks } from '../../scripts/maintenance/risk-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RISK_POLICY_PATH = path.join(ROOT, 'scripts/maintenance/risk-policy.json');

// ---------------------------------------------------------------------------
// C. Hata ve durum yönetimi — computeVerdict semantiği
// ---------------------------------------------------------------------------

test('C: non-blocking (INFO) kontrol başarısızlığı verdict FAIL yapmaz', () => {
  const checks = [
    { id: 'audit-prod', blocking: true, status: 'PASS' },
    { id: 'audit-all', blocking: false, status: 'INFO' },
  ];
  const verdict = computeVerdict({ checks, architecture: { ruleResults: [] } });
  assert.equal(verdict.status, 'PASS');
  assert.equal(verdict.blockingFailures, 0);
});

test('C: zorunlu kontrolde INCOMPLETE verdict INCOMPLETE üretir (eksik analiz PASS sayılmaz)', () => {
  const checks = [
    { id: 'unit-tests', blocking: true, status: 'INCOMPLETE' },
    { id: 'eslint', blocking: true, status: 'PASS' },
  ];
  const verdict = computeVerdict({ checks, architecture: { ruleResults: [] } });
  assert.equal(verdict.status, 'INCOMPLETE');
  assert.equal(verdict.incompleteChecks, 1);
});

test('C: zorunlu kontrolde SKIP (isteğe bağlı olmayan) INCOMPLETE üretir', () => {
  const checks = [{ id: 'unit-tests', blocking: true, optional: false, status: 'SKIP' }];
  const verdict = computeVerdict({ checks, architecture: { ruleResults: [] } });
  assert.equal(verdict.status, 'INCOMPLETE');
});

test('C: isteğe bağlı kontrolün SKIP\'i verdict\'i düşürmez', () => {
  const checks = [
    { id: 'install', blocking: true, optional: true, status: 'SKIP' },
    { id: 'eslint', blocking: true, status: 'PASS' },
  ];
  const verdict = computeVerdict({ checks, architecture: { ruleResults: [] } });
  assert.equal(verdict.status, 'PASS');
});

test('C: FAIL ile ERROR çakıştığında ERROR önceliklidir (tarama hatası gizlenmez)', () => {
  const checks = [{ id: 'unit-tests', blocking: true, status: 'FAIL' }];
  const verdict = computeVerdict({
    checks,
    architecture: null,
    architectureError: 'tarama patladı',
  });
  assert.equal(verdict.status, 'ERROR');
});

test('C: mimari tarama sonucu hiç yoksa (null) PASS üretilemez', () => {
  const verdict = computeVerdict({
    checks: [{ id: 'eslint', blocking: true, status: 'PASS' }],
    architecture: null,
  });
  assert.equal(verdict.status, 'INCOMPLETE');
});

// ---------------------------------------------------------------------------
// A/C. parseNodeTest — çıktı ayrıştırma bütünlüğü
// ---------------------------------------------------------------------------

test('A/C: parseNodeTest TAP biçemini (# tests N) ayrıştırır', () => {
  const output = [
    'not ok 1 - bozuk test',
    '# tests 4',
    '# suites 0',
    '# pass 3',
    '# fail 1',
    '# cancelled 0',
    '# skipped 0',
    '# todo 0',
  ].join('\n');
  const parsed = parseNodeTest(output, '');
  assert.deepEqual(parsed.counts, { tests: 4, pass: 3, fail: 1, skipped: 0, cancelled: 0 });
  assert.ok(parsed.findings.length >= 1, 'not ok satırı bulgu olarak toplanmalı');
});

test('A/C: parseNodeTest spec biçemini (ℹ tests N) ayrıştırır', () => {
  const parsed = parseNodeTest('ℹ tests 10\nℹ pass 10\nℹ fail 0\nℹ skipped 0\n', '');
  assert.deepEqual(parsed.counts, { tests: 10, pass: 10, fail: 0, skipped: 0, cancelled: null });
});

test('A/C: parseNodeTest özet içermeyen çıktıda throw eder (sessiz PASS engeli)', () => {
  assert.throws(() => parseNodeTest('npm warn deprecated something\nall good\n', ''), /test özeti bulunamadı/);
  assert.throws(() => parseNodeTest('', 'stderr boş'), /test özeti bulunamadı/);
});

test('A/C: parseNodeTest son özeti kullanır (iç içe süreç çıktısına dayanıklı)', () => {
  const output = 'ℹ tests 2\nℹ pass 2\nℹ fail 0\nℹ tests 7\nℹ pass 6\nℹ fail 1\n';
  const parsed = parseNodeTest(output, '');
  assert.equal(parsed.counts.tests, 7);
  assert.equal(parsed.counts.fail, 1);
});

// ---------------------------------------------------------------------------
// D. Risk sınıflandırması — determinizm ve sessiz düşürme engeli
// ---------------------------------------------------------------------------

test('D: aynı bulgu tekrarlı sınıflandırmada deterministik sonuç verir', () => {
  const policy = loadRiskPolicy();
  const finding = { source: 'eslint', file: 'src/components/Card.tsx', rule: 'no-unused-vars', fixable: true };
  const first = JSON.stringify(classifyFinding(finding, policy));
  for (let index = 0; index < 100; index += 1) {
    assert.equal(JSON.stringify(classifyFinding(finding, policy)), first, `${index}. tekrar farklı sonuç`);
  }

  const scanA = summarizeRisks(
    [
      { source: 'architecture', file: 'src/core/a.ts', rule: 'core-purity' },
      { source: 'tsc', file: 'src/app/b.ts' },
      { source: 'audit' },
    ],
    policy,
  );
  for (let index = 0; index < 25; index += 1) {
    assert.deepEqual(
      summarizeRisks(
        [
          { source: 'architecture', file: 'src/core/a.ts', rule: 'core-purity' },
          { source: 'tsc', file: 'src/app/b.ts' },
          { source: 'audit' },
        ],
        policy,
      ),
      scanA,
      `${index}. tekrar özet farklı`,
    );
  }
});

test('D: mimari ihlal her koşulda R2 ve otomatik onarıma uygun DEĞİL', () => {
  const policy = loadRiskPolicy();
  for (const file of ['src/core/a.ts', 'src/server/persistent-store.ts', 'src/app/mobile/Dashboard.tsx', null]) {
    const classified = classifyFinding({ source: 'architecture', file, fixable: true }, policy);
    assert.equal(classified.risk, 'R2', `architecture kaynağı R2 olmalı (${file})`);
    assert.equal(classified.autoFixable, false, `architecture bulgusu otomatik düzeltilemez (${file})`);
  }
});

test('D: r2Globs alanları politika boşaltılsa bile mimari kaynak R2 kalır', () => {
  const emptied = { ...loadRiskPolicy(), r2Globs: [], r2Matchers: [] };
  const classified = classifyFinding(
    { source: 'architecture', file: 'src/core/cinetrack-core.ts' },
    emptied,
  );
  assert.equal(classified.risk, 'R2');
  assert.equal(classified.autoFixable, false);
});

test('D: risk-policy.json gerçek dosyası R2 alanlarını korur (persistent-store R2)', () => {
  const policy = loadRiskPolicy(RISK_POLICY_PATH);
  assert.ok(policy.r2Globs.length > 0, 'risk-policy.json r2Globs boş olmamalı');
  const classified = classifyFinding(
    { source: 'eslint', file: 'src/server/persistent-store.ts', rule: 'no-unused-vars', fixable: true },
    policy,
  );
  assert.equal(classified.risk, 'R2');
  assert.equal(classified.autoFixable, false);
});

test('D: bozuk/eksik risk politikası sessiz boş politika ÜRETMEZ (varsayılanlar korunur)', () => {
  const broken = loadRiskPolicy(path.join(ROOT, 'scripts/maintenance/__olmayan-politik__.json'));
  assert.deepEqual(broken.r0Rules, ['no-unused-vars', '@typescript-eslint/no-unused-vars', 'prefer-const']);
  assert.deepEqual(broken.r1Sources, ['tsc', 'test', 'build', 'audit', 'config']);

  const brokenFile = path.join(ROOT, 'scripts/maintenance/.__bozuk-politik-test__.json');
  fs.writeFileSync(brokenFile, '{ bu geçerli JSON değil');
  try {
    const fallback = loadRiskPolicy(brokenFile);
    assert.ok(fallback.r0Rules.length > 0, 'bozuk politika varsayılan r0Rules döndürmeli');
    assert.ok(Array.isArray(fallback.r2Globs), 'bozuk politika varsayılan r2Globs döndürmeli');
  } finally {
    fs.rmSync(brokenFile, { force: true });
  }
});

test('D: R0 yalnızca izinli lint kurallarına verilir; bilinmeyen kural R1 kalır', () => {
  const policy = loadRiskPolicy();
  const r0 = classifyFinding({ source: 'eslint', file: 'src/utils/x.ts', rule: 'prefer-const', fixable: true }, policy);
  assert.equal(r0.risk, 'R0');

  const r1 = classifyFinding({ source: 'eslint', file: 'src/utils/x.ts', rule: 'tanimsiz-kural' }, policy);
  assert.equal(r1.risk, 'R1');
  assert.equal(r1.autoFixable, false, 'sınıflandırılmamış bulgu otomatik düzeltilemez');

  const tsc = classifyFinding({ source: 'tsc', file: 'src/utils/x.ts' }, policy);
  assert.equal(tsc.risk, 'R1');
});
