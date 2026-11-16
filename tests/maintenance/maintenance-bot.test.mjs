// Cinethos — bakım botu regresyon testleri (M0).
//
// Kapsanan hatalar:
//  - mimari tarayıcı yalnızca .ts ailesini tarıyordu (.js/.mjs atlanıyordu),
//  - çok satırlı import ifadeleri kaçırılıyordu,
//  - mimari tarama hatası genel raporu PASS'tan alıkoymuyordu,
//  - test çıktısı ayrıştırılamadığında PASS üretiliyordu,
//  - mevcut ihlal ile yeni ihlal ayrılmıyordu.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractImports,
  listSourceFiles,
  runArchitectureScan,
  stripComments,
} from '../../scripts/maintenance/architecture-boundaries.mjs';
import {
  computeRulesHash,
  diffAgainstBaseline,
  validateRulesIntegrity,
} from '../../scripts/maintenance/architecture-guard.mjs';
import { compareSnapshots, normalizeSnapshot } from '../../scripts/maintenance/report-diff.mjs';
import { classifyFinding, loadRiskPolicy } from '../../scripts/maintenance/risk-classifier.mjs';
import { computeVerdict, parseNodeTest } from '../../scripts/maintenance/analyze.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK_CLI = path.join(ROOT, 'scripts/maintenance/check-architecture.mjs');

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-maint-'));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return root;
}

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CHECK_CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

test('stripComments yalnızca satır yorumunu maskeler, sonraki satırları korur', () => {
  const source = '// açıklama\nconst a = 1; // son\nconst b = 2;\n';
  const masked = stripComments(source);
  assert.equal(masked.split('\n').length, source.split('\n').length);
  assert.match(masked, /const a = 1;/);
  assert.match(masked, /const b = 2;/);
  assert.doesNotMatch(masked, /açıklama/);
});

test('stripComments blok yorumu ve string içindeki /* dizisini ayırır', () => {
  const source = '/** blok\n * açıklama\n */\nconst q = "/*";\nconst r = 1;\n';
  const masked = stripComments(source);
  assert.doesNotMatch(masked, /açıklama/);
  assert.match(masked, /const q = "\/\*";/);
  assert.match(masked, /const r = 1;/);
});

test('extractImports çok satırlı, side-effect, dinamik ve require importlarını yakalar', () => {
  const source = [
    "import {",
    '  a,',
    '  b,',
    "} from '../services/api-client.ts';",
    "export {",
    '  c,',
    "} from './other.ts';",
    "import './side.css';",
    "const dyn = import('./dyn.ts');",
    "const req = require('pkg');",
    "// import commented from './commented.ts';",
    '',
  ].join('\n');

  const imports = extractImports(source).map((entry) => entry.specifier);
  assert.deepEqual(imports, [
    '../services/api-client.ts',
    './other.ts',
    './side.css',
    './dyn.ts',
    'pkg',
  ]);
});

test('listSourceFiles .js/.mjs/.cjs dosyalarını tarar, node_modules ve gizli dizinleri atlar', () => {
  const root = makeRepo({
    'src/core/a.ts': 'export const a = 1;\n',
    'src/core/b.mjs': 'export const b = 1;\n',
    'src/core/c.js': 'module.exports = 1;\n',
    'src/core/d.cjs': 'module.exports = 2;\n',
    'src/core/node_modules/e.ts': 'export const e = 1;\n',
    'src/core/.cache/f.ts': 'export const f = 1;\n',
  });
  const files = listSourceFiles(root);
  assert.deepEqual(files, ['src/core/a.ts', 'src/core/b.mjs', 'src/core/c.js', 'src/core/d.cjs']);
});

test('runArchitectureScan .mjs dosyasındaki çok satırlı ihlali raporlar', () => {
  const root = makeRepo({
    'src/core/sample.mjs': [
      'import {',
      '  x,',
      "} from '../services/api-client.mjs';",
      '',
    ].join('\n'),
    'src/services/api-client.mjs': 'export const x = 1;\n',
  });
  const scan = runArchitectureScan({ root });
  assert.equal(scan.scannedFiles, 2);
  assert.ok(scan.extensionCounts['.mjs'] >= 2);
  const violations = scan.ruleResults.flatMap((rule) => rule.violations);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'src/core/sample.mjs');
  assert.equal(violations[0].specifier, '../services/api-client.mjs');
  assert.equal(violations[0].line, 3);
});

