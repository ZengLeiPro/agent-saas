import { decideSandboxLifecycle, isActiveInvocationLeaseProtected } from './sandboxLifecyclePolicy.js';
import type { SandboxCleanupReport } from './sandboxManagerTypes.js';
import { isBackgroundShellProtected, parseDateMs, type ManagedSandbox } from './sandboxState.js';
import type { SnatCleanupReport } from './snatManager.js';

export interface SandboxCleanupHost {
  lifecyclePolicyMode: 'shadow' | 'enforce';
  sandboxBrokenRecycleGraceMs: number;
  sandboxOrphanGraceMs: number;
  sandboxTtlMs: number;
  sandboxIdlePauseMs: number;
  listManagedSandboxes(): Promise<ManagedSandbox[]>;
  isBusy(name: string, busySandboxNames: Set<string>): boolean;
  deleteWhenIdle(name: string, busySandboxNames: Set<string>): Promise<string[] | null>;
  patchPaused(name: string): Promise<void>;
  cleanupOrphanSnat(): Promise<SnatCleanupReport>;
  warn(message: string): void;
}

export async function cleanupManagedSandboxes(
  host: SandboxCleanupHost,
  input: { busySandboxNames?: Set<string>; now?: Date } = {},
): Promise<SandboxCleanupReport> {
  const nowMs = (input.now ?? new Date()).getTime();
  const busySandboxNames = input.busySandboxNames ?? new Set<string>();
  const sandboxes = await host.listManagedSandboxes();
  const paused: string[] = [];
  const deleted: string[] = [];
  const brokenRecycled: string[] = [];
  const skippedBusy: string[] = [];
  const snatDeleted: string[] = [];
  const decisionCounts: Record<string, number> = {};

  for (const sandbox of sandboxes) {
    if (host.isBusy(sandbox.name, busySandboxNames)) {
      skippedBusy.push(sandbox.name);
      decisionCounts['retain-active-registry'] = (decisionCounts['retain-active-registry'] ?? 0) + 1;
      continue;
    }
    if (isActiveInvocationLeaseProtected(sandbox, nowMs)) {
      skippedBusy.push(sandbox.name);
      decisionCounts['retain-active-lease'] = (decisionCounts['retain-active-lease'] ?? 0) + 1;
      continue;
    }
    if (isBackgroundShellProtected(sandbox, nowMs)) {
      skippedBusy.push(sandbox.name);
      decisionCounts['retain-background-protected'] = (decisionCounts['retain-background-protected'] ?? 0) + 1;
      continue;
    }
    const lifecycle = decideSandboxLifecycle({ ...sandbox, nowMs });
    decisionCounts[lifecycle.decision] = (decisionCounts[lifecycle.decision] ?? 0) + 1;
    const phase = sandbox.phase ?? 'Unknown';
    const createdAtMs = parseDateMs(sandbox.createdAt);
    const lastActiveAtMs = parseDateMs(sandbox.lastActiveAt) ?? createdAtMs;
    const ageMs = createdAtMs === undefined ? 0 : nowMs - createdAtMs;
    const idleMs = lastActiveAtMs === undefined ? 0 : nowMs - lastActiveAtMs;

    if (sandbox.brokenReason && host.sandboxBrokenRecycleGraceMs > 0) {
      const brokenSinceMs = Math.max(
        parseDateMs(sandbox.pausedConditionChangedAt) ?? 0,
        lastActiveAtMs ?? 0,
        createdAtMs ?? 0,
      );
      if (brokenSinceMs > 0 && nowMs - brokenSinceMs >= host.sandboxBrokenRecycleGraceMs) {
        host.warn(`sandbox_broken_recycle name=${sandbox.name} reason=${sandbox.brokenReason} brokenForMs=${nowMs - brokenSinceMs}`);
        const reclaimed = await host.deleteWhenIdle(sandbox.name, busySandboxNames);
        if (!reclaimed) {
          skippedBusy.push(sandbox.name);
          continue;
        }
        snatDeleted.push(...reclaimed);
        brokenRecycled.push(sandbox.name);
        continue;
      }
    }

    const orphanPhase = !['Running', 'Paused'].includes(phase);
    const orphanGraceMs = lifecycle.workloadClass === 'probe' ? 5 * 60_000 : host.sandboxOrphanGraceMs;
    const shouldDeleteOrphan = orphanGraceMs > 0 && orphanPhase && ageMs >= orphanGraceMs;
    const shouldDeleteByLegacyTtl = host.sandboxTtlMs > 0 && idleMs >= host.sandboxTtlMs;
    const shouldDeleteByPolicy = host.lifecyclePolicyMode === 'enforce' && lifecycle.delete;
    if (shouldDeleteOrphan || (host.lifecyclePolicyMode === 'shadow' ? shouldDeleteByLegacyTtl : shouldDeleteByPolicy)) {
      const reclaimed = await host.deleteWhenIdle(sandbox.name, busySandboxNames);
      if (!reclaimed) {
        skippedBusy.push(sandbox.name);
        continue;
      }
      snatDeleted.push(...reclaimed);
      deleted.push(sandbox.name);
      continue;
    }
    if (phase === 'Running' && host.sandboxIdlePauseMs > 0 && idleMs >= host.sandboxIdlePauseMs) {
      if (host.isBusy(sandbox.name, busySandboxNames)) {
        skippedBusy.push(sandbox.name);
        continue;
      }
      await host.patchPaused(sandbox.name);
      paused.push(sandbox.name);
    }
  }

  const pausedSet = new Set(paused);
  const removedSet = new Set([...deleted, ...brokenRecycled]);
  const snatReport = await host.cleanupOrphanSnat();
  return {
    checked: sandboxes.length, paused, deleted, brokenRecycled, skippedBusy,
    snatDeleted: [...snatDeleted, ...snatReport.deleted],
    snatUnexpected: snatReport.unexpected.length,
    runningCount: sandboxes.filter((sandbox) => !removedSet.has(sandbox.name)
      && !pausedSet.has(sandbox.name) && sandbox.phase === 'Running').length,
    totalCount: sandboxes.length,
    policyMode: host.lifecyclePolicyMode,
    decisionCounts,
  };
}
