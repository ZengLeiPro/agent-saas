import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyRuntimeConfigPatch,
  parseRuntimeConfigPatch,
  runtimeConfigSnapshot,
  type AcsOrchestratorConfig,
} from './config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): AcsOrchestratorConfig {
  const root = mkdtempSync(join(tmpdir(), 'acs-drain-budget-'));
  roots.push(root);
  return {
    maxRunningSandboxes: 8,
    warnRunningSandboxes: 6,
    drainDeadlineMs: 120_000,
    runtimeConfigPath: join(root, 'runtime.json'),
  } as AcsOrchestratorConfig;
}

describe('independent deployment drain budget', () => {
  it('does not stretch SNAT maintenance when deployment wait is changed and reloaded', () => {
    const config = fixture();
    expect(runtimeConfigSnapshot(config).deploymentDrainDeadlineMs).toBe(1_140_000);
    applyRuntimeConfigPatch(
      config,
      parseRuntimeConfigPatch({ deploymentDrainDeadlineMs: 1_200_000 }),
    );
    expect(config.drainDeadlineMs).toBe(120_000);
    const persisted = JSON.parse(readFileSync(config.runtimeConfigPath!, 'utf8'));
    expect(persisted).toMatchObject({
      drainDeadlineMs: 120_000,
      deploymentDrainDeadlineMs: 1_200_000,
    });
    const reloaded = fixture();
    applyRuntimeConfigPatch(reloaded, parseRuntimeConfigPatch(persisted));
    expect(runtimeConfigSnapshot(reloaded)).toMatchObject({
      drainDeadlineMs: 120_000,
      deploymentDrainDeadlineMs: 1_200_000,
    });
    applyRuntimeConfigPatch(reloaded, { drainDeadlineMs: 300_000 });
    expect(reloaded.deploymentDrainDeadlineMs).toBe(1_200_000);
  });

  it('restores legacy persisted settings without deriving deployment wait from SNAT wait', () => {
    const config = fixture();
    writeFileSync(config.runtimeConfigPath!, JSON.stringify({ drainDeadlineMs: 900_000 }));
    applyRuntimeConfigPatch(
      config,
      parseRuntimeConfigPatch(JSON.parse(readFileSync(config.runtimeConfigPath!, 'utf8'))),
    );
    expect(runtimeConfigSnapshot(config)).toMatchObject({
      drainDeadlineMs: 900_000,
      deploymentDrainDeadlineMs: 1_140_000,
    });
  });

  it('rejects malformed or unbounded budgets rather than coercing them', () => {
    for (const value of [null, '', '120000', 999, 1_000.5, 86_400_001, NaN, Infinity]) {
      expect(() => parseRuntimeConfigPatch({ deploymentDrainDeadlineMs: value })).toThrow(
        /deploymentDrainDeadlineMs/,
      );
    }
    for (const value of [1_000, 1_140_000, 86_400_000]) {
      expect(parseRuntimeConfigPatch({ deploymentDrainDeadlineMs: value })).toEqual({
        deploymentDrainDeadlineMs: value,
      });
    }
  });
});
