#!/usr/bin/env node
/**
 * Cinethos — mimari sınır ölçümü (M0, salt okunur).
 *
 * `docs/maintenance/OTOMATIK-KOD-BAKIM-ONARIM-PLANI.md` M0 maddesi:
 * "Mimari import sınırları için mevcut yapıyı ölç; henüz otomatik düzeltme yapma."
 *
 * Bu modül yalnızca okur ve raporlar. Hiçbir dosyayı değiştirmez, düzeltmez
 * veya taşımaz. Kurallar `architecture-rules.json` içinde tanımlıdır ve her
 * kural ARCHITECTURE.md'deki bir sınıra dayanır.
 *
 * Tarama kapsamı: `src/**` ve `server.ts`; uzantılar
 * `.ts .tsx .mts .cts .js .jsx .mjs .cjs`. Çok satırlı `import`/`export`
 * ifadeleri, side-effect importları, dinamik `import()` ve `require()`
 * çağrıları tek geçişte yakalanır (yorumlar satır numarası korunarak maskelenir).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(MODULE_DIR, '../..');
const RULES_PATH = path.join(MODULE_DIR, 'architecture-rules.json');

export const SCANNED_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const SOURCE_FILE_RE = new RegExp(`(${SCANNED_EXTENSIONS.map((ext) => ext.replace('.', '\\.')).join('|')})$`);

const LAYER_PREFIXES = [
  ['src/core/', 'core'],
  ['src/server/', 'server'],
  ['src/contracts/', 'contracts'],
  ['src/shared/', 'shared'],
  ['src/services/', 'services'],
  ['src/hooks/', 'hooks'],
  ['src/components/', 'components'],
  ['src/app/', 'app'],
  ['src/features/', 'features'],
  ['src/modules/', 'modules'],
  ['src/utils/', 'utils'],
  ['src/types/', 'types'],
  ['src/design-system/', 'design-system'],
  ['src/workers/', 'workers'],
  ['src/i18n/', 'i18n'],
];

const NODE_BUILTINS = new Set(
  (
    'assert assert/strict async_hooks buffer child_process cluster console constants crypto dgram ' +
    'diagnostics_channel dns domain events fs fs/promises http http2 https module net os path ' +
    'path/posix path/win32 perf_hooks process punycode querystring readline repl stream ' +
    'string_decoder timers timers/promises tls trace_events tty url util v8 vm wasi ' +
    'worker_threads zlib'
  ).split(' '),
);

/** `import`/`export` anahtar kelimeleri — geri izlemesiz, doğrusal tarama. */
const KEYWORD_RE = /\b(?:import|export)\b/g;
/** CommonJS `require('x')` — doğrusal, geri izlemesiz. */
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Bir ifadeyi (import/export) noktalı virgül veya mantıksal satır sonunda keser. */
function readStatement(source, start) {
  let index = start;
  let depth = 0;
  let quote = null;
  while (index < source.length && index - start < 8000) {
    const char = source[index];
    if (quote) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
    } else if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth = Math.max(0, depth - 1);
    } else if (char === ';' && depth === 0) {
      return source.slice(start, index);
    } else if (char === '\n' && depth === 0) {
      // Çok satırlı importlarda `from` satır başında devam eder.
      const rest = source.slice(index + 1).match(/^\s*(?:from\b|\/\/|\*)/);
      if (!rest) return source.slice(start, index);
    }
    index += 1;
  }
  return source.slice(start, index);
}

function readQuoted(source, start) {
  let index = start;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  const quote = source[index];
  if (quote !== "'" && quote !== '"') return null;
  let cursor = index + 1;
  let value = '';
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '\\') {
      value += source[cursor + 1] ?? '';
      cursor += 2;
      continue;
    }
    if (char === quote) return { value, end: cursor + 1 };
    value += char;
    cursor += 1;
  }
  return null;
}

/** Yorumları boşlukla maskeler; satır sonlarını korur ki satır numaraları kaymasın. */
export function stripComments(source) {
  let out = '';
  let state = 'code';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') {
        state = 'line-comment';
        out += '  ';
        index += 1;
      } else if (char === '/' && next === '*') {
        state = 'block-comment';
        out += '  ';
        index += 1;
      } else if (char === "'") {
        state = 'single';
        out += char;
      } else if (char === '"') {
        state = 'double';
        out += char;
      } else if (char === '`') {
        state = 'template';
        out += char;
      } else {
        out += char;
      }
    } else if (state === 'line-comment') {
      if (char === '\n') {
        state = 'code';
        out += '\n';
      } else {
        out += ' ';
      }
    } else if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        out += '  ';
        index += 1;
        state = 'code';
      } else {
        out += char === '\n' ? '\n' : ' ';
      }
    } else if (state === 'single' || state === 'double' || state === 'template') {
      const closing = state === 'single' ? "'" : state === 'double' ? '"' : '`';
      if (char === '\\') {
        out += char + (next ?? '');
        index += 1;
      } else if (char === closing) {
        out += char;
        state = 'code';
      } else {
        out += char;
      }
    }
  }
  return out;
}

