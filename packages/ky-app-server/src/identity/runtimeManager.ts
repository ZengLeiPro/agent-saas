import type { InstallationBinding } from '@kaiyan/ky-app-contract';

import type { InstallationBindingProvider } from './types.js';

export interface InstallationRuntime {
  validate(): Promise<void>;
  start(): Promise<void>;
  drain(): Promise<void>;
}

export type InstallationRuntimeFactory = (
  binding: InstallationBinding,
) => Promise<InstallationRuntime>;

function sameBindingIdentity(left: InstallationBinding, right: InstallationBinding): boolean {
  return (
    left.installationId === right.installationId &&
    left.tenantId === right.tenantId &&
    left.systemId === right.systemId &&
    left.deploymentId === right.deploymentId &&
    left.origin === right.origin &&
    left.platformIssuer === right.platformIssuer &&
    left.platformApiBaseUrl === right.platformApiBaseUrl &&
    left.keyId === right.keyId &&
    left.registeredDigest === right.registeredDigest &&
    left.generation === right.generation &&
    left.grantedScopes.length === right.grantedScopes.length &&
    left.grantedScopes.every((scope) => right.grantedScopes.includes(scope))
  );
}

/** stage -> validate -> start -> atomic swap -> drain old；失败保留最后有效 generation。 */
export class InstallationRuntimeManager {
  private readonly active = new Map<string, { generation: number; runtime: InstallationRuntime }>();

  constructor(
    private readonly bindings: InstallationBindingProvider,
    private readonly factory: InstallationRuntimeFactory,
  ) {}

  async install(binding: InstallationBinding): Promise<void> {
    const stored = await this.bindings.get(binding.installationId);
    if (stored?.state === 'connected' && sameBindingIdentity(stored, binding)) {
      if (this.active.get(binding.installationId)?.generation === binding.generation) return;
      const restored = await this.factory(stored);
      try {
        await restored.validate();
        await restored.start();
        this.active.set(binding.installationId, {
          generation: binding.generation,
          runtime: restored,
        });
        return;
      } catch (error) {
        await restored.drain().catch(() => undefined);
        throw error;
      }
    }
    await this.bindings.stage(binding);
    const candidate = await this.factory(binding);
    try {
      await candidate.validate();
      await candidate.start();
      const old = this.active.get(binding.installationId);
      this.active.set(binding.installationId, {
        generation: binding.generation,
        runtime: candidate,
      });
      await this.bindings.activate(binding.installationId, binding.generation);
      if (old) await old.runtime.drain();
    } catch (error) {
      await candidate.drain().catch(() => undefined);
      throw error;
    }
  }

  async revoke(installationId: string, expectedGeneration: number): Promise<void> {
    await this.bindings.revoke(installationId, expectedGeneration);
    const current = this.active.get(installationId);
    if (current?.generation === expectedGeneration) {
      this.active.delete(installationId);
      await current.runtime.drain();
    }
  }

  generation(installationId: string): number | null {
    return this.active.get(installationId)?.generation ?? null;
  }
}
