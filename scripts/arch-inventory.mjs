#!/usr/bin/env node
/**
 * MIA Faz 0 — mimari envanter üreteci.
 *
 * Harici bağımlılık kullanmaz: `src/` ve `server.ts` içindeki statik import/export
 * ifadelerini okuyup dosya grafiğini, döngüleri, katman ihlallerini, paylaşılan
 * sembolleri, depolama anahtarlarını ve test→kaynak eşlemesini üretir.
 *
 * Kullanım:
 *   node scripts/arch-inventory.mjs               # markdown (stdout)
 *   node scripts/arch-inventory.mjs --json        # JSON (stdout)
 *   node scripts/arch-inventory.mjs --write       # docs/mia/faz0-envanter-veri.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const ENTRY = path.join(ROOT, 'server.ts');

const LAYER_ORDER = [
  'core',
  'shared',
  'types',
  'utils',
  'i18n',
  'services',
  'hooks',
  'components',
  'design-system',
  'app',
  'modules',
  'server',
  'workers',
];

const FORBIDDEN = [
  {
    id: 'core-react',
    test: (from, to) => from === 'core' && ['components', 'app', 'hooks', 'design-system', 'modules'].includes(to),
    rule: 'core/ React/UI katmanına bağımlı olamaz',
  },
  {
    id: 'core-services',
    test: (from, to) => from === 'core' && ['services', 'server'].includes(to),
    rule: 'core/ services|server katmanına bağımlı olamaz',
  },
  {
    id: 'ui-server',
    test: (from, to) =>
      ['components', 'app', 'hooks', 'design-system', 'modules'].includes(from) && to === 'server',
    rule: 'UI katmanı server/ modüllerini import edemez',
  },
  {
    id: 'module-cross',
    test: (from, to, fromPath, toPath) =>
      fromPath.startsWith('src/modules/') &&
      toPath.startsWith('src/modules/') &&
      fromPath.split('/')[2] !== toPath.split('/')[2],
    rule: 'modüller birbirinin içine doğrudan import edemez (service.ts üzerinden)',
  },
];

const SOURCE_RE = /\.(ts|tsx|mts|cts)$/;
const IMPORT_RE = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const EXPORT_DECL_RE =
  /(?:^|\n)\s*export\s+(?:declare\s+)?(?:async\s+)?(?:default\s+)?(function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g;
const NAMED_IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (SOURCE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function layerOf(relPath) {
  if (relPath === 'server.ts') return 'server-entry';
  const parts = relPath.split('/');
  if (parts[0] !== 'src') return 'other';
  if (parts.length === 2) return 'src-root';
  return parts[1];
}

function resolveImport(fromAbs, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromAbs), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile() && SOURCE_RE.test(candidate)) return candidate;
    } catch {
      /* aday yok */
    }
  }
  return null;
}

function parseFile(abs) {
  const code = fs.readFileSync(abs, 'utf8');
  const edges = [];
  const dynamicEdges = [];
  for (const match of code.matchAll(IMPORT_RE)) {
    const [, , typeKeyword, spec] = match;
    const target = resolveImport(abs, spec);
    if (!target) continue;
    edges.push({ target, typeOnly: Boolean(typeKeyword) });
  }
  for (const match of code.matchAll(DYNAMIC_IMPORT_RE)) {
    const target = resolveImport(abs, match[1]);
    if (target) dynamicEdges.push({ target });
  }
  const exports = [];
  for (const match of code.matchAll(EXPORT_DECL_RE)) {
    exports.push(match[2]);
  }
  const named = [];
  for (const match of code.matchAll(NAMED_IMPORT_RE)) {
    const statementType = Boolean(match[1]);
    const target = resolveImport(abs, match[3]);
    if (!target) continue;
    for (const rawName of match[2].split(',')) {
      const trimmed = rawName.trim();
      const inlineType = /^type\s+/.test(trimmed);
      const name = trimmed.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name) named.push({ target, name, typeOnly: statementType || inlineType });
    }
  }
  return {
    code,
    edges,
    dynamicEdges,
    exports: [...new Set(exports)],
    namedImports: named,
    lines: code.split('\n').length,
  };
}

