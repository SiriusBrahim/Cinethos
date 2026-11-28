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
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(MODULE_DIR, '../..');
const RULES_PATH = path.join(MODULE_DIR, 'architecture-rules.json');

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

const SCRIPT_KINDS = new Map([
  ['.ts', ts.ScriptKind.TS],
  ['.mts', ts.ScriptKind.TS],
  ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX],
]);

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function listSourceFiles(root) {
  const files = [];
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) files.push(toPosix(path.relative(root, full)));
    }
  };
  visit(path.join(root, 'src'));
  if (fs.existsSync(path.join(root, 'server.ts'))) files.push('server.ts');
  return files.sort();
}

function classifyLayer(file) {
  if (file === 'server.ts') return 'server';
  for (const [prefix, layer] of LAYER_PREFIXES) {
    if (file.startsWith(prefix)) return layer;
  }
  return null;
}

/**
 * Import/export bağımlılıklarını TypeScript AST'sinden çıkarır.
 *
 * Satır tabanlı regex yaklaşımı çok satırlı `import {\n ... \n} from 'x'`
 * ifadelerini, aynı satırdaki birden fazla dinamik importu ve yorum içindeki
 * sahte importları kaçırıyordu. AST hem statik (import/export/import =) hem de
 * desteklenen dinamik (`import('x')`, `require('x')`) biçimlerini güvenilir
 * biçimde yakalar; yanlış pozitif üretmez.
 *
 * @param {string} source
 * @param {string} file
 * @returns {Array<{ specifier: string, line: number }>}
 */
export function extractImports(source, file = 'module.ts') {
  const scriptKind = SCRIPT_KINDS.get(path.extname(file).toLowerCase()) ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind);
  const imports = [];
  const seen = new Set();

  const record = (specifier, node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const key = `${line + 1}\u0000${specifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    imports.push({ specifier, line: line + 1 });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteralLike(specifier)) record(specifier.text, node);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression.text, node);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const first = node.arguments[0];
      if ((isDynamicImport || isRequire) && ts.isStringLiteralLike(first)) {
        record(first.text, node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return imports;
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveLocalImport(specifier, fromFile, root) {
  if (!specifier.startsWith('.')) return null;
  const base = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)));
  if (base.startsWith('..')) return null;
  const suffixes = ['', '.ts', '.tsx', '.js', '.mjs', '.jsx'];
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

function globToRegExp(glob) {
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
 *   layerEdges: Record<string, number>,
 *   ruleResults: Array<{ id: string, description: string, rationale: string, from: string[], violations: Array<object> }>,
 *   cycles: string[][],
 *   largestFiles: Array<{ file: string, lines: number }>,
 * }}
 */
export function runArchitectureScan({ root = DEFAULT_ROOT, rules = null } = {}) {
  const config = rules ?? JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  const configuredRules = (config.rules ?? []).map((rule) => ({
    ...rule,
    matchers: (rule.from ?? []).map(globToRegExp),
  }));

  const files = listSourceFiles(root);
  const fileSet = new Set(files);
  const edges = [];
  const violationsByRule = new Map(configuredRules.map((rule) => [rule.id, []]));
  const layerEdges = {};
  let totalImports = 0;

  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const { specifier, line } of extractImports(source, file)) {
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = rootIndex !== -1 && args[rootIndex + 1] ? path.resolve(args[rootIndex + 1]) : DEFAULT_ROOT;
  const result = runArchitectureScan({ root });

  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Taranan dosya: ${result.scannedFiles}`);
    console.log(`Yerel import kenarı: ${result.localEdges} / toplam import: ${result.totalImports}`);
    for (const rule of result.ruleResults) {
      console.log(`- ${rule.id}: ${rule.violations.length} ihlal`);
      for (const violation of rule.violations) {
        console.log(
          `    ${violation.file}:${violation.line} → ${violation.specifier} (${violation.reasons.join(', ')})`
        );
      }
    }
    console.log(`Döngüsel import: ${result.cycles.length}`);
    console.log('En büyük dosyalar:');
    for (const entry of result.largestFiles.slice(0, 10)) {
      console.log(`  ${entry.lines.toString().padStart(6)}  ${entry.file}`);
    }
  }
}
