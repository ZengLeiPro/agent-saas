import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import {
  applyBackgroundShellProtection,
  applyInvocationLease,
  clearExpiredInvocationLeases,
  SandboxMutationPreconditionError,
} from './sandboxLifecycleMutations.js';
import type { SandboxStatus } from './sandboxState.js';
import { stringValue } from './sandboxState.js';

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
  ): Promise<string> {
    if (leaseUntil && !Number.isFinite(Date.parse(leaseUntil))) {
      throw new Error('invocation leaseUntil 必须是合法 ISO 时间');
    }
    const { config, kubectl } = this.context;
    return await applyInvocationLease(
      config, kubectl, this.context.resourceName(name), invocationKey, leaseUntil,
      () => this.context.getStatus(name), expectedUid,
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
  ): Promise<string> {
    if (protectedUntil && !Number.isFinite(Date.parse(protectedUntil))) {
      throw new Error('background shell protectedUntil 必须是合法 ISO 时间');
    }
    const { config, kubectl } = this.context;
    return await applyBackgroundShellProtection(
      config, kubectl, this.context.resourceName(name), protectedUntil,
      () => this.context.getStatus(name), expectedUid,
    );
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
