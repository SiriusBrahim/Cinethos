// Cinethos — M0 bağımsız denetim: workflow ve CI yapılandırma doğrulaması (F).
//
// Statik YAML denetimleri: tetikleyiciler, workflow_dispatch girdileri
// (özellikle compare_baseline=false davranışı), aksiyon SHA sabitlemeleri,
// adım sırası, artifact ve izin ayarları. YAML parser bağımlılığı eklememek
// için satır/regex tabanlı assertion'lar kullanılır.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAINTENANCE_YML = fs.readFileSync(path.join(ROOT, '.github/workflows/maintenance.yml'), 'utf8');
const CI_YML = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');

// ---------------------------------------------------------------------------
// F1. maintenance.yml — tetikleyiciler
// ---------------------------------------------------------------------------
test('F1: maintenance workflow pull_request, schedule ve workflow_dispatch ile tetiklenir', () => {
  const triggerBlock = MAINTENANCE_YML.slice(MAINTENANCE_YML.indexOf('\non:\n'), MAINTENANCE_YML.indexOf('permissions:'));
  assert.match(triggerBlock, /pull_request:\s*\n\s*branches:/, 'pull_request tetikleyicisi olmalı');
  assert.match(triggerBlock, /schedule:\s*\n[^\0]*?cron: '0 3 \* \* \*'/, 'gecelik cron olmalı');
  assert.match(triggerBlock, /workflow_dispatch:/, 'manuel tetikleyici olmalı');
});

