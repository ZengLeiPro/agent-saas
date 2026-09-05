import { parse as parseJsonc } from 'jsonc-parser';

import type { AppConfig } from '../app/config.js';
import { GLOBAL_OWNER_ID, type SecretVault, type VaultCaller } from '../security/secretVault.js';

import {
  capabilityConfigFingerprint,
  capabilityConfigSlice,
  type CapabilityBlocker,
  type CapabilityId,
} from './capabilityContract.js';
import type { CapabilityValidationJournal } from './capabilityValidationJournal.js';
import {
  ConfigConflictError,
  ConfigMutationCommittedError,
  RuntimeRestoreFailedError,
  type AdminConfigMutationService,
} from './adminConfigMutationService.js';
import { canonicalJson, configFingerprint } from './configDigest.js';

/**
 * 能力启用的原子事务骨架（docs/plans/capability-guided-enablement.md §6.3）。
 *
 * 这里只提供所有能力共用的基础设施：Secret 暂存与撤销、expected fingerprint
 * 冲突检测、探测失败即回滚、写入后读回 API/Worker 指纹。能力专属的字段校验和
 * 真实探测由调用方注入，本模块不认识任何业务字段。
 */

export const CAPABILITY_ENABLE_ERROR_CODES = [
  'CAPABILITY_CONFIG_INCOMPLETE',
  'CAPABILITY_SECRET_MISSING',
  'CAPABILITY_PROBE_FAILED',
  'CAPABILITY_RUNTIME_NOT_READY',
  'CAPABILITY_CONFIG_CONFLICT',
  'CAPABILITY_APPROVAL_REQUIRED',
] as const;
export type CapabilityEnableErrorCode = (typeof CAPABILITY_ENABLE_ERROR_CODES)[number];

export interface CapabilityEnableErrorDetails {
  missing?: string[];
  blockers?: CapabilityBlocker[];
  /** 冲突时回传当前 config.json 的原始指纹（乐观锁口径），供前端刷新后重试。 */
  rawConfigFingerprint?: string;
  /** 读回不收敛时列出各来源的指纹，便于定位是哪个进程没跟上。 */
  readback?: CapabilityFingerprintReadback[];
  /** 本次暂存 Secret 未能撤销的条数；不返回 ref 标识本身。 */
  unrevokedSecrets?: number;
}

export class CapabilityEnableError extends Error {
  constructor(
    readonly code: CapabilityEnableErrorCode,
    message: string,
    readonly details: CapabilityEnableErrorDetails = {},
  ) {
    super(message);
    this.name = 'CapabilityEnableError';
  }
}

const HTTP_STATUS: Readonly<Record<CapabilityEnableErrorCode, number>> = {
  CAPABILITY_CONFIG_INCOMPLETE: 422,
  CAPABILITY_SECRET_MISSING: 422,
  CAPABILITY_PROBE_FAILED: 502,
  CAPABILITY_RUNTIME_NOT_READY: 503,
  CAPABILITY_CONFIG_CONFLICT: 409,
  CAPABILITY_APPROVAL_REQUIRED: 403,
};

export function capabilityEnableHttpStatus(code: CapabilityEnableErrorCode): number {
  return HTTP_STATUS[code];
}

/**
 * 本次启用新写入的 Secret。提交前一律视为可撤销：配置没有成功落盘时，这些
 * 记录会被 revoke，避免留下无人引用又仍可解密的凭据。
 */
export class SecretStagingArea {
  private readonly staged: string[] = [];
  private committed = false;

  constructor(
    private readonly vault: SecretVault | undefined,
    private readonly caller: VaultCaller,
    private readonly ownerId: string = GLOBAL_OWNER_ID,
  ) {}

  async stage(
    kind: string,
    value: string,
    metadata: Record<string, unknown> = {},
  ): Promise<string> {
    if (!this.vault) {
      throw new CapabilityEnableError(
        'CAPABILITY_SECRET_MISSING',
        'SecretVault 未配置，不能保存能力凭据',
      );
    }
    const ref = await this.vault.putSecret(this.ownerId, kind, value, this.caller, metadata);
    this.staged.push(ref.id);
    return ref.id;
  }

  get refIds(): readonly string[] {
    return [...this.staged];
  }

  commit(): void {
    this.committed = true;
    this.staged.length = 0;
  }

  /** @returns 撤销失败的条数。撤销失败不能盖住原始错误，但必须被上报。 */
  async rollback(): Promise<number> {
    if (this.committed) return 0;
    const pending = this.staged.splice(0, this.staged.length);
    let failed = 0;
    for (const id of pending) {
      try {
        await this.vault?.revokeSecret(id, this.caller);
      } catch {
        failed++;
      }
    }
    return failed;
  }
}

