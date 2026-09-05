/**
 * launcher 侧 Config Identity 四态判定与 fail-closed 矩阵（TASK-318 契约消费方）。
 *
 * expected 来自 release env（readRuntimeIdentity 已解析）；observed 由同一 release 的
 * `dist/config-identity-cli.js` 子进程计算。四态判定直接复用运行期的
 * `evaluateConfigIdentityStatus`——launcher 不复制 projection/digest/判定算法，只额外
 * 表达“观察本身失败”（CLI 非零退出、输出不可解析）这一种 launcher 才知道的状态。
 */
import type { ConfigIdentityStatus } from '@agent/shared/schemas/configIdentity';

import {
  evaluateConfigIdentityStatus,
  type ConfigIdentityEvaluation,
  type ExpectedConfigIdentity,
} from '../configIdentity.js';
import type { RuntimeEnvironment } from '../runtimeIdentity.js';
import type { ExecutionMode } from './intent.js';

export type ConfigIdentityCheckReason =
  NonNullable<ConfigIdentityEvaluation['reason']> | 'observation_failed';

export interface ObservedConfigIdentity {
  schemaVersion: number;
  digest: string;
  credentialVersionDigest?: string;
  secretRefCount: number;
  versionResolution: 'resolved' | 'partial' | 'unavailable';
}

export interface ConfigIdentityCheck {
  status: Exclude<ConfigIdentityStatus, 'not_collected'>;
  reason?: ConfigIdentityCheckReason;
  expectedDigest?: string;
  observedDigest?: string;
  schemaVersion?: number;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export function parseObservedConfigIdentity(stdout: string): ObservedConfigIdentity {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim());
  } catch {
    throw new Error('config-identity-cli output is not JSON');
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('config-identity-cli output must be an object');
  }
  const record = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(record.schemaVersion) || (record.schemaVersion as number) <= 0) {
    throw new Error('config-identity-cli schemaVersion invalid');
  }
  if (typeof record.digest !== 'string' || !DIGEST_PATTERN.test(record.digest)) {
    throw new Error('config-identity-cli digest invalid');
  }
  // CLI 在版本不可解析时输出 null；与缺失同义。
  const credential = record.credentialVersionDigest;
  if (
    credential !== undefined &&
    credential !== null &&
    (typeof credential !== 'string' || !DIGEST_PATTERN.test(credential))
  ) {
    throw new Error('config-identity-cli credentialVersionDigest invalid');
  }
  if (!Number.isSafeInteger(record.secretRefCount) || (record.secretRefCount as number) < 0) {
    throw new Error('config-identity-cli secretRefCount invalid');
  }
  if (
    record.versionResolution !== 'resolved' &&
    record.versionResolution !== 'partial' &&
    record.versionResolution !== 'unavailable'
  ) {
    throw new Error('config-identity-cli versionResolution invalid');
  }
  return {
    schemaVersion: record.schemaVersion as number,
    digest: record.digest,
    ...(typeof credential === 'string' ? { credentialVersionDigest: credential } : {}),
    secretRefCount: record.secretRefCount as number,
    versionResolution: record.versionResolution,
  };
}

export function evaluateConfigIdentity(input: {
  expected: ExpectedConfigIdentity | undefined;
  observed: ObservedConfigIdentity | { error: string };
}): ConfigIdentityCheck {
  const { expected, observed } = input;
  const expectedPart = expected
    ? { expectedDigest: expected.digest, schemaVersion: expected.schemaVersion }
    : {};
  if ('error' in observed) {
    return { status: 'unverifiable', reason: 'observation_failed', ...expectedPart };
  }
  const evaluation = evaluateConfigIdentityStatus(expected, {
    ...observed,
    credentialVersionDigest: observed.credentialVersionDigest ?? null,
  });
  if (evaluation.status === 'not_collected') {
    // 有 observed 时运行期判定不会返回 not_collected；防御性地按观察失败处理。
    return { status: 'unverifiable', reason: 'observation_failed', ...expectedPart };
  }
  return {
    status: evaluation.status,
    ...(evaluation.reason ? { reason: evaluation.reason } : {}),
    ...expectedPart,
    observedDigest: observed.digest,
    schemaVersion: observed.schemaVersion,
  };
}

export interface ConfigIdentityGateDecision {
  allowed: boolean;
  /** 放行但需要在回执中显式标注（development/test 的非 consistent 态、production 只读 expected_not_bound）。 */
  annotated: boolean;
}

/**
 * fail-closed 矩阵（见 docs/admin-runner.md §6）：
 * - production 写：只有 consistent 放行；
 * - production 只读/dry-run：consistent 放行；expected_not_bound 放行+标注；其余拒绝；
 * - staging：只有 consistent 放行（staging 必须绑定 identity，与 readRuntimeIdentity 一致）；
 * - development/test：全部放行，非 consistent 标注。
 */
export function decideConfigIdentityGate(
  environment: RuntimeEnvironment,
  mode: ExecutionMode,
  check: ConfigIdentityCheck,
): ConfigIdentityGateDecision {
  if (check.status === 'consistent') return { allowed: true, annotated: false };
  if (environment === 'development' || environment === 'test') {
    return { allowed: true, annotated: true };
  }
  if (environment === 'production' && mode !== 'write' && check.reason === 'expected_not_bound') {
    return { allowed: true, annotated: true };
  }
  return { allowed: false, annotated: false };
}
