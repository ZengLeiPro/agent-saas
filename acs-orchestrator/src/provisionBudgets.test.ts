import { describe, expect, it } from 'vitest';
import { provisionBudgets, setupCommandBudgetMs } from './provisionBudgets.js';
import type { WorkspaceRecipe } from './protocol.js';

describe('R09 R18 provisioning phase budget sum', () => {
  it('preserves every legal setup step instead of applying a drain-sized total cap', () => {
    const recipe = { workspaceId: 'test', resources: { timeoutMs: 600_000 }, setupCommands: Array(8).fill('fixture') } as WorkspaceRecipe;
    const budget = provisionBudgets(recipe);
    expect(budget.setupSteps).toBe(8);
    expect(budget.totalMs).toBeGreaterThan(80 * 60_000);
    expect(budget.totalMs).toBe(budget.ensureMs + budget.isolationMs + budget.bootstrapMs + budget.setupTotalMs + budget.receiptMs);
  });
  it('uses the exact runtime clamp, counts hydration and accounts for local cleanup', () => {
    expect(setupCommandBudgetMs(undefined)).toBe(60_000);
    expect(setupCommandBudgetMs(1)).toBe(1_000);
    expect(setupCommandBudgetMs(900_000)).toBe(600_000);
    const budget = provisionBudgets({ workspaceId: 'test', repo: { url: 'https://example.invalid/repo' }, files: [{ path: 'a', artifactId: 'fixture' }], setupCommands: ['fixture'] } as WorkspaceRecipe);
    expect(budget.setupSteps).toBe(3);
    expect(budget.setupTotalMs).toBe(3 * 64_000);
  });
});