export interface CapabilityFingerprintReadback {
  /** 'api'、'runtime-worker' 等进程标识。 */
  source: string;
  fingerprint: string | null;
}

export interface CapabilityEnableTransactionOptions {
  capability: CapabilityId;
  actor: string;
  changedPaths: string[];
  expectedFingerprint?: string;
  mutationService: AdminConfigMutationService;
  journal: CapabilityValidationJournal;
  staging: SecretStagingArea;
  /** 当前有效配置；失败时用它给验证台账定位指纹。 */
  getEffectiveConfig: () => AppConfig;
  /** 高风险变更（Production 写入、Retention Execute、全用户 Rollout）必须带审批引用。 */
  approval?: { required: boolean; reference?: string; message?: string };
  /** 写入前把提交上来的 Secret 明文暂存进 Vault，返回可写进配置的 ref。 */
  prepare?: (staging: SecretStagingArea) => void | Promise<void>;
  /** 能力专属候选配置校验；缺字段时抛 CapabilityEnableError。 */
  validateCandidate: () => void | Promise<void>;
  /** 能力专属真实探测；用候选配置与暂存 Secret 打真实上游。 */
  probe: () => void | Promise<void>;
  buildCandidate: (
    currentText: string,
    currentRaw: Record<string, unknown>,
  ) => string | Promise<string>;
  applyRuntime: (next: AppConfig, previous: AppConfig) => void | Promise<void>;
  /** 读回各进程当前生效的配置指纹；不提供时只信任本进程写入结果。 */
  readEffectiveFingerprints?: (next: AppConfig) => Promise<CapabilityFingerprintReadback[]>;
  convergence?: { attempts?: number; delayMs?: number };
}

