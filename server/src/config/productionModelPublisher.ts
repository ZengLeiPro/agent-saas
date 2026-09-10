import { readFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse as parseJsonc } from 'jsonc-parser';
import type { ConfigWritePolicy } from '@agent/shared/configWritePolicy';
import {
  assertPublishedDisk,
  atomicWrite,
  canonical,
  isOwnerAlive,
  processIdentity,
  rawRevision,
  readPublication,
  readSnapshot,
  saveSnapshot,
  signingAvailable,
  writePublication,
  type ConfigPublication,
  type ProcessIdentity,
  type PublishedIdentity,
} from '../../../scripts/release/config-publication.mjs';
import { parseAppConfig, type AppConfig } from '../app/config.js';
import { assertAuxiliaryModelRefsResolvable } from '../app/modelsHotUpdate.js';
import {
  assertProductionManagedCredentialSafety,
  computeObservedConfigIdentity,
  type ExpectedConfigIdentity,
} from '../release/configIdentity.js';
import type { SecretVault } from '../security/secretVault.js';
import {
  acquireFileGuard,
  ConfigConflictError,
  ConfigMutationCommittedError,
  RuntimeRestoreFailedError,
  ProductionConfirmationError,
  configFingerprint,
  type AdminConfigMutationResult,
  type MutationInput,
} from './adminConfigMutationService.js';
import {
  adminConfigOperationAuditPath,
  assertAdminConfigOperationScope,
} from './adminConfigOperationRegistry.js';
import {
  AdminConfigOperationJournal,
  AdminConfigOperationPendingError,
  type AdminConfigOperationRecord,
} from './adminConfigOperationJournal.js';

export interface PublicationTarget {
  role: 'ws-only' | 'runtime-worker';
  process: ProcessIdentity;
  receiptPath: string;
}
export interface PublicationReceipt {
  schemaVersion: 1;
  releaseId: string;
  role: PublicationTarget['role'];
  process: ProcessIdentity;
  revision: string;
  sequence: number;
  phase: ConfigPublication['phase'];
  rawRevision: string;
  identity: PublishedIdentity;
  recordedAt: number;
}
export interface ProductionPublisher {
  getWritePolicy(): ConfigWritePolicy;
  /** Caller owns the existing deployment/config OS fence for the ENTIRE call. */
  mutate(input: MutationInput): Promise<AdminConfigMutationResult>;
  recover(): Promise<void>;
  /** 仅供受信运行时在既有受管 Codex ref 正常 rotate 后推进签名身份。 */
  coordinateCredentialRotation?(credentialRef: string): Promise<void>;
  getOperationStatus?(operationId: string, actor: string): {
    operationId: string;
    operation: string;
    state: string;
    updatedAt: string;
    revision?: string;
    publicationRevision?: string;
  } | undefined;
}

const LEGACY_MODEL_PATHS = new Set([
  'models', 'memory.index', 'titleGenerator', 'guardrail', 'systemPrompts.utility.title',
]);

function asIdentity(value: {
  schemaVersion: number;
  digest: string;
  credentialVersionDigest?: string | null;
}): PublishedIdentity {
  if (value.schemaVersion !== 1) throw new Error('不支持的配置身份版本');
  return {
    schemaVersion: 1,
    digest: value.digest,
    ...(value.credentialVersionDigest
      ? { credentialVersionDigest: value.credentialVersionDigest }
      : {}),
  };
}

/** No network paths, environment selectors or signing options are accepted from HTTP. */
export class ProductionModelPublisher implements ProductionPublisher {
  private operationJournal?: AdminConfigOperationJournal;
  constructor(
    private readonly options: {
      configPath: string;
      processCwd: string;
      releaseId: string;
      expected: ExpectedConfigIdentity;
      secretVault: SecretVault;
      targets: () => PublicationTarget[];
      observeLocal: () => Promise<void>;
      promotionLockPath?: string;
      timeoutMs?: number;
      pollMs?: number;
      now?: () => number;
    },
  ) {}

