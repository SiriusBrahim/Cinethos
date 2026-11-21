export interface GitHubDevelopmentSyncPolicyInput {
  readonly nodeEnv?: string;
  readonly argv: readonly string[];
  readonly override?: string;
}

/** GitHub senkronizasyonu yalnızca açık geliştirme sunucusunda kullanılabilir. */
export function isGitHubDevelopmentSyncEnabled(
  input: GitHubDevelopmentSyncPolicyInput
): boolean {
  return input.nodeEnv !== 'production' &&
    input.argv.includes('--dev') &&
    input.override !== 'false';
}
