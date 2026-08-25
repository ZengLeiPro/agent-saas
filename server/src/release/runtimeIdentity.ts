export type RuntimeEnvironment = 'staging' | 'production' | 'unknown';

export interface RuntimeIdentity {
  environment: RuntimeEnvironment;
  releaseId?: string;
  releaseSha?: string;
  serverDigest?: string;
  webDigest?: string;
  acsDigest?: string;
  safetyAttested: boolean;
}

const FULL_SHA = /^[a-fA-F0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function optionalTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

export function readRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): RuntimeIdentity {
  const rawEnvironment = optionalTrimmed(env, 'AGENT_SAAS_ENVIRONMENT');
  const environment: RuntimeEnvironment = rawEnvironment === 'staging' || rawEnvironment === 'production'
    ? rawEnvironment
    : 'unknown';
  const releaseId = optionalTrimmed(env, 'AGENT_SAAS_RELEASE_ID');
  const releaseSha = optionalTrimmed(env, 'AGENT_SAAS_RELEASE_SHA');
  const serverDigest = optionalTrimmed(env, 'AGENT_SAAS_SERVER_DIGEST');
  const webDigest = optionalTrimmed(env, 'AGENT_SAAS_WEB_DIGEST');
  const acsDigest = optionalTrimmed(env, 'AGENT_SAAS_ACS_DIGEST');

  if (environment === 'staging') {
    if (!releaseId || !releaseSha || !serverDigest || !webDigest) {
      throw new Error('Staging requires AGENT_SAAS_RELEASE_ID, AGENT_SAAS_RELEASE_SHA, AGENT_SAAS_SERVER_DIGEST and AGENT_SAAS_WEB_DIGEST');
    }
    if (!FULL_SHA.test(releaseSha)) throw new Error('AGENT_SAAS_RELEASE_SHA must be a complete 40-character SHA');
    for (const [name, digest] of Object.entries({ AGENT_SAAS_SERVER_DIGEST: serverDigest, AGENT_SAAS_WEB_DIGEST: webDigest, AGENT_SAAS_ACS_DIGEST: acsDigest })) {
      if (digest && !DIGEST.test(digest)) throw new Error(`${name} must be a sha256 digest`);
    }
  }

  return { environment, ...(releaseId ? { releaseId } : {}), ...(releaseSha ? { releaseSha } : {}), ...(serverDigest ? { serverDigest } : {}), ...(webDigest ? { webDigest } : {}), ...(acsDigest ? { acsDigest } : {}), safetyAttested: environment !== 'staging' };
}
