import {
  CONFIG_IDENTITY_SCHEMA_VERSION,
  readExpectedConfigIdentity,
  type ExpectedConfigIdentity,
} from './configIdentity.js';

export type RuntimeEnvironment = 'staging' | 'production' | 'development' | 'test';

export interface RuntimeIdentity {
  environment: RuntimeEnvironment;
  releaseId?: string;
  releaseSha?: string;
  serverDigest?: string;
  webDigest?: string;
  acsOrchestratorDigest?: string;
  acsSandboxImageDigest?: string;
  safetyAttested: boolean;
  /**
   * Release expected config identity（TASK-318，显式版本化新增字段；旧字段语义不变）。
   * 部署脚本在发布时计算并写入 `.release.env`；staging 必须提供，production
   * 提供时必须格式合法（缺失显示为「不可验证」而不是拒启，兼容紧急回滚路径）。
   */
  expectedConfigIdentity?: ExpectedConfigIdentity;
}

const FULL_SHA = /^[a-fA-F0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
function optionalTrimmed(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value || undefined;
}

export function readRuntimeIdentity(env: NodeJS.ProcessEnv = process.env): RuntimeIdentity {
  const rawEnvironment = optionalTrimmed(env, 'AGENT_SAAS_ENVIRONMENT');
  if (!rawEnvironment) {
    if (env.NODE_ENV === 'test') return { environment: 'test', safetyAttested: true };
    if (env.NODE_ENV === 'development' && env.AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT === '1')
      return { environment: 'development', safetyAttested: true };
    throw new Error(
      'AGENT_SAAS_ENVIRONMENT must explicitly be staging or production; development requires AGENT_SAAS_ALLOW_UNIDENTIFIED_ENVIRONMENT=1',
    );
  }
  if (rawEnvironment !== 'staging' && rawEnvironment !== 'production')
    throw new Error('AGENT_SAAS_ENVIRONMENT must be staging or production');

  const releaseId = optionalTrimmed(env, 'AGENT_SAAS_RELEASE_ID');
  const releaseSha = optionalTrimmed(env, 'AGENT_SAAS_RELEASE_SHA');
  const serverDigest = optionalTrimmed(env, 'AGENT_SAAS_SERVER_DIGEST');
  const webDigest = optionalTrimmed(env, 'AGENT_SAAS_WEB_DIGEST');
  const acsOrchestratorDigest = optionalTrimmed(env, 'AGENT_SAAS_ACS_ORCHESTRATOR_DIGEST');
  const acsSandboxImageDigest = optionalTrimmed(env, 'AGENT_SAAS_ACS_SANDBOX_IMAGE_DIGEST');
  // 抛错语义：提供但格式非法 -> fail closed（两边一致）；完全缺失 -> undefined。
  const expectedConfigIdentity = readExpectedConfigIdentity(env);
  if (rawEnvironment === 'staging') {
    if (
      !releaseId ||
      !releaseSha ||
      !serverDigest ||
      !webDigest ||
      !acsOrchestratorDigest ||
      !acsSandboxImageDigest
    ) {
      throw new Error(
        'Staging requires release ID, full SHA, Server/Web digests, and both ACS Orchestrator/Sandbox digests',
      );
    }
    if (!expectedConfigIdentity) {
      throw new Error(
        'Staging requires a release-bound config identity (AGENT_SAAS_CONFIG_IDENTITY_DIGEST)',
      );
    }
    if (expectedConfigIdentity.schemaVersion !== CONFIG_IDENTITY_SCHEMA_VERSION) {
      throw new Error(
        `Staging requires config identity schema version ${CONFIG_IDENTITY_SCHEMA_VERSION}`,
      );
    }
    if (!FULL_SHA.test(releaseSha))
      throw new Error('AGENT_SAAS_RELEASE_SHA must be a complete 40-character SHA');
    for (const [name, digest] of Object.entries({
      AGENT_SAAS_SERVER_DIGEST: serverDigest,
      AGENT_SAAS_WEB_DIGEST: webDigest,
      AGENT_SAAS_ACS_ORCHESTRATOR_DIGEST: acsOrchestratorDigest,
      AGENT_SAAS_ACS_SANDBOX_IMAGE_DIGEST: acsSandboxImageDigest,
    })) {
      if (digest && !DIGEST.test(digest)) throw new Error(`${name} must be a sha256 digest`);
    }
  }
  return {
    environment: rawEnvironment,
    ...(releaseId ? { releaseId } : {}),
    ...(releaseSha ? { releaseSha } : {}),
    ...(serverDigest ? { serverDigest } : {}),
    ...(webDigest ? { webDigest } : {}),
    ...(acsOrchestratorDigest ? { acsOrchestratorDigest } : {}),
    ...(acsSandboxImageDigest ? { acsSandboxImageDigest } : {}),
    ...(expectedConfigIdentity ? { expectedConfigIdentity } : {}),
    safetyAttested: true,
  };
}
