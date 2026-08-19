import { describe, expect, it } from 'vitest';

import {
  isCredentialIsolatedTaskboardRuntime,
  stripTaskboardWritableGitCredentials,
} from './runtimeCredentialPolicy.js';

const writableGitEnv = {
  GH_TOKEN: 'gh',
  GITHUB_TOKEN: 'github',
  GH_ENTERPRISE_TOKEN: 'enterprise',
  GIT_ASKPASS: '/askpass',
  GIT_TERMINAL_PROMPT: '1',
  GH_CONFIG_DIR: '/gh',
  SSH_AUTH_SOCK: '/ssh-agent',
  SSH_AGENT_PID: '42',
  SSH_ASKPASS: '/ssh-askpass',
  GIT_SSH: '/custom-ssh',
  GIT_SSH_COMMAND: 'ssh -i /secret',
  GCM_CREDENTIAL_STORE: 'secretservice',
  GIT_CONFIG_COUNT: '8',
  GIT_CONFIG_KEY_7: 'credential.helper',
  GIT_CONFIG_VALUE_7: '!leak-token',
  SAFE_VALUE: 'kept',
};

const isolatedEnv = {
  SAFE_VALUE: 'kept',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
  GIT_CONFIG_KEY_1: 'remote.origin.pushurl',
  GIT_CONFIG_VALUE_1: 'disabled://taskboard-provider-only',
};

describe('taskboard runtime credential policy', () => {
  it.each(['taskboard-review-task-1', 'taskboard-merge-task-1'])(
    'removes writable Git credentials from %s sessions',
    (sessionId) => {
      const env = { ...writableGitEnv };
      stripTaskboardWritableGitCredentials(sessionId, env);
      expect(env).toEqual(isolatedEnv);
    },
  );

  it('uses compatible metadata to isolate integration work with a legacy session name', () => {
    const metadata = {
      taskboardExecution: true,
      taskboardIntegration: true,
      taskboardIntegrationRole: 'work',
    } as const;
    expect(isCredentialIsolatedTaskboardRuntime('taskboard-task-1', metadata)).toBe(true);
    const env = { ...writableGitEnv };
    stripTaskboardWritableGitCredentials('taskboard-task-1', env, metadata);
    expect(env).toEqual(isolatedEnv);
  });

  it('accepts workflow-v3 purpose metadata without requiring shared type changes', () => {
    expect(isCredentialIsolatedTaskboardRuntime('taskboard-task-1', {
      taskboardExecution: true,
      taskboardWorkflowVersion: 'v3',
      taskboardPurpose: 'review',
    })).toBe(true);
  });

  it('does not let untrusted metadata isolate a non-taskboard runtime', () => {
    expect(isCredentialIsolatedTaskboardRuntime('chat-1', {
      taskboardIntegration: true,
      taskboardIntegrationRole: 'work',
    })).toBe(false);
  });

  it('keeps ordinary implementation work credentials available', () => {
    const env = { ...writableGitEnv };
    stripTaskboardWritableGitCredentials('taskboard-task-1', env, {
      taskboardExecution: true,
      taskboardPurpose: 'work',
    });
    expect(env).toEqual(writableGitEnv);
  });
});
