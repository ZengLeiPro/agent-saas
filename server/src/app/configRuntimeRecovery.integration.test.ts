import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminConfigMutationService, ConfigRuntimeRecoveryError } from '../config/adminConfigMutationService.js';
import type { ConfigRuntimeRecoveryPermit } from '../config/runtimeRecoveryGate.js';
import type { PreparedConfigRecoveryPublication } from '../runtime/configIdentityRuntime.js';
import { InMemorySecretVault } from '../security/secretVault.js';
import { publishAdminCommittedConfigIdentity } from './audioTranscribeAdminRoute.js';
import { parseAppConfig, type AppConfig } from './config.js';
import { initializeRuntimeConfigIdentityAssembly } from './configIdentityAssembly.js';
import { createSharedConfigRefresher } from './sharedConfigRefresher.js';

const roots: string[] = []; // 每个 case 的私有运行态根目录。

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('ConfigRuntimeRecoveryGate integration', () => {
  it('requires the private snapshot to exist and exactly match the in-memory summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'config-identity-snapshot-'));
    roots.push(root);
    const snapshotPath = join(root, 'config-identity.json');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_PATH', snapshotPath);
    const config = parseAppConfig({ agent: { cwd: '/tmp/workspace' }, server: {} });
    const assembly = await initializeRuntimeConfigIdentityAssembly({
      config,
      secretVault: new InMemorySecretVault(),
      processCwd: root,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(assembly.isPrivateSummaryCurrent()).toBe(true);
    await rm(snapshotPath, { force: true });
    expect(assembly.isPrivateSummaryCurrent()).toBe(false);

    const blockedSnapshotPath = join(root, 'snapshot-directory');
    await mkdir(blockedSnapshotPath);
    vi.stubEnv('AGENT_SAAS_CONFIG_IDENTITY_PATH', blockedSnapshotPath);
    const blockedAssembly = await initializeRuntimeConfigIdentityAssembly({
      config,
      secretVault: new InMemorySecretVault(),
      processCwd: root,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    expect(blockedAssembly.isPrivateSummaryCurrent()).toBe(false);
  });

  it('keeps recovery audit and observation commit fail closed until synchronous completion', async () => {
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

    const publishedStatuses: string[] = [];
    const assembly = await initializeRuntimeConfigIdentityAssembly({
      config,
      secretVault: new InMemorySecretVault(),
      processCwd: root,
      logger: { info: vi.fn(), warn: vi.fn() },
      onSummaryUpdated: (summary) => publishedStatuses.push(summary.status),
    });
    const refresher = createSharedConfigRefresher({
      config,
      processCwd: root,
      target: { titleGeneratorConfigs: [], updateGuardrailModelConfigs: vi.fn() },
      prepareSystemPromptOverridesUpdate: () => vi.fn(),
      recoveryGate: assembly.recoveryGate,
      ...assembly.modelResolverHooks,
    });
    const publish = (text: string, recoveryPermit?: ConfigRuntimeRecoveryPermit) =>
      publishAdminCommittedConfigIdentity({
        acknowledgeSharedConfigApplied: refresher.acknowledgeConfigApplied,
        acknowledgeRecoveryConfigApplied: refresher.acknowledgeRecoveryConfigApplied,
        invalidateSharedConfigIdentity: assembly.invalidate,
        notifySharedConfigChanged: assembly.modelResolverHooks.onConfigReloaded,
        prepareSharedConfigIdentityPublication: assembly.prepareRecoveryPublication,
        refreshSharedConfig: refresher.refreshIfChanged,
      }, text, recoveryPermit);
    let recoveryAuditTail: Promise<void> | undefined;
    let recoveryAuditStarted: (() => void) | undefined;
    let returnUntrustedPublication = false;
    let untrustedCommitInvoked = false;
    const service = new AdminConfigMutationService({
      configPath,
      processCwd: root,
      environment: 'staging',
      processRole: 'ws-only',
      recoveryGate: assembly.recoveryGate,
      onCommitted: async (text, recoveryPermit) => {
        const commit = await publish(text, recoveryPermit);
        if (!recoveryPermit || !commit || !returnUntrustedPublication) return commit;
        return (async () => {
          untrustedCommitInvoked = true;
          commit.commit();
          await Promise.resolve();
        }) as unknown as PreparedConfigRecoveryPublication;
      },
      onRuntimeDirty: assembly.invalidate,
      auditAppender: async (path, line) => {
        const record = JSON.parse(line) as { result?: string };
        if (record.result === 'recovered' && recoveryAuditTail) {
          recoveryAuditStarted?.();
          await recoveryAuditTail;
        }
        await appendFile(path, line, { encoding: 'utf8', mode: 0o600 });
      },
    });

    const rollback = deferred();
    const rollbackEntered = deferred();
    let applyCall = 0;
    const originalApplyRuntime = vi.fn(async (next: AppConfig) => {
      applyCall += 1;
      if (applyCall === 1) {
        config.agent.maxTurns = 40;
        throw new Error('candidate partially applied');
      }
      if (applyCall === 2) {
        config.agent.maxTurns = 25;
        rollbackEntered.resolve();
        await rollback.promise;
      }
      config.agent.maxTurns = next.agent.maxTurns;
    });

    const failedMutation = service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 40, {})),
      applyRuntime: originalApplyRuntime,
    });
    await rollbackEntered.promise;

    expect(assembly.recoveryGate.isDirty()).toBe(true);
    expect(assembly.getSummary().status).toBe('not_collected');
    expect(refresher.refreshIfChanged(true)).toBe(false);
    expect(refresher.acknowledgeConfigApplied(originalText)).toBe(false);
    assembly.modelResolverHooks.onConfigReloaded();
    expect(assembly.getSummary().status).toBe('not_collected');

    rollback.reject(new Error('rollback partially applied'));
    await expect(failedMutation).rejects.toBeInstanceOf(ConfigRuntimeRecoveryError);

    const recoveryAudit = deferred();
    const recoveryAuditEntered = deferred();
    recoveryAuditTail = recoveryAudit.promise;
    recoveryAuditStarted = recoveryAuditEntered.resolve;
    const blockedBuildCandidate = vi.fn((text: string) => text);
    const blockedApplyRuntime = vi.fn();
    const blockedMutation = service.mutate({
      actor: 'admin-2',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: blockedBuildCandidate,
      applyRuntime: blockedApplyRuntime,
    });
    await recoveryAuditEntered.promise;

    expect(assembly.recoveryGate.isDirty()).toBe(true);
    expect(refresher.refreshIfChanged(true)).toBe(false);
    expect(refresher.acknowledgeConfigApplied(originalText)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(assembly.getSummary().status).toBe('not_collected');

    recoveryAudit.reject(new Error('recovery audit failed'));
    await expect(blockedMutation).rejects.toBeInstanceOf(ConfigRuntimeRecoveryError);
    expect(assembly.recoveryGate.isDirty()).toBe(true);
    expect(assembly.getSummary().status).toBe('not_collected');
    expect(blockedBuildCandidate).not.toHaveBeenCalled();
    expect(blockedApplyRuntime).not.toHaveBeenCalled();

    recoveryAuditTail = undefined;
    recoveryAuditStarted = undefined;
    const beforeUntrustedAttempt = assembly.getSummary();
    const untrustedSequenceStart = publishedStatuses.length;
    returnUntrustedPublication = true;
    const asyncCommitBuildCandidate = vi.fn((text: string) => text);
    await expect(service.mutate({
      actor: 'admin-3',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: asyncCommitBuildCandidate,
      applyRuntime: vi.fn(),
    })).rejects.toBeInstanceOf(ConfigRuntimeRecoveryError);
    await Promise.resolve();
    expect(assembly.recoveryGate.isDirty()).toBe(true);
    const afterUntrustedAttempt = assembly.getSummary();
    expect(afterUntrustedAttempt.status).toBe('not_collected');
    expect(afterUntrustedAttempt.lastObservedAt).toBe(beforeUntrustedAttempt.lastObservedAt);
    expect(afterUntrustedAttempt.lastChangedAt).toBe(beforeUntrustedAttempt.lastChangedAt);
    expect(untrustedCommitInvoked).toBe(false);
    expect(publishedStatuses.slice(untrustedSequenceStart)).not.toContain('consistent');
    expect(asyncCommitBuildCandidate).not.toHaveBeenCalled();

    returnUntrustedPublication = false;
    const nextApplyRuntime = vi.fn(async (next: AppConfig) => {
      config.agent.maxTurns = next.agent.maxTurns;
    });
    await service.mutate({
      actor: 'admin-4',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 30, {})),
      applyRuntime: nextApplyRuntime,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(originalApplyRuntime).toHaveBeenCalledTimes(5);
    expect(originalApplyRuntime.mock.calls[4]?.[0].agent.maxTurns).toBe(20);
    expect(assembly.recoveryGate.isDirty()).toBe(false);
    expect(nextApplyRuntime).toHaveBeenCalledOnce();
    expect(config.agent.maxTurns).toBe(30);
    expect(assembly.getSummary().status).not.toBe('not_collected');
  });
});
