import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { persistPublishedIdentity } from './persistPublishedIdentity.js';

function parseEnv(path: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.includes('='))
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
}

function seed(releaseId: string, digest: string, cred: string) {
  const root = mkdtempSync(join(tmpdir(), 'persist-identity-'));
  writeFileSync(join(root, 'active-color'), 'green\n');
  writeFileSync(join(root, 'runtime-worker-active-color'), 'green\n');
  const body = [
    `AGENT_SAAS_RELEASE_ID=${releaseId}`,
    `AGENT_SAAS_CONFIG_IDENTITY_DIGEST=${digest}`,
    'AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION=1',
    `AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST=${cred}`,
    '',
  ].join('\n');
  writeFileSync(join(root, 'server-green.release.env'), body);
  writeFileSync(join(root, 'runtime-worker-green.release.env'), body);
  writeFileSync(join(root, 'config.json'), '{}\n');
  return join(root, 'config.json');
}

const OLD_DIGEST = `sha256:${'a'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'b'.repeat(64)}`;
const OLD_CRED = `sha256:${'c'.repeat(64)}`;
const NEW_CRED = `sha256:${'d'.repeat(64)}`;

describe('persistPublishedIdentity', () => {
  it('updates digest and credential version when a signed save changed the identity', () => {
    const configPath = seed('rc-1', OLD_DIGEST, OLD_CRED);
    persistPublishedIdentity(configPath, 'rc-1', {
      schemaVersion: 1,
      digest: NEW_DIGEST,
      credentialVersionDigest: NEW_CRED,
    });
    for (const name of ['server-green.release.env', 'runtime-worker-green.release.env']) {
      const values = parseEnv(join(dirname(configPath), name));
      expect(values.AGENT_SAAS_RELEASE_ID).toBe('rc-1');
      expect(values.AGENT_SAAS_CONFIG_IDENTITY_DIGEST).toBe(NEW_DIGEST);
      expect(values.AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST).toBe(NEW_CRED);
    }
  });

  it('leaves a different release env untouched', () => {
    const configPath = seed('rc-old', OLD_DIGEST, OLD_CRED);
    persistPublishedIdentity(configPath, 'rc-new', {
      schemaVersion: 1,
      digest: NEW_DIGEST,
      credentialVersionDigest: NEW_CRED,
    });
    const values = parseEnv(join(dirname(configPath), 'server-green.release.env'));
    expect(values.AGENT_SAAS_CONFIG_IDENTITY_DIGEST).toBe(OLD_DIGEST);
    expect(values.AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST).toBe(OLD_CRED);
  });
});
