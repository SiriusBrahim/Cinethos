#!/usr/bin/env node
/**
 * Cinethos — Otomatik Kod Bakım Modülü, M0 (gözlem modu) rapor üreticisi.
 *
 * Plan: docs/maintenance/OTOMATIK-KOD-BAKIM-ONARIM-PLANI.md §4 (M0)
 *
 * SALT OKUNUR: hiçbir kaynak dosyayı değiştirmez, branch veya PR oluşturmaz.
 * Yalnızca mevcut doğrulama komutlarını çalıştırır, mimari import sınırlarını
 * ölçer ve sonuçları tek bir raporda birleştirir.
 *
 * Çıktılar (<rapor dizini> altında):
 *   report.md    — GitHub Actions özeti ile aynı Markdown raporu
 *   report.json  — tam yapısal rapor
 *   logs/*.log   — her komutun tam çıktısı
 *
 * Kullanım:
 *   node scripts/maintenance/analyze.mjs [--install] [--report-dir <yol>] [--only <id,id>]
 *     [--compare <onceki-rapor.json>] [--save-baseline <baseline.json>]
 *
 * Bütünlük kuralı: analiz tamamlanamazsa (ayrıştırılamayan test çıktısı, mimari
 * tarama hatası, bağımlılık yokluğu) sonuç PASS olamaz; INCOMPLETE veya ERROR olur
 * ve süreç sıfırdan farklı çıkış koduyla biter.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { flattenViolations, runArchitectureScan } from './architecture-boundaries.mjs';
import { computeRulesHash } from './architecture-guard.mjs';
import { compareSnapshots, formatComparisonMarkdown, normalizeSnapshot } from './report-diff.mjs';
import { classifyFinding, loadRiskPolicy, summarizeRisks } from './risk-classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NODE = process.execPath;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CAPTURED_BYTES = 8 * 1024 * 1024;

/**
 * Kontroller mevcut `package.json` komutlarını yansıtır:
 * `npm run lint` = eslint + tsc (uygulama) + tsc (testler).
 * Ayrı ayrı çalıştırılır ki raporda her sinyal ayrı görünsün.
 */