  getWritePolicy(): ConfigWritePolicy {
    // Signing availability is a server-side capability, never a user-supplied flag.
    try {
      const state = assertPublishedDisk(this.options.configPath);
      const targets = this.options.targets();
      if (
        state?.phase === 'committed' &&
        signingAvailable(this.options.configPath) &&
        targets.length === 2 &&
        targets.some((target) => target.role === 'ws-only' && target.process.pid === process.pid)
      ) {
        return { environment: 'production', mode: 'online', canSave: true };
      }
    } catch {
      /* A missing, unsigned, stale or pending baseline is never writable. */
    }
    return {
      environment: 'production',
      mode: 'controlled-publish-required',
      canSave: false,
      reasonCode: 'PRODUCTION_CONFIG_PUBLISH_REQUIRED',
      message: '生产配置发布暂不可用：请检查配置事务恢复状态、签名基线及 API / Worker 运行状态',
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private journal(): AdminConfigOperationJournal {
    return this.operationJournal ??= new AdminConfigOperationJournal(this.options.configPath);
  }
  getOperationStatus(operationId: string, actor: string) {
    let record = this.journal().read(operationId);
    if (!record || !this.journal().owns(record, actor)) return undefined;
    if (record.state === 'publishing' || record.state === 'committed_unconfirmed') {
      try {
        const publication = this.state();
        if (publication.revision === record.publicationRevision) {
          const nextState = publication.phase === 'committed'
            ? 'committed_unconfirmed'
            : publication.phase === 'recovery_required' ? 'recovery_required' : record.state;
          if (nextState !== record.state) record = this.journal().update(record, {
            state: nextState,
            updatedAt: publication.updatedAt,
          });
        } else if (
          publication.phase === 'committed'
          && publication.rawRevision === record.beforeRevision
        ) {
          record = this.journal().update(record, {
            state: 'rolled_back',
            updatedAt: publication.updatedAt,
          });
        }
      } catch {
        // Keep the durable pending state; absence of signed evidence is not success.
      }
    }
    return {
      operationId,
      operation: record.operation,
      state: record.state,
      updatedAt: record.updatedAt,
      ...(record.candidateRevision ? { revision: record.candidateRevision } : {}),
      ...(record.publicationRevision ? { publicationRevision: record.publicationRevision } : {}),
    };
  }
  private state(): ConfigPublication {
    const state = readPublication(this.options.configPath);
    if (!state) throw new Error('生产配置发布尚未由受控部署初始化');
    return state;
  }
  private async identity(config: AppConfig): Promise<PublishedIdentity> {
    assertProductionManagedCredentialSafety(config);
    if (!config.models) throw new Error('models 未配置');
    assertAuxiliaryModelRefsResolvable(config, config.models);
    const observed = await computeObservedConfigIdentity(
      config,
      this.options.secretVault,
      this.options.processCwd,
    );
    if (observed.versionResolution !== 'resolved') throw new Error('配置凭据版本尚未完整解析');
    return asIdentity(observed);
  }
  private expected(state: ConfigPublication): PublishedIdentity {
    return asIdentity(
      state.releaseId === this.options.releaseId ? state.identity : this.options.expected,
    );
  }
  private assertTargets(targets: PublicationTarget[]): void {
    const current = this.options.targets();
    if (
      targets.length !== 2 ||
      new Set(targets.map((target) => target.role)).size !== 2 ||
      canonical(current) !== canonical(targets) ||
      targets.some((target) => !isOwnerAlive(target.process))
    ) {
      throw new Error('配置发布过程中 API / Worker 进程或活动颜色已变化');
    }
  }
  private receiptMatches(
    target: PublicationTarget,
    state: ConfigPublication,
    expected: PublishedIdentity,
  ): boolean {
    try {
      const st = lstatSync(target.receiptPath);
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        (st.mode & 0o077) !== 0 ||
        st.uid !== process.getuid?.()
      )
        return false;
      const value = JSON.parse(readFileSync(target.receiptPath, 'utf8')) as PublicationReceipt;
      const age = this.now() - value.recordedAt;
      return (
        value.schemaVersion === 1 &&
        value.releaseId === this.options.releaseId &&
        value.role === target.role &&
        canonical(value.process) === canonical(target.process) &&
        value.revision === state.revision &&
        value.sequence === state.sequence &&
        value.phase === state.phase &&
        value.rawRevision === state.rawRevision &&
        canonical(value.identity) === canonical(expected) &&
        Number.isFinite(age) &&
        age >= 0 &&
        age <= 5_000
      );
    } catch {
      return false;
    }
  }
  private async wait(state: ConfigPublication, targets: PublicationTarget[]): Promise<void> {
    const deadline = performance.now() + (this.options.timeoutMs ?? 20_000);
    while (performance.now() <= deadline) {
      this.assertTargets(targets);
      const current = assertPublishedDisk(this.options.configPath, this.state());
      if (canonical(current) !== canonical(state)) throw new Error('配置发布权威发生并发变化');
      await this.options.observeLocal();
      const expected = this.expected(state);
      if (targets.every((target) => this.receiptMatches(target, state, expected))) {
        this.assertTargets(targets);
        if (canonical(this.state()) !== canonical(state)) throw new Error('配置生效确认已失效');
        return;
      }
      await sleep(this.options.pollMs ?? 100);
    }
    throw new Error('等待 API 与 Worker 应用目标配置超时，未报告保存成功');
  }
  private transition(
    state: ConfigPublication,
    phase: ConfigPublication['phase'],
  ): ConfigPublication {
    return writePublication(this.options.configPath, {
      ...state,
      phase,
      sequence: state.sequence + 1,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  private async fenced<T>(action: () => Promise<T>): Promise<T> {
    const path = this.options.promotionLockPath ?? '/run/lock/agent-saas/promotion.lock';
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    let release: () => Promise<void>;
    try {
      release = await acquireFileGuard(path);
    } catch (error) {
      throw new Error('生产发布互斥锁暂不可用，请稍后重试', { cause: error });
    }
    try {
      return await action();
    } finally {
      await release();
    }
  }

  async recover(): Promise<void> {
    return this.fenced(() => this.recoverLocked());
  }

  async coordinateCredentialRotation(credentialRef: string): Promise<void> {
    return this.fenced(async () => {
      await this.recoverLocked();
      const state = assertPublishedDisk(this.options.configPath, this.state())!;
      if (state.phase !== 'committed' || state.releaseId !== this.options.releaseId) {
        throw new Error('凭据轮换时生产配置权威不可用');
      }
      const currentText = readFileSync(this.options.configPath, 'utf8');
      const currentRaw = parseJsonc(currentText) as Record<string, unknown>;
      const config = parseAppConfig(currentRaw);
      const refs = config.codexSubscription?.credentialRefs?.length
        ? config.codexSubscription.credentialRefs
        : config.codexSubscription?.credentialRef ? [config.codexSubscription.credentialRef] : [];
      if (!refs.includes(credentialRef)) throw new Error('拒绝为未登记的 Codex 凭据推进签名身份');
      const identity = await this.identity(config);
      if (canonical(identity) === canonical(this.expected(state))) return;
      const targets = this.options.targets();
      this.assertTargets(targets);
      const intent: ConfigPublication = {
        ...state,
        phase: 'applying',
        sequence: state.sequence + 1,
        revision: randomUUID(),
        rawRevision: rawRevision(currentText),
        identity,
        previous: {
          revision: state.revision,
          rawRevision: state.rawRevision,
          identity: this.expected(state),
        },
        owner: processIdentity(),
        actor: 'system:codex-token-refresh',
        changedPaths: ['runtime-credential-rotation:codexSubscription'],
        updatedAt: new Date(this.now()).toISOString(),
      };
      try {
        writePublication(this.options.configPath, intent);
        await this.wait(intent, targets);
        const committed = this.transition(intent, 'committed');
        await this.wait(committed, targets);
      } catch (error) {
        try {
          const latest = this.state();
          if (latest.revision === intent.revision && latest.phase !== 'committed') {
            this.transition(latest, 'recovery_required');
          }
        } catch {
          /* 已签名的 applying head 本身会保持 fail-closed。 */
        }
        throw new ConfigMutationCommittedError(
          new Error('Codex token 已刷新，但签名身份确认未完成；配置写入已阻断等待恢复', { cause: error }),
        );
      }
    });
  }

  private async recoverLocked(): Promise<void> {
    const state = readPublication(this.options.configPath);
    if (!state || state.phase === 'committed') return;
    if (state.releaseId !== this.options.releaseId)
      throw new Error('未完成配置事务属于其他发布版本，需要原版本恢复');
    if (state.phase !== 'recovery_required' && state.owner && isOwnerAlive(state.owner)) {
      throw new Error('配置发布事务仍由存活进程持有');
    }
    await this.rollback(state, new Error('恢复中断的生产配置事务'));
  }

  private async rollback(state: ConfigPublication, original: unknown): Promise<void> {
    let rolling = state;
    try {
      if (!state.previous) throw new Error('配置事务缺少回滚版本');
      const disk = rawRevision(readFileSync(this.options.configPath, 'utf8'));
      if (disk !== state.rawRevision && disk !== state.previous.rawRevision) {
        throw new Error('磁盘存在事务外变更，拒绝用回滚覆盖');
      }
      const text = readSnapshot(this.options.configPath, state.previous.rawRevision);
      // Keep both known revisions in the pending journal until old bytes are durable.
      atomicWrite(this.options.configPath, text);
      rolling = writePublication(this.options.configPath, {
        ...state,
        ...state.previous,
        phase: 'rolling_back',
        sequence: state.sequence + 1,
        owner: processIdentity(),
        updatedAt: new Date(this.now()).toISOString(),
      });
      const targets = this.options.targets();
      await this.wait(rolling, targets);
      const committed = this.transition(rolling, 'committed');
      await this.wait(committed, targets);
      const operation = this.journal().findByPublicationRevision(state.revision);
      if (operation && operation.state !== 'rolled_back') {
        this.journal().update(operation, {
          state: 'rolled_back',
          updatedAt: committed.updatedAt,
        });
      }
    } catch (restoreError) {
      // Never overwrite an unrelated winning transaction or discard recovery evidence.
      try {
        const current = this.state();
        // Atomic replacement may succeed before fsync throws and the assignment
        // to rolling completes. Recognize only this process's exact rollback head.
        const rollbackHeadSelected =
          current.phase === 'rolling_back' &&
          current.releaseId === state.releaseId &&
          current.revision === state.previous?.revision &&
          current.rawRevision === state.previous?.rawRevision &&
          current.sequence === state.sequence + 1 &&
          canonical(current.owner) === canonical(processIdentity());
        if ((current.revision === rolling.revision || rollbackHeadSelected) && current.phase !== 'committed') {
          this.transition(current, 'recovery_required');
        }
      } catch {
        /* The old signed pending head itself keeps admission closed. */
      }
      throw new RuntimeRestoreFailedError(original, restoreError);
    }
  }

  async mutate(input: MutationInput): Promise<AdminConfigMutationResult> {
    return this.fenced(async () => {
      try {
        return await this.mutateLocked(input);
      } catch (error) {
        if (input.operationId) {
          const record = this.journal().read(input.operationId);
          // `preparing` is written before candidate construction. If no signed
          // publication head was selected, every route-level candidate Secret
          // cleanup can safely converge this operation to a terminal no-write.
          if (record?.state === 'preparing') {
            this.journal().update(record, {
              state: 'not_committed',
              updatedAt: new Date(this.now()).toISOString(),
            });
          }
        }
        throw error;
      }
    });
  }

  private async mutateLocked(input: MutationInput): Promise<AdminConfigMutationResult> {
    await this.recoverLocked();
    const state = assertPublishedDisk(this.options.configPath, this.state())!;
    if (!this.getWritePolicy().canSave) throw new Error('生产配置发布当前不可用');
    const currentText = readFileSync(this.options.configPath, 'utf8');
    const currentRaw = parseJsonc(currentText) as Record<string, unknown>;
    const beforeFingerprint = configFingerprint(currentRaw);
    const beforeRevision = rawRevision(currentText);
    // #593 内部调用兼容：只对原有模型固定集合推导 models.save；其他操作必须显式绑定。
    const operation = input.operation ?? (
      input.changedPaths.length > 0 && input.changedPaths.every((path) => LEGACY_MODEL_PATHS.has(path))
        ? { id: 'models.save' as const }
        : undefined
    );
    if (!operation) throw new Error('生产配置发布缺少服务端操作策略');
    if (input.operationId && this.journal().read(input.operationId)) {
      const existing = this.journal().begin({
        operationId: input.operationId, operation: operation.id, actor: input.actor,
        semantic: input.requestSemantic, beforeRevision, now: new Date(this.now()).toISOString(),
      });
      if (existing.state !== 'applied' || !existing.candidateRevision) {
        throw new AdminConfigOperationPendingError(existing.state);
      }
      const replayText = readSnapshot(this.options.configPath, existing.candidateRevision);
      const replayRaw = parseJsonc(replayText) as Record<string, unknown>;
      const previousText = readSnapshot(this.options.configPath, existing.beforeRevision);
      const previousRaw = parseJsonc(previousText) as Record<string, unknown>;
      return {
        config: parseAppConfig(replayRaw), previousConfig: parseAppConfig(previousRaw),
        beforeFingerprint: configFingerprint(previousRaw),
        rawConfigFingerprint: configFingerprint(replayRaw), effectiveConfigFingerprint: configFingerprint(replayRaw),
        revision: existing.candidateRevision, appliedAt: existing.updatedAt,
      };
    }
    if (
      !input.expectedRevision ||
      input.expectedRevision !== beforeRevision ||
      (input.expectedFingerprint && input.expectedFingerprint !== beforeFingerprint)
    ) {
      throw new ConfigConflictError(beforeFingerprint, beforeRevision);
    }
    if (input.productionConfirmation !== beforeRevision)
      throw new ProductionConfirmationError();
    let operationRecord: AdminConfigOperationRecord | undefined;
    if (input.operationId) {
      operationRecord = this.journal().begin({
        operationId: input.operationId,
        operation: operation.id,
        actor: input.actor,
        semantic: input.requestSemantic,
        beforeRevision,
        now: new Date(this.now()).toISOString(),
      });
    }
    const targets = this.options.targets();
    await this.wait(state, targets);
    const previousConfig = parseAppConfig(currentRaw);
    const previousIdentity = await this.identity(previousConfig);
    if (canonical(previousIdentity) !== canonical(this.expected(state)))
      throw new Error('生产配置基线与可信身份不一致');
    await input.validateBaseline?.(currentText, previousConfig);
    let candidateText: string;
    try {
      candidateText = await input.buildCandidate(currentText, currentRaw);
    } catch (error) {
      if (operationRecord) this.journal().update(operationRecord, {
        state: 'not_committed', updatedAt: new Date(this.now()).toISOString(),
      });
      throw error;
    }
    const candidateRaw = parseJsonc(candidateText) as Record<string, unknown>;
    assertAdminConfigOperationScope(operation, currentRaw, candidateRaw);
    const config = parseAppConfig(candidateRaw);
    await input.validateCandidate?.(config);
    const candidateIdentity = await this.identity(config);
    if (
      readFileSync(this.options.configPath, 'utf8') !== currentText ||
      canonical(this.state()) !== canonical(state)
    ) {
      throw new ConfigConflictError(beforeFingerprint, beforeRevision);
    }
    this.assertTargets(targets);
    const fingerprint = configFingerprint(candidateRaw);
    const result = (): AdminConfigMutationResult => ({
      config,
      previousConfig,
      beforeFingerprint,
      rawConfigFingerprint: fingerprint,
      effectiveConfigFingerprint: fingerprint,
      revision: rawRevision(candidateText),
      appliedAt: new Date(this.now()).toISOString(),
    });
    if (candidateText === currentText) {
      // Idempotent replay still needs a durable result snapshot.
      saveSnapshot(this.options.configPath, currentText);
      if (operationRecord) this.journal().update(operationRecord, {
        state: 'applied', candidateRevision: beforeRevision, updatedAt: new Date(this.now()).toISOString(),
      });
      return result();
    }
    saveSnapshot(this.options.configPath, currentText);
    saveSnapshot(this.options.configPath, candidateText);
    const intent: ConfigPublication = {
      schemaVersion: 1,
      environment: 'production',
      releaseId: this.options.releaseId,
      phase: 'applying',
      sequence: state.sequence + 1,
      revision: randomUUID(),
      rawRevision: rawRevision(candidateText),
      identity: candidateIdentity,
      previous: {
        revision: state.revision,
        rawRevision: beforeRevision,
        identity: previousIdentity,
      },
      owner: processIdentity(),
      actor: input.actor,
      changedPaths: [adminConfigOperationAuditPath(operation)],
      updatedAt: new Date(this.now()).toISOString(),
    };
    try {
      if (operationRecord) operationRecord = this.journal().update(operationRecord, {
        state: 'publishing', candidateRevision: intent.rawRevision,
        publicationRevision: intent.revision, updatedAt: new Date(this.now()).toISOString(),
      });
      writePublication(this.options.configPath, intent);
      atomicWrite(this.options.configPath, candidateText);
      // The shared runtime refresher, not the HTTP route's partial update recipe,
      // applies models, auxiliary chains, pricing AND memory.index in both processes.
      await this.wait(intent, targets);
      const committed = this.transition(intent, 'committed');
      await this.wait(committed, targets);
      if (operationRecord) this.journal().update(operationRecord, {
        state: 'applied', updatedAt: new Date(this.now()).toISOString(),
      });
      return result();
    } catch (error) {
      let latest: ConfigPublication;
      try {
        latest = this.state();
      } catch (readError) {
        throw new RuntimeRestoreFailedError(error, readError);
      }
      if (latest.revision === intent.revision && latest.phase === 'committed') {
        if (operationRecord) this.journal().update(operationRecord, {
          state: 'committed_unconfirmed', updatedAt: new Date(this.now()).toISOString(),
        });
        throw new ConfigMutationCommittedError(
          new Error('配置已提交，但最终生效确认未完成，请刷新确认后再操作', { cause: error }),
        );
      }
      if (latest.revision === intent.revision) {
        try {
          await this.rollback(latest, error);
          if (operationRecord) this.journal().update(operationRecord, {
            state: 'rolled_back', updatedAt: new Date(this.now()).toISOString(),
          });
        } catch (restoreError) {
          if (operationRecord) this.journal().update(operationRecord, {
            state: 'recovery_required', updatedAt: new Date(this.now()).toISOString(),
          });
          throw restoreError;
        }
      }
      else if (canonical(latest) !== canonical(state))
        throw new RuntimeRestoreFailedError(error, new Error('配置事务权威已变化'));
      throw error;
    }
  }
}
