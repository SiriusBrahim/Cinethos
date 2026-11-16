// Cinethos — M0 bakım robotu BAĞIMSIZ denetim: 10 negatif senaryo.
//
// Her senaryo geçici kopya depo/dizin üzerinde çalışır; gerçek çalışma dalındaki
// dosyalar bozulmaz. Her senaryoda beklenen sonuç ile gerçek sonuç karşılaştırılır.
//
// Senaryolar (görev şartnamesi §5):
//   1. Yeni mimari ihlal ekleme                  → kapı FAIL (çıkış 1)
//   2. Yasaklı import kuralını kaldırma          → kilit uyuşmazlığı FAIL
//   3. Kural kilidini değiştirme (required gevşetme) → FAIL
//   4. Tarayıcının hata vermesi                  → ERROR (çıkış 2) / verdict ERROR
//   5. Ayrıştırılamayan test çıktısı             → INCOMPLETE (çıkış 1)
//   6. Bozuk (başarısız) test çıktısı            → FAIL (çıkış 1)
//   7. Eski baseline ile gizleme girişimi        → stale FAIL; baseline'a elle
//      ekleme ile gizleme denemesi belgelenir (bilinen sınırlık — raporda)
//   8. R2'yi otomatik onarıma yönlendirme denemesi → reddedilir (autoFixable false,
//      scriptlerde onarım/commit/PR yolu yok)
//   9. compare_baseline=false davranışı          → --compare verilmezse raporda
//      karşılaştırma bölümü oluşmaz; verildiğinde oluşur
//  10. Salt okunur analiz sırasında kaynak dosyaya yazma girişimi → depo
//      değişmez (dosya özet manifestosu önce/sonra aynı)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { computeVerdict } from '../../scripts/maintenance/analyze.mjs';
import { classifyFinding } from '../../scripts/maintenance/risk-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Geçici kopya depo: scripts/maintenance + minimal src ağacı kopyalanır. */
function makeCopyRepo({ srcFiles = {}, packageJson = null, nodeModulesSymlink = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'm0-negcheck-'));
  fs.mkdirSync(path.join(root, 'scripts/maintenance'), { recursive: true });
  for (const name of fs.readdirSync(path.join(ROOT, 'scripts/maintenance'))) {
    fs.copyFileSync(path.join(ROOT, 'scripts/maintenance', name), path.join(root, 'scripts/maintenance', name));
  }
  for (const [relative, content] of Object.entries(srcFiles)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  if (packageJson) {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(packageJson, null, 2));
  }
  if (nodeModulesSymlink) {
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  }
  // analyze.mjs buildMeta için `git rev-parse HEAD` çalıştırır; geçici depoda
  // geçerli bir git deposu ve commit gereklidir, aksi halde rapor üretilmez.
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'm0-negcheck@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'm0-negcheck'], { cwd: root });
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules\nmaintenance-report\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'm0 negcheck fixture'], { cwd: root });
  return root;
}

/** Kopya deponun KENDİ mimari kapısı (kopyadaki rules/lock/baseline'ı okur). */
function copyCheckCli(root) {
  return path.join(root, 'scripts/maintenance/check-architecture.mjs');
}