function lineAt(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < source.length; cursor += 1) {
    if (source[cursor] === '\n') line += 1;
  }
  return line;
}

/**
 * Bir kaynak dosyadaki tüm import/require hedeflerini satır numarasıyla döner.
 * Yorumlar maskelendiği için yorum satırındaki örnek importlar sayılmaz.
 */
export function extractImports(source) {
  const masked = stripComments(source);
  const found = new Map();
  const record = (specifier, offset) => {
    const line = lineAt(masked, offset);
    const key = `${line}\u0000${specifier}`;
    if (!found.has(key)) found.set(key, { specifier, line });
  };

  for (const match of masked.matchAll(KEYWORD_RE)) {
    const keyword = match[0];
    const afterKeyword = match.index + keyword.length;
    const trimmedStart = afterKeyword + (masked.slice(afterKeyword).match(/^\s*/)?.[0].length ?? 0);

    // Dinamik import: import('./x')
    if (keyword === 'import' && masked[trimmedStart] === '(') {
      const quoted = readQuoted(masked, trimmedStart + 1);
      if (quoted) record(quoted.value, masked.indexOf(quoted.value, trimmedStart));
      continue;
    }

    const statement = readStatement(masked, afterKeyword);
    if (!statement) continue;
    const statementStart = afterKeyword;

    // Side-effect import: import './x'
    const direct = statement.match(/^\s*(?:type\s+)?['"]([^'"]+)['"]/);
    if (direct) {
      record(direct[1], masked.indexOf(direct[1], statementStart));
      continue;
    }
    // import ... from 'x' / export ... from 'x' (çok satırlı olabilir)
    const from = statement.match(/\bfrom\s*(['"])([^'"]+)\1/);
    if (from) {
      record(from[2], masked.indexOf(from[2], statementStart));
    }
  }

  for (const match of masked.matchAll(REQUIRE_RE)) {
    const specifier = match[1];
    record(specifier, match.index + match[0].indexOf(specifier));
  }

  return [...found.values()].sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

export function listSourceFiles(root) {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (SOURCE_FILE_RE.test(entry.name)) files.push(toPosix(path.relative(root, full)));
    }
  };
  visit(path.join(root, 'src'));
  for (const extra of ['server.ts', 'server.mjs', 'server.js']) {
    if (fs.existsSync(path.join(root, extra))) files.push(extra);
  }
  return [...new Set(files)].sort();
}

export function classifyLayer(file) {
  if (file === 'server.ts' || file === 'server.mjs' || file === 'server.js') return 'server';
  for (const [prefix, layer] of LAYER_PREFIXES) {
    if (file.startsWith(prefix)) return layer;
  }
  return null;
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveLocalImport(specifier, fromFile, root) {
  if (!specifier.startsWith('.')) return null;
  const base = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)));
  if (base.startsWith('..')) return null;
  const suffixes = ['', ...SCANNED_EXTENSIONS];
  for (const suffix of suffixes) {
    if (isFile(path.join(root, base + suffix))) return base + suffix;
  }
  for (const suffix of suffixes) {
    if (isFile(path.join(root, `${base}/index${suffix}`))) return `${base}/index${suffix}`;
  }
  return null;
}

function packageName(specifier) {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  return NODE_BUILTINS.has(specifier.split('/')[0]);
}

export function globToRegExp(glob) {
  let out = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        out += '.*';
        index += 1;
        if (glob[index + 1] === '/') index += 1;
      } else {
        out += '[^/]*';
      }
    } else if ('\\^$.|?+()[]{}'.includes(char)) {
      out += `\\${char}`;
    } else {
      out += char;
    }
  }
  return new RegExp(`${out}$`);
}

function findCycles(edges, fileSet) {
  const adjacency = new Map();
  for (const { from, to } of edges) {
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from).add(to);
  }
  const state = new Map();
  const stack = [];
  const cycles = [];
  const seen = new Set();

  const visit = (node) => {
    state.set(node, 1);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!fileSet.has(next)) continue;
      if (!state.has(next)) {
        visit(next);
      } else if (state.get(next) === 1) {
        const startIndex = stack.indexOf(next);
        const cycle = stack.slice(startIndex);
        const signature = [...cycle].sort().join('|');
        if (!seen.has(signature)) {
          seen.add(signature);
          cycles.push([...cycle, next]);
        }
      }
    }
    stack.pop();
    state.set(node, 2);
  };

  for (const file of fileSet) {
    if (!state.has(file)) visit(file);
  }
  return cycles;
}