function tarjan(nodes, adjacency) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const components = [];

  const visit = (node) => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      components.push(component.reverse());
    }
  };

  for (const node of nodes) if (!indices.has(node)) visit(node);
  return components;
}

function storageInventory(files) {
  const idb = new Map();
  const local = new Map();
  const literalRe = /['"`]((?:ct:|cinetrack)[^'"`\n]*)['"`]/g;
  const dbConstRe = /(?:DB_NAME|DATABASE_NAME)\s*=\s*['"`]([^'"`]+)['"`]/g;
  const dbOpenRe = /(?:openDB|indexedDB\.open|createStore)\(\s*['"`]([^'"`]+)['"`]/g;
  const isDbName = (name) => /-db$/.test(name) || /^cinetrack-relationship-cache$/.test(name);
  const isStorageKey = (name) => {
    if (!name || name.length < 4 || name.includes(' ')) return false;
    if (/\.(json|sqlite|db)$/.test(name)) return false;
    if (name.includes('@cinetrack.local')) return false;
    // DOM kimlikleri, worker adları ve dosya adları
    if (/^cinetrack(-|$)/.test(name)) return false;
    // shell olay adları (`cinetrack:*`), depolama anahtarı değil
    if (/^cinetrack:/.test(name)) return false;
    return /^(ct:|cinetrack\.|cinetrack_)/.test(name);
  };

  const normalizeKey = (name) => name.replace(/\$\{[^}]*\}|\{[^}]*\}/g, '*');
  const add = (map, name, owner) => {
    const key = normalizeKey(name);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(owner);
  };

  for (const file of files) {
    const dbNames = [];
    for (const match of file.code.matchAll(dbOpenRe)) dbNames.push(match[1]);
    for (const match of file.code.matchAll(dbConstRe)) dbNames.push(match[1]);
    for (const name of dbNames) {
      if (isDbName(name)) add(idb, name, file.rel);
    }
    for (const match of file.code.matchAll(literalRe)) {
      const name = match[1];
      if (isDbName(name) || !isStorageKey(name)) continue;
      add(local, name, file.rel);
    }
  }
  return { idb, local };
}

function moduleOf(relPath) {
  if (relPath === 'server.ts') return 'entry';
  const parts = relPath.split('/');
  if (parts[0] !== 'src') return 'other';
  if (parts.length === 2) return 'src-root';
  if (parts[1] === 'modules') return parts[2] ? `modules/${parts[2]}` : 'modules';
  return parts[1];
}

const DECL_RE =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|const|let|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/;

function declarationsOf(code) {
  const result = [];
  const lines = code.split('\n');
  let depth = 0;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (depth === 0 && !inBlockComment) {
      if (trimmed.startsWith('/*')) inBlockComment = !trimmed.includes('*/');
      else {
        const match = line.match(DECL_RE);
        if (match && !trimmed.startsWith('*')) {
          result.push({
            line: i + 1,
            kind: match[1],
            name: match[2],
            exported: trimmed.startsWith('export'),
          });
        }
      }
    } else if (inBlockComment && trimmed.includes('*/')) {
      inBlockComment = false;
    }
    for (const char of line) {
      if (char === '{') depth += 1;
      else if (char === '}') depth = Math.max(0, depth - 1);
    }
  }
  return result;
}

function dataAccessInventory(files) {
  const access = new Map();
  const keyRe = /['"`]((?:ct:|cinetrack[._])[a-zA-Z0-9_.${}*-]*)['"`]/g;
  const dbRe = /['"`](cinetrack-[a-z-]+(?:-db|-cache))['"`]/g;
  const isNoise = (name) => /\.(json|sqlite|db)$/.test(name) || name.includes('@cinetrack.local');
  const classifyFile = (code, name) => {
    let read = false;
    let write = false;
    const occurrences = [];
    const re = new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\'"\`]*')}['"\`]`, 'g');
    for (const match of code.matchAll(re)) occurrences.push(match.index ?? 0);
    if (occurrences.length === 0) return 'sabit';
    for (const index of occurrences) {
      const snippet = code.slice(Math.max(0, index - 240), index + 260);
      if (/setItem|removeItem/.test(snippet)) write = true;
      if (/getItem/.test(snippet)) read = true;
      if (/\.(put|set|delete|add|clear)\(/.test(snippet)) write = true;
      if (/\.(get|getAll|getAllKeys|has)\(/.test(snippet)) read = true;
    }
    if (read && write) return 'R/W';
    if (write) return 'W';
    if (read) return 'R';
    return 'sabit';
  };
  for (const file of files) {
    for (const re of [keyRe, dbRe]) {
      for (const match of file.code.matchAll(re)) {
        const name = match[1].replace(/\$\{[^}]*\}|\{[^}]*\}/g, '*');
        if (isNoise(name)) continue;
        if (!access.has(name)) access.set(name, new Map());
        const modes = access.get(name);
        const isDb = dbRe.test(`'${name}'`);
        const mode = isDb ? 'R/W' : classifyFile(file.code, name);
        const previous = modes.get(file.rel);
        if (!previous) modes.set(file.rel, mode);
        else if (previous !== mode) {
          const pair = new Set([previous, mode]);
          modes.set(file.rel, pair.has('R/W') || (pair.has('R') && pair.has('W')) ? 'R/W' : [...pair][0]);
        }
      }
    }
  }
  return [...access.entries()]
    .map(([name, modes]) => ({
      name,
      access: [...modes.entries()].map(([file, mode]) => ({ file, mode })).sort((a, b) => a.file.localeCompare(b.file)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function testInventory() {
  const dir = path.join(ROOT, 'tests');
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!/\.(mjs|ts)$/.test(name)) continue;
    const abs = path.join(dir, name);
    const code = fs.readFileSync(abs, 'utf8');
    const targets = new Set();
    for (const match of code.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (!spec.includes('src/') && !spec.includes('server.ts')) continue;
      const cleaned = spec.replace(/^.*?(src\/|server\.ts)/, '$1');
      targets.add(cleaned.split('#')[0]);
    }
    results.push({
      test: `tests/${name}`,
      tests: (code.match(/^test\(/gm) ?? []).length,
      lines: code.split('\n').length,
      targets: [...targets].sort(),
    });
  }
  return results;
}

function build() {
  const absFiles = [...walk(SRC)];
  if (fs.existsSync(ENTRY)) absFiles.push(ENTRY);
  const parsed = new Map();
  for (const abs of absFiles) {
    const file = parseFile(abs);
    file.abs = abs;
    file.rel = rel(abs);
    file.layer = layerOf(file.rel);
    parsed.set(abs, file);
  }

  const nodes = [...parsed.keys()];
  const adjacency = new Map();
  const reverse = new Map();
  for (const node of nodes) {
    adjacency.set(node, new Set());
    reverse.set(node, new Set());
  }
  const edges = [];
  for (const [abs, file] of parsed) {
    for (const edge of file.edges) {
      adjacency.get(abs).add(edge.target);
      reverse.get(edge.target).add(abs);
      edges.push({ from: abs, to: edge.target, typeOnly: edge.typeOnly });
    }
  }

  const violations = [];
  for (const edge of edges) {
    const fromFile = parsed.get(edge.from);
    const toFile = parsed.get(edge.to);
    const fromLayer = layerOf(fromFile.rel);
    const toLayer = layerOf(toFile.rel);
    for (const rule of FORBIDDEN) {
      if (rule.test(fromLayer, toLayer, fromFile.rel, toFile.rel)) {
        violations.push({
          rule: rule.id,
          description: rule.rule,
          from: fromFile.rel,
          to: toFile.rel,
          typeOnly: edge.typeOnly,
        });
      }
    }
  }

  const valueAdjacency = new Map();
  for (const node of nodes) valueAdjacency.set(node, new Set());
  for (const edge of edges) {
    if (!edge.typeOnly) valueAdjacency.get(edge.from).add(edge.to);
  }
  const valueCycles = tarjan(nodes, valueAdjacency).filter((component) => component.length > 1);
  const valueCycleMembers = new Set(valueCycles.flat());

  const components = tarjan(nodes, adjacency).filter((component) => component.length > 1);
  const cycles = components.map((component) => {
    const members = new Set(component);
    const internal = edges.filter((edge) => members.has(edge.from) && members.has(edge.to));
    return {
      files: component.map((abs) => parsed.get(abs).rel).sort(),
      edges: internal.length,
      typeOnlyEdges: internal.filter((edge) => edge.typeOnly).length,
      valueEdges: internal
        .filter((edge) => !edge.typeOnly)
        .map((edge) => `${parsed.get(edge.from).rel} → ${parsed.get(edge.to).rel}`),
      hasValueCycle: component.every((abs) => valueCycleMembers.has(abs)),
    };
  });

  const symbolUsage = new Map();
  for (const file of parsed.values()) {
    for (const { target, name, typeOnly } of file.namedImports) {
      const targetFile = parsed.get(target);
      if (!targetFile) continue;
      if (!targetFile.exports.includes(name)) continue;
      const key = `${targetFile.rel}#${name}`;
      if (!symbolUsage.has(key)) symbolUsage.set(key, { value: new Set(), type: new Set() });
      const usage = symbolUsage.get(key);
      (typeOnly ? usage.type : usage.value).add(file.rel);
    }
  }

  const files = [...parsed.values()].map((file) => ({
    path: file.rel,
    layer: file.layer,
    lines: file.lines,
    fanIn: reverse.get(file.abs).size,
    fanOut: adjacency.get(file.abs).size,
    exports: file.exports.length,
  }));

  const layerStats = new Map();
  for (const file of files) {
    const stat = layerStats.get(file.layer) ?? { files: 0, lines: 0 };
    stat.files += 1;
    stat.lines += file.lines;
    layerStats.set(file.layer, stat);
  }

  const stores = storageInventory([...parsed.values()]);
  const tests = testInventory();
  const moduleEdges = new Map();
  for (const edge of edges) {
    const from = moduleOf(parsed.get(edge.from).rel);
    const to = moduleOf(parsed.get(edge.to).rel);
    if (from === to) continue;
    const key = `${from} -> ${to}`;
    const entry = moduleEdges.get(key) ?? { from, to, count: 0, typeOnly: 0, samples: [] };
    entry.count += 1;
    if (edge.typeOnly) entry.typeOnly += 1;
    if (entry.samples.length < 3) {
      entry.samples.push(`${parsed.get(edge.from).rel} → ${parsed.get(edge.to).rel}`);
    }
    moduleEdges.set(key, entry);
  }
  const moduleGraph = [...moduleEdges.values()].sort((a, b) => b.count - a.count);
  const modules = [...new Set(moduleGraph.flatMap((edge) => [edge.from, edge.to]))].sort();
  const declarations = {};
  for (const file of parsed.values()) {
    if (file.lines < 500) continue;
    declarations[file.rel] = declarationsOf(file.code);
  }
  const dataAccess = dataAccessInventory([...parsed.values()]);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      files: files.length,
      lines: files.reduce((sum, file) => sum + file.lines, 0),
      edges: edges.length,
      typeOnlyEdges: edges.filter((edge) => edge.typeOnly).length,
      cycles: cycles.length,
      valueCycles: cycles.filter((cycle) => cycle.hasValueCycle).length,
      violations: violations.length,
      exports: files.reduce((sum, file) => sum + file.exports, 0),
      tests: tests.length,
      testCases: tests.reduce((sum, test) => sum + test.tests, 0),
    },
    layers: [...layerStats.entries()]
      .map(([layer, stat]) => ({ layer, ...stat }))
      .sort((a, b) => b.lines - a.lines),
    files,
    largest: [...files].sort((a, b) => b.lines - a.lines).slice(0, 25),
    topFanIn: [...files].sort((a, b) => b.fanIn - a.fanIn).slice(0, 15),
    topFanOut: [...files].sort((a, b) => b.fanOut - a.fanOut).slice(0, 10),
    cycles,
    violations,
    sharedSymbols: [...symbolUsage.entries()]
      .map(([key, usage]) => {
        const users = new Set([...usage.value, ...usage.type]);
        return {
          symbol: key,
          count: users.size,
          valueCount: usage.value.size,
          typeCount: usage.type.size,
          users: [...users].sort(),
        };
      })
      .sort((a, b) => b.count - a.count || b.valueCount - a.valueCount)
      .slice(0, 25),
    storage: {
      idb: [...stores.idb.entries()].map(([name, owners]) => ({ name, owners: [...owners].sort() })),
      local: [...stores.local.entries()].map(([name, owners]) => ({ name, owners: [...owners].sort() })),
    },
    tests,
    moduleGraph,
    modules,
    declarations,
    dataAccess,
    fileEdges: edges
      .map((edge) => ({
        from: parsed.get(edge.from).rel,
        to: parsed.get(edge.to).rel,
        typeOnly: edge.typeOnly,
      }))
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    entryPoints: files.filter((file) => file.fanIn === 0).map((file) => file.path),
  };
}

function renderMarkdown(report) {
  const line = (rows) => rows.join('\n');
  const table = (headers, rows) =>
    line([
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`,
      ...rows.map((row) => `| ${row.join(' | ')} |`),
    ]);

  const out = [];
  out.push('# MIA Faz 0 — Doğrulanmış Envanter Verisi');
  out.push('');
  out.push(
    `> **Üretim:** \`node scripts/arch-inventory.mjs --write\` · ${report.generatedAt}\n> **Kapsam:** \`src/\` + \`server.ts\` — ${report.totals.files} kaynak dosya, ${report.totals.tests} test dosyası, ${report.totals.testCases} statik test bloğu (çalıştırıcı alt testlerle daha fazla vaka raporlar).`
  );
  out.push('');
  out.push('## 1. Özet');
  out.push('');
  out.push(
    table(
      ['Metrik', 'Değer'],
      [
        ['Kaynak dosya', report.totals.files],
        ['Toplam satır', report.totals.lines.toLocaleString('tr-TR')],
        ['İç import kenarı', report.totals.edges],
        ['Bunlardan `import type`', report.totals.typeOnlyEdges],
        ['Döngüsel bileşen (SCC)', report.totals.cycles],
        ['Gerçek değer döngüsü (yalnız değer kenarları)', report.totals.valueCycles],
        ['Katman ihlali', report.totals.violations],
        ['Dışa açılan sembol', report.totals.exports],
      ]
    )
  );
  out.push('');
  out.push('## 2. Katman Dağılımı');
  out.push('');
  out.push(
    table(
      ['Katman', 'Dosya', 'Satır'],
      report.layers.map((layer) => [`\`${layer.layer}\``, layer.files, layer.lines.toLocaleString('tr-TR')])
    )
  );
  out.push('');
  out.push('## 3. En Büyük 25 Dosya');
  out.push('');
  out.push(
    table(
      ['Dosya', 'Satır', 'fan-in', 'fan-out', 'export'],
      report.largest.map((file) => [
        `\`${file.path}\``,
        file.lines.toLocaleString('tr-TR'),
        file.fanIn,
        file.fanOut,
        file.exports,
      ])
    )
  );
  out.push('');
  out.push('## 4. En Çok Bağımlı Olunan Dosyalar (fan-in)');
  out.push('');
  out.push(
    table(
      ['Dosya', 'fan-in', 'fan-out', 'Satır'],
      report.topFanIn.map((file) => [`\`${file.path}\``, file.fanIn, file.fanOut, file.lines])
    )
  );
  out.push('');
  out.push('## 5. Döngüsel Bağımlılıklar');
  out.push('');
  if (report.cycles.length === 0) {
    out.push('Döngü bulunmadı.');
  } else {
    out.push(
      table(
        ['#', 'Dosyalar', 'Kenar', 'type-only', 'Niteliği'],
        report.cycles.map((cycle, index) => [
          index + 1,
          cycle.files.map((file) => `\`${file}\``).join('<br>'),
          cycle.edges,
          cycle.typeOnlyEdges,
          cycle.hasValueCycle
            ? '**değer döngüsü**'
            : `tip ile kırılıyor<br>${cycle.valueEdges.map((edge) => `- ${edge}`).join('<br>')}` || 'yalnızca tip',
        ])
      )
    );
  }
  out.push('');
  out.push('## 6. Katman İhlalleri');
  out.push('');
  if (report.violations.length === 0) {
    out.push('İhlal bulunmadı.');
  } else {
    out.push(
      table(
        ['Kural', 'Kaynak', 'Hedef', 'Tür'],
        report.violations.map((violation) => [
          `\`${violation.rule}\``,
          `\`${violation.from}\``,
          `\`${violation.to}\``,
          violation.typeOnly ? 'tip' : '**değer**',
        ])
      )
    );
  }
  out.push('');
  out.push('## 7. Paylaşılan Semboller');
  out.push('');
  out.push(
    table(
      ['Sembol', 'Toplam', 'Değer', 'Tip', 'Kullanıcılar'],
      report.sharedSymbols.map((symbol) => [
        `\`${symbol.symbol}\``,
        symbol.count,
        symbol.valueCount,
        symbol.typeCount,
        symbol.users.slice(0, 6).map((user) => `\`${user}\``).join('<br>') +
          (symbol.users.length > 6 ? `<br>+${symbol.users.length - 6}` : ''),
      ])
    )
  );
  out.push('');
  out.push('## 8. Depolama Anahtarları');
  out.push('');
  out.push('### IndexedDB');
  out.push('');
  out.push(
    table(
      ['Depo', 'Erişen dosyalar'],
      report.storage.idb.map((store) => [
        `\`${store.name}\``,
        store.owners.map((owner) => `\`${owner}\``).join('<br>'),
      ])
    )
  );
  out.push('');
  out.push('### localStorage');
  out.push('');
  out.push(
    table(
      ['Anahtar', 'Erişen dosyalar'],
      report.storage.local.map((store) => [
        `\`${store.name}\``,
        store.owners.map((owner) => `\`${owner}\``).join('<br>'),
      ])
    )
  );
  out.push('');
  out.push('## 9. Test → Kaynak Eşlemesi');
  out.push('');
  out.push(
    table(
      ['Test dosyası', '`test()` bloğu', 'Satır', 'Hedef kaynaklar'],
      report.tests.map((test) => [
        `\`${test.test}\``,
        test.tests,
        test.lines,
        test.targets.length === 0
          ? '—'
          : test.targets.slice(0, 5).map((target) => `\`${target}\``).join('<br>') +
            (test.targets.length > 5 ? `<br>+${test.targets.length - 5}` : ''),
      ])
    )
  );
  out.push('');
  out.push('## 10. Modül Bağımlılık Grafiği');
  out.push('');
  out.push(
    `Modüller arası ${report.moduleGraph.reduce((sum, edge) => sum + edge.count, 0)} import kenarı, ${report.moduleGraph.length} yönlü modül çifti (modül içi kenarlar hariç). Mermaid grafiği yalnızca ≥2 kenarlı bağımlılıkları gösterir.`
  );
  out.push('');
  out.push('```mermaid');
  out.push('flowchart LR');
  for (const edge of report.moduleGraph.filter((edge) => edge.count >= 2)) {
    out.push(`  ${edge.from.replace(/[^a-zA-Z0-9_]/g, '_')}["${edge.from}"] -->|${edge.count}| ${edge.to.replace(/[^a-zA-Z0-9_]/g, '_')}["${edge.to}"]`);
  }
  out.push('```');
  out.push('');
  const matrixModules = report.modules;
  const matrixCells = new Map(report.moduleGraph.map((edge) => [`${edge.from}|${edge.to}`, edge.count]));
  out.push(
    table(
      ['Kaynak \\ Hedef', ...matrixModules],
      matrixModules.map((from) => [from, ...matrixModules.map((to) => matrixCells.get(`${from}|${to}`) ?? '·')])
    )
  );
  out.push('');
  out.push('### Modül → bağımlı olduğu modüller');
  out.push('');
  out.push(
    table(
      ['Modül', 'Hedef modüller (kenar sayısı)', 'Örnek dosya kenarları'],
      matrixModules
        .filter((module) => report.moduleGraph.some((edge) => edge.from === module))
        .map((module) => {
          const edges = report.moduleGraph.filter((edge) => edge.from === module);
          return [
            `\`${module}\``,
            edges.map((edge) => `${edge.to} (${edge.count})`).join('<br>'),
            edges.flatMap((edge) => edge.samples).slice(0, 4).map((sample) => `\`${sample}\``).join('<br>'),
          ];
        })
    )
  );
  out.push('');
  out.push('## 11. Veri Erişim Envanteri (R/W)');
  out.push('');
  out.push(
    table(
      ['Anahtar / depo', 'Erişim'],
      report.dataAccess.map((entry) => [
        `\`${entry.name}\``,
        entry.access.map((access) => `\`${access.file}\` (${access.mode})`).join('<br>'),
      ])
    )
  );
  out.push('');
  out.push('## 12. Büyük Dosya Bildirimleri (≥900 satır)');
  out.push('');
  const bigDeclFiles = Object.entries(report.declarations)
    .filter(([, declarations]) => declarations.length > 0)
    .map(([file, declarations]) => ({
      file,
      declarations,
      lines: report.files.find((entry) => entry.path === file)?.lines ?? 0,
    }))
    .filter((entry) => entry.lines >= 900)
    .sort((a, b) => b.lines - a.lines);
  for (const entry of bigDeclFiles) {
    out.push(`### \`${entry.file}\` — ${entry.lines} satır, ${entry.declarations.length} üst düzey bildirim`);
    out.push('');
    out.push(
      table(
        ['Satır', 'Tür', 'Sembol', 'Export'],
        entry.declarations.map((declaration) => [
          declaration.line,
          declaration.kind,
          `\`${declaration.name}\``,
          declaration.exported ? '✓' : '—',
        ])
      )
    );
    out.push('');
  }
  out.push('## 13. Ek — Dosya Düzeyinde Import Kenarları');
  out.push('');
  let currentFrom = '';
  for (const edge of report.fileEdges) {
    if (edge.from !== currentFrom) {
      currentFrom = edge.from;
      out.push('');
      out.push(`**\`${edge.from}\`**`);
      out.push('');
    }
    out.push(`- → \`${edge.to}\`${edge.typeOnly ? ' *(tip)*' : ''}`);
  }
  out.push('');
  out.push('## 14. Giriş Noktaları (fan-in = 0)');
  out.push('');
  out.push(
    report.entryPoints.length === 0
      ? 'Yok.'
      : report.entryPoints.map((entry) => `- \`${entry}\``).join('\n')
  );
  out.push('');
  return out.join('\n');
}

const report = build();
if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (process.argv.includes('--write')) {
  const target = path.join(ROOT, 'docs', 'mia', 'faz0-envanter-veri.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderMarkdown(report), 'utf8');
  process.stdout.write(`wrote ${rel(target)}\n`);
} else {
  process.stdout.write(`${renderMarkdown(report)}\n`);
}