function runNode(cli, args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

function writeBaseline(root, exceptions) {
  const baselinePath = path.join(root, 'baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify({ version: 1, exceptions }, null, 2));
  return baselinePath;
}

const CLEAN_SRC = {
  'src/core/clean.ts': 'export const clean = 1;\n',
  'src/services/clean.ts': 'export const service = 1;\n',
};

// ---------------------------------------------------------------------------
// Senaryo 1 — Yeni mimari ihlal ekleme
// ---------------------------------------------------------------------------
test('N1: yeni mimari ihlal kapıyı başarısız kılar (YENİ İHLAL raporlanır)', () => {
  const root = makeCopyRepo({ srcFiles: CLEAN_SRC });
  const baseline = writeBaseline(root, []);
  const before = runNode(copyCheckCli(root), ['--root', root, '--baseline', baseline], root);
  assert.equal(before.status, 0, `temiz depo PASS beklenir: ${before.stderr}`);

  fs.writeFileSync(path.join(root, 'src/core/bad.ts'), "import { service } from '../services/clean.ts';\n");
  const after = runNode(copyCheckCli(root), ['--root', root, '--baseline', baseline], root);
  // Beklenen: çıkış 1 + "YENİ İHLAL" mesajı. Gerçek: aşağıdaki assertion.
  assert.equal(after.status, 1, `yeni ihlal FAIL beklenir: ${after.stdout}`);
  assert.match(after.stderr, /YENİ İHLAL/);
  assert.match(after.stderr, /src\/core\/bad\.ts/);
});

// ---------------------------------------------------------------------------
// Senaryo 2 — Yasaklı import kuralını kaldırma
// ---------------------------------------------------------------------------
test('N2: yasaklı paket kuralı kaldırıldığında kilit uyuşmazlığı kapıyı düşürür', () => {
  const root = makeCopyRepo({ srcFiles: CLEAN_SRC });
  const rulesPath = path.join(root, 'scripts/maintenance/architecture-rules.json');
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const corePurity = rules.rules.find((rule) => rule.id === 'core-purity');
  corePurity.forbidPackages = corePurity.forbidPackages.filter((pkg) => pkg !== 'react');
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2));

  const baseline = writeBaseline(root, []);
  const result = runNode(copyCheckCli(root), ['--root', root, '--baseline', baseline], root);
  // Beklenen: kural dosyası kilit SHA'sıyla uyuşmaz → çıkış 1. Gerçek: assertion.
  assert.equal(result.status, 1, `gevşetilen kural FAIL beklenir: ${result.stdout}`);
  assert.match(result.stderr, /özeti kilitle uyuşmuyor/);
});

// ---------------------------------------------------------------------------
// Senaryo 3 — Kural kilidini değiştirme (SHA güncellenip required gevşetilir)
// ---------------------------------------------------------------------------
test('N3: kilit SHA\'sı güncellenip zorunlu yasak kümesi gevşetilirse yine FAIL olur', () => {
  const root = makeCopyRepo({ srcFiles: CLEAN_SRC });
  const maintDir = path.join(root, 'scripts/maintenance');
  const rulesPath = path.join(maintDir, 'architecture-rules.json');
  const lockPath = path.join(maintDir, 'architecture-rules.lock.json');

  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const corePurity = rules.rules.find((rule) => rule.id === 'core-purity');
  corePurity.forbidPackages = corePurity.forbidPackages.filter((pkg) => pkg !== 'react');
  const rulesRaw = JSON.stringify(rules, null, 2);
  fs.writeFileSync(rulesPath, rulesRaw);

  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  // Saldırgan SHA'yı da günceller:
  lock.sha256 = crypto.createHash('sha256').update(rulesRaw, 'utf8').digest('hex');
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));

  const baseline = writeBaseline(root, []);
  const result = runNode(copyCheckCli(root), ['--root', root, '--baseline', baseline], root);
  // Beklenen: required.forbidPackages denetimi gevşetmeyi yakalar → çıkış 1.
  assert.equal(result.status, 1, `required denetimi FAIL beklenir: ${result.stdout}`);
  assert.match(result.stderr, /yasak paket gevşetilmiş/);
});

test('N3b: kilitten zorunlu kural silinirse "Zorunlu mimari kural eksik" ile FAIL', () => {
  const root = makeCopyRepo({ srcFiles: CLEAN_SRC });
  const lockPath = path.join(root, 'scripts/maintenance/architecture-rules.lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.ruleIds = lock.ruleIds.filter((id) => id !== 'contracts-isolation');
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));

  const baseline = writeBaseline(root, []);
  const result = runNode(copyCheckCli(root), ['--root', root, '--baseline', baseline], root);
  assert.equal(result.status, 1, `kural silme FAIL beklenir: ${result.stdout}`);
  // Kilit listeden çıkarılan kural "kilitsiz yeni kural" olarak yakalanır:
  // kurallar ve kilit birebir eşleşmek zorundadır.
  assert.match(result.stderr, /Kilitsiz yeni mimari kural: contracts-isolation/);
});

