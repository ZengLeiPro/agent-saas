import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { SnatManager } from './snatManager.js';

describe('SnatManager · shared-cidr 模式（2026-08-10）', () => {
  const SHARED = '172.16.179.0/24';
  const SHARED_NEXT = '172.16.180.0/24';
  function sharedConfig(cliPath: string): AcsOrchestratorConfig {
    const base = baseConfig(cliPath);
    return {
      ...base,
      snat: {
        ...base.snat,
        mode: 'shared-cidr',
        sharedCidr: SHARED,
        sharedCidrs: [SHARED, SHARED_NEXT],
      },
    };
  }
  function setup(name: string, entries: unknown[] = [], state: Record<string, unknown> = {}) {
    const root = mkdtempSync(join(tmpdir(), name));
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'calls.log');
    writeFileSync(statePath, JSON.stringify({ entries, ...state }), 'utf-8');
    writeFileSync(logPath, '', 'utf-8');
    return { root, statePath, logPath, cliPath: writeFakeAliyun(root, statePath, logPath) };
  }
  const ref = (n: string) => ({
    name: n,
    workspaceId: 'ws-1',
    sandboxScopeId: 'ws-1__s_top',
    sessionId: 'top',
    mountSubPath: 'ws-1',
  });

  it('不同网段的 pod 各复用唯一共享条目，且不再逐 pod 创建', async () => {
    const { statePath, logPath, cliPath } = setup('acs-snat-shared-');
    const m1 = new SnatManager(sharedConfig(cliPath), podKubectl('172.16.179.204'), noopLogger);
    const m2 = new SnatManager(sharedConfig(cliPath), podKubectl('172.16.180.212'), noopLogger);

    const a = await m1.ensureForSandboxWhenPodReady(ref('as-pod-a'), {
      timeoutMs: 2_000,
      pollIntervalMs: 10,
    });
    const b = await m2.ensureForSandboxWhenPodReady(ref('as-pod-b'), {
      timeoutMs: 2_000,
      pollIntervalMs: 10,
    });

    expect(a?.sourceCidr).toBe(SHARED);
    expect(b?.sourceCidr).toBe(SHARED_NEXT);
    const entries = JSON.parse(readFileSync(statePath, 'utf-8')).entries as Array<{
      SourceCIDR: string;
      SnatEntryName: string;
    }>;
    expect(entries.map((entry) => entry.SourceCIDR).sort()).toEqual([SHARED, SHARED_NEXT]);
    expect(new Set(entries.map((entry) => entry.SnatEntryName)).size).toBe(2);
    expect((readFileSync(logPath, 'utf-8').match(/CreateSnatEntry/g) ?? []).length).toBe(2);
  });

  it('同一共享 CIDR 的并发 ensure 使用 singleflight，只创建一次', async () => {
    const { statePath, logPath, cliPath } = setup('acs-snat-shared-concurrent-');
    const manager = new SnatManager(
      sharedConfig(cliPath),
      podKubectl('172.16.179.204'),
      noopLogger,
    );

    const [first, second] = await Promise.all([
      manager.ensureForSandboxWhenPodReady(ref('as-pod-concurrent'), {
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      }),
      manager.ensureForSandboxWhenPodReady(ref('as-pod-concurrent'), {
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      }),
    ]);

    expect(first?.id).toBe(second?.id);
    expect(readFileSync(logPath, 'utf-8').match(/CreateSnatEntry/g) ?? []).toHaveLength(1);
    expect(JSON.parse(readFileSync(statePath, 'utf-8')).entries).toHaveLength(1);
  });

  it('pod IP 落在允许网段外时立即 fail-closed，禁止回退 per-pod', async () => {
    const { logPath, cliPath } = setup('acs-snat-outside-');
    const errors: string[] = [];
    const logger = {
      info() {},
      warn() {},
      error(msg: string) {
        errors.push(msg);
      },
    };
    const manager = new SnatManager(sharedConfig(cliPath), podKubectl('172.16.181.9'), logger);

    await expect(
      manager.ensureForSandboxWhenPodReady(ref('as-pod-outside'), {
        timeoutMs: 2_000,
        pollIntervalMs: 10,
      }),
    ).rejects.toThrow(/outside configured shared CIDRs/);

    expect(errors.some((m) => m.includes('action=fail_closed'))).toBe(true);
    expect(readFileSync(logPath, 'utf-8')).not.toContain('CreateSnatEntry');
  });

  it('迁移必须先创建并确认所有共享条目，再删除被覆盖的 /32', async () => {
    const { statePath, logPath, cliPath } = setup('acs-snat-shared-cleanup-', [
      {
        SnatEntryId: 'snat-shared',
        SnatEntryName: 'agent-saas-acs-shared-cidr',
        SourceCIDR: SHARED,
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
      {
        SnatEntryId: 'snat-active-pod',
        SnatEntryName: 'agent-saas-acs-as-active',
        SourceCIDR: '172.16.179.204/32',
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
      {
        SnatEntryId: 'snat-paused-pod',
        SnatEntryName: 'agent-saas-acs-as-paused',
        SourceCIDR: '172.16.180.99/32',
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
    ]);
    const manager = new SnatManager(
      sharedConfig(cliPath),
      podKubectl('172.16.179.204'),
      noopLogger,
    );

    const report = await manager.migrateCoveredPerPodEntries();

    expect(report.deleted.sort()).toEqual(['snat-active-pod', 'snat-paused-pod']);
    const calls = readFileSync(logPath, 'utf-8');
    expect(calls.indexOf('CreateSnatEntry')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('CreateSnatEntry')).toBeLessThan(calls.indexOf('DeleteSnatEntry'));
    const entries = JSON.parse(readFileSync(statePath, 'utf-8')).entries as Array<{
      SourceCIDR: string;
      Status: string;
    }>;
    expect(entries.map((entry) => entry.SourceCIDR).sort()).toEqual([SHARED, SHARED_NEXT]);
    expect(entries.every((entry) => entry.Status === 'Available')).toBe(true);
  });

  it('常规 lifecycle 只建共享条目，不在真实网络验收前自动删活跃或 Paused 的 /32', async () => {
    const { statePath, cliPath } = setup('acs-snat-shared-staged-', [
      {
        SnatEntryId: 'snat-shared',
        SnatEntryName: 'agent-saas-acs-shared-cidr',
        SourceCIDR: SHARED,
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
      {
        SnatEntryId: 'snat-active',
        SnatEntryName: 'agent-saas-acs-as-active',
        SourceCIDR: '172.16.179.204/32',
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
      {
        SnatEntryId: 'snat-paused',
        SnatEntryName: 'agent-saas-acs-as-paused',
        SourceCIDR: '172.16.180.99/32',
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
    ]);
    const manager = new SnatManager(
      sharedConfig(cliPath),
      podKubectl('172.16.179.204'),
      noopLogger,
    );

    const report = await manager.cleanupOrphans(new Set(['172.16.179.204/32']), {
      retainedEntryNames: new Set(['agent-saas-acs-as-paused']),
    });

    expect(report.deleted).toEqual([]);
    const cidrs = JSON.parse(readFileSync(statePath, 'utf-8')).entries.map(
      (entry: { SourceCIDR: string }) => entry.SourceCIDR,
    );
    expect(cidrs).toContain('172.16.179.204/32');
    expect(cidrs).toContain('172.16.180.99/32');
    expect(cidrs).toContain(SHARED_NEXT);
  });

  it('回滚前可先为全部当前 Pod 恢复并确认 /32 Available', async () => {
    const { statePath, cliPath } = setup('acs-snat-shared-restore-', [
      {
        SnatEntryId: 'snat-shared-a',
        SnatEntryName: 'agent-saas-acs-shared-cidr',
        SourceCIDR: SHARED,
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
      {
        SnatEntryId: 'snat-shared-b',
        SnatEntryName: 'agent-saas-acs-shared-cidr-172-16-180-0-24',
        SourceCIDR: SHARED_NEXT,
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
    ]);
    const manager = new SnatManager(
      sharedConfig(cliPath),
      podKubectl('172.16.180.88', {
        workspaceId: 'workspace-1',
        sandboxScopeId: 'scope-1',
      }),
      noopLogger,
    );

    const report = await manager.restorePerPodEntriesForManagedPods([
      {
        name: 'as-running-sandbox',
        workspaceId: 'workspace-1',
        sandboxScopeId: 'scope-1',
      },
    ]);

    expect(report).toMatchObject({ checked: 1, available: 1 });
    const entries = JSON.parse(readFileSync(statePath, 'utf-8')).entries as Array<{
      SourceCIDR: string;
      SnatEntryName: string;
    }>;
    expect(entries.map((entry) => entry.SourceCIDR)).toContain('172.16.180.88/32');
    expect(entries.map((entry) => entry.SourceCIDR)).toContain(SHARED_NEXT);
    expect(entries.find((entry) => entry.SourceCIDR === '172.16.180.88/32')?.SnatEntryName).toBe(
      'agent-saas-acs-as-running-sandbox',
    );
  });

  it('任一共享条目创建失败时保留全部 /32，允许无损回滚', async () => {
    const { statePath, logPath, cliPath } = setup(
      'acs-snat-shared-rollback-',
      [
        {
          SnatEntryId: 'snat-shared',
          SnatEntryName: 'agent-saas-acs-shared-cidr',
          SourceCIDR: SHARED,
          SnatIp: '120.77.218.94',
          Status: 'Available',
        },
        {
          SnatEntryId: 'snat-pod',
          SnatEntryName: 'agent-saas-acs-as-active',
          SourceCIDR: '172.16.179.204/32',
          SnatIp: '120.77.218.94',
          Status: 'Available',
        },
      ],
      { failCreateCidrs: [SHARED_NEXT] },
    );
    const manager = new SnatManager(
      sharedConfig(cliPath),
      podKubectl('172.16.179.204'),
      noopLogger,
    );

    await expect(manager.migrateCoveredPerPodEntries()).rejects.toThrow(
      /CreateSnatEntry\(shared\)/,
    );

    expect(readFileSync(logPath, 'utf-8')).not.toContain('DeleteSnatEntry');
    const ids = JSON.parse(readFileSync(statePath, 'utf-8')).entries.map(
      (entry: { SnatEntryId: string }) => entry.SnatEntryId,
    );
    expect(ids).toContain('snat-pod');
  });

  it('状态统计与孤儿清理使用同一 shared-cidr 豁免语义', async () => {
    const { cliPath } = setup('acs-snat-shared-status-', [
      {
        SnatEntryId: 'snat-shared',
        SnatEntryName: 'agent-saas-acs-shared-cidr',
        SourceCIDR: SHARED,
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
      {
        SnatEntryId: 'snat-stale-pod',
        SnatEntryName: 'agent-saas-acs-as-old',
        SourceCIDR: '172.16.179.99/32',
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
    ]);
    const manager = new SnatManager(
      sharedConfig(cliPath),
      podKubectl('172.16.179.204'),
      noopLogger,
    );

    const status = await manager.status(new Set(['172.16.179.204/32']));

    expect(status.managedCount).toBe(2);
    expect(status.orphanCount).toBe(1);
    expect(status.redundantPerPodCount).toBe(1);
  });

  it('删除单个 Sandbox 不得连带删掉共享条目', async () => {
    const { statePath, cliPath } = setup('acs-snat-shared-del-', [
      {
        SnatEntryId: 'snat-shared',
        SnatEntryName: 'agent-saas-acs-shared-cidr',
        SourceCIDR: SHARED,
        SnatIp: '120.77.218.94',
        Status: 'Available',
      },
    ]);
    const manager = new SnatManager(
      sharedConfig(cliPath),
      podKubectl('172.16.179.204'),
      noopLogger,
    );

    const deleted = await manager.deleteForSandboxName('as-pod-a');

    expect(deleted).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf-8')).entries).toHaveLength(1);
  });

  it('network-policy probe 在 shared-cidr 模式也复用匹配网段，不创建 /32', async () => {
    const { cliPath } = setup('acs-snat-shared-probe-');
    const manager = new SnatManager(sharedConfig(cliPath), podKubectl('172.16.180.88'), noopLogger);

    const entry = await manager.ensureForProbe(ref('as-probe-shared'));

    expect(entry?.sourceCidr).toBe(SHARED_NEXT);
  });
});

describe('SnatManager', () => {
  it('paginates SNAT entries beyond the provider page size', async () => {
    const entries = Array.from({ length: 65 }, (_, index) => ({
      SnatEntryId: `snat-${index + 1}`,
      SnatEntryName: `agent-saas-acs-as-${index + 1}`,
      SourceCIDR: `172.16.${Math.floor(index / 250)}.${(index % 250) + 1}/32`,
      SnatIp: '120.77.218.94',
      Status: 'Available',
    }));
    const root = mkdtempSync(join(tmpdir(), 'acs-snat-pagination-'));
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'calls.log');
    writeFileSync(statePath, JSON.stringify({ entries }), 'utf-8');
    writeFileSync(logPath, '', 'utf-8');
    const manager = new SnatManager(
      baseConfig(writeFakeAliyun(root, statePath, logPath)),
      podKubectl('172.16.177.10'),
      noopLogger,
    );

    const status = await manager.status();

    expect(status.managedCount).toBe(65);
    expect(readFileSync(logPath, 'utf-8').match(/DescribeSnatTableEntries/g) ?? []).toHaveLength(2);
  });

  it('creates one /32 SNAT entry for a probe sandbox and reuses existing entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-snat-test-'));
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'calls.log');
    writeFileSync(statePath, JSON.stringify({ entries: [] }), 'utf-8');
    const cliPath = writeFakeAliyun(root, statePath, logPath);
    const kubectl = podKubectl('172.16.177.139');
    const manager = new SnatManager(
      { ...baseConfig(cliPath), snat: { ...baseConfig(cliPath).snat, mode: 'probe-only' } },
      kubectl,
      noopLogger,
    );

    const ref = {
      name: 'as-probe-123',
      workspaceId: 'network-probe',
      sandboxScopeId: 'network-probe',
      sessionId: 'probe-123',
      mountSubPath: 'network-probe',
    };
    const created = await manager.ensureForProbe(ref);
    const reused = await manager.ensureForProbe(ref);

    expect(created?.sourceCidr).toBe('172.16.177.139/32');
    expect(reused?.id).toBe(created?.id);
    const calls = readFileSync(logPath, 'utf-8');
    expect((calls.match(/CreateSnatEntry/g) ?? []).length).toBe(1);
    expect(JSON.parse(readFileSync(statePath, 'utf-8')).entries).toHaveLength(1);
  });

  it('deletes only managed orphan SNAT entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-snat-cleanup-'));
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'calls.log');
    writeFileSync(
      statePath,
      JSON.stringify({
        entries: [
          {
            SnatEntryId: 'snat-managed-active',
            SnatEntryName: 'agent-saas-acs-as-active',
            SourceCIDR: '172.16.177.10/32',
            SnatIp: '120.77.218.94',
            Status: 'Available',
          },
          {
            SnatEntryId: 'snat-managed-orphan',
            SnatEntryName: 'agent-saas-acs-as-orphan',
            SourceCIDR: '172.16.177.11/32',
            SnatIp: '120.77.218.94',
            Status: 'Available',
          },
          {
            SnatEntryId: 'snat-manual',
            SnatEntryName: 'manual-entry',
            SourceCIDR: '172.16.177.12/32',
            SnatIp: '120.77.218.94',
            Status: 'Available',
          },
        ],
      }),
      'utf-8',
    );
    const cliPath = writeFakeAliyun(root, statePath, logPath);
    const manager = new SnatManager(
      { ...baseConfig(cliPath), snat: { ...baseConfig(cliPath).snat, mode: 'probe-only' } },
      podKubectl('172.16.177.10'),
      noopLogger,
    );

    const report = await manager.cleanupOrphans(new Set(['172.16.177.10/32']));

    expect(report.deleted).toEqual(['snat-managed-orphan']);
    expect(report.unexpected.map((entry) => entry.id)).toEqual(['snat-manual']);
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      entries: Array<{ SnatEntryId: string }>;
    };
    expect(state.entries.map((entry) => entry.SnatEntryId).sort()).toEqual([
      'snat-managed-active',
      'snat-manual',
    ]);
  });

  it('retains SNAT entries for existing paused sandboxes during orphan cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-snat-retain-'));
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'calls.log');
    writeFileSync(
      statePath,
      JSON.stringify({
        entries: [
          {
            SnatEntryId: 'snat-managed-active',
            SnatEntryName: 'agent-saas-acs-as-active',
            SourceCIDR: '172.16.177.10/32',
            SnatIp: '120.77.218.94',
            Status: 'Available',
          },
          {
            SnatEntryId: 'snat-managed-paused',
            SnatEntryName: 'agent-saas-acs-as-paused',
            SourceCIDR: '172.16.177.11/32',
            SnatIp: '120.77.218.94',
            Status: 'Available',
          },
          {
            SnatEntryId: 'snat-managed-orphan',
            SnatEntryName: 'agent-saas-acs-as-orphan',
            SourceCIDR: '172.16.177.12/32',
            SnatIp: '120.77.218.94',
            Status: 'Available',
          },
        ],
      }),
      'utf-8',
    );
    const cliPath = writeFakeAliyun(root, statePath, logPath);
    const manager = new SnatManager(
      { ...baseConfig(cliPath), snat: { ...baseConfig(cliPath).snat, mode: 'probe-only' } },
      podKubectl('172.16.177.10'),
      noopLogger,
    );

    const report = await manager.cleanupOrphans(new Set(['172.16.177.10/32']), {
      retainedEntryNames: new Set(['agent-saas-acs-as-paused']),
    });

    expect(report.deleted).toEqual(['snat-managed-orphan']);
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      entries: Array<{ SnatEntryId: string }>;
    };
    expect(state.entries.map((entry) => entry.SnatEntryId).sort()).toEqual([
      'snat-managed-active',
      'snat-managed-paused',
    ]);
  });

  it('uses a fresh ClientToken when recreating a deleted SNAT entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-snat-token-'));
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'calls.log');
    writeFileSync(statePath, JSON.stringify({ entries: [] }), 'utf-8');
    const cliPath = writeFakeAliyun(root, statePath, logPath);
    const manager = new SnatManager(
      { ...baseConfig(cliPath), snat: { ...baseConfig(cliPath).snat, mode: 'probe-only' } },
      podKubectl('172.16.177.139'),
      noopLogger,
    );
    const ref = {
      name: 'as-probe-123',
      workspaceId: 'network-probe',
      sandboxScopeId: 'network-probe',
      sessionId: 'probe-123',
      mountSubPath: 'network-probe',
    };

    await manager.ensureForProbe(ref);
    await manager.deleteForSandboxName(ref.name);
    await manager.ensureForProbe(ref);

    const createCalls = readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter((line) => line.includes('CreateSnatEntry'));
    const clientTokens = createCalls.map((line) => valueAfter(line.split(' '), '--ClientToken'));
    expect(clientTokens).toHaveLength(2);
    expect(clientTokens[0]).toMatch(/^agent-saas-acs-/);
    expect(clientTokens[1]).toMatch(/^agent-saas-acs-/);
    expect(clientTokens[1]).not.toBe(clientTokens[0]);
  });

  it('deletes stale same-sandbox SNAT entries before creating one for a new Pod IP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-snat-stale-'));
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'calls.log');
    writeFileSync(
      statePath,
      JSON.stringify({
        entries: [
          {
            SnatEntryId: 'snat-stale',
            SnatEntryName: 'agent-saas-acs-as-probe-123',
            SourceCIDR: '172.16.177.138/32',
            SnatIp: '120.77.218.94',
            Status: 'Available',
          },
        ],
      }),
      'utf-8',
    );
    const cliPath = writeFakeAliyun(root, statePath, logPath);
    const manager = new SnatManager(
      { ...baseConfig(cliPath), snat: { ...baseConfig(cliPath).snat, mode: 'probe-only' } },
      podKubectl('172.16.177.139'),
      noopLogger,
    );
    const ref = {
      name: 'as-probe-123',
      workspaceId: 'network-probe',
      sandboxScopeId: 'network-probe',
      sessionId: 'probe-123',
      mountSubPath: 'network-probe',
    };

    const created = await manager.ensureForProbe(ref);

    expect(created?.sourceCidr).toBe('172.16.177.139/32');
    const calls = readFileSync(logPath, 'utf-8');
    expect(calls).toContain('DeleteSnatEntry');
    expect(calls).toContain('CreateSnatEntry');
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      entries: Array<{ SnatEntryId: string; SourceCIDR: string }>;
    };
    expect(
      state.entries.map((entry) => ({ id: entry.SnatEntryId, sourceCidr: entry.SourceCIDR })),
    ).toEqual([{ id: 'snat-1', sourceCidr: '172.16.177.139/32' }]);
  });

  it('stabilize 传播等待不阻塞返回（2026-07-31 方案4）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-snat-stabilize-'));
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'calls.log');
    writeFileSync(statePath, JSON.stringify({ entries: [] }), 'utf-8');
    const cliPath = writeFakeAliyun(root, statePath, logPath);
    const base = baseConfig(cliPath);
    const manager = new SnatManager(
      { ...base, snat: { ...base.snat, mode: 'probe-only', stabilizeAfterCreateMs: 5_000 } },
      podKubectl('172.16.177.140'),
      noopLogger,
    );
    const ref = {
      name: 'as-probe-stab',
      workspaceId: 'network-probe',
      sandboxScopeId: 'network-probe',
      sessionId: 'probe-stab',
      mountSubPath: 'network-probe',
    };

    const startedAt = Date.now();
    const created = await manager.ensureForProbe(ref);
    expect(created?.sourceCidr).toBe('172.16.177.140/32');
    // 同步等待版本会 >=5s；异步化后应立即返回
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });
});