export interface CapabilityEnableResult {
  capability: CapabilityId;
  appliedAt: string;
  /** 有效配置指纹（解析后的 AppConfig），与 /api/admin/config-status 同口径。 */
  effectiveConfigFingerprint: string;
  /** 写入后的原始 config.json 指纹，下一次回写的 If-Match 令牌。 */
  rawConfigFingerprint: string;
  capabilityConfigFingerprint: string;
  readback: CapabilityFingerprintReadback[];
  /**
   * 验证台账是否成功落盘。false 表示配置已经生效但这次验证记录只存在于内存里，
   * 重启后会丢失（状态页会退回「未验证」），需要运维关注数据目录可写性。
   */
  journalPersisted: boolean;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_DELAY_MS = 200;

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 候选配置必须真的引用上本次暂存的每一个 Secret。
 *
 * 少了这道检查，向导可以一边把明文写进 Vault、一边把另一个 ref 写进配置：
 * Vault 里留下没人引用的孤儿凭据，配置里却指向不存在或过期的 ref。
 */
function assertStagedSecretsReferenced(
  capability: CapabilityId,
  stagedRefIds: readonly string[],
  candidateText: string,
): void {
  if (stagedRefIds.length === 0) return;
  const parsed = parseJsonc(candidateText);
  const slice = parsed && typeof parsed === 'object' ? capabilityConfigSlice(parsed as AppConfig, capability) : undefined;
  const serialized = canonicalJson(slice ?? null);
  const orphans = stagedRefIds.filter((id) => !serialized.includes(JSON.stringify(id)));
  if (orphans.length === 0) return;
  throw new CapabilityEnableError(
    'CAPABILITY_CONFIG_INCOMPLETE',
    `候选配置没有引用本次写入的 ${orphans.length} 个 Secret，拒绝提交以免产生孤儿凭据`,
  );
}

function toCapabilityEnableError(error: unknown): CapabilityEnableError {
  if (error instanceof CapabilityEnableError) return error;
  if (error instanceof RuntimeRestoreFailedError) {
    return new CapabilityEnableError('CAPABILITY_RUNTIME_NOT_READY', error.message);
  }
  if (error instanceof ConfigConflictError) {
    return new CapabilityEnableError('CAPABILITY_CONFIG_CONFLICT', error.message, {
      rawConfigFingerprint: error.currentFingerprint,
    });
  }
  return new CapabilityEnableError(
    'CAPABILITY_RUNTIME_NOT_READY',
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * 写入后等待各进程读回同一份指纹。跑在 applyRuntime 内部：不收敛时抛错，
 * AdminConfigMutationService 会把 config.json 与进程内配置一起恢复到写入前。
 */
async function assertReadbackConverged(
  options: CapabilityEnableTransactionOptions,
  next: AppConfig,
): Promise<CapabilityFingerprintReadback[]> {
  const expected = configFingerprint(next);
  const attempts = Math.max(1, options.convergence?.attempts ?? DEFAULT_ATTEMPTS);
  const waitMs = Math.max(0, options.convergence?.delayMs ?? DEFAULT_DELAY_MS);
  let reports: CapabilityFingerprintReadback[] = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    reports = (await options.readEffectiveFingerprints?.(next)) ?? [];
    if (reports.every((report) => report.fingerprint === expected)) return reports;
    if (attempt < attempts - 1) await delay(waitMs);
  }
  throw new CapabilityEnableError(
    'CAPABILITY_RUNTIME_NOT_READY',
    '配置已写入但各进程读回指纹未收敛，已恢复到变更前配置',
    { readback: reports },
  );
}

export async function runCapabilityEnableTransaction(
  options: CapabilityEnableTransactionOptions,
): Promise<CapabilityEnableResult> {
  const { capability, journal, staging } = options;
  const finishValidating = journal.beginValidation(capability);
  let readback: CapabilityFingerprintReadback[] = [];
  let runtimeApplied = false;
  try {
    if (options.approval?.required && !options.approval.reference?.trim()) {
      throw new CapabilityEnableError(
        'CAPABILITY_APPROVAL_REQUIRED',
        options.approval.message ?? '当前环境的该项变更需要提供审批引用',
      );
    }
    await options.prepare?.(staging);
    await options.validateCandidate();
    await options.probe();

    const result = await options.mutationService.mutate({
      actor: options.actor,
      changedPaths: options.changedPaths,
      ...(options.expectedFingerprint ? { expectedFingerprint: options.expectedFingerprint } : {}),
      buildCandidate: async (currentText, currentRaw) => {
        const candidateText = await options.buildCandidate(currentText, currentRaw);
        assertStagedSecretsReferenced(capability, staging.refIds, candidateText);
        return candidateText;
      },
      applyRuntime: async (next, previous) => {
        // mutate 在回滚时会再调一次 applyRuntime 把运行时恢复回旧配置。收敛断言只
        // 属于正向那一次；在回滚调用里重跑只会把「读回不收敛」误报成「回滚失败」。
        const forward = !runtimeApplied;
        runtimeApplied = true;
        await options.applyRuntime(next, previous);
        if (forward) readback = await assertReadbackConverged(options, next);
      },
    });

    staging.commit();
    const fingerprint = capabilityConfigFingerprint(result.config, capability);
    // 配置已经生效，台账落盘失败不该反过来把这次启用判成失败，但必须说出来。
    let journalPersisted = true;
    try {
      await journal.recordResult(capability, 'passed', fingerprint);
    } catch (cause) {
      journalPersisted = false;
      console.error(
        `[capability-enable] ${capability}: 验证台账落盘失败，重启后本次验证记录会丢失：${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    return {
      capability,
      appliedAt: result.appliedAt,
      effectiveConfigFingerprint: configFingerprint(result.config),
      rawConfigFingerprint: result.rawConfigFingerprint,
      capabilityConfigFingerprint: fingerprint,
      readback,
      journalPersisted,
    };
  } catch (error) {
    // durable/runtime 已提交但 publication/prune 失败，或运行时恢复失败时，配置仍可能
    // 引用候选 Secret；此时撤销只会让已生效/仍在运行的实例失去凭据，必须保留。
    const mutationCommitted = error instanceof ConfigMutationCommittedError;
    const runtimeRestoreFailed = error instanceof RuntimeRestoreFailedError;
    const retainStagedSecrets = mutationCommitted || runtimeRestoreFailed;
    if (retainStagedSecrets) {
      console.error(
        mutationCommitted
          ? `[capability-enable] ${capability}: 配置已提交但后续发布或维护失败，已保留本次暂存 Secret（${staging.refIds.length} 个）避免生效配置失去凭据，需人工核对发布状态`
          : `[capability-enable] ${capability}: 运行时回滚失败，已保留本次暂存 Secret（${staging.refIds.length} 个）避免运行实例立即失效，需人工核对进程内配置`,
      );
    }
    const unrevoked = retainStagedSecrets ? 0 : await staging.rollback();
    if (unrevoked > 0) {
      console.error(
        `[capability-enable] ${capability}: ${unrevoked} 个暂存 Secret 撤销失败，需人工在 SecretVault 中吊销`,
      );
    }
    // 失败时有效配置未变，所以把结果记在当前生效的切片上：已启用的能力会因此
    // 显示为 degraded，未启用的能力仍是 disabled/incomplete，不会凭空多出噪音。
    try {
      await journal.recordResult(
        capability,
        'failed',
        capabilityConfigFingerprint(options.getEffectiveConfig(), capability),
      );
    } catch (cause) {
      console.error(
        `[capability-enable] ${capability}: 失败记录未能落盘：${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
    const failure = toCapabilityEnableError(error);
    if (unrevoked > 0) failure.details.unrevokedSecrets = unrevoked;
    if (retainStagedSecrets) failure.details.unrevokedSecrets = staging.refIds.length;
    throw failure;
  } finally {
    finishValidating();
  }
}