const CHECKS = [
  {
    id: 'install',
    label: 'Temiz bağımlılık kurulumu (npm ci)',
    command: [NPM, 'ci'],
    blocking: true,
    optional: true,
  },
  {
    id: 'eslint',
    needsDependencies: true,
    label: 'ESLint (src, server.ts, tests)',
    command: [
      NODE,
      'node_modules/eslint/bin/eslint.js',
      'src',
      'server.ts',
      'tests',
      '--max-warnings',
      '0',
      '--format',
      'json',
    ],
    blocking: true,
    parse: 'eslint',
  },
  {
    id: 'typecheck',
    needsDependencies: true,
    label: 'TypeScript tip denetimi (uygulama)',
    command: [NODE, 'node_modules/typescript/bin/tsc', '--noEmit'],
    blocking: true,
    parse: 'tsc',
  },
  {
    id: 'typecheck-tests',
    needsDependencies: true,
    label: 'TypeScript tip denetimi (testler)',
    command: [NODE, 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.tests.json'],
    blocking: true,
    parse: 'tsc',
  },
  {
    id: 'unit-tests',
    needsDependencies: true,
    label: 'Birim testleri (npm test)',
    command: [NPM, 'test'],
    blocking: true,
    parse: 'node-test',
  },
  {
    id: 'taste-tests',
    needsDependencies: true,
    label: 'Taste testleri (npm run test:taste)',
    command: [NPM, 'run', 'test:taste'],
    blocking: true,
    parse: 'node-test',
  },
  {
    id: 'build',
    needsDependencies: true,
    label: 'Üretim derlemesi (npm run build)',
    command: [NPM, 'run', 'build'],
    blocking: true,
    parse: 'build',
  },
  {
    id: 'audit-prod',
    label: 'Bağımlılık güvenlik taraması (production, high+)',
    command: [NPM, 'audit', '--omit=dev', '--audit-level=high', '--json'],
    blocking: true,
    parse: 'audit',
  },
  {
    id: 'audit-all',
    label: 'Bağımlılık güvenlik taraması (tüm bağımlılıklar, bilgi amaçlı)',
    command: [NPM, 'audit', '--json'],
    blocking: false,
    parse: 'audit',
  },
];

function parseArgs(argv) {
  const options = {
    reportDir: 'maintenance-report',
    install: false,
    only: null,
    help: false,
    compare: null,
    saveBaseline: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--install') options.install = true;
    else if (arg === '--report-dir') options.reportDir = argv[index + 1] ?? options.reportDir;
    else if (arg.startsWith('--report-dir=')) options.reportDir = arg.slice('--report-dir='.length);
    else if (arg === '--compare') options.compare = argv[index + 1] ?? null;
    else if (arg.startsWith('--compare=')) options.compare = arg.slice('--compare='.length);
    else if (arg === '--save-baseline') options.saveBaseline = argv[index + 1] ?? null;
    else if (arg.startsWith('--save-baseline=')) options.saveBaseline = arg.slice('--save-baseline='.length);
    else if (arg === '--only') {
      options.only = String(argv[index + 1] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg.startsWith('--only=')) {
      options.only = arg
        .slice('--only='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Cinethos bakım analizi (M0, salt okunur)

Kullanım:
  node scripts/maintenance/analyze.mjs [seçenekler]

Seçenekler:
  --install            Önce temiz kurulum (npm ci) yapar; CI bu seçeneği kullanır.
  --report-dir <yol>   Rapor dizini (varsayılan: maintenance-report).
  --only <id,id>       Yalnızca verilen kontrolleri çalıştırır.
                       Kimlikler: ${CHECKS.map((check) => check.id).join(', ')}
  --compare <dosya>    Önceki rapor/baseline ile karşılaştırır (yeni/düzelen ihlaller).
  --save-baseline <dosya> Karşılaştırma için kompakt baseline yazar.
  --help               Bu yardımı gösterir.

Rapor: <rapor dizini>/report.md, report.json ve logs/.
Mimari tarama her zaman çalışır ve yalnızca raporlar (otomatik düzeltme yoktur).`);
}

function formatDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0 sn';
  const seconds = Math.round(durationMs / 1000);
  if (seconds < 60) return `${seconds} sn`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} dk ${seconds % 60} sn`;
}

function appendCaptured(current, chunk) {
  if (current.length >= MAX_CAPTURED_BYTES) return current;
  return (current + chunk).slice(0, MAX_CAPTURED_BYTES);
}

function runCommand(command, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    let child;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd: ROOT,
        env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: String(error), durationMs: 0, timedOut: false });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = appendCaptured(stdout, chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendCaptured(stderr, chunk.toString());
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: `${stderr}\n${String(error)}`, durationMs: Date.now() - startedAt, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
    });
  });
}

function parseEslint(stdout) {
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error('ESLint JSON çıktısı bulunamadı');
  const results = JSON.parse(stdout.slice(start));
  let errors = 0;
  let warnings = 0;
  const findings = [];
  for (const result of results) {
    errors += result.errorCount ?? 0;
    warnings += result.warningCount ?? 0;
    for (const message of result.messages ?? []) {
      findings.push({
        source: 'eslint',
        file: path.relative(ROOT, result.filePath ?? ''),
        line: message.line ?? 0,
        column: message.column ?? 0,
        severity: message.severity === 2 ? 'error' : 'warning',
        rule: message.ruleId ?? null,
        message: message.message,
        fixable: Boolean(message.fix),
      });
    }
  }
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return {
    summary: `${errors} hata, ${warnings} uyarı`,
    counts: { errors, warnings },
    findings: findings.slice(0, 25),
  };
}

function parseTsc(stdout, stderr) {
  const output = `${stdout}\n${stderr}`;
  const matches = [...output.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)];
  const total = matches.length || [...output.matchAll(/\berror TS\d+\b/g)].length;
  return {
    summary: total === 0 ? 'tip hatası yok' : `${total} tip hatası`,
    counts: { errors: total },
    findings: matches.slice(0, 25).map((match) => ({
      source: 'tsc',
      file: match[1],
      line: Number(match[2]),
      rule: match[4],
      message: match[5],
      fixable: false,
    })),
  };
}

