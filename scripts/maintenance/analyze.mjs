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
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runArchitectureScan } from './architecture-boundaries.mjs';

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
  const options = { reportDir: 'maintenance-report', install: false, only: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--install') options.install = true;
    else if (arg === '--report-dir') options.reportDir = argv[index + 1] ?? options.reportDir;
    else if (arg.startsWith('--report-dir=')) options.reportDir = arg.slice('--report-dir='.length);
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
        file: path.relative(ROOT, result.filePath ?? ''),
        line: message.line ?? 0,
        column: message.column ?? 0,
        severity: message.severity === 2 ? 'error' : 'warning',
        rule: message.ruleId ?? null,
        message: message.message,
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
      file: match[1],
      line: Number(match[2]),
      rule: match[4],
      message: match[5],
    })),
  };
}

function parseNodeTest(stdout, stderr) {
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
    return {
      summary:
        failedLines.length > 0
          ? `test özeti bulunamadı; başarısız test satırı: ${failedLines.length}`
          : 'test özeti bulunamadı',
      counts: null,
      findings: failedLines,
    };
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

function buildMarkdown(report) {
  const { meta, verdict, checks, architecture, architectureError } = report;
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
  push(
    verdict.status === 'PASS'
      ? '**Sonuç: ✅ PASS** — zorunlu kontrollerin tamamı başarılı.'
      : `**Sonuç: ❌ FAIL** — ${verdict.blockingFailures} zorunlu kontrol başarısız. Bu rapor bir bakım PR’ı üretmez; hata giderilmeden hiçbir otomatik düzeltme hazır sayılmaz.`,
  );
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
          push(
            `- ${location ? `\`${mdEscape(location)}\` — ` : ''}${mdText(
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
  let installFailed = false;
  let dependenciesAvailable = await pathExists(path.join(ROOT, 'node_modules'));

  for (const [index, check] of CHECKS.entries()) {
    const base = {
      id: check.id,
      label: check.label,
      command: displayCommand(check.command),
      blocking: check.blocking,
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
    if (result.timedOut) {
      parsed.summary = 'zaman aşımı';
    } else if (check.parse) {
      try {
        parsed = parseOutput(check.parse, result);
      } catch (error) {
        parsed.summary = `çıktı ayrıştırılamadı: ${error.message}`;
      }
    }

    const passed = result.exitCode === 0 && !result.timedOut;
    // Zorunlu olmayan kontrollerde bulgu "FAIL" değil bilgi amaçlı "INFO" olarak raporlanır.
    const status = passed ? 'PASS' : check.blocking ? 'FAIL' : 'INFO';
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

  const blockingFailures = checks.filter((check) => check.blocking && check.status === 'FAIL').length;
  const report = {
    meta: buildMeta(),
    verdict: {
      status: blockingFailures === 0 ? 'PASS' : 'FAIL',
      blockingFailures,
      totalChecks: checks.length,
    },
    checks,
    architecture,
    architectureError,
  };

  await fs.writeFile(path.join(reportDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const markdown = buildMarkdown(report);
  await fs.writeFile(path.join(reportDir, 'report.md'), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  }

  console.log(`\nRapor: ${path.relative(ROOT, path.join(reportDir, 'report.md'))} (${report.verdict.status})`);
  if (architecture) {
    console.log(
      `Mimari: ${architecture.localEdges} kenar, ${architecture.ruleResults.reduce(
        (total, rule) => total + rule.violations.length,
        0,
      )} ihlal, ${architecture.cycles.length} döngü (yalnızca rapor).`,
    );
  }
  process.exitCode = blockingFailures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
