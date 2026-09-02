import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import {
  applyBackgroundShellProtection,
  applyInvocationLease,
  clearExpiredInvocationLeases,
  clearMalformedInvocationLeases,
  completeInvocationLease,
  SandboxMutationPreconditionError,
} from './sandboxLifecycleMutations.js';
import type { ActiveInvocationLeaseState } from './sandboxLifecyclePolicy.js';
import {
  BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION,
  BACKGROUND_SHELL_PROTECTION_GENERATION_ANNOTATION,
  type SandboxStatus, stringValue,
} from './sandboxState.js';

interface SandboxInvocationMutationContext {
  config: AcsOrchestratorConfig;
  kubectl: Kubectl;
  resourceName(name: string): string;
  getStatus(name: string): Promise<SandboxStatus | null>;
}

export class SandboxInvocationMutationFacade {
  constructor(private readonly context: SandboxInvocationMutationContext) {}

  async setActiveLease(
    name: string,
    invocationKey: string,
    leaseUntil?: string,
    expectedUid?: string,
    activityGeneration?: string,
    leaseState: ActiveInvocationLeaseState = 'executing',
    completedAt?: string,
  ): Promise<string> {
    if (leaseUntil && !Number.isFinite(Date.parse(leaseUntil))) {
      throw new Error('invocation leaseUntil 必须是合法 ISO 时间');
    }
    if (completedAt && !Number.isFinite(Date.parse(completedAt))) {
      throw new Error('invocation completedAt 必须是合法 ISO 时间');
    }
    if (leaseUntil && leaseState === 'completion_pending' && !completedAt) {
      throw new Error('completion_pending invocation lease 必须包含 completedAt');
    }
    const { config, kubectl } = this.context;
    return await applyInvocationLease(
      config, kubectl, this.context.resourceName(name), invocationKey, leaseUntil,
      () => this.context.getStatus(name), expectedUid, activityGeneration, leaseState, completedAt,
    );
  }

  /** Removes one UID-fenced lease and advances activity atomically. */
  async completeInvocation(
    name: string,
    invocationKey: string,
    completedAt: Date,
    expectedUid: string,
  ): Promise<string> {
    const { config, kubectl } = this.context;
    return await completeInvocationLease(
      config, kubectl, this.context.resourceName(name), invocationKey, completedAt,
      () => this.context.getStatus(name), expectedUid,
    );
  }

  async clearExpired(name: string, now = new Date(), expectedUid?: string): Promise<{ active: boolean; removed: number }> {
    const { config, kubectl } = this.context;
    return await clearExpiredInvocationLeases(
      config, kubectl, this.context.resourceName(name), now.getTime(),
      () => this.context.getStatus(name), expectedUid,
    );
  }

  async clearMalformed(name: string, expectedUid?: string, now = new Date()): Promise<number> {
    const { config, kubectl } = this.context;
    return await clearMalformedInvocationLeases(
      config, kubectl, this.context.resourceName(name),
      () => this.context.getStatus(name), expectedUid, now.getTime(),
    );
  }

  async setBackgroundProtection(
    name: string,
    protectedUntil?: string,
    expectedUid?: string,
    expectedClearGeneration?: string | null,
    generation?: string,
  ): Promise<string> {
    if (protectedUntil && !Number.isFinite(Date.parse(protectedUntil))) {
      throw new Error('background shell protectedUntil 必须是合法 ISO 时间');
    }
    const { config, kubectl } = this.context;
    return await applyBackgroundShellProtection(
      config, kubectl, this.context.resourceName(name), protectedUntil,
      () => this.context.getStatus(name), expectedUid, expectedClearGeneration, generation,
    );
  }

  async getBackgroundProtection(name: string, expectedUid: string): Promise<{ protectedUntil: string | null; generation: string | null }> {
    const status = await this.context.getStatus(name);
    if (!status) throw new SandboxMutationPreconditionError('Sandbox 不存在，拒绝读取后台 Shell 生命周期保护');
    const metadata = status.raw?.metadata as Record<string, unknown> | undefined;
    const uid = stringValue(metadata?.uid);
    if (!uid || uid !== expectedUid) throw new SandboxMutationPreconditionError('Sandbox 已同名重建，拒绝读取后台 Shell 生命周期保护');
    const annotations = metadata?.annotations as Record<string, unknown> | undefined;
    return {
      protectedUntil: stringValue(annotations?.[BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION]) ?? null,
      generation: stringValue(annotations?.[BACKGROUND_SHELL_PROTECTION_GENERATION_ANNOTATION]) ?? null,
    };
  }

  /** Returns the UID even while deletion is in progress; use getMutableUid for recovery writes. */
  async getUid(name: string): Promise<string | null> {
    const status = await this.context.getStatus(name);
    if (!status) return null;
    const uid = stringValue((status.raw?.metadata as Record<string, unknown> | undefined)?.uid);
    if (!uid) throw new SandboxMutationPreconditionError('Sandbox 缺少 UID');
    return uid;
  }

  /** Returns null when the resource is absent or already immutable because deletion has started. */
  async getMutableUid(name: string): Promise<string | null> {
    const status = await this.context.getStatus(name);
    if (!status) return null;
    const metadata = status.raw?.metadata as Record<string, unknown> | undefined;
    if (stringValue(metadata?.deletionTimestamp)) return null;
    const uid = stringValue(metadata?.uid);
    if (!uid) throw new SandboxMutationPreconditionError('Sandbox 缺少 UID');
    return uid;
  }
}
