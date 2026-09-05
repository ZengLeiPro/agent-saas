/**
 * Release identity 预检：只比对 release 目录自带的 `runtime-dependencies.json`
 * 与 release env（`AGENT_SAAS_RELEASE_SHA` 等）之间的一致性，不重算安装内容摘要
 * （那由 verify-installed-release 在发布链路保证）。`AGENT_SAAS_SERVER_DIGEST`
 * 与 `AGENT_SAAS_RELEASE_ID` 只记录进回执。
 */
import type { RuntimeIdentity } from '../runtimeIdentity.js';

export interface ReleaseIdentityInput {
  runtimeIdentity: RuntimeIdentity;
  /** `<release>/server/runtime-dependencies.json` 的原始 JSON 文本；缺失传 undefined。 */
  runtimeDependenciesJson: string | undefined;
  manifestDependencyContractDigest: string;
}

export type ReleaseIdentityStatus = 'bound' | 'not_bound' | 'mismatch';

export interface ReleaseIdentityCheck {
  status: ReleaseIdentityStatus;
  reason?:
    | 'runtime_dependencies_missing'
    | 'runtime_dependencies_invalid'
    | 'release_sha_not_bound'
    | 'release_sha_mismatch'
    | 'contract_digest_mismatch';
  releaseId?: string;
  releaseSha?: string;
  serverDigest?: string;
  dependencyContractDigest?: string;
  dependencyDigest?: string;
}

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RELEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

interface RuntimeDependenciesIdentity {
  sourceSha: string;
  contractDigest: string;
  dependencyDigest: string;
}

function parseRuntimeDependencies(text: string): RuntimeDependenciesIdentity | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== 'agent-saas-runtime-dependency-identity' ||
    typeof record.sourceSha !== 'string' ||
    !SHA_PATTERN.test(record.sourceSha) ||
    typeof record.contractDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.contractDigest) ||
    typeof record.dependencyDigest !== 'string' ||
    !DIGEST_PATTERN.test(record.dependencyDigest)
  ) {
    return undefined;
  }
  return {
    sourceSha: record.sourceSha,
    contractDigest: record.contractDigest,
    dependencyDigest: record.dependencyDigest,
  };
}

export function checkReleaseIdentity(input: ReleaseIdentityInput): ReleaseIdentityCheck {
  const { runtimeIdentity } = input;
  // 回执只复制形态合法的身份值；不合法的 env 原文不落盘（其内容可能是任何东西）。
  const recorded = {
    ...(runtimeIdentity.releaseId && RELEASE_ID_PATTERN.test(runtimeIdentity.releaseId)
      ? { releaseId: runtimeIdentity.releaseId }
      : {}),
    ...(runtimeIdentity.releaseSha && SHA_PATTERN.test(runtimeIdentity.releaseSha.toLowerCase())
      ? { releaseSha: runtimeIdentity.releaseSha.toLowerCase() }
      : {}),
    ...(runtimeIdentity.serverDigest && DIGEST_PATTERN.test(runtimeIdentity.serverDigest)
      ? { serverDigest: runtimeIdentity.serverDigest }
      : {}),
  };
  if (input.runtimeDependenciesJson === undefined) {
    return { status: 'mismatch', reason: 'runtime_dependencies_missing', ...recorded };
  }
  const identity = parseRuntimeDependencies(input.runtimeDependenciesJson);
  if (!identity) {
    return { status: 'mismatch', reason: 'runtime_dependencies_invalid', ...recorded };
  }
  const withIdentity = {
    ...recorded,
    dependencyContractDigest: identity.contractDigest,
    dependencyDigest: identity.dependencyDigest,
  };
  if (identity.contractDigest !== input.manifestDependencyContractDigest) {
    return { status: 'mismatch', reason: 'contract_digest_mismatch', ...withIdentity };
  }
  if (!runtimeIdentity.releaseSha) {
    return { status: 'not_bound', reason: 'release_sha_not_bound', ...withIdentity };
  }
  if (runtimeIdentity.releaseSha.toLowerCase() !== identity.sourceSha) {
    return { status: 'mismatch', reason: 'release_sha_mismatch', ...withIdentity };
  }
  return { status: 'bound', ...withIdentity };
}

/** production/staging 必须 bound；development/test 允许 not_bound，但 mismatch 一律拒绝。 */
export function releaseIdentityAllowed(
  environment: RuntimeIdentity['environment'],
  check: ReleaseIdentityCheck,
): boolean {
  if (check.status === 'bound') return true;
  if (check.status === 'mismatch') return false;
  return environment === 'development' || environment === 'test';
}