/**
 * @param {{ root?: string, rules?: object }} [options]
 * @returns {{
 *   scannedFiles: number,
 *   totalImports: number,
 *   localEdges: number,
 *   extensionCounts: Record<string, number>,
 *   layerEdges: Record<string, number>,
 *   ruleResults: Array<{ id: string, description: string, rationale: string, from: string[], violations: Array<object> }>,
 *   cycles: string[][],
 *   largestFiles: Array<{ file: string, lines: number }>,
 * }}
 */
export function runArchitectureScan({ root = DEFAULT_ROOT, rules = null } = {}) {
  const config = rules ?? JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  if (!config || !Array.isArray(config.rules) || config.rules.length === 0) {
    throw new Error('Mimari kurallar okunamadı veya boş: architecture-rules.json');
  }
  const configuredRules = config.rules.map((rule) => ({
    ...rule,
    matchers: (rule.from ?? []).map(globToRegExp),
  }));

  const files = listSourceFiles(root);
  if (files.length === 0) {
    throw new Error(`Taranacak kaynak dosya bulunamadı (root: ${root})`);
  }
  const fileSet = new Set(files);
  const edges = [];
  const violationsByRule = new Map(configuredRules.map((rule) => [rule.id, []]));
  const layerEdges = {};
  const extensionCounts = {};
  let totalImports = 0;

  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const { specifier, line } of extractImports(source)) {
      totalImports += 1;
      const resolved = resolveLocalImport(specifier, file, root);
      if (resolved) {
        edges.push({ from: file, to: resolved, specifier, line });
        const fromLayer = classifyLayer(file) ?? '(root)';
        const toLayer = classifyLayer(resolved) ?? '(root)';
        const key = `${fromLayer} -> ${toLayer}`;
        layerEdges[key] = (layerEdges[key] ?? 0) + 1;
      }

      const targetLayer = resolved ? classifyLayer(resolved) : null;
      const pkg = packageName(specifier);
      const builtin = !resolved && isNodeBuiltin(specifier);

      for (const rule of configuredRules) {
        if (!rule.matchers.some((matcher) => matcher.test(file))) continue;
        const reasons = [];
        if (targetLayer && (rule.forbidLayers ?? []).includes(targetLayer)) {
          reasons.push(`katman: ${targetLayer}`);
        }
        if (pkg && (rule.forbidPackages ?? []).includes(pkg)) {
          reasons.push(`paket: ${pkg}`);
        }
        if (builtin && rule.forbidNodeBuiltins) {
          reasons.push(`node yerleşik modülü: ${specifier}`);
        }
        if (reasons.length > 0) {
          violationsByRule.get(rule.id).push({
            file,
            line,
            specifier,
            target: resolved ?? pkg ?? specifier,
            reasons,
          });
        }
      }
    }
  }

  const largestFiles = files
    .map((file) => ({
      file,
      lines: fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).length,
    }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, 15);

  return {
    scannedFiles: files.length,
    totalImports,
    localEdges: edges.length,
    extensionCounts,
    layerEdges,
    ruleResults: configuredRules.map((rule) => ({
      id: rule.id,
      description: rule.description ?? '',
      rationale: rule.rationale ?? '',
      from: rule.from ?? [],
      violations: violationsByRule.get(rule.id),
    })),
    cycles: findCycles(edges, fileSet),
    largestFiles,
  };
}

/** Rapor için kural sonuçlarını toplar; tüm ihlalleri tek listede döner. */
export function flattenViolations(scan) {
  return (scan?.ruleResults ?? []).flatMap((rule) =>
    (rule.violations ?? []).map((violation) => ({ rule: rule.id, ...violation })),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex !== -1 && args[rootIndex + 1] ? path.resolve(args[rootIndex + 1]) : DEFAULT_ROOT;
  const result = runArchitectureScan({ root });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Taranan dosya: ${result.scannedFiles}`);
    console.log(`Uzantılar: ${JSON.stringify(result.extensionCounts)}`);
    console.log(`Yerel import kenarı: ${result.localEdges} / toplam import: ${result.totalImports}`);
    for (const rule of result.ruleResults) {
      console.log(`- ${rule.id}: ${rule.violations.length} ihlal`);
    }
    console.log(`Döngüsel import: ${result.cycles.length}`);
    console.log('En büyük dosyalar:');
    for (const entry of result.largestFiles.slice(0, 10)) {
      console.log(`  ${entry.lines.toString().padStart(6)}  ${entry.file}`);
    }
  }
}