function writeFakeAliyun(root: string, statePath: string, logPath: string): string {
  const cliPath = join(root, 'aliyun-fake.cjs');
  writeFileSync(
    cliPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const statePath = ${JSON.stringify(statePath)};
const logPath = ${JSON.stringify(logPath)};
const args = process.argv.slice(2);
fs.appendFileSync(logPath, args.join(' ') + '\\n');
const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
if (args[1] === 'DescribeSnatTableEntries') {
  const source = arg('--SourceCIDR');
  const entries = source ? state.entries.filter((entry) => entry.SourceCIDR === source) : state.entries;
  const pageSize = Number(arg('--PageSize') || 50);
  const pageNumber = Number(arg('--PageNumber') || 1);
  const start = (pageNumber - 1) * pageSize;
  const page = entries.slice(start, start + pageSize);
  console.log(JSON.stringify({ SnatTableEntries: { SnatTableEntry: page }, TotalCount: entries.length }));
  process.exit(0);
}
if (args[1] === 'CreateSnatEntry') {
  const sourceCidr = arg('--SourceCIDR');
  if ((state.failCreateCidrs || []).includes(sourceCidr)) {
    console.error('QuotaExceeded: simulated shared CIDR create failure');
    process.exit(1);
  }
  const id = 'snat-' + String(state.entries.length + 1);
  state.entries.push({
    SnatEntryId: id,
    SnatEntryName: arg('--SnatEntryName'),
    SourceCIDR: arg('--SourceCIDR'),
    SnatIp: arg('--SnatIp'),
    Status: 'Available',
  });
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify({ SnatEntryId: id }));
  process.exit(0);
}
if (args[1] === 'DeleteSnatEntry') {
  const id = arg('--SnatEntryId');
  // 测试钩子：模拟阿里云侧「同一 SNAT 表同时只允许一个操作」造成的瞬时删除失败。
  if ((state.failDeleteIds || []).includes(id)) {
    console.error('IncorrectSnatEntryStatus: another operation is in progress');
    process.exit(1);
  }
  state.entries = state.entries.filter((entry) => entry.SnatEntryId !== id);
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify({ RequestId: 'ok' }));
  process.exit(0);
}
console.error('unexpected args ' + args.join(' '));
process.exit(2);
`,
    'utf-8',
  );
  chmodSync(cliPath, 0o755);
  return cliPath;
}

function testLabelValue(value: string | undefined): string {
  return value ? createHash('sha256').update(value).digest('hex').slice(0, 40) : '';
}

function podKubectl(
  podIp: string,
  identity?: { workspaceId: string; sandboxScopeId: string },
): Kubectl {
  return {
    async run(args: string[]): Promise<KubectlResult> {
      if (args[0] === 'get' && args[1] === 'pod') {
        return {
          stdout: JSON.stringify({
            items: [
              {
                metadata: {
                  name: 'as-probe-123-pod',
                  labels: {
                    'agent-saas.kaiyan.net/workspace-id': testLabelValue(identity?.workspaceId),
                    'agent-saas.kaiyan.net/sandbox-scope-id': testLabelValue(
                      identity?.sandboxScopeId,
                    ),
                  },
                },
                status: { podIP: podIp },
              },
            ],
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
        };
      }
      throw new Error(`unexpected kubectl args: ${args.join(' ')}`);
    },
  } as unknown as Kubectl;
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const noopLogger = {
  info() {},
  warn() {},
  error() {},
};

function baseConfig(aliyunCliPath: string): AcsOrchestratorConfig {
  return {
    port: 3400,
    host: '127.0.0.1',
    authToken: 'test-token',
    kubectlPath: 'kubectl',
    namespace: 'agent-saas-coding',
    sandboxApiVersion: 'agents.kruise.io/v1alpha1',
    sandboxKind: 'Sandbox',
    sandboxCrdName: 'sandboxes.agents.kruise.io',
    trafficPolicyCrdName: 'trafficpolicies.network.alibabacloud.com',
    sandboxImage: 'registry.example.com/agent-saas/acs-sandbox:test',
    sandboxContainerName: 'sandbox',
    sandboxRuntimes: [],
    workspaceMountPath: '/workspace',
    pvcName: 'agent-saas-workspace-nas',
    imagePullSecretNames: [],
    imagePullPolicy: 'IfNotPresent',
    sandboxRunAsUser: 501,
    sandboxRunAsGroup: 20,
    cpuRequest: '250m',
    memoryRequest: '512Mi',
    sandboxWaitTimeoutMs: 1,
    execTimeoutMs: 1,
    healthDeepCacheMs: 0,
    imageCacheEnabled: true,
    skipProvisionOnSameRecipe: true,
    lifecycleEnabled: true,
    sandboxCleanupIntervalMs: 300_000,
    sandboxIdlePauseMs: 900_000,
    sandboxTtlMs: 7 * 24 * 60 * 60_000,
    sandboxOrphanGraceMs: 1_800_000,
    sandboxBrokenRecycleGraceMs: 300_000,
    maxRunningSandboxes: 8,
    warnRunningSandboxes: 6,
    maxAllocatedCpuMillicores: 0,
    warnAllocatedCpuMillicores: 0,
    maxAllocatedMemoryMib: 0,
    warnAllocatedMemoryMib: 0,
    executionMaintenance: false,
    drainDeadlineMs: 120_000,
    networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
    snat: {
      mode: 'probe-only',
      aliyunCliPath,
      regionId: 'cn-shenzhen',
      snatTableId: 'stb-test',
      snatIp: '120.77.218.94',
      entryNamePrefix: 'agent-saas-acs',
      maxManagedEntries: 12,
      // The fake CLI launches a fresh Node process. Avoid scheduler-load flakes
      // when the complete ACS suite runs many subprocess-heavy files together.
      requestTimeoutMs: 5_000,
      stabilizeAfterCreateMs: 0,
      statusCacheMs: 0,
    },
    alertWebhookUrls: [],
    alertMinIntervalMs: 300_000,
    capabilities: {
      browser: true,
      media: true,
      officeDocuments: true,
      pythonBasePackages: true,
    },
    egress: {
      proxy: { enabled: false, proxyUrl: '', noProxy: [] },
      packageMirrors: { enabled: false, pipIndexUrl: '', pipTrustedHost: '', npmRegistry: '' },
    },
    logLevel: 'info',
  };
}

describe('SnatManager · 孤儿清理逐条容错（2026-08-11）', () => {
  it('单条删除失败不中断其余条目，也不把异常抛给调用方', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-snat-orphan-fail-'));
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'calls.log');
    writeFileSync(
      statePath,
      JSON.stringify({
        entries: [
          {
            SnatEntryId: 'snat-1',
            SnatEntryName: 'agent-saas-acs-a',
            SourceCIDR: '172.16.179.11/32',
            SnatIp: '120.0.0.1',
            Status: 'Available',
          },
          {
            SnatEntryId: 'snat-2',
            SnatEntryName: 'agent-saas-acs-b',
            SourceCIDR: '172.16.179.12/32',
            SnatIp: '120.0.0.1',
            Status: 'Available',
          },
        ],
        failDeleteIds: ['snat-1'],
      }),
      'utf-8',
    );
    const cliPath = writeFakeAliyun(root, statePath, logPath);
    const warns: string[] = [];
    const logger = {
      info() {},
      warn(message: string) {
        warns.push(message);
      },
      error() {},
    };
    const manager = new SnatManager(baseConfig(cliPath), podKubectl('172.16.179.99'), logger);

    // 两条都是孤儿（活跃集合为空），第一条删除被模拟为瞬时失败。
    const report = await manager.cleanupOrphans(new Set());

    expect(report.deleted).toEqual(['snat-2']);
    expect(warns.some((m) => m.includes('snat_orphan_delete_failed') && m.includes('snat-1'))).toBe(
      true,
    );
    const remaining = JSON.parse(readFileSync(statePath, 'utf-8')).entries as Array<{
      SnatEntryId: string;
    }>;
    expect(remaining.map((entry) => entry.SnatEntryId)).toEqual(['snat-1']);
  });
});
