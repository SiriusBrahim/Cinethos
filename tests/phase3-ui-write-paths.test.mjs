/**
 * MIA Faz 3 — UI yazma yolları ve tek-kaynak/paralel-sistem denetimi (görev §2-E).
 *
 * Statik kaynak denetimi; uygulama kodunu DEĞİŞTİRMEZ, ihlal bulunursa raporlar:
 *  - `useItemActions` kayıt üretimini `modules/library/operations.ts`'e devretmeli;
 *    yerel kopya (ikinci kural seti) bulundurmamalı; uyumluluk re-export'ları kalmalı.
 *  - `buildLibraryItem` / `pickContentFields` tek kaynakta tanımlı olmalı
 *    (paralel uygulama çoğaltması yasak).
 *  - `app.ts` servisleri modül fabrikalarından bağlamalı; inline sınıf kopyası olmamalı.
 *  - Faz 3 modülleri paralel Repository/EventBus/ModuleRegistry/SQLite sistemi
 *    KURMAMALI (bağımlılık enjeksiyonu zorunlu).
 *  - Library Manager yalnızca repository üzerinden yazar (doğrudan dosya/DB erişimi yok).
 *  - `ILibraryService` / `IContentService` sözleşmeleri tek yerde tanımlı olmalı.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

// ---------------------------------------------------------------------------
// E1. useItemActions → operations.ts devri
// ---------------------------------------------------------------------------
test('F3-E1 useItemActions: buildLibraryItem’ı operations.ts’ten kullanır, yerel kopya bulundurmaz', () => {
  const source = read('src/hooks/useItemActions.ts');

  assert.ok(
    source.includes("from '../modules/library/operations.ts'"),
    'useItemActions kütüphane kurallarını modules/library/operations.ts’ten import etmeli'
  );
  assert.ok(
    source.includes('buildLibraryItem'),
    'kayıt üretimi buildLibraryItem üzerinden olmalı'
  );

  // Yerel tanım kalıntısı yasak (ikinci kural seti):
  assert.equal(
    /^export function resolveItemActionTimestamps/m.test(source),
    false,
    'resolveItemActionTimestamps hook’ta yeniden tanımlanmamalı (tek kaynak operations.ts)'
  );
  assert.equal(
    /^export type ItemWatchStatus/m.test(source),
    false,
    'ItemWatchStatus hook’ta yeniden tanımlanmamalı'
  );

  // Uyumluluk re-export'ları korunmalı (eski import yolları bozulmamalı):
  assert.ok(
    /export \{ mapWatchStatusToLibraryList, resolveItemActionTimestamps \} from '\.\.\/modules\/library\/operations\.ts'/.test(
      source
    ),
    'eski import yolları için re-export uyumluluğu korunmalı'
  );
});

// ---------------------------------------------------------------------------
// E2. Tek kaynak: paralel uygulama çoğaltması yok
// ---------------------------------------------------------------------------
test('F3-E2 buildLibraryItem ve pickContentFields tek kaynakta tanımlı', () => {
  const srcFiles = walk(path.join(ROOT, 'src')).filter((file) =>
    /\.(ts|tsx)$/.test(file)
  );
  const definitions = { buildLibraryItem: [], pickContentFields: [] };

  for (const file of srcFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const name of Object.keys(definitions)) {
      if (new RegExp(`export function ${name}\\b`).test(source)) {
        definitions[name].push(rel(file));
      }
    }
  }

  assert.deepEqual(
    definitions.buildLibraryItem,
    ['src/modules/library/operations.ts'],
    `buildLibraryItem yalnızca operations.ts’ten export edilmeli; bulunanlar: ${definitions.buildLibraryItem.join(', ')}`
  );
  assert.deepEqual(
    definitions.pickContentFields,
    ['src/modules/library/operations.ts'],
    `pickContentFields yalnızca operations.ts’ten export edilmeli; bulunanlar: ${definitions.pickContentFields.join(', ')}`
  );
});

test('F3-E3 ILibraryService ve IContentService sözleşmeleri tek yerde tanımlı', () => {
  const srcFiles = walk(path.join(ROOT, 'src')).filter((file) =>
    /\.(ts|tsx)$/.test(file)
  );
  const counts = { ILibraryService: [], IContentService: [] };

  for (const file of srcFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const name of Object.keys(counts)) {
      if (new RegExp(`export interface ${name}\\b`).test(source)) {
        counts[name].push(rel(file));
      }
    }
  }

  assert.deepEqual(
    counts.ILibraryService,
    ['src/contracts/services.ts'],
    `ILibraryService yalnızca contracts/services.ts’te tanımlı olmalı: ${counts.ILibraryService.join(', ')}`
  );
  assert.deepEqual(
    counts.IContentService,
    ['src/contracts/services.ts'],
    `IContentService yalnızca contracts/services.ts’te tanımlı olmalı: ${counts.IContentService.join(', ')}`
  );
});

// ---------------------------------------------------------------------------
// E3. app.ts bağlaması — inline kopya yok
// ---------------------------------------------------------------------------
test('F3-E3b app.ts: servisler modül fabrikalarından bağlanır, inline sınıf kopyası yok', () => {
  const source = read('src/server/app.ts');

  assert.ok(
    source.includes("from '../modules/library/service.ts'"),
    'app.ts Library Manager’ı modül dosyasından import etmeli'
  );
  assert.ok(
    source.includes("from '../modules/content/service.ts'"),
    'app.ts Content Manager’ı modül dosyasından import etmeli'
  );
  assert.ok(
    source.includes('createLibraryService({') && source.includes('createContentService({'),
    'app.ts servisleri fabrikalarla oluşturmalı'
  );
  assert.equal(
    /class LibraryService|class ContentService/.test(source),
    false,
    'app.ts içinde servis sınıfının kopyası bulunmamalı'
  );
});

// ---------------------------------------------------------------------------
// E4. Paralel sistem kurulumu yasak (ikinci Repository/EventBus/Registry/SQLite)
// ---------------------------------------------------------------------------
test('F3-E4 Faz 3 modülleri paralel Repository/EventBus/Registry/SQLite sistemi kurmaz', () => {
  const faz3Files = [
    ...walk(path.join(ROOT, 'src', 'modules', 'library')),
    path.join(ROOT, 'src', 'modules', 'content', 'service.ts'),
  ];

  const forbiddenPatterns = [
    { re: /createAppEventBus\s*\(/, why: 'ikinci EventBus kurulumu' },
    { re: /createProfileContext\s*\(/, why: 'ikinci ProfileContext kurulumu' },
    { re: /createContentIntelligenceRepository\s*\(/, why: 'ikinci repository kurulumu' },
    { re: /new\s+DatabaseSync\s*\(/, why: 'doğrudan SQLite kurulumu' },
    { re: /from\s+'node:sqlite'/, why: 'doğrudan node:sqlite erişimi' },
    { re: /createModuleRegistry\s*\(/, why: 'ikinci ModuleRegistry kurulumu' },
  ];

  for (const file of faz3Files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { re, why } of forbiddenPatterns) {
      assert.equal(
        re.test(source),
        false,
        `${rel(file)} paralel sistem kurmamalı (${why}) — bağımlılık enjeksiyonu zorunlu`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// E5. Library Manager yazma sınırı: yalnızca repository üzerinden
// ---------------------------------------------------------------------------
test('F3-E5 Library Manager: yazım yalnızca saveForProfileOrThrow üzerinden; doğrudan dosya/DB yazımı yok', () => {
  const source = read('src/modules/library/service.ts');

  assert.ok(
    source.includes('saveForProfileOrThrow'),
    'kütüphane yazımı repository.saveForProfileOrThrow üzerinden olmalı'
  );

  for (const { re, why } of [
    { re: /writeFile|appendFile|createWriteStream/, why: 'doğrudan dosya yazımı' },
    { re: /node:fs(?![a-z])/, why: 'fs erişimi' },
    { re: /fetch\s*\(/, why: 'doğrudan ağ çağrısı' },
    { re: /TMDB_API_KEY|api\.themoviedb/, why: 'doğrudan TMDB erişimi' },
  ]) {
    assert.equal(
      re.test(source),
      false,
      `LibraryService ${why} YAPMAMALI (veri erişimi repository sınırından geçmeli)`
    );
  }
});

// ---------------------------------------------------------------------------
// E6. Eski API sözleşmeleri korunuyor
// ---------------------------------------------------------------------------
test('F3-E6 eski sözleşmeler: AddLibraryItemInput mevcut alanları koruyor, yenileri opsiyonel', () => {
  const source = read('src/contracts/services.ts');

  // Mevcut alanlar:
  for (const field of ['readonly ref: WriteProfileRef', 'readonly mediaKey: string', 'readonly mediaType: MediaKind', 'readonly list: LibraryListId']) {
    assert.ok(source.includes(field), `sözleşme alanı korunmalı: ${field}`);
  }
  // Yeni alanlar geriye dönük uyumlu (opsiyonel):
  assert.ok(
    /readonly metadata\?: Readonly<Record<string, unknown>>;/.test(source),
    'metadata alanı opsiyonel olmalı'
  );
  assert.ok(
    /readonly progress\?: \{/.test(source),
    'progress alanı opsiyonel olmalı'
  );
  // not-interested hâlâ LibraryListId üyesi:
  assert.ok(
    /'watched' \| 'watching' \| 'watchlist' \| 'not-interested'/.test(
      read('src/contracts/common.ts')
    ),
    'not-interested liste kimliği korunmalı'
  );
});
