#!/usr/bin/env node
/**
 * Cinethos — mimari sınır kapısı (CI).
 *
 * `architecture-boundaries.mjs` taramasını gerekçeli istisna listesiyle
 * karşılaştırır ve şu durumlarda **başarısız** olur:
 *   - tarayıcı çalışmazsa / hiç dosya bulamazsa (ERROR, çıkış 2),
 *   - istisna listesinde olmayan yeni ihlal varsa (çıkış 1),
 *   - düzeltilmiş bir ihlal hâlâ istisna listesindeyse (stale, çıkış 1),
 *   - kurallar kilitle uyuşmuyorsa veya zorunlu yasaklar gevşetilmişse (çıkış 1).
 *
 * SALT OKUNUR: hiçbir dosyayı değiştirmez, baseline'ı kendiliğinden güncellemez.
 *
 * Kullanım:
 *   node scripts/maintenance/check-architecture.mjs [--root <yol>] [--baseline <yol>] [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { flattenViolations, runArchitectureScan } from './architecture-boundaries.mjs';
import {
  diffAgainstBaseline,
  loadJsonIfExists,
  validateRulesIntegrity,
} from './architecture-guard.mjs';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(MODULE_DIR, '../..');
const RULES_PATH = path.join(MODULE_DIR, 'architecture-rules.json');
const LOCK_PATH = path.join(MODULE_DIR, 'architecture-rules.lock.json');
const BASELINE_PATH = path.join(MODULE_DIR, 'architecture-baseline.json');

function parseArgs(argv) {
  const options = { root: ROOT, json: false, baseline: BASELINE_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--root') options.root = path.resolve(argv[index + 1] ?? ROOT);
    else if (arg.startsWith('--root=')) options.root = path.resolve(arg.slice('--root='.length));
    else if (arg === '--baseline') options.baseline = path.resolve(argv[index + 1] ?? BASELINE_PATH);
    else if (arg.startsWith('--baseline=')) options.baseline = path.resolve(arg.slice('--baseline='.length));
  }
  return options;
}

function printJson(result) {
  console.log(JSON.stringify(result, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = {
    ok: false,
    status: 'ERROR',
    root: options.root,
    scannedFiles: 0,
    violations: 0,
    unexpected: [],
    stale: [],
    ruleErrors: [],
    errors: [],
  };

  let scan;
  try {
    scan = runArchitectureScan({ root: options.root });
  } catch (error) {
    result.errors.push(`Mimari tarama çalıştırılamadı: ${error.message}`);
    if (options.json) printJson(result);
    else console.error(`❌ ${result.errors[0]}`);
    process.exitCode = 2;
    return;
  }

  result.scannedFiles = scan.scannedFiles;
  const violations = flattenViolations(scan);
  result.violations = violations.length;

  const rulesRaw = fs.readFileSync(RULES_PATH, 'utf8');
  const rules = JSON.parse(rulesRaw);
  const lock = loadJsonIfExists(LOCK_PATH);
  result.ruleErrors = validateRulesIntegrity(rulesRaw, rules, lock);

  const baseline = loadJsonIfExists(options.baseline);
  if (!baseline || !Array.isArray(baseline.exceptions)) {
    result.errors.push('architecture-baseline.json okunamadı veya exceptions dizisi yok.');
  }
  const diff = diffAgainstBaseline(violations, baseline?.exceptions ?? []);
  result.unexpected = diff.unexpected;
  result.stale = diff.stale;

  const failed =
    result.errors.length > 0 || result.ruleErrors.length > 0 || diff.unexpected.length > 0 || diff.stale.length > 0;
  result.ok = !failed;
  result.status = failed ? 'FAIL' : 'PASS';

  if (options.json) {
    printJson(result);
  } else {
    console.log(`Taranan dosya: ${scan.scannedFiles} (${JSON.stringify(scan.extensionCounts)})`);
    console.log(`Mimari ihlal: ${violations.length} (istisna: ${diff.matched.length}, yeni: ${diff.unexpected.length})`);
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`❌ ${error}`);
    }
    if (result.ruleErrors.length > 0) {
      console.error('❌ Kural bütünlüğü hatası:');
      for (const error of result.ruleErrors) console.error(`   - ${error}`);
    }
    for (const violation of diff.unexpected) {
      console.error(`❌ YENİ İHLAL: ${violation.file}:${violation.line} → ${violation.specifier} [${violation.rule}]`);
    }
    for (const exception of diff.stale) {
      console.error(
        `❌ ESKİ İSTİSNA: ${exception.file} → ${exception.specifier} artık ihlal değil; architecture-baseline.json'dan çıkarın.`,
      );
    }
    console.log(result.ok ? '✅ Mimari kapı: PASS' : '❌ Mimari kapı: FAIL');
  }

  process.exitCode = failed ? 1 : 0;
}

main();