test('F1: pull_request tetikleyicisi PR hedef dallarını kapsar (maintenance-bot)', () => {
  const branchesLine = MAINTENANCE_YML.match(/pull_request:\s*\n\s*branches:\s*\[([^\]]+)\]/);
  assert.ok(branchesLine, 'pull_request.branches listesi bulunamadı');
  const branches = branchesLine[1].split(',').map((value) => value.trim().replace(/^'|"$/g, ''));
  for (const required of ['main', 'master', 'agent-2/maintenance-bot']) {
    assert.ok(branches.includes(required), `maintenance.yml pull_request.branches "${required}" içermeli`);
  }
});

// ---------------------------------------------------------------------------
// F2. maintenance.yml — workflow_dispatch girdileri ve compare_baseline=false
// ---------------------------------------------------------------------------
test('F2: dispatch girdileri analysis (full|post-faz3) ve compare_baseline (boolean, default true)', () => {
  const inputsBlock = MAINTENANCE_YML.slice(MAINTENANCE_YML.indexOf('    inputs:'), MAINTENANCE_YML.indexOf('permissions:'));
  assert.match(inputsBlock, /analysis:\s*\n[^\0]*?type: choice\s*\n[^\0]*?options: \[full, post-faz3\]\s*\n[^\0]*?default: full/, 'analysis girdisi tanımlı olmalı');
  assert.match(inputsBlock, /compare_baseline:\s*\n[^\0]*?type: boolean\s*\n[^\0]*?default: true/, 'compare_baseline girdisi tanımlı olmalı');
});

test('F2: compare_baseline=false doğru uygulanır — boolean coercion regresyonu yok', () => {
  // Eski hata: `${{ inputs.compare_baseline || 'true' }}` yazılıyordu; bu,
  // dispatch'te false seçilse bile 'true' string'ine coerce ediyordu (0025cac
  // düzeltmesi). Regresyon testi: hem eski desen YOK hem yeni desen VAR.
  assert.doesNotMatch(
    MAINTENANCE_YML,
    /inputs\.compare_baseline\s*\|\|\s*'true'/,
    "eski `inputs.compare_baseline || 'true'` coercion deseni geri gelmemeli",
  );
  assert.match(
    MAINTENANCE_YML,
    /COMPARE_BASELINE:\s*\$\{\{\s*github\.event_name != 'workflow_dispatch' \|\| inputs\.compare_baseline\s*\}\}/,
    'dispatch dışı koşullarda karşılaştırma açık, dispatch\'te kullanıcı seçimi korunmalı',
  );
  // Kabuk tarafı: yalnızca COMPARE_BASELINE=true iken --compare eklenir.
  assert.match(MAINTENANCE_YML, /if \[ "\$\{COMPARE_BASELINE\}" = "true" \] && \[ -f "\$\{BASELINE\}" \]; then\s*\n\s*ARGS\+=\(--compare "\$\{BASELINE\}"\)/);
});

test('F2: post-faz3 analizi için baseline yoksa iş açıkça başarısız olur', () => {
  assert.match(MAINTENANCE_YML, /::error::post-faz3 analizi için baseline bulunamadı/, 'baseline yokluğu sessiz geçilmemeli');
});

// ---------------------------------------------------------------------------
// F3. maintenance.yml — güvenlik ve adım sırası
// ---------------------------------------------------------------------------
test('F3: aksiyonlar mutable tag değil tam SHA ile sabitli', () => {
  const uses = [...MAINTENANCE_YML.matchAll(/uses:\s*(\S+)@(\S+)/g)].map((match) => match[2]);
  assert.ok(uses.length >= 3, 'en az 3 aksiyon kullanılmalı');
  for (const ref of uses) {
    assert.match(ref, /^[0-9a-f]{40}( #.+)?$/, `aksiyon referansı tam SHA olmalı: ${ref}`);
  }
});

test('F3: salt okunur güvenlik ayarları korunur', () => {
  assert.match(MAINTENANCE_YML, /permissions:\s*\n\s*contents: read/, 'yalnızca contents: read');
  assert.match(MAINTENANCE_YML, /persist-credentials:\s*false/, 'kimlik bilgisi kalıcı olmamalı');
  assert.doesNotMatch(MAINTENANCE_YML, /pull_request_target/, 'pull_request_target kullanılmamalı');
});

test('F3: adım sırası npm ci → mimari kapı → bot öz-testleri → analiz → artifact', () => {
  const steps = [
    ['npm ci --no-audit --no-fund', 'npm ci'],
    ['npm run check:architecture', 'mimari kapı'],
    ['npm run test:maintenance', 'bot öz-testleri'],
    ['node scripts/maintenance/analyze.mjs', 'analiz'],
    ['uses: actions/upload-artifact', 'artifact'],
  ];
  let lastIndex = -1;
  for (const [needle, label] of steps) {
    const index = MAINTENANCE_YML.indexOf(needle);
    assert.ok(index > lastIndex, `"${label}" adımı sırayla olmalı (index ${index} <= ${lastIndex})`);
    lastIndex = index;
  }
});

test('F3: artifact if-no-files-found: error — eksik rapor sessizce geçilmez', () => {
  const artifactBlock = MAINTENANCE_YML.slice(MAINTENANCE_YML.indexOf('upload-artifact'));
  assert.match(artifactBlock, /if-no-files-found:\s*error/, 'eksik artifact hatada olmalı');
  assert.match(artifactBlock, /maintenance-report/, 'artifact adı maintenance-report olmalı');
});

test('F3: Node sürümü 22.18.0 sabit', () => {
  const versions = [...MAINTENANCE_YML.matchAll(/node-version:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(versions.length >= 1);
  for (const version of versions) assert.equal(version, '22.18.0');
});

// ---------------------------------------------------------------------------
// F4. ci.yml — mimari kapı ve tetikleyiciler
// ---------------------------------------------------------------------------
test('F4: ci.yml mimari kapı adımı içerir ve lint ile unit test arasındadır', () => {
  const lintIndex = CI_YML.indexOf('npm run lint');
  const gateIndex = CI_YML.indexOf('npm run check:architecture');
  const testIndex = CI_YML.indexOf('npm test');
  assert.ok(lintIndex > 0 && gateIndex > lintIndex && testIndex > gateIndex, 'sıra: lint → check:architecture → npm test');
});

test('F4: ci.yml Node 22.18.0 sabit (>= aralığı kabul edilmez)', () => {
  const versions = [...CI_YML.matchAll(/node-version:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.ok(versions.length >= 2, 'her iki job için node tanımlı olmalı');
  for (const version of versions) assert.equal(version, '22.18.0');
});

test('F4: ci.yml pull_request tetikleyicisi maintenance-bot dalını kapsar', () => {
  const branchesLine = CI_YML.match(/pull_request:\s*\n\s*branches:\s*\[([^\]]+)\]/);
  assert.ok(branchesLine, 'pull_request.branches bulunamadı');
  const branches = branchesLine[1].split(',').map((value) => value.trim().replace(/^'|"$/g, ''));
  for (const required of ['main', 'master', 'agent-2/phase-3', 'agent-2/maintenance-bot']) {
    assert.ok(branches.includes(required), `ci.yml pull_request.branches "${required}" içermeli`);
  }
});

// ---------------------------------------------------------------------------
// F5. package.json — test komutları
// ---------------------------------------------------------------------------
test('F5: test:maintenance ve check:architecture komutları tanımlı ve doğru hedefleri gösterir', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(
    pkg.scripts['test:maintenance'],
    /^tsx --test tests\/maintenance\/maintenance-bot\.test\.mjs tests\/maintenance\/m0-verdict-parsers\.test\.mjs tests\/maintenance\/m0-negative-scenarios\.test\.mjs tests\/maintenance\/m0-workflow\.test\.mjs$/,
    'test:maintenance dört M0 test dosyasını da çalıştırmalı',
  );
  assert.equal(pkg.scripts['check:architecture'], 'node scripts/maintenance/check-architecture.mjs');
});

test('F5: tüm M0 denetim testleri npm test kapsamındadır', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const testScript = pkg.scripts.test;
  for (const file of [
    'tests/maintenance/maintenance-bot.test.mjs',
    'tests/maintenance/m0-verdict-parsers.test.mjs',
    'tests/maintenance/m0-negative-scenarios.test.mjs',
    'tests/maintenance/m0-workflow.test.mjs',
    'tests/architecture-boundaries.test.mjs',
  ]) {
    assert.ok(testScript.includes(file), `${file} npm test kapsamında olmalı`);
  }
});
