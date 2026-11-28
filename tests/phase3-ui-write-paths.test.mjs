/**
 * MIA Faz 3 — UI yazma yolları ve tek-kaynak/paralel-sistem denetimi (görev §2-E).
 *
 * F5.1-04: Bu suite artık kaynak metnini regex ile eşlemez; TypeScript AST
 * üzerinden import/export/tanım/çağrı yapısını doğrular. Böylece çok satırlı
 * import'lar, takma adlar ve yorum içindeki metinler yanlış sonuç üretmez.
 *
 * Korunan güvenceler:
 *  - `useItemActions` kayıt üretimini `modules/library/operations.ts`'e devretmeli;
 *    yerel kopya (ikinci kural seti) bulundurmamalı; uyumluluk re-export'ları kalmalı.
 *  - `buildLibraryItem` / `pickContentFields` tek kaynakta tanımlı olmalı.
 *  - `app.ts` servisleri modül fabrikalarından bağlamalı; inline sınıf kopyası olmamalı.
 *  - Faz 3 modülleri paralel Repository/EventBus/ModuleRegistry/SQLite sistemi KURMAMALI.
 *  - Library Manager yalnızca repository üzerinden yazar (doğrudan dosya/DB/ağ erişimi yok).
 *  - `ILibraryService` / `IContentService` sözleşmeleri tek yerde tanımlı olmalı.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  callCount,
  declaredNames,
  getModuleEdges,
  hasReExport,
  importedNamesFrom,
  interfaceProperties,
  newExpressionCount,
  parseFile,
  stringLiterals,
  unionLiteralValues,
} from './helpers/source-ast.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function ast(relativePath) {
  return parseFile(path.join(ROOT, relativePath));
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

function sourceFiles() {
  return walk(path.join(ROOT, 'src')).filter((file) => /\.(ts|tsx)$/.test(file));
}

// ---------------------------------------------------------------------------
// E1. useItemActions → operations.ts devri
// ---------------------------------------------------------------------------
test('F3-E1 useItemActions: kütüphane kurallarını tek kaynaktan kullanır, yerel kopya bulundurmaz', () => {
  const source = ast('src/hooks/useItemActions.ts');

  assert.ok(
    importedNamesFrom(source, 'modules/library/client-service.ts').includes(
      'createClientLibraryService'
    ),
    'useItemActions kütüphane hattını (modules/library/client-service.ts) kullanmalı'
  );
  assert.ok(
    hasReExport(source, 'modules/library/operations.ts', [
      'mapWatchStatusToLibraryList',
      'resolveItemActionTimestamps',
    ]),
    'eski import yolları için re-export uyumluluğu korunmalı'
  );

  // Yerel tanım kalıntısı yasak (ikinci kural seti):
  const declared = declaredNames(source);
  assert.equal(
    declared.functions.includes('resolveItemActionTimestamps'),
    false,
    'resolveItemActionTimestamps hook’ta yeniden tanımlanmamalı (tek kaynak operations.ts)'
  );
  assert.equal(
    declared.types.includes('ItemWatchStatus') || declared.interfaces.includes('ItemWatchStatus'),
    false,
    'ItemWatchStatus hook’ta yeniden tanımlanmamalı'
  );
});

// ---------------------------------------------------------------------------
// E2. Tek kaynak: paralel uygulama çoğaltması yok
// ---------------------------------------------------------------------------
test('F3-E2 buildLibraryItem ve pickContentFields tek kaynakta tanımlı', () => {
  const definitions = { buildLibraryItem: [], pickContentFields: [] };

  for (const file of sourceFiles()) {
    const declared = declaredNames(parseFile(file));
    for (const name of Object.keys(definitions)) {
      if (declared.functions.includes(name)) definitions[name].push(rel(file));
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
  const counts = { ILibraryService: [], IContentService: [] };

  for (const file of sourceFiles()) {
    const declared = declaredNames(parseFile(file));
    for (const name of Object.keys(counts)) {
      if (declared.interfaces.includes(name)) counts[name].push(rel(file));
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
  const source = ast('src/server/app.ts');
  const edges = getModuleEdges(source);
  const imports = edges.filter((edge) => !edge.exportFrom).map((edge) => edge.module);

  assert.ok(
    imports.some((module) => module.endsWith('modules/library/service.ts')),
    'app.ts Library Manager’ı modül dosyasından import etmeli'
  );
  assert.ok(
    imports.some((module) => module.endsWith('modules/content/service.ts')),
    'app.ts Content Manager’ı modül dosyasından import etmeli'
  );
  assert.ok(
    callCount(source, 'createLibraryService') > 0 && callCount(source, 'createContentService') > 0,
    'app.ts servisleri fabrikalarla oluşturmalı'
  );

  const declared = declaredNames(source);
  assert.equal(
    declared.classes.includes('LibraryService') || declared.classes.includes('ContentService'),
    false,
    'app.ts içinde servis sınıfının kopyası bulunmamalı'
  );
  assert.equal(
    newExpressionCount(source, 'LibraryService') + newExpressionCount(source, 'ContentService'),
    0,
    'app.ts servis sınıflarını doğrudan örneklememeli'
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

  for (const file of faz3Files) {
    const source = parseFile(file);
    const modules = getModuleEdges(source).map((edge) => edge.module);

    for (const factory of [
      'createAppEventBus',
      'createProfileContext',
      'createContentIntelligenceRepository',
      'createModuleRegistry',
    ]) {
      assert.equal(
        callCount(source, factory),
        0,
        `${rel(file)} paralel sistem kurmamalı (${factory}) — bağımlılık enjeksiyonu zorunlu`
      );
    }
    assert.equal(
      newExpressionCount(source, 'DatabaseSync'),
      0,
      `${rel(file)} doğrudan SQLite kurmamalı — bağımlılık enjeksiyonu zorunlu`
    );
    assert.equal(
      modules.some((module) => module === 'node:sqlite'),
      false,
      `${rel(file)} doğrudan node:sqlite erişmemeli`
    );
  }
});

// ---------------------------------------------------------------------------
// E5. Library Manager yazma sınırı: yalnızca repository üzerinden
// ---------------------------------------------------------------------------
test('F3-E5 Library Manager: yazım yalnızca saveForProfileOrThrow üzerinden; doğrudan dosya/DB yazımı yok', () => {
  const source = ast('src/modules/library/service.ts');
  const text = source.getFullText();

  assert.ok(
    text.includes('saveForProfileOrThrow'),
    'kütüphane yazımı repository.saveForProfileOrThrow üzerinden olmalı'
  );

  for (const forbidden of ['writeFile', 'appendFile', 'createWriteStream', 'fetch']) {
    assert.equal(
      callCount(source, forbidden),
      0,
      `LibraryService doğrudan ${forbidden} çağırmamalı (veri erişimi repository sınırından geçmeli)`
    );
  }

  const modules = getModuleEdges(source).map((edge) => edge.module);
  assert.equal(
    modules.some((module) => module === 'node:fs' || module.startsWith('node:fs/')),
    false,
    'LibraryService node:fs erişmemeli'
  );
  assert.equal(
    modules.some((module) => module === 'node:sqlite'),
    false,
    'LibraryService node:sqlite erişmemeli'
  );

  const literals = stringLiterals(source);
  assert.equal(literals.has('TMDB_API_KEY'), false, 'LibraryService TMDB anahtarı kullanmamalı');
  assert.equal(
    [...literals].some((value) => value.includes('api.themoviedb')),
    false,
    'LibraryService doğrudan TMDB erişmemeli'
  );
});

// ---------------------------------------------------------------------------
// E6. Eski API sözleşmeleri korunuyor
// ---------------------------------------------------------------------------
test('F3-E6 eski sözleşmeler: AddLibraryItemInput mevcut alanları koruyor, yenileri opsiyonel', () => {
  const source = ast('src/contracts/services.ts');
  const properties = interfaceProperties(source, 'AddLibraryItemInput');
  assert.ok(properties, 'AddLibraryItemInput sözleşmesi bulunmalı');

  const byName = new Map(properties.map((property) => [property.name, property]));
  for (const field of ['ref', 'mediaKey', 'mediaType', 'list']) {
    assert.ok(byName.has(field), `zorunlu sözleşme alanı korunmalı: ${field}`);
    assert.equal(byName.get(field).optional, false, `${field} zorunlu kalmalı`);
  }
  for (const optionalField of ['metadata', 'progress', 'rating']) {
    const property = byName.get(optionalField);
    if (property) {
      assert.equal(property.optional, true, `${optionalField} alanı opsiyonel olmalı`);
    }
  }

  const lists = unionLiteralValues(ast('src/contracts/common.ts'), 'LibraryListId');
  assert.deepEqual(
    lists,
    ['watched', 'watching', 'watchlist', 'not-interested'],
    'not-interested dahil liste kimlikleri korunmalı'
  );
});
