import type { AcsOrchestratorConfig } from './config.js';
import { MAX_BACKGROUND_SHELL_TIMEOUT_MS } from './backgroundShell.js';
import { establishInvocationCompletionFence } from './invocationCompletionRecovery.js';
import type { SandboxManager, SandboxRef } from './sandboxManager.js';
import type { ActiveInvocationLeaseSnapshot } from './sandboxLifecyclePolicy.js';
import type { ManagedSandbox } from './sandboxState.js';

const UNKNOWN_BACKGROUND_SHELL_PROTECTION_MS = 2 * MAX_BACKGROUND_SHELL_TIMEOUT_MS;

type BackgroundInventory = { protectedUntil?: string; activeTaskIds: string[] };

type RestartRecoveryInput = {
  config: AcsOrchestratorConfig;
  sandboxManager: SandboxManager;
  logger: { info(msg: string): void; warn(msg: string): void };
  inventory(ref: SandboxRef): Promise<BackgroundInventory>;
  reconcilePersistedProtection(sandbox: ManagedSandbox): Promise<void>;
  now?: Date;
};

/**
 * Reconciles persisted invocation ownership after an orchestrator restart.
 * The list result is the immutable first snapshot: no residue is swept before
 * completion/background recovery and strict inventory consume every lease value and deadline.
 */
export async function reconcileInvocationRestartRecovery(
  input: RestartRecoveryInput,
): Promise<{ checked: number; failed: number }> {
  const sandboxes = await input.sandboxManager.listManagedSandboxes();
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  let failed = 0;

  for (const sandbox of sandboxes) {
    let sandboxFailed = false;
    const snapshots = sandbox.activeInvocationLeases
      ? [...sandbox.activeInvocationLeases]
      : undefined;

    // Compatibility for older tests/callers that project only the aggregate deadline.
    if (!snapshots) {
      try {
        const { active } = await input.sandboxManager.clearExpiredInvocationLeases(sandbox.name, now, sandbox.uid);
        if (!sandbox.backgroundShellProtectedUntil && !active) continue;
        await input.reconcilePersistedProtection(sandbox);
      } catch (err) {
        sandboxFailed = true;
        input.logger.warn(`invocation_restart_recovery_failed sandbox=${sandbox.name}: ${errorMessage(err)}`);
      }
      if (sandboxFailed) failed += 1;
      continue;
    }

    const valid = snapshots.filter((lease) => !lease.malformed);
    const malformed = snapshots.filter((lease) => lease.malformed);
    const completionPending = valid.filter((lease) => lease.state === 'completion_pending');
    const backgroundCandidates = valid.filter((lease) => lease.state === 'background_pending'
      || (lease.state === 'executing' && leaseExpired(lease, nowMs)));

    for (const lease of completionPending) {
      try {
        if (!sandbox.uid || !lease.invocationKey || !lease.completedAt) throw new Error('completion_pending lease 缺少 UID/invocationKey/completedAt');
        await input.sandboxManager.completeInvocation(
          sandbox.name, lease.invocationKey, new Date(lease.completedAt), sandbox.uid,
        );
        input.logger.info(`invocation_restart_completion_recovered sandbox=${sandbox.name}`);
      } catch (err) {
        sandboxFailed = true;
        input.logger.warn(`invocation_restart_completion_failed sandbox=${sandbox.name}: ${errorMessage(err)}`);
      }
    }

    let unresolvedLease = backgroundCandidates.some(
      (lease) => lease.state === 'background_pending' && !leaseExpired(lease, nowMs),
    );
    if (backgroundCandidates.length > 0 || malformed.length > 0) {
      try {
        const ref = sandboxRef(input.sandboxManager, sandbox);
        if (!sandbox.uid) throw new Error('Sandbox lease snapshot 缺少 UID');
        const inventory = await input.inventory(ref);
        validateInventory(inventory);
        const recoveredAt = input.now ?? new Date();
        const recoveredAtMs = recoveredAt.getTime();
        const active = inventory.activeTaskIds.length > 0;
        if (active) {
          const protectedUntil = safeProtectionDeadline(inventory.protectedUntil, recoveredAtMs)
            ?? new Date(recoveredAtMs + UNKNOWN_BACKGROUND_SHELL_PROTECTION_MS).toISOString();
          await input.sandboxManager.setBackgroundShellProtection(
            sandbox.name, protectedUntil, sandbox.uid, undefined,
            backgroundCandidates[0]?.invocationKey,
          );
          const confirmedAtMs = input.now?.getTime() ?? Date.now();
          if (!safeProtectionDeadline(protectedUntil, confirmedAtMs)) {
            throw new Error('background protection expired before persistence confirmation');
          }
        }
        for (const lease of backgroundCandidates) {
          if (!lease.invocationKey) throw new Error('recoverable lease 缺少 invocationKey');
          if (!active && lease.state === 'background_pending' && !leaseExpired(lease, nowMs)) {
            // A newly detached worker may not yet have published its inventory file.
            continue;
          }
          await persistAndComplete(input, sandbox.name, sandbox.uid, lease.invocationKey, recoveredAt);
        }
        if (malformed.length > 0) {
          // Unknown ownership is released only after strict inventory succeeds. Refreshing
          // activity first prevents a no-worker residue from exposing an old TTL edge.
          if (!active) await input.sandboxManager.touch(sandbox.name, recoveredAt, sandbox.uid);
          await input.sandboxManager.clearMalformedInvocationLeases(sandbox.name, sandbox.uid, recoveredAt);
        }
      } catch (err) {
        unresolvedLease = true;
        sandboxFailed = true;
        input.logger.warn(`invocation_restart_background_failed sandbox=${sandbox.name}: ${errorMessage(err)}`);
      }
    }

    if (sandbox.backgroundShellProtectedUntil && !unresolvedLease && backgroundCandidates.length === 0) {
      try {
        await input.reconcilePersistedProtection(sandbox);
      } catch (err) {
        sandboxFailed = true;
        input.logger.warn(`background_shell_reconcile_failed sandbox=${sandbox.name}: ${errorMessage(err)}`);
      }
    }
    if (sandboxFailed) failed += 1;
  }
  return { checked: sandboxes.length, failed };
}

