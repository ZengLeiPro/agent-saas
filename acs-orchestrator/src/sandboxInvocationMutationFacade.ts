import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import {
  applyBackgroundShellProtection,
  applyInvocationLease,
  clearExpiredInvocationLeases,
  SandboxMutationPreconditionError,
} from './sandboxLifecycleMutations.js';
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
  ): Promise<string> {
    if (leaseUntil && !Number.isFinite(Date.parse(leaseUntil))) {
      throw new Error('invocation leaseUntil 必须是合法 ISO 时间');
    }
    const { config, kubectl } = this.context;
    return await applyInvocationLease(
      config, kubectl, this.context.resourceName(name), invocationKey, leaseUntil,
      () => this.context.getStatus(name), expectedUid, activityGeneration,
    );
  }

  async clearExpired(name: string, now = new Date()): Promise<{ active: boolean; removed: number }> {
    const { config, kubectl } = this.context;
    return await clearExpiredInvocationLeases(
      config, kubectl, this.context.resourceName(name), now.getTime(),
      () => this.context.getStatus(name),
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

  /** Returns null only when the named resource no longer exists. */
  async getUid(name: string): Promise<string | null> {
    const status = await this.context.getStatus(name);
    if (!status) return null;
    const uid = stringValue((status.raw?.metadata as Record<string, unknown> | undefined)?.uid);
    if (!uid) throw new SandboxMutationPreconditionError('Sandbox 缺少 UID');
    return uid;
  }
}
