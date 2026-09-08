import { readFileSync, lstatSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse as parseJsonc } from 'jsonc-parser';
import type { ConfigWritePolicy } from '@agent/shared/configWritePolicy';
import {
  assertPublishedDisk, atomicWrite, canonical, isOwnerAlive, processIdentity,
  publishedExpected, rawRevision, readPublication, readSnapshot, saveSnapshot,
  signingAvailable, writePublication,
  type ConfigPublication, type ProcessIdentity, type PublishedIdentity,
} from '../../../scripts/release/config-publication.mjs';
import { parseAppConfig, type AppConfig } from '../app/config.js';
import { assertAuxiliaryModelRefsResolvable } from '../app/modelsHotUpdate.js';
import {
  assertProductionManagedCredentialSafety, computeObservedConfigIdentity,
  type ExpectedConfigIdentity,
} from '../release/configIdentity.js';
import type { SecretVault } from '../security/secretVault.js';
import {
  ConfigConflictError, ConfigMutationCommittedError, RuntimeRestoreFailedError,
  configFingerprint, type AdminConfigMutationResult, type MutationInput,
} from './adminConfigMutationService.js';

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
}

const ALLOWED = new Set(['models', 'memory.index', 'titleGenerator', 'guardrail', 'systemPrompts.utility.title']);
function withoutModelSettings(value: Record<string, unknown>): string {
  const copy = structuredClone(value);
  for (const key of ['models', 'titleGenerator', 'guardrail']) delete copy[key];
  for (const [key, field] of [['memory', 'index'], ['systemPrompts', 'utility.title']]) {
    const section = copy[key];
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      delete (section as Record<string, unknown>)[field];
      if (Object.keys(section).length === 0) delete copy[key];
    }
  }
  return canonical(copy);
}
function asIdentity(value: { schemaVersion: number; digest: string; credentialVersionDigest?: string | null }): PublishedIdentity {
  if (value.schemaVersion !== 1) throw new Error('不支持的配置身份版本');
  return { schemaVersion: 1, digest: value.digest,
    ...(value.credentialVersionDigest ? { credentialVersionDigest: value.credentialVersionDigest } : {}) };
}

/** No network paths, environment selectors or signing options are accepted from HTTP. */
export class ProductionModelPublisher implements ProductionPublisher {
  constructor(private readonly options: {
    configPath: string;
    processCwd: string;
    releaseId: string;
    expected: ExpectedConfigIdentity;
    secretVault: SecretVault;
    targets: () => PublicationTarget[];
    observeLocal: () => Promise<void>;
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
  }) {}

  getWritePolicy(): ConfigWritePolicy {
    // Signing availability is a server-side capability, never a user-supplied flag.
    try {
      const state = assertPublishedDisk(this.options.configPath);
      const targets = this.options.targets();
      if (state?.phase === 'committed' && signingAvailable(this.options.configPath)
        && targets.length === 2 && targets.some((target) => target.role === 'ws-only' && target.process.pid === process.pid)) {
        return { environment: 'production', mode: 'online', canSave: true };
      }
    } catch { /* A missing, unsigned, stale or pending baseline is never writable. */ }
    return { environment: 'production', mode: 'controlled-publish-required', canSave: false,
      reasonCode: 'PRODUCTION_CONFIG_PUBLISH_REQUIRED',
      message: '生产配置发布暂不可用：请检查配置事务恢复状态、签名基线及 API / Worker 运行状态' };
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private state(): ConfigPublication {
    const state = readPublication(this.options.configPath);
    if (!state) throw new Error('生产配置发布尚未由受控部署初始化');
    return state;
  }
  private async identity(config: AppConfig): Promise<PublishedIdentity> {
    assertProductionManagedCredentialSafety(config);
    if (!config.models) throw new Error('models 未配置');
    assertAuxiliaryModelRefsResolvable(config, config.models);
    const observed = await computeObservedConfigIdentity(config, this.options.secretVault, this.options.processCwd);
    if (observed.versionResolution !== 'resolved') throw new Error('配置凭据版本尚未完整解析');
    return asIdentity(observed);
  }
  private expected(state: ConfigPublication): PublishedIdentity {
    return asIdentity(state.releaseId === this.options.releaseId ? state.identity : this.options.expected);
  }
  private assertTargets(targets: PublicationTarget[]): void {
    const current = this.options.targets();
    if (targets.length !== 2 || new Set(targets.map((target) => target.role)).size !== 2
      || canonical(current) !== canonical(targets) || targets.some((target) => !isOwnerAlive(target.process))) {
      throw new Error('配置发布过程中 API / Worker 进程或活动颜色已变化');
    }
  }
  private receiptMatches(target: PublicationTarget, state: ConfigPublication, expected: PublishedIdentity): boolean {
    try {
      const st = lstatSync(target.receiptPath);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid?.()) return false;
      const value = JSON.parse(readFileSync(target.receiptPath, 'utf8')) as PublicationReceipt;
      const age = this.now() - value.recordedAt;
      return value.schemaVersion === 1 && value.releaseId === this.options.releaseId
        && value.role === target.role && canonical(value.process) === canonical(target.process)
        && value.revision === state.revision && value.sequence === state.sequence && value.phase === state.phase
        && value.rawRevision === state.rawRevision && canonical(value.identity) === canonical(expected)
        && Number.isFinite(age) && age >= 0 && age <= 5_000;
    } catch { return false; }
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
  private transition(state: ConfigPublication, phase: ConfigPublication['phase']): ConfigPublication {
    return writePublication(this.options.configPath, { ...state, phase,
      sequence: state.sequence + 1, updatedAt: new Date(this.now()).toISOString() });
  }

  async recover(): Promise<void> {
    const state = readPublication(this.options.configPath);
    if (!state || state.phase === 'committed') return;
    if (state.releaseId !== this.options.releaseId) throw new Error('未完成配置事务属于其他发布版本，需要原版本恢复');
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
      rolling = writePublication(this.options.configPath, { ...state, ...state.previous,
        phase: 'rolling_back', sequence: state.sequence + 1,
        owner: processIdentity(), updatedAt: new Date(this.now()).toISOString() });
      atomicWrite(this.options.configPath, text);
      const targets = this.options.targets();
      await this.wait(rolling, targets);
      const committed = this.transition(rolling, 'committed');
      await this.wait(committed, targets);
    } catch (restoreError) {
      // Never overwrite an unrelated winning transaction or discard recovery evidence.
      try {
        const current = this.state();
        if (current.revision === rolling.revision && current.phase !== 'committed') {
          this.transition(current, 'recovery_required');
        }
      } catch { /* The old signed pending head itself keeps admission closed. */ }
      throw new RuntimeRestoreFailedError(original, restoreError);
    }
  }