test('runArchitectureScan boş kökte hata verir (sessiz PASS yok)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-empty-'));
  assert.throws(() => runArchitectureScan({ root }), /Taranacak kaynak dosya bulunamadı/);
});

test('baseline: yeni ihlal unexpected, düzeltilen ihlal stale olur', () => {
  const exceptions = [
    { rule: 'core-purity', file: 'src/core/old.ts', specifier: '../services/a.ts' },
  ];
  const existing = [{ rule: 'core-purity', file: 'src/core/old.ts', specifier: '../services/a.ts' }];
  const withNew = [...existing, { rule: 'core-purity', file: 'src/core/new.ts', specifier: '../app/x.ts' }];

  const same = diffAgainstBaseline(existing, exceptions);
  assert.equal(same.unexpected.length, 0);
  assert.equal(same.stale.length, 0);

  const changed = diffAgainstBaseline(withNew, exceptions);
  assert.equal(changed.unexpected.length, 1);
  assert.equal(changed.unexpected[0].file, 'src/core/new.ts');

  const fixed = diffAgainstBaseline([], exceptions);
  assert.equal(fixed.stale.length, 1);
  assert.equal(fixed.stale[0].file, 'src/core/old.ts');
});

test('kural kilidi: gerçek kurallar geçerli, gevşetme ve özet uyuşmazlığı yakalanır', () => {
  const rulesRaw = fs.readFileSync(path.join(ROOT, 'scripts/maintenance/architecture-rules.json'), 'utf8');
  const rules = JSON.parse(rulesRaw);
  const lock = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'scripts/maintenance/architecture-rules.lock.json'), 'utf8'),
  );
  assert.equal(computeRulesHash(rulesRaw), lock.sha256);
  assert.deepEqual(validateRulesIntegrity(rulesRaw, rules, lock), []);

  const relaxedHash = validateRulesIntegrity(`${rulesRaw} `, rules, lock);
  assert.ok(relaxedHash.some((error) => error.includes('özeti kilitle uyuşmuyor')));

  const relaxed = structuredClone(rules);
  relaxed.rules[0].forbidLayers = relaxed.rules[0].forbidLayers.filter((layer) => layer !== 'services');
  const relaxedErrors = validateRulesIntegrity(rulesRaw, relaxed, lock);
  assert.ok(relaxedErrors.some((error) => error.includes('yasak katman gevşetilmiş')));

  const removed = structuredClone(rules);
  removed.rules = removed.rules.filter((rule) => rule.id !== 'contracts-isolation');
  const removedErrors = validateRulesIntegrity(rulesRaw, removed, lock);
  assert.ok(removedErrors.some((error) => error.includes('Zorunlu mimari kural eksik')));

  const added = structuredClone(rules);
  added.rules.push({ id: 'new-rule', from: ['src/**'], forbidLayers: [] });
  const addedErrors = validateRulesIntegrity(rulesRaw, added, lock);
  assert.ok(addedErrors.some((error) => error.includes('Kilitsiz yeni mimari kural')));
});

test('computeVerdict: mimari yok/hatalı veya zorunlu kontrol eksikse PASS verilmez', () => {
  const passCheck = [{ blocking: true, status: 'PASS' }];
  assert.equal(computeVerdict({ checks: passCheck, architecture: { ruleResults: [] } }).status, 'PASS');
  assert.equal(computeVerdict({ checks: passCheck, architecture: null }).status, 'INCOMPLETE');
  assert.equal(
    computeVerdict({ checks: passCheck, architecture: null, architectureError: 'tarama hatası' }).status,
    'ERROR',
  );
  assert.equal(
    computeVerdict({ checks: [{ blocking: true, status: 'SKIP' }], architecture: { ruleResults: [] } }).status,
    'INCOMPLETE',
  );
  assert.equal(
    computeVerdict({ checks: [{ blocking: true, status: 'FAIL' }], architecture: { ruleResults: [] } }).status,
    'FAIL',
  );
});

