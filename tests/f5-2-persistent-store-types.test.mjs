/**
 * Aşama 5.2 — F5.2-05 kabul testleri.
 *
 * Kalıcı depo modülünde açık `any` kalmadığını AST üzerinden doğrular ve
 * GitHub yanıtları için eklenen dar doğrulayıcıların davranışını sınar.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

import {
  findGitHubDirectoryEntry,
  isGitHubTooLargeError,
  readGitHubCommittedSha,
  readGitHubErrorMessage,
  readGitHubFileEnvelope,
  readGitHubRepositoryMeta,
} from '../src/server/github-response.ts';
import { errorMessageOf } from '../src/server/persistent-store-utils.ts';
import { normalizeProfileId } from '../src/core/profile-id.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

function collectAnyUsages(filePath) {
  const source = ts.createSourceFile(
    filePath,
    fs.readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const lines = [];
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      lines.push(line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

test('F5.2-05 persistent-store modüllerinde açık `any` kalmadı', () => {
  const files = [
    'src/server/persistent-store.ts',
    'src/server/persistent-store/catalog-store.ts',
    'src/server/persistent-store/derived-profile-store.ts',
    'src/server/persistent-store/contracts.ts',
    'src/server/persistent-store/store-state.ts',
  ];
  for (const rel of files) {
    const remaining = collectAnyUsages(path.join(repoRoot, rel));
    assert.deepEqual(remaining, [], `${rel} beklenmeyen any satırları: ${remaining.join(', ')}`);
  }
});

test('F5.2-05 doğrulanmış dar geçişler gerekçeleriyle işaretli', () => {
  const files = [
    'src/server/persistent-store.ts',
    'src/server/persistent-store/catalog-store.ts',
    'src/server/persistent-store/derived-profile-store.ts',
  ];
  const counts = files.map((rel) => {
    const source = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    return {
      rel,
      casts: source.split('as unknown as').length - 1,
      comments: source.split('F5.2-05 istisnası').length - 1,
    };
  });
  const casts = counts.reduce((sum, entry) => sum + entry.casts, 0);
  const comments = counts.reduce((sum, entry) => sum + entry.comments, 0);
  assert.equal(casts, 2, 'yalnızca iki doğrulanmış geçiş kalmalı (manifest + türetilmiş profil)');
  assert.equal(comments, 2, 'her geçiş gerekçe yorumu taşımalı');
});

test('F5.2-05 readGitHubRepositoryMeta: geçerli alanları çıkarır, bozuk yükü reddeder', () => {
  assert.deepEqual(
    readGitHubRepositoryMeta({
      default_branch: 'main',
      private: false,
      permissions: { push: true, admin: false },
    }),
    { defaultBranch: 'main', isPrivate: false, canPush: true }
  );
  assert.deepEqual(readGitHubRepositoryMeta({ permissions: { push: false } }), { canPush: false });
  assert.equal(readGitHubRepositoryMeta(null), null);
  assert.equal(readGitHubRepositoryMeta([1, 2]), null);
  assert.equal(readGitHubRepositoryMeta('metin'), null);
});

test('F5.2-05 readGitHubFileEnvelope / committedSha: içerik, kodlama, boyut ve commit SHA', () => {
  assert.deepEqual(readGitHubFileEnvelope({ content: 'abc', encoding: 'base64' }), {
    content: 'abc',
    encoding: 'base64',
  });
  assert.deepEqual(readGitHubFileEnvelope({ sha: 's1', size: 12, encoding: 'none' }), {
    sha: 's1',
    encoding: 'none',
    size: 12,
  });
  assert.equal(readGitHubFileEnvelope(null), null);
  assert.equal(readGitHubCommittedSha({ content: { sha: 'commit-sha' } }), 'commit-sha');
  assert.equal(readGitHubCommittedSha({ content: {} }), undefined);
  assert.equal(readGitHubCommittedSha('bozuk'), undefined);
});

test('F5.2-05 findGitHubDirectoryEntry: ada göre kayıt, geçersiz listede null', () => {
  const list = [
    { name: 'a.json', sha: 'sha-a', size: 1 },
    { name: 'b.json', sha: 'sha-b' },
    { bozuk: true },
  ];
  assert.deepEqual(findGitHubDirectoryEntry(list, 'b.json'), { name: 'b.json', sha: 'sha-b' });
  assert.equal(findGitHubDirectoryEntry(list, 'yok.json'), null);
  assert.equal(findGitHubDirectoryEntry({ not: 'a list' }, 'a.json'), null);
});

test('F5.2-05 hata ve too_large doğrulayıcıları', () => {
  assert.equal(readGitHubErrorMessage({ message: 'kota' }), 'kota');
  assert.equal(readGitHubErrorMessage(null), '');
  assert.equal(isGitHubTooLargeError({ errors: [{ code: 'too_large' }] }), true);
  assert.equal(isGitHubTooLargeError({ errors: [{ code: 'other' }] }), false);
  assert.equal(isGitHubTooLargeError({ message: 'too_large' }), false);

  assert.equal(errorMessageOf(new Error('ağ hatası')), 'ağ hatası');
  assert.equal(errorMessageOf('metin hata'), 'metin hata');
  assert.equal(errorMessageOf({ message: 'nesne' }, 'yedek'), 'yedek');
  assert.equal(errorMessageOf(undefined, 'yedek'), 'yedek');
});

test('F5.2-05 profil kimliği normalizasyonu değişmedi', () => {
  assert.equal(normalizeProfileId('profile-a'), 'PROFILE-A');
  assert.equal(normalizeProfileId(''), null);
});
