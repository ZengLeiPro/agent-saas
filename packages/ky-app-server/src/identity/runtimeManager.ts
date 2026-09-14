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

/** stage -> validate -> start -> atomic swap -> drain old；失败保留最后有效 generation。 */
export class InstallationRuntimeManager {
  private readonly active = new Map<string, { generation: number; runtime: InstallationRuntime }>();

  constructor(
    private readonly bindings: InstallationBindingProvider,
    private readonly factory: InstallationRuntimeFactory,
  ) {}

  async install(binding: InstallationBinding): Promise<void> {
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
