import { describe, expect, it } from 'vitest';

import {
  assertGitCredentialEnvHasNoPlaintextSecret,
  buildIsolatedGitCredentialEnv,
  redactGitSecretText,
} from '../security/gitCredentialIsolation.js';

describe('gitCredentialIsolation', () => {
  it('builds git helper env that reads connector token from runtime env', () => {
    const env = buildIsolatedGitCredentialEnv({
      tokenCommand: `printf '%s' "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}"`,
      allowGhCli: true,
      ghConfigDir: '/tmp/gh-user',
    });

    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env.GIT_CONFIG_VALUE_1).toContain('GH_TOKEN');
    expect(env.GIT_CONFIG_VALUE_1).toContain('GITHUB_TOKEN');
    expect(env.GIT_CONFIG_VALUE_1).not.toMatch(/gh[pousr]_/);
    expect(env.GH_CONFIG_DIR).toBe('/tmp/gh-user');
  });

  it('redacts and rejects known token patterns', () => {
    expect(redactGitSecretText('https://x-access-token:ghp_secret@github.com/a/b.git')).toBe('https://***@github.com/a/b.git');
    expect(() => assertGitCredentialEnvHasNoPlaintextSecret({ GH_TOKEN: 'ghp_secret' })).not.toThrow();
    expect(() => assertGitCredentialEnvHasNoPlaintextSecret({ GIT_CONFIG_VALUE_1: 'password=ghp_secret' })).toThrow(/plaintext secret/);
  });
});