export function parseNodeTest(stdout, stderr) {
  const output = `${stdout}\n${stderr}`;
  // Node test runner hem TAP ("# tests 12") hem spec ("ℹ tests 12") özeti üretir.
  const lastValue = (label) => {
    const pattern = new RegExp(`^(?:#|ℹ)\\s*${label}\\s+(\\d+)$`, 'gm');
    const all = [...output.matchAll(pattern)];
    return all.length > 0 ? Number(all[all.length - 1][1]) : null;
  };
  const tests = lastValue('tests');
  const pass = lastValue('pass');
  const fail = lastValue('fail');
  const skipped = lastValue('skipped');
  const cancelled = lastValue('cancelled');
  const failedLines = output
    .split(/\r?\n/)
    .filter((line) => /^(?:not ok |✖ )/.test(line))
    .slice(0, 25)
    .map((line) => ({ message: line }));

  if (tests === null) {
    // Özet yoksa sonuç başarı sayılamaz: çıktı biçimi beklenenden farklı veya test
    // çalıştırılamamış olabilir. Çağıran taraf bunu INCOMPLETE olarak işaretler.
    throw new Error(
      failedLines.length > 0
        ? `test özeti bulunamadı (${failedLines.length} başarısız satır)`
        : 'test özeti bulunamadı',
    );
  }
  return {
    summary: `${tests} test, ${pass ?? 0} geçti, ${fail ?? 0} başarısız${
      skipped ? `, ${skipped} atlandı` : ''
    }${cancelled ? `, ${cancelled} iptal` : ''}`,
    counts: { tests, pass, fail, skipped, cancelled },
    findings: failedLines,
  };
}

function parseBuild(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error('derleme çıktısı boş; derlemenin gerçekten çalıştığı doğrulanamadı');
  }
  return {
    summary: 'derleme çıktısı üretildi',
    counts: null,
    findings: lines.slice(-8).map((line) => ({ message: line })),
  };
}

function parseAudit(stdout) {
  const start = stdout.indexOf('{');
  if (start === -1) throw new Error('npm audit JSON çıktısı bulunamadı');
  const data = JSON.parse(stdout.slice(start));
  const counts = data.metadata?.vulnerabilities ?? {};
  const packages = Object.entries(data.vulnerabilities ?? {}).map(([name, info]) => ({
    name,
    severity: info.severity ?? 'unknown',
    direct: Boolean(info.isDirect),
    fixAvailable: Boolean(info.fixAvailable),
    advisories: (info.via ?? [])
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({
        title: entry.title,
        severity: entry.severity,
        url: entry.url,
        range: entry.range,
      })),
  }));
  const order = { critical: 0, high: 1, moderate: 2, low: 3, info: 4, unknown: 5 };
  packages.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  return {
    summary: `kritik ${counts.critical ?? 0}, yüksek ${counts.high ?? 0}, orta ${
      counts.moderate ?? 0
    }, düşük ${counts.low ?? 0} (toplam ${counts.total ?? 0})`,
    counts,
    findings: packages.slice(0, 20),
  };
}

function parseOutput(parser, result) {
  switch (parser) {
    case 'eslint':
      return parseEslint(result.stdout);
    case 'tsc':
      return parseTsc(result.stdout, result.stderr);
    case 'node-test':
      return parseNodeTest(result.stdout, result.stderr);
    case 'build':
      return parseBuild(result.stdout, result.stderr);
    case 'audit':
      return parseAudit(result.stdout);
    default:
      throw new Error(`bilinmeyen ayrıştırıcı: ${parser}`);
  }
}

function logHeader(check, result) {
  return [
    `# ${check.label}`,
    `# Komut: ${displayCommand(check.command)}`,
    `# Çıkış kodu: ${result.exitCode ?? '(yok)'}${result.timedOut ? ' (zaman aşımı)' : ''}`,
    `# Süre: ${formatDuration(result.durationMs)}`,
    '',
    '## stdout',
    result.stdout,
    '',
    '## stderr',
    result.stderr,
    '',
  ].join('\n');
}

