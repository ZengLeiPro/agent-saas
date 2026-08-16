const TASKBOARD_WRITABLE_GIT_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_ASKPASS',
  'GIT_TERMINAL_PROMPT',
  'GH_CONFIG_DIR',
  'SSH_AUTH_SOCK',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GCM_CREDENTIAL_STORE',
] as const;

export function stripTaskboardWritableGitCredentials(
  sessionId: string,
  env: Record<string, string>,
): void {
  if (!sessionId.startsWith('taskboard-review-') && !sessionId.startsWith('taskboard-merge-')) return;
  for (const key of TASKBOARD_WRITABLE_GIT_ENV_KEYS) delete env[key];
  env.GIT_CONFIG_COUNT = '2';
  env.GIT_CONFIG_KEY_0 = 'credential.helper';
  env.GIT_CONFIG_VALUE_0 = '';
  env.GIT_CONFIG_KEY_1 = 'remote.origin.pushurl';
  env.GIT_CONFIG_VALUE_1 = 'disabled://taskboard-provider-only';
}
