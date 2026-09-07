import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAppConfig, type AppConfig } from '../app/config.js';
import {
  ConfigRuntimeRecoveryGate,
  type ConfigRuntimeRecoveryPermit,
} from '../config/runtimeRecoveryGate.js';
import {
  createConfigIdentityRuntime,
  type PreparedConfigRecoveryPublication,
} from '../runtime/configIdentityRuntime.js';
import { CredentialResolutionError } from '../security/credentialResolutionError.js';
import {
  AdminConfigMutationService,
  ConfigConflictError,
  ConfigMutationCommittedError,
  ProductionConfigPublishRequiredError,
  ConfigRuntimeRecoveryError,
  configFingerprint,
} from '../config/adminConfigMutationService.js';

const roots: string[] = [];

type PublicationCallback = (
  candidateText: string,
  recoveryPermit?: ConfigRuntimeRecoveryPermit,
) => void | PreparedConfigRecoveryPublication
  | Promise<void | PreparedConfigRecoveryPublication>;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(callbacks: {
  recoveryGate?: ConfigRuntimeRecoveryGate;
  onCommitted?: PublicationCallback;
  onRuntimeDirty?: () => void;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'admin-config-mutation-'));
  roots.push(root);
  await mkdir(join(root, 'data'));
  const configPath = join(root, 'config.json');
  const raw = {
    agent: { cwd: '/tmp/workspace', maxTurns: 20, permissionMode: 'default' },
    server: { port: 3000 },
  };
  await writeFile(configPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o640 });
  let nowOffsetMs = 0;
  const service = new AdminConfigMutationService({
    configPath,
    processCwd: root,
    environment: 'staging',
    processRole: 'ws-only',
    now: () => new Date(Date.parse('2026-09-01T00:00:00.000Z') + nowOffsetMs++),
    ...callbacks,
  });
  return { root, configPath, raw, service };
}

