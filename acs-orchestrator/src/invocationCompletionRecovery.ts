import type { AcsOrchestratorConfig } from './config.js';
import type { SandboxManager } from './sandboxManager.js';

const MUTATION_CONFIRM_MARGIN_MS = 5_000;

export type CompletionRecoveryInput = {
  config: AcsOrchestratorConfig;
  sandboxManager: SandboxManager;
  sandboxName: string;
  leaseKey: string;
  expectedUid: string;
  completedAt: Date;
  retryMs: number;
  logger: { info(msg: string): void; warn(msg: string): void };
};

/** Covers three status+patch attempts for both the fence CAS and completion CAS. */
export async function establishInvocationCompletionFence(
  config: AcsOrchestratorConfig,
  sandboxManager: SandboxManager,
  name: string,
  leaseKey: string,
  expectedUid: string,
  completedAt: Date,
): Promise<void> {
  const mutationWindowMs = 3 * (15_000 + Math.max(1, config.sandboxWaitTimeoutMs));
  const requiredRemainingMs = mutationWindowMs + MUTATION_CONFIRM_MARGIN_MS;
  const leaseUntilMs = Date.now() + mutationWindowMs + requiredRemainingMs;
  await sandboxManager.setActiveInvocationLease(
    name, leaseKey, new Date(leaseUntilMs).toISOString(), expectedUid, undefined,
    'completion_pending', completedAt.toISOString(),
  );
  if (leaseUntilMs - Date.now() < requiredRemainingMs) {
    throw new Error('invocation completion fence expired before persistence confirmation');
  }
}

export async function recoverInvocationCompletion(input: CompletionRecoveryInput): Promise<void> {
  const { config, sandboxManager, sandboxName, leaseKey, expectedUid, completedAt, logger } = input;
  for (;;) {
    try {
      if (!await mutableOriginalExists(sandboxManager, sandboxName, expectedUid)) {
        logger.info(`invocation_completion_recovery_original_gone sandbox=${sandboxName}`);
        return;
      }
    } catch (err) {
      logger.warn(`invocation_completion_recovery_uid_check_failed sandbox=${sandboxName}: ${errorMessage(err)}`);
      await unrefDelay(input.retryMs);
      continue;
    }
    try {
      await establishInvocationCompletionFence(config, sandboxManager, sandboxName, leaseKey, expectedUid, completedAt);
      await sandboxManager.completeInvocation(sandboxName, leaseKey, completedAt, expectedUid);
      logger.info(`invocation_completion_recovery_completed sandbox=${sandboxName}`);
      return;
    } catch (err) {
      logger.warn(`invocation_completion_recovery_retry sandbox=${sandboxName}: ${errorMessage(err)}`);
      await unrefDelay(input.retryMs);
    }
  }
}

export async function recoverHousekeepingLeaseClear(
  input: Omit<CompletionRecoveryInput, 'config' | 'completedAt'>,
): Promise<void> {
  const { sandboxManager, sandboxName, leaseKey, expectedUid, logger } = input;
  for (;;) {
    try {
      if (!await mutableOriginalExists(sandboxManager, sandboxName, expectedUid)) {
        logger.info(`invocation_housekeeping_clear_recovery_original_gone sandbox=${sandboxName}`);
        return;
      }
      await sandboxManager.setActiveInvocationLease(sandboxName, leaseKey, undefined, expectedUid);
      logger.info(`invocation_housekeeping_clear_recovery_completed sandbox=${sandboxName}`);
      return;
    } catch (err) {
      logger.warn(`invocation_housekeeping_clear_recovery_retry sandbox=${sandboxName}: ${errorMessage(err)}`);
      await unrefDelay(input.retryMs);
    }
  }
}

async function mutableOriginalExists(
  sandboxManager: SandboxManager,
  name: string,
  expectedUid: string,
): Promise<boolean> {
  const manager = sandboxManager as SandboxManager & {
    getMutableSandboxUid?: (sandboxName: string) => Promise<string | null>;
  };
  const currentUid = typeof manager.getMutableSandboxUid === 'function'
    ? await manager.getMutableSandboxUid(name)
    : await manager.getSandboxUid(name);
  return currentUid === expectedUid;
}

function unrefDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
