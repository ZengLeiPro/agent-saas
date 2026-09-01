import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminConfigMutationService, ConfigRuntimeRecoveryError } from '../config/adminConfigMutationService.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { publishAdminCommittedConfigIdentity } from './audioTranscribeAdminRoute.js';
import { parseAppConfig, type AppConfig } from './config.js';
import { initializeRuntimeConfigIdentityAssembly } from './configIdentityAssembly.js';
import { createSharedConfigRefresher } from './sharedConfigRefresher.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ConfigRuntimeRecoveryGate integration', () => {
  it('keeps service, refresher and ConfigIdentity fail closed until the original recipe recovers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-runtime-recovery-'));
    roots.push(root);
    await mkdir(join(root, 'data'));
    const configPath = join(root, 'config.json');
    const originalRaw = {
      agent: { cwd: '/tmp/workspace', maxTurns: 20, permissionMode: 'default' },
      server: { port: 3000 },
    };
    const originalText = `${JSON.stringify(originalRaw, null, 2)}\n`;
    await writeFile(configPath, originalText);
    const config = parseAppConfig(originalRaw);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AGENT_SAAS_CONFIG_PATH', configPath);

    const assembly = await initializeRuntimeConfigIdentityAssembly({
      config,
      secretVault: new InMemorySecretVault(),
      processCwd: root,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: root,
      target: { titleGeneratorConfigs: [], updateGuardrailModelConfigs: vi.fn() },
      prepareSystemPromptOverridesUpdate: () => vi.fn(),
      recoveryGate: assembly.recoveryGate,
      ...assembly.modelResolverHooks,
    });
    const publish = (text: string) => publishAdminCommittedConfigIdentity({
      acknowledgeSharedConfigApplied: refresher.acknowledgeConfigApplied,
      invalidateSharedConfigIdentity: assembly.invalidate,
      notifySharedConfigChanged: assembly.modelResolverHooks.onConfigReloaded,
      refreshSharedConfig: refresher.refreshIfChanged,
    }, text);
    const service = new AdminConfigMutationService({
      configPath,
      processCwd: root,
      environment: 'staging',
      processRole: 'ws-only',
      recoveryGate: assembly.recoveryGate,
      onCommitted: publish,
      onRuntimeDirty: assembly.invalidate,
    });

    let applyCall = 0;
    const originalApplyRuntime = vi.fn(async (next: AppConfig) => {
      applyCall += 1;
      if (applyCall === 1) {
        config.agent.maxTurns = 40;
        throw new Error('candidate partially applied');
      }
      if (applyCall === 2) {
        config.agent.maxTurns = 25;
        throw new Error('rollback partially applied');
      }
      config.agent.maxTurns = next.agent.maxTurns;
    });

    await expect(service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 40, {})),
      applyRuntime: originalApplyRuntime,
    })).rejects.toBeInstanceOf(ConfigRuntimeRecoveryError);

    expect(assembly.recoveryGate.isDirty()).toBe(true);
    expect(assembly.getSummary().status).toBe('not_collected');
    expect(refresher.refreshIfChanged(true)).toBe(false);
    expect(refresher.acknowledgeConfigApplied(originalText)).toBe(false);
    assembly.modelResolverHooks.onConfigReloaded();
    expect(assembly.getSummary().status).toBe('not_collected');

    const nextApplyRuntime = vi.fn(async (next: AppConfig) => {
      config.agent.maxTurns = next.agent.maxTurns;
    });
    await service.mutate({
      actor: 'admin-2',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 30, {})),
      applyRuntime: nextApplyRuntime,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(originalApplyRuntime).toHaveBeenCalledTimes(3);
    expect(originalApplyRuntime.mock.calls[2]?.[0].agent.maxTurns).toBe(20);
    expect(assembly.recoveryGate.isDirty()).toBe(false);
    expect(nextApplyRuntime).toHaveBeenCalledOnce();
    expect(config.agent.maxTurns).toBe(30);
    expect(assembly.getSummary().status).not.toBe('not_collected');
  });
});