async function persistAndComplete(
  input: RestartRecoveryInput,
  sandboxName: string,
  expectedUid: string,
  invocationKey: string,
  completedAt: Date,
): Promise<void> {
  await establishInvocationCompletionFence(
    input.config, input.sandboxManager, sandboxName, invocationKey, expectedUid, completedAt,
  );
  await input.sandboxManager.completeInvocation(sandboxName, invocationKey, completedAt, expectedUid);
}

function sandboxRef(manager: SandboxManager, sandbox: ManagedSandbox): SandboxRef {
  if (!sandbox.workspaceId || !sandbox.sessionId) throw new Error('Sandbox 缺少 workspace/session identity');
  const ref = manager.ref({
    workspaceId: sandbox.workspaceId,
    sessionId: sandbox.sessionId,
    sandboxScopeId: sandbox.sandboxScopeId,
    mountSubPath: sandbox.mountSubPath,
  });
  if (ref.name !== sandbox.name) throw new Error(`Sandbox identity/name mismatch: ${ref.name}`);
  return ref;
}

function leaseExpired(lease: ActiveInvocationLeaseSnapshot, nowMs: number): boolean {
  const untilMs = lease.until ? Date.parse(lease.until) : Number.NaN;
  return !Number.isFinite(untilMs) || untilMs <= nowMs;
}

function safeProtectionDeadline(value: string | undefined, nowMs: number): string | undefined {
  if (!value) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > nowMs + 5_000 ? value : undefined;
}

function validateInventory(inventory: BackgroundInventory): void {
  if (!Array.isArray(inventory.activeTaskIds)
    || inventory.activeTaskIds.some((taskId) => typeof taskId !== 'string')) {
    throw new Error('strict background inventory 未返回合法 activeTaskIds');
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