// ---------------------------------------------------------------------------
// Senaryo 4 — Tarayıcının hata vermesi
// ---------------------------------------------------------------------------
test('N4: tarayıcı hiç dosya bulamazsa kapı ERROR verir (çıkış 2), PASS değil', () => {
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'm0-empty-'));
  const baseline = writeBaseline(emptyRoot, []);
  const result = runNode(
    path.join(ROOT, 'scripts/maintenance/check-architecture.mjs'),
    ['--root', emptyRoot, '--baseline', baseline],
    emptyRoot,
  );
  // Beklenen: çıkış 2 (ERROR). Gerçek: assertion.
  assert.equal(result.status, 2, `boş kök ERROR beklenir: ${result.stdout}`);
  assert.match(result.stderr, /Taranacak kaynak dosya bulunamadı/);
});

test('N4b: mimari tarama hatası genel verdict ERROR üretir (PASS değil)', () => {
  const verdict = computeVerdict({
    checks: [{ id: 'unit-tests', blocking: true, status: 'PASS' }],
    architecture: null,
    architectureError: 'Taranacak kaynak dosya bulunamadı',
  });
  assert.equal(verdict.status, 'ERROR');
});

// ---------------------------------------------------------------------------
// Senaryo 5 — Ayrıştırılamayan test çıktısı → INCOMPLETE
// ---------------------------------------------------------------------------
test('N5: test çıktısı ayrıştırılamazsa analiz INCOMPLETE olur ve çıkış 1 verir', () => {
  const root = makeCopyRepo({
    srcFiles: CLEAN_SRC,
    packageJson: {
      name: 'm0-negcheck',
      version: '1.0.0',
      scripts: { test: "echo 'bu çıktı test özeti içermiyor'" },
    },
    nodeModulesSymlink: true,
  });
  const result = runNode(path.join(root, 'scripts/maintenance/analyze.mjs'), ['--only', 'unit-tests', '--report-dir', 'maintenance-report'], root);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'maintenance-report/report.json'), 'utf8'));
  // Beklenen: ayrıştırılamayan çıktı zorunlu kontrolde INCOMPLETE → çıkış 1.
  assert.equal(result.status, 1, `INCOMPLETE çıkışı beklenir: ${result.stdout}`);
  assert.equal(report.verdict.status, 'INCOMPLETE', 'ayrıştırılamayan çıktı PASS sayılamaz');
  const unitCheck = report.checks.find((check) => check.id === 'unit-tests');
  assert.equal(unitCheck.status, 'INCOMPLETE');
  assert.match(unitCheck.summary, /ayrıştırılamadı/);
});

// ---------------------------------------------------------------------------
// Senaryo 6 — Bozuk (başarısız) test çıktısı → FAIL
// ---------------------------------------------------------------------------
test('N6: başarısız test komutu FAIL üretir, çıkış 1; PASS maskelenmez', () => {
  const root = makeCopyRepo({
    srcFiles: CLEAN_SRC,
    packageJson: {
      name: 'm0-negcheck',
      version: '1.0.0',
      // Ayrıştırılabilir özet + fail>0 + sıfırdan farklı çıkış kodu:
      scripts: {
        test:
          "node -e \"console.log('not ok 1 - bozuk test'); console.log('# tests 1'); console.log('# pass 0'); console.log('# fail 1'); process.exit(1)\"",
      },
    },
    nodeModulesSymlink: true,
  });
  const result = runNode(path.join(root, 'scripts/maintenance/analyze.mjs'), ['--only', 'unit-tests', '--report-dir', 'maintenance-report'], root);
  const report = JSON.parse(fs.readFileSync(path.join(root, 'maintenance-report/report.json'), 'utf8'));
  assert.equal(result.status, 1);
  assert.equal(report.verdict.status, 'FAIL');
  assert.ok(report.verdict.blockingFailures >= 1);
});

