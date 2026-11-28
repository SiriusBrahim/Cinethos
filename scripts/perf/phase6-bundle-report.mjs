#!/usr/bin/env node
/**
 * Aşama 6 (B-20) — Bundle ölçüm raporu.
 *
 * `npm run build` çıktısını (dist/) okur; ilk açılışta indirilen dosyaları
 * (index.html içindeki script + modulepreload) ve tüm JS chunk toplamını
 * gzip boyutlarıyla birlikte JSON olarak yazar. Tahmin içermez: yalnızca
 * diskteki gerçek build çıktısını ölçer.
 *
 * Kullanım: node scripts/perf/phase6-bundle-report.mjs [--out <dosya>]
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '../..');
const distDir = path.join(ROOT, 'dist');
const assetsDir = path.join(distDir, 'assets');
const outArgIdx = process.argv.indexOf('--out');
const outFile =
  outArgIdx >= 0 && process.argv[outArgIdx + 1]
    ? path.resolve(ROOT, process.argv[outArgIdx + 1])
    : null;

if (!existsSync(path.join(distDir, 'index.html'))) {
  console.error('dist/index.html bulunamadı. Önce `npm run build` çalıştırın.');
  process.exit(1);
}

const html = readFileSync(path.join(distDir, 'index.html'), 'utf8');
const initialFiles = new Set();
for (const match of html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.js)"/g)) {
  initialFiles.add(path.basename(match[1]));
}

function measure(fileName) {
  const fullPath = path.join(assetsDir, fileName);
  const buffer = readFileSync(fullPath);
  const gzip = zlib.gzipSync(buffer, { level: 9 });
  return {
    file: fileName,
    bytes: buffer.length,
    gzipBytes: gzip.length,
  };
}

const initial = [...initialFiles].map(measure).sort((a, b) => b.bytes - a.bytes);
const allJs = readdirSync(assetsDir)
  .filter((name) => name.endsWith('.js'))
  .map(measure);

const sum = (rows, key) => rows.reduce((acc, row) => acc + row[key], 0);
const cssFiles = readdirSync(assetsDir).filter((entry) => entry.endsWith('.css'));
const css = cssFiles.length > 0 ? measure(cssFiles[0]) : { file: null, bytes: 0, gzipBytes: 0 };

const report = {
  generatedAt: new Date().toISOString(),
  initialLoadFiles: initial,
  initialLoad: {
    jsBytes: sum(initial, 'bytes'),
    jsGzipBytes: sum(initial, 'gzipBytes'),
    cssBytes: css.bytes,
    cssGzipBytes: css.gzipBytes,
  },
  allJsChunks: {
    count: allJs.length,
    bytes: sum(allJs, 'bytes'),
    gzipBytes: sum(allJs, 'gzipBytes'),
  },
};

console.log(JSON.stringify(report, null, 2));
if (outFile) {
  writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`[phase6-bundle] rapor yazıldı: ${path.relative(ROOT, outFile)}`);
}
