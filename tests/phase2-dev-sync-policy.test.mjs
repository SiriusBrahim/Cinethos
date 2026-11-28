import test from 'node:test';
import assert from 'node:assert/strict';
import { isGitHubDevelopmentSyncEnabled } from '../src/server/development-sync-policy.ts';

test('GitHub geliştirme senkronizasyonu yalnızca --dev modunda varsayılan olarak açılır', () => {
  assert.equal(isGitHubDevelopmentSyncEnabled({ nodeEnv: 'development', argv: ['node', 'server.ts', '--dev'] }), true);
  assert.equal(isGitHubDevelopmentSyncEnabled({ nodeEnv: 'test', argv: ['node', 'server.ts', '--dev'] }), true);
});

test('Production modunda GitHub senkronizasyonu hiçbir override ile açılamaz', () => {
  assert.equal(isGitHubDevelopmentSyncEnabled({ nodeEnv: 'production', argv: ['node', 'server.ts', '--dev'], override: 'true' }), false);
  assert.equal(isGitHubDevelopmentSyncEnabled({ nodeEnv: 'production', argv: ['node', 'server.ts'] }), false);
});

test('Geliştirme modunda açık opt-out GitHub senkronizasyonunu kapatır', () => {
  assert.equal(isGitHubDevelopmentSyncEnabled({ nodeEnv: 'development', argv: ['node', 'server.ts', '--dev'], override: 'false' }), false);
  assert.equal(isGitHubDevelopmentSyncEnabled({ nodeEnv: 'development', argv: ['node', 'server.ts'] }), false);
});
