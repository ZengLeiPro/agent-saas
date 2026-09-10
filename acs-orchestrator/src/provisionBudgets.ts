import type { WorkspaceRecipe } from './protocol.js';
import { OWNED_WAIT_BUDGETS } from './ownedWait.js';

export const SETUP_DEFAULT_TIMEOUT_MS = 60_000;
export const RUNTIME_BOOTSTRAP_TIMEOUT_MS = 360_000;

export function setupCommandBudgetMs(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return SETUP_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(1_000, Math.floor(requested)), 600_000);
}

/** The sum of independently legal phases, never the deployment drain window. */
export function provisionBudgets(recipe: WorkspaceRecipe) {
  const setupMs = setupCommandBudgetMs(recipe.resources?.timeoutMs);
  const setupSteps = Number(Boolean(recipe.repo)) + (recipe.files?.length ?? 0) + (recipe.setupCommands?.length ?? 0);
  const transportCleanupMs = OWNED_WAIT_BUDGETS.termGraceMs + OWNED_WAIT_BUDGETS.killGraceMs;
  const ensureMs = OWNED_WAIT_BUDGETS.ensureMs;
  const isolationMs = recipe.runtimeIsolationRequirement ? OWNED_WAIT_BUDGETS.ensureMs : 0;
  const bootstrapMs = Math.max(setupMs, RUNTIME_BOOTSTRAP_TIMEOUT_MS) + transportCleanupMs;
  const setupTotalMs = setupSteps * (setupMs + transportCleanupMs);
  // One hash read, one write and final ownership publication each have their own budget.
  const receiptMs = 3 * (OWNED_WAIT_BUDGETS.persistenceMs + transportCleanupMs);
  const totalMs = ensureMs + isolationMs + bootstrapMs + setupTotalMs + receiptMs;
  if (!Number.isSafeInteger(totalMs) || totalMs > 2_147_483_647) {
    throw new RangeError('Provision recipe exceeds the supported monotonic timer range');
  }
  return { ensureMs, isolationMs, bootstrapMs, setupMs, setupSteps, setupTotalMs, receiptMs, totalMs };
}
