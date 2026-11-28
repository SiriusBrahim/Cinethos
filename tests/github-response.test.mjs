/**
 * Aşama 5.1 — F5.1-06: GitHub API yanıt sınırı doğrulaması.
 *
 * Beklenmeyen/eksik alanlar istisna fırlatmaz; `null`/boş değer döner ve
 * senkronizasyon motoru `malformed_response` üretir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isGitHubTooLargeError,
  readGitHubBlobPayload,
  readGitHubContentEntry,
  readGitHubDirectoryEntries,
  readGitHubErrorMessage,
} from '../src/server/github-response.ts';

test('F5.1-06 readGitHubBlobPayload: geçerli içerik, eksik alan ve yanlış tip', () => {
  assert.deepEqual(readGitHubBlobPayload({ content: 'aGVsbG8=', size: 8 }), {
    content: 'aGVsbG8=',
    size: 8,
  });
  assert.deepEqual(readGitHubBlobPayload({ content: 'YQ==' }), { content: 'YQ==' });
  assert.equal(readGitHubBlobPayload({ content: 42 }), null);
  assert.equal(readGitHubBlobPayload({ size: 8 }), null);
  assert.equal(readGitHubBlobPayload(null), null);
  assert.equal(readGitHubBlobPayload('base64'), null);
  assert.equal(readGitHubBlobPayload([{ content: 'YQ==' }]), null);
});

test('F5.1-06 readGitHubContentEntry: sha zorunlu, isteğe bağlı alanlar doğrulanır', () => {
  const full = readGitHubContentEntry({
    sha: 'abc123',
    size: 1024,
    content: 'YQ==',
    encoding: 'base64',
    download_url: 'https://raw.githubusercontent.com/x/y/main/data/a.json',
    type: 'file',
  });
  assert.deepEqual(full, {
    sha: 'abc123',
    size: 1024,
    content: 'YQ==',
    encoding: 'base64',
    downloadUrl: 'https://raw.githubusercontent.com/x/y/main/data/a.json',
  });

  assert.deepEqual(readGitHubContentEntry({ sha: 'abc123' }), { sha: 'abc123' });
  assert.equal(readGitHubContentEntry({ size: 10 }), null);
  assert.equal(readGitHubContentEntry({ sha: 7 }), null);
  assert.equal(readGitHubContentEntry(undefined), null);
});

test('F5.1-06 readGitHubDirectoryEntries: yalnızca adı olan girişler korunur', () => {
  const entries = readGitHubDirectoryEntries([
    { name: 'profile-1.json', type: 'file', sha: 's1', size: 12 },
    { name: 'nested', type: 'dir' },
    { type: 'file', sha: 's2' },
    'ignore',
    null,
  ]);
  assert.deepEqual(entries, [
    { name: 'profile-1.json', type: 'file', sha: 's1', size: 12 },
    { name: 'nested', type: 'dir' },
  ]);
  assert.equal(readGitHubDirectoryEntries({ name: 'x' }), null);
  assert.equal(readGitHubDirectoryEntries(null), null);
});

test('F5.1-06 readGitHubErrorMessage ve isGitHubTooLargeError', () => {
  assert.equal(readGitHubErrorMessage({ message: 'API rate limit exceeded' }), 'API rate limit exceeded');
  assert.equal(readGitHubErrorMessage({}), '');
  assert.equal(readGitHubErrorMessage(null), '');
  assert.equal(readGitHubErrorMessage('boom'), '');

  assert.equal(isGitHubTooLargeError({ errors: [{ code: 'too_large' }] }), true);
  assert.equal(isGitHubTooLargeError({ errors: [{ code: 'other' }] }), false);
  assert.equal(isGitHubTooLargeError({ errors: 'too_large' }), false);
  assert.equal(isGitHubTooLargeError(null), false);
});
