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
  deleteWhenIdle(
    name: string,
    busySandboxNames: Set<string>,
    canDelete?: (latest: ManagedSandbox) => boolean,
  ): Promise<string[] | null>;
  pauseWhenIdle(
    name: string,
    busySandboxNames: Set<string>,
    canPause: (latest: ManagedSandbox) => boolean,
  ): Promise<boolean>;
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
    const deletionReason = cleanupDeletionReason(host, sandbox, nowMs);
    if (deletionReason) {
      if (deletionReason === 'broken') host.warn(`sandbox_broken_recycle name=${sandbox.name} reason=${sandbox.brokenReason}`);
      const reclaimed = await host.deleteWhenIdle(
        sandbox.name,
        busySandboxNames,
        (latest) => cleanupDeletionReason(host, mergeLatestSandbox(sandbox, latest), nowMs) === deletionReason,
      );
      if (!reclaimed) {
        skippedBusy.push(sandbox.name);
        continue;
      }
      snatDeleted.push(...reclaimed);
      if (deletionReason === 'broken') brokenRecycled.push(sandbox.name);
      else deleted.push(sandbox.name);
      continue;
    }
    const phase = sandbox.phase ?? 'Unknown';
    const createdAtMs = parseDateMs(sandbox.createdAt);
    const lastActiveAtMs = parseDateMs(sandbox.lastActiveAt) ?? createdAtMs;
    const idleMs = lastActiveAtMs === undefined ? 0 : nowMs - lastActiveAtMs;
    if (phase === 'Running' && host.sandboxIdlePauseMs > 0 && idleMs >= host.sandboxIdlePauseMs) {
      const pausedNow = await host.pauseWhenIdle(sandbox.name, busySandboxNames, (latest) => {
        const current = mergeLatestSandbox(sandbox, latest);
        const currentCreatedAtMs = parseDateMs(current.createdAt);
        const currentLastActiveAtMs = parseDateMs(current.lastActiveAt) ?? currentCreatedAtMs;
        return current.phase === 'Running' && currentLastActiveAtMs !== undefined
          && nowMs - currentLastActiveAtMs >= host.sandboxIdlePauseMs
          && cleanupDeletionReason(host, current, nowMs) === undefined;
      });
      if (pausedNow) paused.push(sandbox.name);
      else skippedBusy.push(sandbox.name);
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

type CleanupDeletionReason = 'broken' | 'expired';

function mergeLatestSandbox(fallback: ManagedSandbox, latest: ManagedSandbox): ManagedSandbox {
  const defined = Object.fromEntries(Object.entries(latest).filter(([, value]) => value !== undefined));
  return { ...fallback, ...defined };
}

function cleanupDeletionReason(
  host: Pick<SandboxCleanupHost, 'lifecyclePolicyMode' | 'sandboxBrokenRecycleGraceMs' | 'sandboxOrphanGraceMs' | 'sandboxTtlMs'>,
  sandbox: ManagedSandbox,
  nowMs: number,
): CleanupDeletionReason | undefined {
  const createdAtMs = parseDateMs(sandbox.createdAt);
  const lastActiveAtMs = parseDateMs(sandbox.lastActiveAt) ?? createdAtMs;
  if (sandbox.brokenReason && host.sandboxBrokenRecycleGraceMs > 0) {
    const brokenSinceMs = Math.max(parseDateMs(sandbox.pausedConditionChangedAt) ?? 0, lastActiveAtMs ?? 0, createdAtMs ?? 0);
    if (brokenSinceMs > 0 && nowMs - brokenSinceMs >= host.sandboxBrokenRecycleGraceMs) return 'broken';
  }
  const lifecycle = decideSandboxLifecycle({ ...sandbox, nowMs });
  const orphanGraceMs = lifecycle.workloadClass === 'probe' ? 5 * 60_000 : host.sandboxOrphanGraceMs;
  const orphanExpired = orphanGraceMs > 0 && !['Running', 'Paused'].includes(sandbox.phase ?? 'Unknown')
    && createdAtMs !== undefined && nowMs - createdAtMs >= orphanGraceMs;
  const legacyExpired = host.sandboxTtlMs > 0 && lastActiveAtMs !== undefined && nowMs - lastActiveAtMs >= host.sandboxTtlMs;
  const policyExpired = host.lifecyclePolicyMode === 'enforce' && lifecycle.delete;
  return orphanExpired || (host.lifecyclePolicyMode === 'shadow' ? legacyExpired : policyExpired) ? 'expired' : undefined;
}