  async mutate(input: MutationInput): Promise<AdminConfigMutationResult> {
    await this.recover();
    const state = assertPublishedDisk(this.options.configPath, this.state())!;
    if (!this.getWritePolicy().canSave) throw new Error('生产配置发布当前不可用');
    const currentText = readFileSync(this.options.configPath, 'utf8');
    const currentRaw = parseJsonc(currentText) as Record<string, unknown>;
    const beforeFingerprint = configFingerprint(currentRaw);
    const beforeRevision = rawRevision(currentText);
    if (!input.expectedRevision || input.expectedRevision !== beforeRevision
      || (input.expectedFingerprint && input.expectedFingerprint !== beforeFingerprint)) {
      throw new ConfigConflictError(beforeFingerprint, beforeRevision);
    }
    if (input.productionConfirmation !== beforeRevision) throw new Error('请确认对当前版本的生产配置进行修改');
    if (input.changedPaths.some((path) => !ALLOWED.has(path))) throw new Error('生产在线发布仅允许模型配置范围');
    const targets = this.options.targets();
    await this.wait(state, targets);
    const previousConfig = parseAppConfig(currentRaw);
    const previousIdentity = await this.identity(previousConfig);
    if (canonical(previousIdentity) !== canonical(this.expected(state))) throw new Error('生产配置基线与可信身份不一致');
    await input.validateBaseline?.(currentText, previousConfig);
    const candidateText = await input.buildCandidate(currentText, currentRaw);
    const candidateRaw = parseJsonc(candidateText) as Record<string, unknown>;
    if (withoutModelSettings(currentRaw) !== withoutModelSettings(candidateRaw)) throw new Error('模型保存不允许修改其他配置段');
    const config = parseAppConfig(candidateRaw);
    await input.validateCandidate?.(config);
    const candidateIdentity = await this.identity(config);
    if (readFileSync(this.options.configPath, 'utf8') !== currentText || canonical(this.state()) !== canonical(state)) {
      throw new ConfigConflictError(beforeFingerprint, beforeRevision);
    }
    this.assertTargets(targets);
    const fingerprint = configFingerprint(candidateRaw);
    const result = (): AdminConfigMutationResult => ({ config, previousConfig, beforeFingerprint,
      rawConfigFingerprint: fingerprint, effectiveConfigFingerprint: fingerprint,
      revision: rawRevision(candidateText), appliedAt: new Date(this.now()).toISOString() });
    if (candidateText === currentText) return result();
    saveSnapshot(this.options.configPath, currentText);
    saveSnapshot(this.options.configPath, candidateText);
    const intent: ConfigPublication = { schemaVersion: 1, environment: 'production',
      releaseId: this.options.releaseId, phase: 'applying', sequence: state.sequence + 1,
      revision: randomUUID(), rawRevision: rawRevision(candidateText), identity: candidateIdentity,
      previous: { revision: state.revision, rawRevision: beforeRevision, identity: previousIdentity },
      owner: processIdentity(), actor: input.actor, changedPaths: [...new Set(input.changedPaths)].sort(),
      updatedAt: new Date(this.now()).toISOString() };
    try {
      writePublication(this.options.configPath, intent);
      atomicWrite(this.options.configPath, candidateText);
      // The shared runtime refresher, not the HTTP route's partial update recipe,
      // applies models, auxiliary chains, pricing AND memory.index in both processes.
      await this.wait(intent, targets);
      const committed = this.transition(intent, 'committed');
      await this.wait(committed, targets);
      return result();
    } catch (error) {
      let latest: ConfigPublication;
      try { latest = this.state(); }
      catch (readError) { throw new RuntimeRestoreFailedError(error, readError); }
      if (latest.revision === intent.revision && latest.phase === 'committed') {
        throw new ConfigMutationCommittedError(error);
      }
      if (latest.revision === intent.revision) await this.rollback(latest, error);
      else if (canonical(latest) !== canonical(state)) throw new RuntimeRestoreFailedError(error, new Error('配置事务权威已变化'));
      throw error;
    }
  }
}