describe('AdminConfigMutationService', () => {
  it('生产 Runtime 拒绝普通在线写盘，要求受控配置发布', async () => {
    const test = await fixture();
    const service = new AdminConfigMutationService({
      configPath: test.configPath,
      processCwd: test.root,
      environment: 'production',
      processRole: 'ws-only',
    });
    const error = await service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => text,
      applyRuntime: () => {},
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProductionConfigPublishRequiredError);
    expect(error).toMatchObject({ code: 'PRODUCTION_CONFIG_PUBLISH_REQUIRED' });
  });

  it('atomically applies a validated update and records a redacted audit', async () => {
    const test = await fixture();
    const applyRuntime = vi.fn();
    const result = await test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      expectedFingerprint: configFingerprint(test.raw),
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 30, {})),
      applyRuntime,
    });
    expect(result.config.agent.maxTurns).toBe(30);
    expect(applyRuntime).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(test.configPath, 'utf8')).agent.maxTurns).toBe(30);
    const audit = await readFile(join(test.root, 'data/config-governance/audit.jsonl'), 'utf8');
    expect(audit).toContain('"result":"applied"');
    expect(audit).toContain('agent.maxTurns');
    expect(await readdir(join(test.root, 'data/config-governance/backups'))).toHaveLength(1);
  });

  it('reports publication failure as committed without rolling back durable/runtime state', async () => {
    const publicationError = new Error('forced publication failure');
    const test = await fixture({ onCommitted: vi.fn().mockRejectedValue(publicationError) });
    const applyRuntime = vi.fn();

    const error = await test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 30, {})),
      applyRuntime,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigMutationCommittedError);
    expect(error).toMatchObject({ cause: publicationError, code: 'CONFIG_MUTATION_COMMITTED' });
    expect(applyRuntime).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(test.configPath, 'utf8')).agent.maxTurns).toBe(30);
    const audit = await readFile(join(test.root, 'data/config-governance/audit.jsonl'), 'utf8');
    expect(audit).toContain('"result":"applied"');
  });

  it('serializes concurrent service instances with the shared OS guard', async () => {
    const test = await fixture();
    const second = new AdminConfigMutationService({
      configPath: test.configPath,
      processCwd: test.root,
      environment: 'staging',
      processRole: 'ws-only',
    });
    let releaseRuntime!: () => void;
    let markRuntimeEntered!: () => void;
    const runtimeEntered = new Promise<void>((resolve) => {
      markRuntimeEntered = resolve;
    });
    const holdRuntime = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const firstMutation = test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 21, {})),
      applyRuntime: async () => {
        markRuntimeEntered();
        await holdRuntime;
      },
    });
    await runtimeEntered;
    const secondBuild = vi.fn((text: string) => text);
    await expect(second.mutate({
      actor: 'admin-2',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: secondBuild,
      applyRuntime: vi.fn(),
    })).rejects.toBeInstanceOf(ConfigConflictError);
    expect(secondBuild).not.toHaveBeenCalled();
    releaseRuntime();
    await firstMutation;
  });

  it('does not reclaim a stale-looking deployment lock while its owner pid is alive', async () => {
    const test = await fixture();
    const lockPath = join(test.root, 'data/config-governance/config.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      createdAt: '2020-01-01T00:00:00.000Z',
      token: 'deploy-owner',
    }));
    await utimes(lockPath, new Date(0), new Date(0));
    const buildCandidate = vi.fn((text: string) => text);

    await expect(test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate,
      applyRuntime: vi.fn(),
    })).rejects.toBeInstanceOf(ConfigConflictError);
    expect(buildCandidate).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))).toMatchObject({
      token: 'deploy-owner',
    });
  });

  it('reclaims a stale lock under the OS guard only after its recorded owner process is dead', async () => {
    const test = await fixture();
    const lockPath = join(test.root, 'data/config-governance/config.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      pid: 2_147_483_647,
      createdAt: '2020-01-01T00:00:00.000Z',
      token: 'dead-owner',
    }));
    await utimes(lockPath, new Date(0), new Date(0));

    await expect(test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => text,
      applyRuntime: vi.fn(),
    })).resolves.toBeDefined();
  });

  it('does not delete a replacement lock owner during release', async () => {
    const test = await fixture();
    const lockPath = join(test.root, 'data/config-governance/config.lock');
    // Simulate ownership replacement after the runtime transition but before finally releases.
    await test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 21, {})),
      applyRuntime: async () => {
        await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          token: 'replacement-owner',
        }));
      },
    });
    expect(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8'))).toMatchObject({
      token: 'replacement-owner',
    });
  });

  it('rejects a stale optimistic fingerprint without touching the file', async () => {
    const test = await fixture();
    await expect(
      test.service.mutate({
        actor: 'admin-1',
        changedPaths: ['agent.maxTurns'],
        expectedFingerprint: `sha256:${'0'.repeat(64)}`,
        buildCandidate: (text) => text,
        applyRuntime: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(ConfigConflictError);
    expect(JSON.parse(await readFile(test.configPath, 'utf8')).agent.maxTurns).toBe(20);
  });

  it('restores the previous file and runtime when apply fails', async () => {
    const test = await fixture();
    const applyRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime rejected candidate'))
      .mockResolvedValueOnce(undefined);
    await expect(
      test.service.mutate({
        actor: 'admin-1',
        changedPaths: ['agent.maxTurns'],
        buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 40, {})),
        applyRuntime,
      }),
    ).rejects.toThrow('runtime rejected candidate');
    expect(JSON.parse(await readFile(test.configPath, 'utf8')).agent.maxTurns).toBe(20);
    expect(applyRuntime).toHaveBeenCalledTimes(2);
    const audit = await readFile(join(test.root, 'data/config-governance/audit.jsonl'), 'utf8');
    expect(audit).toContain('"result":"rolled_back"');
  });

  it('writes only the safe credential resolution error to rollback audit', async () => {
    const test = await fixture();
    const rawRef = 'vault://sensitive-runtime-ref';
    const rawVaultDetail = 'upstream returned secret material';
    const safeError = new CredentialResolutionError('webTools.search.apiKeyRef');
    // 模拟 resolver 已在 Vault 边界丢弃 raw ref 与底层错误，再触发真实 runtime rollback。
    expect(JSON.stringify(safeError)).not.toContain(rawRef);
    expect(JSON.stringify(safeError)).not.toContain(rawVaultDetail);
    const applyRuntime = vi.fn()
      .mockRejectedValueOnce(safeError)
      .mockResolvedValueOnce(undefined);

    await expect(test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['webTools.search.apiKeyRef'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 21, {})),
      applyRuntime,
    })).rejects.toMatchObject({ code: 'CREDENTIAL_RESOLUTION_FAILED' });

    const audit = await readFile(join(test.root, 'data/config-governance/audit.jsonl'), 'utf8');
    expect(audit).toContain('CredentialResolutionError: webTools.search.apiKeyRef 凭据解析失败');
    expect(audit).not.toContain(rawRef);
    expect(audit).not.toContain(rawVaultDetail);
  });

  it('keeps the shared gate closed until rollback audit and observation commit both succeed', async () => {
    const recoveryGate = new ConfigRuntimeRecoveryGate();
    const identityRuntime = createConfigIdentityRuntime({
      config: parseAppConfig({ agent: { cwd: '/tmp/workspace' }, server: {} }),
      environment: 'test',
    });
    await identityRuntime.initialize();
    const onCommitted = vi.fn(async (_text: string, permit?: ConfigRuntimeRecoveryPermit) => {
      expect(recoveryGate.isDirty()).toBe(true);
      expect(recoveryGate.allowsRecoveryCompletion(permit)).toBe(true);
      return await identityRuntime.prepareConfigChanged('rollback_test');
    });
    const test = await fixture({ recoveryGate, onCommitted });
    const applyRuntime = vi
      .fn()
      .mockRejectedValueOnce(new Error('runtime rejected candidate'))
      .mockResolvedValueOnce(undefined);

    await expect(test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 40, {})),
      applyRuntime,
    })).rejects.toThrow('runtime rejected candidate');

    expect(onCommitted).toHaveBeenCalledOnce();
    expect(identityRuntime.getSummary().status).not.toBe('not_collected');
    expect(recoveryGate.isDirty()).toBe(false);
  });

  it('keeps the shared gate closed when recovery publication is missing, prepare fails or value is untrusted', async () => {
    const failures = [
      {
        phase: 'missing', expectedError: '未返回受信 prepared publication',
        onCommitted: () => undefined,
      },
      {
        phase: 'prepare', expectedError: 'prepare publication failed',
        onCommitted: () => { throw new Error('prepare publication failed'); },
      },
      {
        phase: 'untrusted-callback', expectedError: '未返回受信 prepared publication',
        onCommitted: (() => async () => { await Promise.resolve(); }) as unknown as PublicationCallback,
      },
    ] as const;

    for (const failure of failures) {
      const recoveryGate = new ConfigRuntimeRecoveryGate();
      const onRuntimeDirty = vi.fn();
      const test = await fixture({
        recoveryGate,
        onCommitted: failure.onCommitted,
        onRuntimeDirty,
      });
      const applyRuntime = vi
        .fn()
        .mockRejectedValueOnce(new Error(`candidate failed before ${failure.phase}`))
        .mockResolvedValueOnce(undefined);

      const error = await test.service.mutate({
        actor: `admin-${failure.phase}`,
        changedPaths: ['agent.maxTurns'],
        buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 40, {})),
        applyRuntime,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConfigRuntimeRecoveryError);
      expect(recoveryGate.isDirty()).toBe(true);
      expect(onRuntimeDirty).toHaveBeenCalledTimes(2);
      expect((error as ConfigRuntimeRecoveryError).recoveryError).toEqual(
        expect.objectContaining({ message: expect.stringContaining(failure.expectedError) }),
      );
    }
  });

  it('does not swallow a runtime rollback rejection or publish the restored disk identity', async () => {
    const onCommitted = vi.fn();
    const onRuntimeDirty = vi.fn();
    const test = await fixture({ onCommitted, onRuntimeDirty });
    const originalApplyError = new Error('runtime rejected candidate');
    const rollbackError = new Error('runtime rejected rollback');
    const applyRuntime = vi
      .fn()
      .mockRejectedValueOnce(originalApplyError)
      .mockRejectedValueOnce(rollbackError);

    const error = await test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 40, {})),
      applyRuntime,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConfigRuntimeRecoveryError);
    expect(error).toMatchObject({
      originalApplyError,
      rollbackError,
      candidateStillOwned: true,
      diskRestored: true,
    });
    expect((error as ConfigRuntimeRecoveryError).errors).toEqual([
      originalApplyError,
      rollbackError,
    ]);
    expect(JSON.parse(await readFile(test.configPath, 'utf8')).agent.maxTurns).toBe(20);
    expect(onCommitted).not.toHaveBeenCalled();
    expect(onRuntimeDirty).toHaveBeenCalledOnce();

    const audit = await readFile(join(test.root, 'data/config-governance/audit.jsonl'), 'utf8');
    expect(audit).toContain('"result":"rollback_failed"');
    expect(audit).toContain('runtime rejected candidate');
    expect(audit).toContain('runtime rejected rollback');
    expect(audit).toContain('"candidateStillOwned":true');
    expect(audit).toContain('"diskRestored":true');
    expect(audit).not.toContain('/tmp/workspace');
  });

  it('blocks later mutations until the original applyRuntime recovers old disk, then commits the candidate', async () => {
    const publishedMaxTurns: number[] = [];
    const onCommitted = vi.fn((text: string) => {
      publishedMaxTurns.push(JSON.parse(text).agent.maxTurns);
    });
    const onRuntimeDirty = vi.fn();
    const test = await fixture({ onCommitted, onRuntimeDirty });
    let runtimeMaxTurns = 20;
    let originalApplyCall = 0;
    const originalApplyError = new Error('candidate partially applied');
    const rollbackError = new Error('rollback partially applied');
    const recoveryError = new Error('forced recovery still rejected');
    const originalApplyRuntime = vi.fn(async (next: AppConfig) => {
      originalApplyCall += 1;
      if (originalApplyCall === 1) {
        runtimeMaxTurns = 40;
        throw originalApplyError;
      }
      if (originalApplyCall === 2) {
        runtimeMaxTurns = 25;
        throw rollbackError;
      }
      if (originalApplyCall === 3) {
        runtimeMaxTurns = 26;
        throw recoveryError;
      }
      runtimeMaxTurns = next.agent.maxTurns!;
    });

    await expect(test.service.mutate({
      actor: 'admin-1',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 40, {})),
      applyRuntime: originalApplyRuntime,
    })).rejects.toBeInstanceOf(ConfigRuntimeRecoveryError);
    expect(runtimeMaxTurns).toBe(25);

    const blockedBuildCandidate = vi.fn((text: string) => text);
    const blockedApplyRuntime = vi.fn();
    const blockedError = await test.service.mutate({
      actor: 'admin-2',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: blockedBuildCandidate,
      applyRuntime: blockedApplyRuntime,
    }).catch((caught: unknown) => caught);

    expect(blockedError).toBeInstanceOf(ConfigRuntimeRecoveryError);
    expect(blockedError).toMatchObject({
      originalApplyError,
      rollbackError,
      recoveryError,
      candidateStillOwned: true,
      diskRestored: true,
    });
    expect(runtimeMaxTurns).toBe(26);
    expect(blockedBuildCandidate).not.toHaveBeenCalled();
    expect(blockedApplyRuntime).not.toHaveBeenCalled();
    expect(publishedMaxTurns).toEqual([]);
    expect(JSON.parse(await readFile(test.configPath, 'utf8')).agent.maxTurns).toBe(20);

    const nextApplyRuntime = vi.fn(async (next: AppConfig) => {
      runtimeMaxTurns = next.agent.maxTurns!;
    });
    const result = await test.service.mutate({
      actor: 'admin-3',
      changedPaths: ['agent.maxTurns'],
      buildCandidate: (text) => applyEdits(text, modify(text, ['agent', 'maxTurns'], 30, {})),
      applyRuntime: nextApplyRuntime,
    });

    expect(result.config.agent.maxTurns).toBe(30);
    expect(originalApplyRuntime).toHaveBeenCalledTimes(4);
    expect(originalApplyRuntime.mock.calls[3]?.[0].agent.maxTurns).toBe(20);
    expect(nextApplyRuntime).toHaveBeenCalledOnce();
    expect(runtimeMaxTurns).toBe(30);
    expect(publishedMaxTurns).toEqual([20, 30]);
    expect(onRuntimeDirty).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(test.configPath, 'utf8')).agent.maxTurns).toBe(30);

    const audit = await readFile(join(test.root, 'data/config-governance/audit.jsonl'), 'utf8');
    expect(audit).toContain('"result":"recovery_failed"');
    expect(audit).toContain('forced recovery still rejected');
    expect(audit).toContain('"result":"recovered"');
    expect(audit).toContain('"result":"applied"');
  });
});
