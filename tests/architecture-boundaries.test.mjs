/**
 * MIA — Mimari sınır regresyon testi (test/CI ajanı, G3).
 *
 * Amaç: Mevcut mimariyi ve modüler sınırları otomatik doğrulamak; mimari
 * GERİLEMEYİ önlemek. Bu test yalnızca mevcut durumu yeşil göstermek için
 * değil, aşağıdaki garantileri sürekli kılmak için tasarlanmıştır:
 *
 *  1. Sınır analizi her koşuda tamamlanmalı ve eksiksiz rapor üretmelidir.
 *     Analiz çalışamaz, rapor eksik kalır veya taranan dosya sayısı beklenen
 *     tabanın altına düşerse test BAŞARISIZ olur.
 *  2. YENİ ihlal → test başarısız. (İhlal sayısı asla artamaz.)
 *  3. BİLİNEN ihlaller, aşağıda açıkça tanımlanmış GEÇİCİ allowlist'te
 *     tutulur. Bir ihlal giderildiğinde allowlist girdisi "bayat" hale gelir
 *     ve test, girdinin allowlist'ten ÇIKARILMASINI ister (kontrollü temizlik;
 *     allowlist yalnızca küçülebilir, asla büyüyemez).
 *  4. Kural dosyası (architecture-rules.json) denetlenir: kural silmek,
 *     forbid listelerinden öğe çıkarmak veya forbidNodeBuiltins bayrağını
 *     düşürmek testi başarısız kılar — kural gevşetme testin dışına
 *     bırakılmaz.
 *  5. Döngüsel import sayısı 0'dan yukarı çıkamaz.
 *
 * Allowlist'teki her girdi bir kodlama-ajanı düzeltmesiyle (kural 6: uygulama
 * kodunu test/CI ajanı düzeltmez) giderilmeli ve ardından bu listeden
 * çıkarılmalıdır. Girdi eklemek yeni bir ihlal kabulüdür ve PR'da
 * gerekçelendirilmelidir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  extractImports,
  runArchitectureScan,
} from '../scripts/maintenance/architecture-boundaries.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULES_PATH = path.join(REPO_ROOT, 'scripts/maintenance/architecture-rules.json');

/**
 * GEÇİCİ allowlist — bilinen `core-purity` ihlalleri.
 * Biçim: `<kural-id> :: <dosya> :: <specifier>`
 * Satır numarası bilinçli olarak anahtara dahil DEĞİLDİR (satırlar editsiz
 * kayar; ihlalin özü dosya + import edilen birimdir).
 *
 * NOT (F5-02): AST tabanlı tarayıcı çok satırlı importları da gördüğü için
 * `relationship-explorer.ts` iki ek ihlal daha bildirir (storage-idb,
 * series-tv-seeds). Bu ihlaller F5-04 (core ports/adapters) kapsamında
 * giderilecek ve allowlist küçülecektir.
 */
const ALLOWED_VIOLATIONS = new Set([]);

function violationKey(ruleId, violation) {
  return `${ruleId} :: ${violation.file} :: ${violation.specifier}`;
}

