import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { pickHandEnv } from '../runtime/handEnvAllowlist.js';
import {
  assertGitCredentialEnvHasNoPlaintextSecret,
  buildIsolatedGitCredentialEnv,
  redactGitSecretText,
} from '../security/gitCredentialIsolation.js';

describe('gitCredentialIsolation', () => {
  it('builds git helper env that reads connector token from runtime env', () => {
    const env = buildIsolatedGitCredentialEnv({
      tokenCommand: `printf '%s' "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}"`,
      credentialAvailable: true,
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

  it('only resets inherited helpers when no connector credential is available', () => {
    const env = buildIsolatedGitCredentialEnv({
      tokenCommand: 'unused',
      credentialAvailable: false,
      allowGhCli: true,
      ghConfigDir: '/tmp/gh-user',
    });

    expect(env).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
    });
  });

  it('survives hand env filtering and serves credentials to a real git process', () => {
    const source = {
      GH_TOKEN: 'ghp_integration_test',
      ...buildIsolatedGitCredentialEnv({
        tokenCommand: `printf '%s' "\${GH_TOKEN:-\${GITHUB_TOKEN:-}}"`,
        credentialAvailable: true,
        allowGhCli: false,
        ghConfigDir: '/tmp/unused',
      }),
    };
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_CONFIG_')),
    );
    const result = spawnSync('git', ['credential', 'fill'], {
      env: { ...env, ...pickHandEnv(source) },
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('username=x-access-token');
    expect(result.stdout).toContain('password=ghp_integration_test');
  });

  it('redacts and rejects known token patterns', () => {
    expect(redactGitSecretText('https://x-access-token:ghp_secret@github.com/a/b.git')).toBe('https://***@github.com/a/b.git');
    expect(() => assertGitCredentialEnvHasNoPlaintextSecret({ GH_TOKEN: 'ghp_secret' })).not.toThrow();
    expect(() => assertGitCredentialEnvHasNoPlaintextSecret({ GIT_CONFIG_VALUE_1: 'password=ghp_secret' })).toThrow(/plaintext secret/);
  });
});
