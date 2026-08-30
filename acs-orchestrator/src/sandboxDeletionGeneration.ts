import { CREATED_AT_ANNOTATION } from './sandboxInventoryReader.js';
import {
  DELETION_GENERATION_ANNOTATION,
  type SandboxDeletionGenerationUpdate,
  type SandboxScopeDeletion,
} from './sandboxLifecyclePolicy.js';
import type { ManagedSandbox, SandboxStatus } from './sandboxState.js';
import type { SandboxRef } from './sandboxManagerTypes.js';
import type { SandboxDeletionPreconditions } from './sandboxDeletion.js';

export interface SandboxDeletionGenerationHost {
  getStatus(name: string): Promise<SandboxStatus | null>;
  refFromStatus(name: string, status: SandboxStatus): SandboxRef;
  patchGeneration(name: string, generation: string): Promise<void>;
  conflict(name: string): Error;
  deleteWhenIdle(
    name: string,
    busySandboxNames: Set<string> | undefined,
    canDelete: (latest: ManagedSandbox) => boolean,
    preconditions: SandboxDeletionPreconditions,
  ): Promise<string[] | null>;
}

export class SandboxDeletionGenerationCoordinator {
  private readonly commitLocks = new Map<string, Promise<void>>();

  constructor(private readonly host: SandboxDeletionGenerationHost) {}

  async advance(
    ref: SandboxRef,
    input: SandboxDeletionGenerationUpdate,
  ): Promise<{ name: string; updated: boolean; missing: boolean }> {
    return await this.withCommitLock(ref.name, async () => {
      const status = await this.host.getStatus(ref.name);
      if (!status || !sameIdentity(this.host.refFromStatus(ref.name, status), input)) {
        return { name: ref.name, updated: false, missing: true };
      }
      const current = annotation(status, DELETION_GENERATION_ANNOTATION);
      if (current === input.deletionGeneration) return { name: ref.name, updated: false, missing: false };
      const initializesFence = current === undefined;
      if ((initializesFence && !generationCanInitializeRecreatedSandbox(input.deletionGeneration, status))
        || (!initializesFence && current !== input.previousDeletionGeneration)) {
        throw this.host.conflict(ref.name);
      }
      await this.host.patchGeneration(ref.name, input.deletionGeneration);
      return { name: ref.name, updated: true, missing: false };
    });
  }

  async delete(
    ref: SandboxRef,
    input: SandboxScopeDeletion,
    busySandboxNames?: Set<string>,
  ): Promise<{ name: string; deleted: boolean; missing: boolean; stale?: boolean; busy?: boolean }> {
    const initial = await this.host.getStatus(ref.name);
    if (!initial || !sameIdentity(this.host.refFromStatus(ref.name, initial), input)) {
      return { name: ref.name, deleted: false, missing: true };
    }
    return await this.withCommitLock(ref.name, async () => {
      const latest = await this.host.getStatus(ref.name);
      if (!latest || !sameIdentity(this.host.refFromStatus(ref.name, latest), input)) {
        return { name: ref.name, deleted: false, missing: true };
      }
      if (annotation(latest, DELETION_GENERATION_ANNOTATION) !== input.deletionGeneration) {
        return { name: ref.name, deleted: false, missing: false, stale: true };
      }
      const preconditions = resourcePreconditions(latest);
      if (!preconditions) return { name: ref.name, deleted: false, missing: false, busy: true };
      const reclaimed = await this.host.deleteWhenIdle(
        ref.name,
        busySandboxNames,
        (sandbox) => sandbox.deletionGeneration === input.deletionGeneration,
        preconditions,
      );
      return reclaimed
        ? { name: ref.name, deleted: true, missing: false }
        : { name: ref.name, deleted: false, missing: false, busy: true };
    });
  }

  private async withCommitLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const previous = this.commitLocks.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = previous.catch(() => undefined).then(() => gate);
    this.commitLocks.set(name, current);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.commitLocks.get(name) === current) this.commitLocks.delete(name);
    }
  }
}

function sameIdentity(actual: SandboxRef, expected: SandboxScopeDeletion): boolean {
  return actual.workspaceId === expected.workspaceId
    && actual.sessionId === expected.sessionId
    && actual.sandboxScopeId === expected.sandboxScopeId;
}

function annotation(status: SandboxStatus, name: string): string | undefined {
  const metadata = status.raw?.metadata && typeof status.raw.metadata === 'object'
    ? status.raw.metadata as Record<string, unknown>
    : {};
  const annotations = metadata.annotations && typeof metadata.annotations === 'object'
    ? metadata.annotations as Record<string, unknown>
    : {};
  const value = annotations[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resourcePreconditions(status: SandboxStatus): SandboxDeletionPreconditions | undefined {
  const metadata = status.raw?.metadata && typeof status.raw.metadata === 'object'
    ? status.raw.metadata as Record<string, unknown>
    : {};
  const uid = typeof metadata.uid === 'string' ? metadata.uid : undefined;
  const resourceVersion = typeof metadata.resourceVersion === 'string' ? metadata.resourceVersion : undefined;
  return uid && resourceVersion ? { uid, resourceVersion } : undefined;
}

// An unfenced CR may be recreated; only a strictly newer generation may initialize that incarnation.
function generationCanInitializeRecreatedSandbox(generation: string, status: SandboxStatus): boolean {
  const generationAt = Number.parseInt(generation.split('-', 1)[0] ?? '', 10);
  const createdAt = Date.parse(annotation(status, CREATED_AT_ANNOTATION) ?? '');
  return Number.isFinite(generationAt) && Number.isFinite(createdAt) && generationAt > createdAt;
}