// ---------------------------------------------------------------------------
// Senaryo 7 — Eski baseline ile gizleme girişimi
// ---------------------------------------------------------------------------
test('N7a: çözülmüş ihlal baseline\'da kalırsa kapı "stale exception" ile FAIL olur', () => {
  const root = makeCopyRepo({ srcFiles: CLEAN_SRC });
  // İhlal YOK, ama baseline'da hâlâ kayıt var → bayat istisna.
  const baseline = writeBaseline(root, [
    { rule: 'core-purity', file: 'src/core/old.ts', specifier: '../services/clean.ts' },
  ]);
  const result = runNode(copyCheckCli(root), ['--root', root, '--baseline', baseline], root);
  // Beklenen: bayat istisna FAIL. Gerçek: assertion.
  assert.equal(result.status, 1, `bayat istisna FAIL beklenir: ${result.stdout}`);
  assert.match(result.stderr, /ESKİ İSTİSNA/);
});

test('N7b: yeni ihlali baseline\'a elle ekleyerek gizleme denemesi — kapı geçer (BİLİNEN SINIRLILIK)', () => {
  // Bu senaryo bilinen bir sınırlılığı BELGELER: baseline dosyasının kendi
  // bütünlük kilidi yoktur; yeni ihlali baseline'a eklemek kapıyı geçer.
  // Kontrol mekanizması PR incelemesidir (baseline değişikliği diff'te görünür).
  // RAPOR: Agent 2'ye "baseline değişiklikleri için review zorunluluğu + opsiyonel
  // hash kilidi" önerisi ile iletilecektir.
  const root = makeCopyRepo({ srcFiles: CLEAN_SRC });
  fs.writeFileSync(path.join(root, 'src/core/bad.ts'), "import { service } from '../services/clean.ts';\n");
  const baseline = writeBaseline(root, [
    { rule: 'core-purity', file: 'src/core/bad.ts', specifier: '../services/clean.ts' },
  ]);
  const result = runNode(copyCheckCli(root), ['--root', root, '--baseline', baseline], root);
  // Gerçek davranış: kapı geçer (istisna eşleşir). Bu test davranışı sabitlemek
  // içindir; sınırlılık teslim raporunda risk olarak listelenir.
  assert.equal(result.status, 0, 'mevcut davranış: baseline elle ekleme kapıyı geçer');
});

