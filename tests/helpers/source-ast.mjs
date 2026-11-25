/**
 * AST tabanlı kaynak denetim yardımcıları (F5.1-04).
 *
 * Metin/regex eşlemesi yerine TypeScript Compiler API kullanılır: çok satırlı
 * import'lar, `export … from`, takma adlar ve yorum içindeki sahte metinler
 * doğru şekilde ayrılır. Yalnızca testlerde kullanılır.
 */

import fs from 'node:fs';
import ts from 'typescript';

export function parseFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, scriptKindFor(filePath));
}

function scriptKindFor(filePath) {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

function moduleSpecifier(node) {
  return node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)
    ? node.moduleSpecifier.text
    : null;
}

/** Dosyanın import/export-from/re-export kenarları: { module, names, typeOnly }. */
export function getModuleEdges(sourceFile) {
  const edges = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const module = moduleSpecifier(statement);
      if (!module) continue;
      const clause = statement.importClause;
      if (!clause) {
        edges.push({ module, names: [], typeOnly: false, sideEffect: true });
        continue;
      }
      const names = [];
      if (clause.name) names.push(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push(`*${clause.namedBindings.name.text}`);
        } else {
          for (const element of clause.namedBindings.elements) {
            names.push(element.name.text);
          }
        }
      }
      edges.push({
        module,
        names,
        typeOnly: Boolean(clause.isTypeOnly),
        sideEffect: false,
      });
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const module = moduleSpecifier(statement);
      if (!module) continue;
      const names = [];
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.push(element.name.text);
      }
      edges.push({
        module,
        names,
        typeOnly: Boolean(statement.isTypeOnly),
        sideEffect: false,
        exportFrom: true,
      });
    }
  }
  return edges;
}

/** Bir modülden import edilen adlar (yoksa boş dizi). */
export function importedNamesFrom(sourceFile, moduleSuffix) {
  return getModuleEdges(sourceFile)
    .filter((edge) => !edge.exportFrom && edge.module.endsWith(moduleSuffix))
    .flatMap((edge) => edge.names);
}

/** Adlandırılmış yeniden dışa aktarım var mı? */
export function hasReExport(sourceFile, moduleSuffix, names) {
  return getModuleEdges(sourceFile).some(
    (edge) =>
      edge.exportFrom &&
      edge.module.endsWith(moduleSuffix) &&
      names.every((name) => edge.names.includes(name))
  );
}

/** Dosya kökünde tanımlı adlar (fonksiyon/sınıf/arayüz/tip/sabit). */
export function declaredNames(sourceFile) {
  const result = { functions: [], classes: [], interfaces: [], types: [], consts: [] };
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      result.functions.push(statement.name.text);
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      result.classes.push(statement.name.text);
    } else if (ts.isInterfaceDeclaration(statement)) {
      result.interfaces.push(statement.name.text);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      result.types.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) result.consts.push(declaration.name.text);
      }
    }
  }
  return result;
}

/** Dosyanın tamamında `<name>(` çağrısı sayısı. */
export function callCount(sourceFile, name) {
  let count = 0;
  walk(sourceFile, (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      count += 1;
    }
  });
  return count;
}

/** Dosyanın tamamında `new <name>(` sayısı. */
export function newExpressionCount(sourceFile, name) {
  let count = 0;
  walk(sourceFile, (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      count += 1;
    }
  });
  return count;
}

/** Dosyadaki tüm string literal + JSX metin değerleri. */
export function stringLiterals(sourceFile) {
  const values = new Set();
  walk(sourceFile, (node) => {
    if (ts.isStringLiteralLike(node)) values.add(node.text);
    if (ts.isJsxText(node)) {
      const text = node.text.trim();
      if (text) values.add(text);
    }
  });
  return values;
}

/** Arayüz alan adları: { name, optional, typeText } */
export function interfaceProperties(sourceFile, interfaceName) {
  let target = null;
  for (const statement of sourceFile.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName) {
      target = statement;
      break;
    }
  }
  if (!target) return null;
  return target.members.map((member) => ({
    name: member.name && ts.isIdentifier(member.name) ? member.name.text : null,
    optional: Boolean(member.questionToken),
    typeText: member.type ? member.type.getText(sourceFile) : '',
  }));
}

/** Metinsel birleşim (union) üyelerindeki string literal değerler. */
export function unionLiteralValues(sourceFile, typeName) {
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName) {
      const members = ts.isUnionTypeNode(statement.type) ? statement.type.types : [statement.type];
      return members.filter(ts.isLiteralTypeNode).map((member) => member.literal.text);
    }
  }
  return null;
}

/** Kök düzeydeki bir `const`/`let` bildiriminin başlatıcı metni. */
export function constInitializerText(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer.getText(sourceFile);
      }
    }
  }
  return null;
}

/** Sayısal sabit ifadesini güvenli biçimde değerlendirir (yalnızca + - * / ve parantez). */
export function constInitializerNumber(sourceFile, name) {
  const text = constInitializerText(sourceFile, name);
  if (!text || !/^[\d\s()+*/-]+$/.test(text)) return null;
  try {
    const value = Function(`"use strict"; return (${text});`)();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
