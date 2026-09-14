import type { InstallationBinding } from '@kaiyan/ky-app-contract';

import type { BindingChange, InstallationBindingProvider } from './types.js';

/** 仅供测试和单进程本地开发；生产多副本必须使用共享持久化 provider。 */
export class MemoryInstallationBindingProvider implements InstallationBindingProvider {
  private readonly bindings = new Map<string, InstallationBinding>();
  private readonly staged = new Map<string, InstallationBinding>();
  private readonly listeners = new Set<(change: BindingChange) => void>();

  async get(installationId: string): Promise<InstallationBinding | null> {
    return this.bindings.get(installationId) ?? null;
  }

  async list(): Promise<InstallationBinding[]> {
    return [...this.bindings.values()];
  }

  async stage(binding: InstallationBinding): Promise<void> {
    const current = this.bindings.get(binding.installationId);
    const pending = this.staged.get(binding.installationId);
    if (
      (current && binding.generation <= current.generation) ||
      (pending && binding.generation < pending.generation)
    )
      throw new Error('binding_generation_conflict');
    const staged = { ...binding, state: 'activating' as const };
    this.staged.set(binding.installationId, staged);
    this.emit({ type: 'staged', binding: staged });
  }

  async activate(installationId: string, expectedGeneration: number): Promise<void> {
    const current = this.staged.get(installationId);
    if (!current || current.generation !== expectedGeneration)
      throw new Error('binding_generation_conflict');
    const active = { ...current, state: 'connected' as const, updatedAt: new Date().toISOString() };
    this.bindings.set(installationId, active);
    this.staged.delete(installationId);
    this.emit({ type: 'activated', binding: active });
  }

  async revoke(installationId: string, expectedGeneration: number): Promise<void> {
    const current = this.require(installationId, expectedGeneration);
    this.bindings.set(installationId, {
      ...current,
      state: 'revoked',
      updatedAt: new Date().toISOString(),
    });
    this.emit({ type: 'revoked', installationId, generation: expectedGeneration });
  }

  subscribe(listener: (change: BindingChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private require(installationId: string, generation: number): InstallationBinding {
    const current = this.bindings.get(installationId);
    if (!current) throw new Error('binding_not_found');
    if (current.generation !== generation) throw new Error('binding_generation_conflict');
    return current;
  }

  private emit(change: BindingChange): void {
    for (const listener of this.listeners) listener(change);
  }
}