// ---------------------------------------------------------------------------
// Senaryo 8 — R2'yi otomatik onarıma yönlendirme denemesi
// ---------------------------------------------------------------------------
test('N8: R2 bulgusu otomatik onarıma yönlendirilemez (autoFixable false, onarım yolu yok)', () => {
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/maintenance/risk-policy.json'), 'utf8'));
  for (const finding of [
    { source: 'architecture', file: 'src/core/cinetrack-core.ts', fixable: true },
    { source: 'eslint', file: 'src/server/persistent-store.ts', rule: 'no-unused-vars', fixable: true },
    { source: 'tsc', file: 'src/server/sqlite-primary-store.ts', fixable: true },
  ]) {
    const classified = classifyFinding(finding, policy);
    assert.equal(classified.risk, 'R2', JSON.stringify(finding));
    assert.equal(classified.autoFixable, false, `R2 otomatik onarılamaz: ${finding.file}`);
  }

  // Statik garanti: kapı ve yardımcı scriptlerde onarım/commit/PR/silme yolu yok.
  for (const script of [
    'check-architecture.mjs',
    'architecture-guard.mjs',
    'risk-classifier.mjs',
    'report-diff.mjs',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/maintenance', script), 'utf8');
    assert.doesNotMatch(source, /fs\.writeFile|fs\.rm|fs\.unlink|fs\.rename|fs\.mkdir/, `${script} dosya yazmamalı`);
    assert.doesNotMatch(source, /git\s+(commit|push|checkout\b -b)|gh\s+pr|--fix\b/, `${script} onarım/commit/PR üretmemeli`);
  }
});

// ---------------------------------------------------------------------------
// Senaryo 9 — compare_baseline=false davranışı
// ---------------------------------------------------------------------------
test('N9: --compare verilmezse raporda karşılaştırma oluşmaz; verilirse yeni ihlal raporlanır', () => {
  const srcFiles = {
    ...CLEAN_SRC,
    'src/core/extra.ts': "import { service } from '../services/clean.ts';\n",
  };
  const fastTest = {
    name: 'm0-negcheck',
    version: '1.0.0',
    scripts: { test: "node -e \"console.log('ℹ tests 1'); console.log('ℹ pass 1'); console.log('ℹ fail 0')\"" },
  };

  const withoutCompare = makeCopyRepo({ srcFiles, packageJson: fastTest, nodeModulesSymlink: true });
  runNode(path.join(withoutCompare, 'scripts/maintenance/analyze.mjs'), ['--only', 'unit-tests', '--report-dir', 'maintenance-report'], withoutCompare);
  const reportA = JSON.parse(
    fs.readFileSync(path.join(withoutCompare, 'maintenance-report/report.json'), 'utf8'),
  );
  // Beklenen (compare_baseline=false): compare bölümü YOK, verdict etkilenmez.
  assert.equal(reportA.compare, null, 'compare verilmediğinde karşılaştırma üretilmemeli');
  assert.equal(reportA.compareError, null);

  const previousSnapshot = {
    version: 1,
    commit: '0000000000000000000000000000000000000000',
    verdict: 'PASS',
    violations: [],
    checks: [{ id: 'unit-tests', status: 'PASS' }],
  };
  fs.writeFileSync(path.join(withoutCompare, 'previous.json'), JSON.stringify(previousSnapshot));
  runNode(
    path.join(withoutCompare, 'scripts/maintenance/analyze.mjs'),
    ['--only', 'unit-tests', '--report-dir', 'maintenance-report', '--compare', 'previous.json'],
    withoutCompare,
  );
  const reportB = JSON.parse(
    fs.readFileSync(path.join(withoutCompare, 'maintenance-report/report.json'), 'utf8'),
  );
  // Beklenen (--compare verildi): yeni ihlal görünür (src/core/extra.ts).
  assert.ok(reportB.compare, 'compare verildiğinde karşılaştırma üretilmeli');
  assert.equal(reportB.compare.newViolations.length, 1);
  assert.equal(reportB.compare.newViolations[0].file, 'src/core/extra.ts');
});

// ---------------------------------------------------------------------------
// Senaryo 10 — Salt okunur analiz: kaynak dosyalara yazma girişimi yok
// ---------------------------------------------------------------------------
test('N10: tarama + mimari kapı çalışması depo içeriğini değiştirmez (hash manifestosu)', () => {
  const root = makeCopyRepo({ srcFiles: CLEAN_SRC });
  const baseline = writeBaseline(root, []);

  const manifest = () => {
    const hashes = {};
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'baseline.json') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          hashes[path.relative(root, full)] = crypto
            .createHash('sha256')
            .update(fs.readFileSync(full))
            .digest('hex');
        }
      }
    };
    walk(root);
    return hashes;
  };

  const before = manifest();
  runNode(copyCheckCli(root), ['--root', root, '--baseline', baseline], root);
  // analyze.mjs yalnızca --report-dir altına yazmalı:
  runNode(path.join(root, 'scripts/maintenance/analyze.mjs'), ['--only', 'unit-tests', '--report-dir', 'maintenance-report'], root);
  const after = manifest();

  const changed = Object.keys(before).filter((file) => before[file] !== after[file]);
  assert.deepEqual(changed, [], `salt okunur analiz kaynak dosyaları değiştirdi: ${changed.join(', ')}`);
  assert.ok(fs.existsSync(path.join(root, 'maintenance-report/report.json')), 'rapor üretilmiş olmalı');
});