function loadRules() {
  const raw = fs.readFileSync(RULES_PATH, 'utf8');
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// 1. Analiz tamamlanmalı ve eksiksiz rapor üretmeli
// ---------------------------------------------------------------------------
test('Mimari sınır analizi tamamlanır ve eksiksiz rapor üretir', () => {
  let report;
  assert.doesNotThrow(
    () => {
      report = runArchitectureScan({ root: REPO_ROOT });
    },
    (err) => `Analiz tamamlanamadı (tarayıcı/ortam hatası): ${err?.message ?? err}`
  );

  assert.ok(report, 'analiz raporu üretilmeli');
  assert.ok(
    Number.isInteger(report.scannedFiles) && report.scannedFiles >= 200,
    `taranan dosya sayısı beklenen tabanın altında: ${report?.scannedFiles}`
  );
  assert.ok(report.totalImports > 0, 'hiç import taranmamış — rapor eksik');
  assert.ok(report.localEdges > 0, 'yerel import kenarı yok — rapor eksik');

  const rules = loadRules();
  assert.equal(
    report.ruleResults.length,
    rules.rules.length,
    'raporda kural eksik: tüm kurallar sonuç üretmeli'
  );
  for (const ruleResult of report.ruleResults) {
    assert.ok(Array.isArray(ruleResult.violations), `${ruleResult.id}: violations dizisi olmalı`);
  }
});

// ---------------------------------------------------------------------------
// 2. Kural dosyası denetimi — gevşetme yasak
// ---------------------------------------------------------------------------
test('architecture-rules.json gevşetilemez: kurallar ve yasak listeleri korunur', () => {
  const config = loadRules();

  assert.equal(config.version, 2, 'kural dosyası sürümü düşürülemez');

  const ruleIds = new Set((config.rules ?? []).map((r) => r.id));
  // Her bilinen kural mevcut olmalı (kural silmek gevşetmedir).
  for (const requiredId of [
    'core-purity',
    'server-isolation',
    'client-no-server',
    'contracts-isolation',
    'modules-no-server',
    'shared-isolation',
  ]) {
    assert.ok(ruleIds.has(requiredId), `zorunlu kural eksik: ${requiredId}`);
  }

  const byId = new Map((config.rules ?? []).map((r) => [r.id, r]));
  const mustContain = (ruleId, field, expected, message) => {
    const rule = byId.get(ruleId);
    assert.ok(rule, `kural eksik: ${ruleId}`);
    const actual = rule[field] ?? [];
    for (const item of expected) {
      assert.ok(
        actual.includes(item),
        `${message} — ${ruleId}.${field} içinde '${item}' olmalı (mevcut: ${JSON.stringify(actual)})`
      );
    }
  };

  // core-purity: çekirdek katman saf kalmalı.
  mustContain('core-purity', 'from', ['src/core/**'], 'kural kapsamı daraltılamaz');
  mustContain(
    'core-purity',
    'forbidLayers',
    ['server', 'services', 'app', 'components', 'hooks', 'features', 'modules', 'design-system'],
    'katman yasağı gevşetilemez'
  );
  mustContain(
    'core-purity',
    'forbidPackages',
    ['react', 'react-dom', 'express', 'idb-keyval', 'exceljs'],
    'paket yasağı gevşetilemez'
  );
  assert.equal(
    byId.get('core-purity').forbidNodeBuiltins,
    true,
    'core-purity: Node yerleşik modül yasağı kaldırılamaz'
  );

  // server-isolation: sunucu arayüz katmanına bağımlı olamaz.
  mustContain('server-isolation', 'from', ['server.ts', 'src/server/**'], 'kural kapsamı daraltılamaz');
  mustContain(
    'server-isolation',
    'forbidLayers',
    ['app', 'components', 'hooks', 'features', 'design-system'],
    'katman yasağı gevşetilemez'
  );
  mustContain('server-isolation', 'forbidPackages', ['react', 'react-dom'], 'paket yasağı gevşetilemez');

  // client-no-server: istemci paketine Node/sunucu sızmaz.
  mustContain(
    'client-no-server',
    'from',
    ['src/components/**', 'src/hooks/**', 'src/app/**', 'src/features/**', 'src/design-system/**'],
    'kural kapsamı daraltılamaz'
  );
  mustContain('client-no-server', 'forbidLayers', ['server'], 'katman yasağı gevşetilemez');
  mustContain('client-no-server', 'forbidPackages', ['express', 'exceljs'], 'paket yasağı gevşetilemez');
  assert.equal(
    byId.get('client-no-server').forbidNodeBuiltins,
    true,
    'client-no-server: Node yerleşik modül yasağı kaldırılamaz'
  );

  // modules-no-server: modüller sunucu uygulama katmanına bağımlı olamaz.
  mustContain('modules-no-server', 'from', ['src/modules/**'], 'kural kapsamı daraltılamaz');
  mustContain('modules-no-server', 'forbidLayers', ['server'], 'katman yasağı gevşetilemez');
  assert.equal(
    byId.get('modules-no-server').forbidNodeBuiltins,
    true,
    'modules-no-server: Node yerleşik modül yasağı kaldırılamaz'
  );

  // shared-isolation: ortak primitifler tüketen katmanlara bağımlı olamaz.
  mustContain('shared-isolation', 'from', ['src/shared/**'], 'kural kapsamı daraltılamaz');
  mustContain(
    'shared-isolation',
    'forbidLayers',
    ['server', 'app', 'components', 'hooks', 'features', 'modules', 'services', 'design-system'],
    'katman yasağı gevşetilemez'
  );

  // contracts-isolation: sözleşme katmanı çalışma zamanına bağımlı olamaz.
  mustContain('contracts-isolation', 'from', ['src/contracts/**'], 'kural kapsamı daraltılamaz');
  mustContain(
    'contracts-isolation',
    'forbidLayers',
    ['core', 'server', 'services', 'app', 'components', 'hooks', 'features', 'modules', 'design-system'],
    'katman yasağı gevşetilemez'
  );
  mustContain('contracts-isolation', 'forbidPackages', ['react', 'express'], 'paket yasağı gevşetilemez');

  // Her kural en az bir yaptırım mekanizması tanımlamalı.
  for (const rule of config.rules ?? []) {
    const hasTeeth =
      (rule.forbidLayers?.length ?? 0) > 0 ||
      (rule.forbidPackages?.length ?? 0) > 0 ||
      rule.forbidNodeBuiltins === true;
    assert.ok(hasTeeth, `kural yaptırımsız bırakılamaz: ${rule.id}`);
    assert.ok(rule.description, `kural açıklamasız olamaz: ${rule.id}`);
    assert.ok(rule.rationale, `kural gerekçesiz olamaz: ${rule.id}`);
  }
});

// ---------------------------------------------------------------------------
// 3. İhlal kapısı — yeni ihlal yasak, allowlist yalnızca küçülebilir
// ---------------------------------------------------------------------------
test('Mimari ihlaller: yeni ihlal yok, allowlist güncel (bayat girdi yok)', () => {
  const report = runArchitectureScan({ root: REPO_ROOT });
  const actualViolations = [];
  for (const ruleResult of report.ruleResults) {
    for (const violation of ruleResult.violations) {
      actualViolations.push({ ruleId: ruleResult.id, ...violation });
    }
  }

  const unknown = actualViolations.filter(
    (v) => !ALLOWED_VIOLATIONS.has(violationKey(v.ruleId, v))
  );
  assert.deepEqual(
    unknown.map((v) => violationKey(v.ruleId, v)),
    [],
    [
      'YENİ mimari ihlal(t)er tespit edildi — ihlal sayısı artamaz.',
      'Bu ihlalleri test/CI ajanı DÜZELTMEZ; kodlama ajanına dosya+satır ile bildirilir:',
      ...unknown.map(
        (v) => `  - ${v.ruleId}: ${v.file}:${v.line} → ${v.specifier} (${v.reasons.join(', ')})`
      ),
    ].join('\n')
  );

  // Bayat allowlist girdileri: ihlal giderildiğinde girdi listeden çıkarılmalı.
  const actualKeys = new Set(actualViolations.map((v) => violationKey(v.ruleId, v)));
  const stale = [...ALLOWED_VIOLATIONS].filter((key) => !actualKeys.has(key));
  assert.deepEqual(
    stale,
    [],
    [
      'Allowlist\'te artık geçerli olmayan (bayat) girdi(ler) var — ihlal giderilmiş:',
      'Kontrollü temizlik: bu girdileri allowlist\'ten ÇIKARIN:',
      ...stale.map((key) => `  - ${key}`),
    ].join('\n')
  );

  // Çift koruma: toplam ihlal sayısı allowlist boyutunu aşamaz.
  assert.ok(
    actualViolations.length <= ALLOWED_VIOLATIONS.size,
    `ihlal sayısı izin verilen tabanı aşıyor: ${actualViolations.length} > ${ALLOWED_VIOLATIONS.size}`
  );
});

// ---------------------------------------------------------------------------
// 3b. Import tespiti — çok satırlı ve dinamik biçimler kaçmaz (F5-02)
test('Import tespiti çok satırlı, alias, relative ve dinamik biçimleri yakalar', () => {
  const source = [
    "import { a } from './tek-satir.ts';",
    "import {",
    '  b,',
    '  c,',
    "} from '../cok-satirli/hedef.ts';",
    "import type { D } from '@kapsam/paket'; // yorum",
    "export * from './yeniden-disa-aktarim.ts';",
    "export { e } from './secmeli-disa-aktarim.ts';",
    'const lazy = await import(\'./dinamik.ts\');',
    "const legacy = require('./gereksinim.ts');",
    "// import { sahte } from './yorum-icinde.ts';",
    "const metin = \"import './metin-icinde.ts';\";",
  ].join('\n');

  const found = extractImports(source, 'ornek.ts').map((entry) => entry.specifier);

  assert.ok(found.includes('./tek-satir.ts'), 'tek satırlı import kaçmamalı');
  assert.ok(found.includes('../cok-satirli/hedef.ts'), 'çok satırlı import kaçmamalı');
  assert.ok(found.includes('@kapsam/paket'), 'kapsamlı paket importu kaçmamalı');
  assert.ok(found.includes('./yeniden-disa-aktarim.ts'), 'export * kaçmamalı');
  assert.ok(found.includes('./secmeli-disa-aktarim.ts'), 'seçmeli export kaçmamalı');
  assert.ok(found.includes('./dinamik.ts'), 'dinamik import kaçmamalı');
  assert.ok(found.includes('./gereksinim.ts'), 'require kaçmamalı');
  assert.equal(found.includes('./yorum-icinde.ts'), false, 'yorumdaki import sayılmamalı');
  assert.equal(found.includes('./metin-icinde.ts'), false, 'metin içindeki import sayılmamalı');

  const multiline = extractImports(source, 'ornek.ts').find(
    (entry) => entry.specifier === '../cok-satirli/hedef.ts'
  );
  assert.equal(multiline.line, 2, 'çok satırlı import doğru satırda bildirilmeli');
});

// ---------------------------------------------------------------------------
// 4. Döngüsel import — 0'dan yukarı çıkamaz
// ---------------------------------------------------------------------------
test('Döngüsel import sayısı 0 olmalı', () => {
  const report = runArchitectureScan({ root: REPO_ROOT });
  assert.deepEqual(
    report.cycles,
    [],
    `döngüsel import tespit edildi:\n${report.cycles
      .map((c) => `  - ${(c?.path ?? c?.cycle ?? JSON.stringify(c)).join(' → ')}`)
      .join('\n')}`
  );
});
