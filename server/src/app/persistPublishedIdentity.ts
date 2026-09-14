import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  atomicWrite,
  type PublishedIdentity,
} from '../../../scripts/release/config-publication.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

/** Write the signed publication identity into the active-color release env. */
export function persistPublishedIdentity(
  configPath: string,
  releaseId: string,
  identity: PublishedIdentity,
): void {
  if (!DIGEST.test(identity.digest)) throw new Error('published identity digest is malformed');
  if (identity.credentialVersionDigest && !DIGEST.test(identity.credentialVersionDigest)) {
    throw new Error('published credential version digest is malformed');
  }
  const root = dirname(configPath);
  for (const [colorFile, envPrefix] of [
    ['active-color', 'server'],
    ['runtime-worker-active-color', 'runtime-worker'],
  ] as const) {
    let color: string;
    try {
      color = readFileSync(join(root, colorFile), 'utf8').trim();
    } catch {
      return;
    }
    if (color !== 'blue' && color !== 'green') throw new Error('活动配置拓扑无效');
    const envPath = join(root, `${envPrefix}-${color}.release.env`);
    const text = readFileSync(envPath, 'utf8');
    const values = Object.fromEntries(
      text
        .split(/\r?\n/u)
        .filter((line) => line.includes('='))
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    if (values.AGENT_SAAS_RELEASE_ID !== releaseId) continue;
    values.AGENT_SAAS_CONFIG_IDENTITY_DIGEST = identity.digest;
    if (identity.credentialVersionDigest) {
      values.AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST =
        identity.credentialVersionDigest;
    }
    atomicWrite(
      envPath,
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`,
    );
  }
}