test('parseNodeTest özet yoksa hata verir, özet varsa sayıları ayrıştırır', () => {
  assert.throws(() => parseNodeTest('rastgele çıktı', ''), /test özeti bulunamadı/);
  const parsed = parseNodeTest('ℹ tests 3\nℹ pass 2\nℹ fail 1\n', '');
  assert.deepEqual(parsed.counts, { tests: 3, pass: 2, fail: 1, skipped: null, cancelled: null });
  assert.equal(parsed.findings.length, 0);
});

test('risk sınıflandırması: mimari ve core R2, kullanılmayan import R0', () => {
  const policy = loadRiskPolicy();
  const architecture = classifyFinding({ source: 'architecture', file: 'src/core/a.ts' }, policy);
  assert.equal(architecture.risk, 'R2');
  assert.equal(architecture.autoFixable, false);

  const coreLint = classifyFinding({ source: 'eslint', file: 'src/core/a.ts', rule: 'no-unused-vars' }, policy);
  assert.equal(coreLint.risk, 'R2');
  assert.equal(coreLint.autoFixable, false);

  const uiLint = classifyFinding(
    { source: 'eslint', file: 'src/components/Button.tsx', rule: 'no-unused-vars', fixable: true },
    policy,
  );
  assert.equal(uiLint.risk, 'R0');
  assert.equal(uiLint.autoFixable, true);

  const dependency = classifyFinding({ source: 'audit', file: null, rule: 'CVE' }, policy);
  assert.equal(dependency.risk, 'R1');
  assert.equal(dependency.autoFixable, false);
});

test('compareSnapshots yeni ve düzelen ihlalleri ayırır', () => {
  const previous = normalizeSnapshot({
    commit: 'old',
    checks: [{ id: 'eslint', status: 'PASS' }],
    architecture: {
      ruleResults: [
        { id: 'core-purity', violations: [{ file: 'src/core/a.ts', specifier: '../services/a.ts', line: 1 }] },
      ],
    },
  });
  const current = normalizeSnapshot({
    commit: 'new',
    checks: [{ id: 'eslint', status: 'FAIL' }],
    architecture: {
      ruleResults: [
        { id: 'core-purity', violations: [{ file: 'src/core/b.ts', specifier: '../services/b.ts', line: 2 }] },
      ],
    },
  });
  const comparison = compareSnapshots(previous, current);
  assert.equal(comparison.newViolations.length, 1);
  assert.equal(comparison.newViolations[0].file, 'src/core/b.ts');
  assert.equal(comparison.fixedViolations.length, 1);
  assert.equal(comparison.fixedViolations[0].file, 'src/core/a.ts');
  assert.deepEqual(comparison.checkRegressions, [{ id: 'eslint', from: 'PASS', to: 'FAIL' }]);
  assert.equal(comparison.riskSummary.counts.R2, 1);
});

test('check-architecture CLI: mevcut repo PASS, yeni ihlal FAIL, boş kök ERROR', () => {
  const repo = runCli(['--root', ROOT]);
  assert.equal(repo.status, 0, repo.stderr);

  const cleanRoot = makeRepo({
    'src/core/a.ts': 'export const a = 1;\n',
    'src/app/a.ts': 'export const b = 1;\n',
  });
  const baselineFile = path.join(cleanRoot, 'baseline.json');
  fs.writeFileSync(baselineFile, JSON.stringify({ version: 1, exceptions: [] }));
  const clean = runCli(['--root', cleanRoot, '--baseline', baselineFile]);
  assert.equal(clean.status, 0, clean.stderr);

  fs.writeFileSync(
    path.join(cleanRoot, 'src/core/violation.ts'),
    "import { x } from '../app/a.ts';\n",
  );
  const violating = runCli(['--root', cleanRoot, '--baseline', baselineFile]);
  assert.equal(violating.status, 1);

  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cinethos-empty-cli-'));
  const empty = runCli(['--root', emptyRoot, '--baseline', baselineFile]);
  assert.equal(empty.status, 2);
});
