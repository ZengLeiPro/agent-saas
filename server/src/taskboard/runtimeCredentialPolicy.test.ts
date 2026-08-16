import { describe, expect, it } from 'vitest';

import { stripTaskboardWritableGitCredentials } from './runtimeCredentialPolicy.js';

const writableGitEnv = {
  GH_TOKEN: 'gh',
  GITHUB_TOKEN: 'github',
  GIT_ASKPASS: '/askpass',
  GIT_TERMINAL_PROMPT: '0',
  GH_CONFIG_DIR: '/gh',
  SSH_AUTH_SOCK: '/ssh-agent',
  GIT_SSH: '/custom-ssh',
  GIT_SSH_COMMAND: 'ssh -i /secret',
  GCM_CREDENTIAL_STORE: 'secretservice',
  SAFE_VALUE: 'kept',
};

describe('taskboard runtime credential policy', () => {
  it.each(['taskboard-review-task-1', 'taskboard-merge-task-1'])(
    'removes writable Git credentials from %s sessions',
    (sessionId) => {
      const env = { ...writableGitEnv };
      stripTaskboardWritableGitCredentials(sessionId, env);
      expect(env).toEqual({
        SAFE_VALUE: 'kept',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'remote.origin.pushurl',
        GIT_CONFIG_VALUE_1: 'disabled://taskboard-provider-only',
      });
    },
  );

  it('keeps work session credentials available for implementation', () => {
    const env = { ...writableGitEnv };
    stripTaskboardWritableGitCredentials('taskboard-task-1', env);
    expect(env).toEqual(writableGitEnv);
  });
});
