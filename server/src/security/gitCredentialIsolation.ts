const SECRET_PATTERNS = [
  /x-access-token:[^@\s]+@/i,
  /gh[pousr]_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /oauth[^@\s]*@/i,
];

export interface IsolatedGitCredentialEnvInput {
  tokenCommand: string;
  allowGhCli: boolean;
  ghConfigDir: string;
}

/**
 * Builds git credential env without writing the token into .git/config or workspace files.
 * The helper command reads the connector-provided GH_TOKEN/GITHUB_TOKEN only when git asks
 * for credentials.
 */
export function buildIsolatedGitCredentialEnv(input: IsolatedGitCredentialEnvInput): Record<string, string> {
  const env: Record<string, string> = {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.helper',
    GIT_CONFIG_VALUE_1: `!f() { test "$1" = get || exit 0; echo "username=x-access-token"; echo "password=$(${input.tokenCommand})"; }; f`,
  };
  if (input.allowGhCli) {
    env.GH_CONFIG_DIR = input.ghConfigDir;
    env.GH_NO_UPDATE_NOTIFIER = '1';
    env.GH_NO_EXTENSION_UPDATE_NOTIFIER = '1';
    env.GH_PROMPT_DISABLED = '1';
  }
  assertGitCredentialEnvHasNoPlaintextSecret(env);
  return env;
}

export function redactGitSecretText(text: string): string {
  return SECRET_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, (match) => {
    if (match.includes('@')) return '***@';
    return '***';
  }), text);
}

export function assertGitCredentialEnvHasNoPlaintextSecret(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (key === 'GH_TOKEN' || key === 'GITHUB_TOKEN') continue;
    const redacted = redactGitSecretText(value);
    if (redacted !== value) throw new Error(`git credential env contains plaintext secret in ${key}`);
  }
}