function mdEscape(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdText(value) {
  return String(value ?? '').replace(/\r?\n/g, ' ');
}

function displayCommand(command) {
  return command[0] === NODE ? `node ${command.slice(1).join(' ')}` : command.join(' ');
}

function readCommit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function buildMeta() {
  const server = process.env.GITHUB_SERVER_URL;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return {
    commit: readCommit(),
    ref: process.env.GITHUB_REF_NAME ?? process.env.GITHUB_REF ?? null,
    event: process.env.GITHUB_EVENT_NAME ?? 'local',
    runUrl: server && repository && runId ? `${server}/${repository}/actions/runs/${runId}` : null,
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    mode: 'M0 — salt okunur gözlem (otomatik düzeltme yok)',
  };
}

function statusLabel(status) {
  switch (status) {
    case 'PASS':
      return '✅ PASS';
    case 'FAIL':
      return '❌ FAIL';
    case 'INFO':
      return '⚠️ INFO';
    case 'SKIP':
      return '⏭️ SKIP';
    default:
      return status;
  }
}

/**
 * Genel sonuç: PASS yalnızca tüm zorunlu kontroller PASS VE mimari tarama
 * tamamlandığında verilir. Aksi halde FAIL / INCOMPLETE / ERROR döner.
 * Dışa açıktır (test edilebilirlik).
 */
export function computeVerdict({ checks, architecture, architectureError }) {
  // İsteğe bağlı kontroller (ör. --install verilmediğinde npm ci) atlandığında
  // analiz eksik sayılmaz; yalnızca zorunlu ve isteğe bağlı OLMAYAN atlamalar
  // INCOMPLETE üretir.
  const blockingChecks = (checks ?? []).filter((check) => check.blocking);
  const blockingFailures = blockingChecks.filter((check) => check.status === 'FAIL').length;
  const incompleteChecks = blockingChecks.filter(
    (check) =>
      check.status === 'INCOMPLETE' || (check.status === 'SKIP' && check.optional !== true),
  ).length;

  let status = 'PASS';
  if (architectureError) status = 'ERROR';
  else if (blockingFailures > 0) status = 'FAIL';
  else if (incompleteChecks > 0 || !architecture) status = 'INCOMPLETE';

  return {
    status,
    blockingFailures,
    incompleteChecks,
    architectureScanned: Boolean(architecture),
    architectureError: architectureError ?? null,
    totalChecks: (checks ?? []).length,
  };
}

function verdictText(verdict) {
  switch (verdict.status) {
    case 'PASS':
      return '**Sonuç: ✅ PASS** — zorunlu kontrollerin tamamı başarılı ve mimari tarama tamamlandı.';
    case 'FAIL':
      return `**Sonuç: ❌ FAIL** — ${verdict.blockingFailures} zorunlu kontrol başarısız. Bu rapor bir bakım PR’ı üretmez; hata giderilmeden hiçbir otomatik düzeltme hazır sayılmaz.`;
    case 'ERROR':
      return `**Sonuç: ⛔ ERROR** — analiz tamamlanamadı: ${mdEscape(
        verdict.architectureError ?? 'mimari tarama çalıştırılamadı',
      )}. PASS verilmez.`;
    default:
      return `**Sonuç: ⚠️ INCOMPLETE** — ${verdict.incompleteChecks} zorunlu kontrol tamamlanamadı (eksik bağımlılık, ayrıştırılamayan çıktı veya atlanan kontrol). Eksik analiz PASS sayılmaz.`;
  }
}

function buildMarkdown(report) {
  const { meta, verdict, checks, architecture, architectureError, compare } = report;
  const lines = [];
  const push = (line = '') => lines.push(line);

  push('# Cinethos — Bakım Analizi Raporu (M0 · salt okunur)');
  push();
  push(
    '> Otomatik kod bakım modülünün **M0 gözlem** aşamasıdır. Bu çalıştırma kaynak dosya, branch veya PR değiştirmez; yalnızca mevcut doğrulama sonuçlarını ve mimari sınır ölçümünü tek raporda birleştirir.',
  );
  push();
  push('| Alan | Değer |');
  push('|---|---|');
  push(`| Commit | \`${mdEscape(meta.commit ?? 'bilinmiyor')}\` |`);
  push(`| Ref | \`${mdEscape(meta.ref ?? '-')}\` |`);
  push(`| Tetikleyici | ${mdEscape(meta.event)} |`);
  push(`| Çalıştırma | ${meta.runUrl ? `[GitHub Actions](${meta.runUrl})` : 'yerel çalıştırma'} |`);
  push(`| Üretim zamanı | ${mdEscape(meta.generatedAt)} |`);
  push(`| Node | \`${mdEscape(meta.nodeVersion)}\` |`);
  push();

  push('## 1. Genel durum');
  push();
  push(verdictText(verdict));
  if (verdict.status !== 'PASS') {
    push();
    push(
      '> **Analiz bütünlüğü:** Sonuç PASS değildir. Eksik veya hatalı analiz başarı gibi raporlanmaz; önce eksik sinyal giderilmelidir.',
    );
  }
  push();
  push('| Kontrol | Durum | Süre | Özet | Zorunlu |');
  push('|---|---|---|---|---|');
  for (const check of checks) {
    push(
      `| ${mdEscape(check.label)} | ${statusLabel(check.status)} | ${formatDuration(
        check.durationMs,
      )} | ${mdEscape(check.summary)} | ${check.blocking ? 'evet' : 'hayır'} |`,
    );
  }
  push();

  const failed = checks.filter((check) => check.status === 'FAIL');
  if (failed.length > 0) {
    push('### Başarısız kontroller');
    push();
    for (const check of failed) {
      push(`#### ${check.label}`);
      push();
      push(`- Komut: \`${mdEscape(check.command)}\``);
      push(`- Çıkış kodu: \`${check.exitCode ?? 'yok'}\``);
      if (check.logFile) push(`- Tam çıktı: \`${check.logFile}\``);
      if (check.findings.length === 0) {
        push('- Ayrıştırılmış bulgu yok; tam çıktı için log dosyasına bakın.');
      } else {
        for (const finding of check.findings) {
          const location = finding.file ? `${finding.file}${finding.line ? `:${finding.line}` : ''}` : '';
          const risk = finding.risk ? `[${finding.risk}${finding.autoFixable ? ' · otomatik uygun' : ' · manuel'}] ` : '';
          push(
            `- ${risk}${location ? `\`${mdEscape(location)}\` — ` : ''}${mdText(
              finding.message ?? finding.title ?? JSON.stringify(finding),
            )}`,
          );
        }
      }
      push();
    }
  }

  push('## 2. Bağımlılık güvenlik taraması');
  push();
  const auditProd = checks.find((check) => check.id === 'audit-prod');
  const auditAll = checks.find((check) => check.id === 'audit-all');
  push(`- **Production bağımlılıkları (zorunlu, high+):** ${mdEscape(auditProd?.summary ?? 'çalıştırılmadı')}`);
  push(`- **Tüm bağımlılıklar (bilgi amaçlı):** ${mdEscape(auditAll?.summary ?? 'çalıştırılmadı')}`);
  const advisories = (auditProd?.findings ?? []).flatMap((pkg) =>
    (pkg.advisories ?? []).map((advisory) => ({ pkg: pkg.name, severity: advisory.severity ?? pkg.severity, ...advisory })),
  );
  if (advisories.length > 0) {
    push();
    push('| Önem | Paket | Advisory | Aralık |');
    push('|---|---|---|---|');
    for (const advisory of advisories.slice(0, 15)) {
      push(
        `| ${mdEscape(advisory.severity)} | \`${mdEscape(advisory.pkg)}\` | ${mdEscape(
          advisory.title ?? '-',
        )}${advisory.url ? ` ([bağlantı](${advisory.url}))` : ''} | ${mdEscape(advisory.range ?? '-')} |`,
      );
    }
  }
  push();

  push('## 3. Mimari sınır ölçümü (yalnızca rapor)');
  push();
  if (!architecture) {
    push(`Mimari tarama çalıştırılamadı: ${mdEscape(architectureError ?? 'bilinmeyen hata')}`);
    push();
  } else {
    push(`- Taranan kaynak dosya: **${architecture.scannedFiles}**`);
    push(`- Toplam import: **${architecture.totalImports}**, yerel import kenarı: **${architecture.localEdges}**`);
    push(`- Döngüsel import: **${architecture.cycles.length}**`);
    push();
    push('| Kural | Kapsam | İhlal |');
    push('|---|---|---|');
    for (const rule of architecture.ruleResults) {
      push(`| \`${rule.id}\` | ${mdEscape(rule.from.join(', '))} | ${rule.violations.length} |`);
    }
    push();
    for (const rule of architecture.ruleResults) {
      if (rule.violations.length === 0) continue;
      push(`### İhlaller — \`${rule.id}\``);
      push();
      push(`_${mdEscape(rule.description)}_`);
      if (rule.rationale) push(`Dayanak: ${mdEscape(rule.rationale)}`);
      push();
      for (const violation of rule.violations.slice(0, 20)) {
        push(
          `- \`${violation.file}:${violation.line}\` → \`${mdText(violation.specifier)}\` (${mdText(
            violation.reasons.join('; '),
          )})`,
        );
      }
      if (rule.violations.length > 20) {
        push(`- … ve ${rule.violations.length - 20} ihlal daha (report.json içinde tamamı var).`);
      }
      push();
    }
    if (architecture.cycles.length > 0) {
      push('### Döngüsel importlar');
      push();
      for (const cycle of architecture.cycles.slice(0, 10)) {
        push(`- ${cycle.map((file) => `\`${file}\``).join(' → ')}`);
      }
      if (architecture.cycles.length > 10) {
        push(`- … ve ${architecture.cycles.length - 10} döngü daha.`);
      }
      push();
    }
    push('### En büyük dosyalar');
    push();
    push('| Dosya | Satır |');
    push('|---|---|');
    for (const entry of architecture.largestFiles.slice(0, 10)) {
      push(`| \`${entry.file}\` | ${entry.lines} |`);
    }
    push();
  }

  push('## 4. Kapsam ve sınırlar');
  push();
  push('- Bu rapor **M0 gözlem** aşamasıdır: otomatik düzeltme, allowlist, bot branch’i veya PR üretimi yoktur.');
  push(
    '- R0/R1/R2 risk sınıfları ve otomatik onarım yetkisi M1 ve sonrasında devreye alınır; R2 alanları (şema/migration, kullanıcı verisi, öneri algoritmaları, modül sözleşmeleri, güvenlik sınırları) hiçbir aşamada otomatik onarılmaz.',
  );
  push('- Mimari ihlaller bilinçli olarak yalnızca raporlanır; düzeltme insan kararıyla ayrı PR’da yapılır.');
  push('- Test/CI doğrulaması bu modülün yerine geçmez; bu modül de test/CI’ın yerine geçmez.');
  push();
  if (compare) {
    lines.push(...formatComparisonMarkdown(compare, 'önceki M0 raporu'));
  }
  push('_Rapor `scripts/maintenance/analyze.mjs` tarafından üretildi. Tam veri: `report.json`, komut çıktıları: `logs/`._');

  return `${lines.join('\n')}\n`;
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const reportDir = path.resolve(ROOT, options.reportDir);
  const logsDir = path.join(reportDir, 'logs');
  await fs.mkdir(logsDir, { recursive: true });

  const checks = [];
  const riskPolicy = loadRiskPolicy();
  let installFailed = false;
  let dependenciesAvailable = await pathExists(path.join(ROOT, 'node_modules'));

  for (const [index, check] of CHECKS.entries()) {
    const base = {
      id: check.id,
      label: check.label,
      command: displayCommand(check.command),
      blocking: check.blocking,
      optional: Boolean(check.optional),
    };

    const skip = (reason) => {
      checks.push({
        ...base,
        status: 'SKIP',
        summary: reason,
        exitCode: null,
        durationMs: 0,
        counts: null,
        findings: [],
        logFile: null,
      });
      console.log(`SKIP ${check.label} — ${reason}`);
    };

    if (options.only && !options.only.includes(check.id)) {
      skip('--only filtresi dışında');
      continue;
    }
    if (check.optional && !options.install) {
      skip('--install verilmedi');
      continue;
    }
    if (check.needsDependencies && !dependenciesAvailable) {
      skip(
        installFailed
          ? 'temiz kurulum başarısız olduğu için atlandı'
          : 'node_modules bulunamadı; --install ile çalıştırın',
      );
      continue;
    }

    process.stdout.write(`→ ${check.label} … `);
    const result = await runCommand(check.command);
    let parsed = {
      summary: result.exitCode === 0 ? 'başarılı' : `başarısız (çıkış kodu ${result.exitCode ?? 'yok'})`,
      counts: null,
      findings: [],
    };
    let incompleteReason = null;
    if (result.timedOut) {
      incompleteReason = 'zaman aşımı; sonuç doğrulanamadı';
      parsed.summary = incompleteReason;
    } else {
      if (check.parse) {
        try {
          parsed = parseOutput(check.parse, result);
        } catch (error) {
          incompleteReason = `çıktı ayrıştırılamadı: ${error.message}`;
          parsed.summary = incompleteReason;
        }
      }
      if (result.exitCode === 0 && check.requireZeroFindings && (parsed.counts?.errors ?? 0) > 0) {
        incompleteReason = 'çıkış kodu 0 ancak bulgu sayısı sıfır değil';
      }
    }

    // PASS yalnızca komut başarılı VE çıktı doğrulanabildiğinde verilir.
    // Ayrıştırılamayan/eksik çıktı, zorunlu kontrolde INCOMPLETE; isteğe bağlıda INFO'dur.
    let status;
    if (incompleteReason) {
      status = check.blocking ? 'INCOMPLETE' : 'INFO';
    } else if (result.exitCode === 0) {
      status = 'PASS';
    } else {
      status = check.blocking ? 'FAIL' : 'INFO';
    }

    // Bulgulara risk etiketi ekle (yalnızca etiket; otomatik düzeltme yok).
    parsed.findings = (parsed.findings ?? []).map((finding) => {
      const classified = classifyFinding(finding, riskPolicy);
      return { ...finding, risk: classified.risk, autoFixable: classified.autoFixable, rationale: classified.rationale };
    });
    const logFile = path.join(logsDir, `${String(index + 1).padStart(2, '0')}-${check.id}.log`);
    await fs.writeFile(logFile, logHeader(check, result));

    if (check.id === 'install' && status === 'FAIL') installFailed = true;
    if (check.id === 'install' && status === 'PASS') dependenciesAvailable = true;

    checks.push({
      ...base,
      status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      summary: parsed.summary,
      counts: parsed.counts ?? null,
      findings: parsed.findings ?? [],
      logFile: path.relative(reportDir, logFile),
    });

    console.log(`${status} — ${parsed.summary} (${formatDuration(result.durationMs)})`);
  }

  let architecture = null;
  let architectureError = null;
  try {
    architecture = runArchitectureScan({ root: ROOT });
  } catch (error) {
    architectureError = error.message;
  }

  let compare = null;
  let compareError = null;
  if (options.compare) {
    try {
      const previousRaw = await fs.readFile(path.resolve(ROOT, options.compare), 'utf8');
      const previous = normalizeSnapshot(JSON.parse(previousRaw));
      if (!previous) throw new Error('önceki rapor biçimi tanınamadı');
      compare = compareSnapshots(previous, normalizeSnapshot({ verdict: null, checks, architecture }));
    } catch (error) {
      compareError = error.message;
    }
  }

  const meta = buildMeta();
  const verdict = computeVerdict({ checks, architecture, architectureError });
  if (compareError) {
    verdict.status = verdict.status === 'PASS' ? 'INCOMPLETE' : verdict.status;
    verdict.compareError = compareError;
  }

  const violations = flattenViolations(architecture);
  const riskSummary = summarizeRisks(
    [
      ...violations.map((violation) => ({
        source: 'architecture',
        file: violation.file,
        rule: violation.rule,
        message: violation.specifier,
      })),
      ...checks.flatMap((check) => check.findings ?? []),
    ],
    riskPolicy,
  );

  const report = {
    meta,
    verdict,
    checks,
    architecture,
    architectureError,
    riskSummary,
    compare,
    compareError,
  };

  await fs.writeFile(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = buildMarkdown(report);
  await fs.writeFile(path.join(reportDir, 'report.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  }

  if (options.saveBaseline) {
    let rulesHash = null;
    try {
      rulesHash = computeRulesHash(
        await fs.readFile(path.join(ROOT, 'scripts/maintenance/architecture-rules.json'), 'utf8'),
      );
    } catch {
      rulesHash = null;
    }
    const baseline = {
      version: 1,
      commit: meta.commit,
      generatedAt: meta.generatedAt,
      verdict: verdict.status,
      rulesHash,
      violations: violations.map((violation) => ({
        rule: violation.rule,
        file: violation.file,
        specifier: violation.specifier,
        reasons: violation.reasons,
      })),
      checks: checks.map((check) => ({ id: check.id, status: check.status })),
    };
    const baselinePath = path.resolve(ROOT, options.saveBaseline);
    await fs.mkdir(path.dirname(baselinePath), { recursive: true });
    await fs.writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Baseline: ${path.relative(ROOT, baselinePath)}`);
  }

  console.log(`\nRapor: ${path.relative(ROOT, path.join(reportDir, 'report.md'))} (${verdict.status})`);
  if (architecture) {
    console.log(
      `Mimari: ${architecture.localEdges} kenar, ${violations.length} ihlal, ${architecture.cycles.length} döngü (yalnızca rapor).`,
    );
  } else {
    console.error(`Mimari tarama başarısız: ${architectureError ?? 'bilinmeyen hata'}`);
  }
  if (compareError) console.error(`Karşılaştırma okunamadı: ${compareError}`);
  if (compare) {
    console.log(
      `Karşılaştırma: ${compare.newViolations.length} yeni, ${compare.fixedViolations.length} düzelen ihlal.`,
    );
  }
  process.exitCode = verdict.status === 'PASS' ? 0 : 1;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
