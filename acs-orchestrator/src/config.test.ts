import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyRuntimeConfigPatch,
  loadConfigFromEnv,
  parseEgressConfigPatch,
  parseRuntimeConfigPatch,
  runtimeConfigSnapshot,
  type AcsOrchestratorConfig,
} from './config.js';

describe('ACS runtime config', () => {
  it('updates running quota settings and persists them when runtimeConfigPath is configured', () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-runtime-config-'));
    const runtimeConfigPath = join(root, 'runtime.json');
    const config = {
      maxRunningSandboxes: 8,
      warnRunningSandboxes: 6,
      drainDeadlineMs: 120_000,
      runtimeConfigPath,
    } as AcsOrchestratorConfig;

    const snapshot = applyRuntimeConfigPatch(config, {
      maxRunningSandboxes: 4,
      warnRunningSandboxes: 3,
      drainDeadlineMs: 900_000,
    });

    expect(snapshot).toMatchObject({
      maxRunningSandboxes: 4,
      warnRunningSandboxes: 3,
      drainDeadlineMs: 900_000,
      persisted: true,
    });
    expect(runtimeConfigSnapshot(config)).toMatchObject({
      maxRunningSandboxes: 4,
      warnRunningSandboxes: 3,
      drainDeadlineMs: 900_000,
    });
    // 持久化文件自 2026-07-25 起额外包含 egress 段（缺省全关），
    // 旧格式文件回灌时由 cloneEgressConfig 补默认值，不会崩。
    expect(JSON.parse(readFileSync(runtimeConfigPath, 'utf-8'))).toEqual({
      maxRunningSandboxes: 4,
      warnRunningSandboxes: 3,
      drainDeadlineMs: 900_000,
      egress: {
        proxy: { enabled: false, proxyUrl: '', noProxy: [] },
        packageMirrors: {
          enabled: false,
          pipIndexUrl: 'https://mirrors.aliyun.com/pypi/simple/',
          pipTrustedHost: 'mirrors.aliyun.com',
          npmRegistry: 'https://registry.npmmirror.com',
        },
      },
    });
  });

  it('persists weighted capacity and execution maintenance and can clear the reason', () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-runtime-config-weighted-'));
    const runtimeConfigPath = join(root, 'runtime.json');
    const config = {
      maxRunningSandboxes: 140,
      warnRunningSandboxes: 120,
      maxAllocatedCpuMillicores: 280_000,
      warnAllocatedCpuMillicores: 240_000,
      maxAllocatedMemoryMib: 573_440,
      warnAllocatedMemoryMib: 491_520,
      executionMaintenance: false,
      drainDeadlineMs: 120_000,
      runtimeConfigPath,
    } as AcsOrchestratorConfig;

    expect(applyRuntimeConfigPatch(config, {
      maxAllocatedCpuMillicores: 260_000,
      warnAllocatedCpuMillicores: 220_000,
      maxAllocatedMemoryMib: 532_480,
      warnAllocatedMemoryMib: 450_560,
      executionMaintenance: true,
      executionMaintenanceReason: 'planned maintenance',
    })).toMatchObject({
      maxAllocatedCpuMillicores: 260_000,
      warnAllocatedCpuMillicores: 220_000,
      maxAllocatedMemoryMib: 532_480,
      warnAllocatedMemoryMib: 450_560,
      executionMaintenance: true,
      executionMaintenanceReason: 'planned maintenance',
      persisted: true,
    });

    const persisted = JSON.parse(readFileSync(runtimeConfigPath, 'utf-8')) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      maxAllocatedCpuMillicores: 260_000,
      warnAllocatedCpuMillicores: 220_000,
      maxAllocatedMemoryMib: 532_480,
      warnAllocatedMemoryMib: 450_560,
      executionMaintenance: true,
      executionMaintenanceReason: 'planned maintenance',
    });

    const cleared = applyRuntimeConfigPatch(config, {
      executionMaintenance: false,
      executionMaintenanceReason: undefined,
    });
    expect(cleared.executionMaintenance).toBe(false);
    expect(cleared).not.toHaveProperty('executionMaintenanceReason');
    expect(JSON.parse(readFileSync(runtimeConfigPath, 'utf-8'))).not.toHaveProperty('executionMaintenanceReason');
  });

  it('rejects invalid runtime config values', () => {
    expect(() => parseRuntimeConfigPatch({ maxRunningSandboxes: 2, warnRunningSandboxes: 3 }))
      .toThrow(/warnRunningSandboxes/);
    expect(() => parseRuntimeConfigPatch({ maxRunningSandboxes: 1.5 }))
      .toThrow(/integer/);
    expect(() => parseRuntimeConfigPatch({ drainDeadlineMs: 999 }))
      .toThrow(/drainDeadlineMs/);
    expect(() => parseRuntimeConfigPatch({
      maxAllocatedCpuMillicores: 10_000,
      warnAllocatedCpuMillicores: 10_001,
    })).toThrow(/warnAllocatedCpuMillicores/);
    expect(() => parseRuntimeConfigPatch({
      maxAllocatedMemoryMib: 10_000,
      warnAllocatedMemoryMib: 10_001,
    })).toThrow(/warnAllocatedMemoryMib/);
    expect(() => parseRuntimeConfigPatch({ executionMaintenance: 'yes' }))
      .toThrow(/executionMaintenance/);
    expect(() => parseRuntimeConfigPatch({ executionMaintenanceReason: 'x'.repeat(501) }))
      .toThrow(/at most 500/);
  });

  it('rejects a hot running limit above shared-cidr rollback capacity', () => {
    const config = {
      maxRunningSandboxes: 190,
      warnRunningSandboxes: 150,
      drainDeadlineMs: 120_000,
      snat: {
        mode: 'shared-cidr',
        maxManagedEntries: 200,
        sharedCidrs: Array.from({ length: 8 }, (_, index) => `172.16.${index}.0/24`),
      },
    } as AcsOrchestratorConfig;

    expect(() => applyRuntimeConfigPatch(config, { maxRunningSandboxes: 191 }))
      .toThrow(/rollback capacity 1\.\.190/);
    expect(() => applyRuntimeConfigPatch(config, { maxRunningSandboxes: 0 }))
      .toThrow(/rollback capacity 1\.\.190/);
    expect(applyRuntimeConfigPatch(config, { maxRunningSandboxes: 190 }).maxRunningSandboxes).toBe(190);
  });

  it('loads desired network policy from env without claiming enforcement', () => {
    const originalEnv = { ...process.env };
    process.env.ACS_ORCH_AUTH_TOKEN = 'orchestrator-token';
    process.env.ACS_SANDBOX_IMAGE = 'registry.example.com/agent-saas/acs-sandbox:test';
    process.env.ACS_NETWORK_POLICY_MODE = 'private-egress';
    process.env.ACS_NETWORK_POLICY_ALLOW_CIDRS = '10.8.0.0/16';
    process.env.ACS_NETWORK_POLICY_ALLOW_DOMAINS = 'internal.example.com';
    try {
      const config = loadConfigFromEnv();
      expect(config.networkPolicy).toEqual({
        mode: 'private-egress',
        denyPrivateNetworks: true,
        allowCidrs: ['10.8.0.0/16'],
        allowDomains: ['internal.example.com'],
      });
    } finally {
      process.env = originalEnv;
    }
  });

  it('loads disabled SNAT by default and requires cloud parameters when enabled', () => {
    const originalEnv = { ...process.env };
    process.env.ACS_ORCH_AUTH_TOKEN = 'orchestrator-token';
    process.env.ACS_SANDBOX_IMAGE = 'registry.example.com/agent-saas/acs-sandbox:test';
    delete process.env.ACS_SNAT_MODE;
    delete process.env.ACS_SNAT_REGION_ID;
    delete process.env.ACS_SNAT_TABLE_ID;
    delete process.env.ACS_SNAT_IP;
    try {
      expect(loadConfigFromEnv().snat).toMatchObject({
        mode: 'disabled',
        entryNamePrefix: 'agent-saas-acs',
        stabilizeAfterCreateMs: 8_000,
      });
      process.env.ACS_SNAT_MODE = 'probe-only';
      expect(() => loadConfigFromEnv()).toThrow(/ACS_SNAT_REGION_ID/);
      process.env.ACS_SNAT_REGION_ID = 'cn-shenzhen';
      process.env.ACS_SNAT_TABLE_ID = 'stb-test';
      process.env.ACS_SNAT_IP = '120.77.218.94';
      expect(loadConfigFromEnv().snat).toMatchObject({
        mode: 'probe-only',
        regionId: 'cn-shenzhen',
        snatTableId: 'stb-test',
        snatIp: '120.77.218.94',
        stabilizeAfterCreateMs: 8_000,
      });
    } finally {
      process.env = originalEnv;
    }
  });

  it('loads multiple shared SNAT CIDRs, canonicalizes them, and keeps the legacy variable compatible', () => {
    const originalEnv = { ...process.env };
    process.env.ACS_ORCH_AUTH_TOKEN = 'orchestrator-token';
    process.env.ACS_SANDBOX_IMAGE = 'registry.example.com/agent-saas/acs-sandbox:test';
    process.env.ACS_SNAT_MODE = 'shared-cidr';
    process.env.ACS_SNAT_REGION_ID = 'cn-shenzhen';
    process.env.ACS_SNAT_TABLE_ID = 'stb-test';
    process.env.ACS_SNAT_IP = '120.77.218.94';
    process.env.ACS_SANDBOX_MAX_RUNNING = '8';
    process.env.ACS_SANDBOX_WARN_RUNNING = '6';
    delete process.env.ACS_SNAT_SHARED_CIDR;
    try {
      process.env.ACS_SNAT_SHARED_CIDRS = '172.16.179.9/24, 172.16.180.0/24\n172.16.179.0/24';
      expect(loadConfigFromEnv().snat.sharedCidrs).toEqual([
        '172.16.179.0/24',
        '172.16.180.0/24',
      ]);

      delete process.env.ACS_SNAT_SHARED_CIDRS;
      process.env.ACS_SNAT_SHARED_CIDR = '172.16.181.7/24';
      expect(loadConfigFromEnv().snat.sharedCidrs).toEqual(['172.16.181.0/24']);
    } finally {
      process.env = originalEnv;
    }
  });

  it('rejects ambiguous or invalid shared SNAT CIDR configuration', () => {
    const originalEnv = { ...process.env };
    process.env.ACS_ORCH_AUTH_TOKEN = 'orchestrator-token';
    process.env.ACS_SANDBOX_IMAGE = 'registry.example.com/agent-saas/acs-sandbox:test';
    process.env.ACS_SNAT_MODE = 'shared-cidr';
    process.env.ACS_SNAT_REGION_ID = 'cn-shenzhen';
    process.env.ACS_SNAT_TABLE_ID = 'stb-test';
    process.env.ACS_SNAT_IP = '120.77.218.94';
    try {
      process.env.ACS_SNAT_SHARED_CIDR = '172.16.179.0/24';
      process.env.ACS_SNAT_SHARED_CIDRS = '172.16.180.0/24';
      expect(() => loadConfigFromEnv()).toThrow(/ACS_SNAT_SHARED_CIDR.*ACS_SNAT_SHARED_CIDRS/);

      delete process.env.ACS_SNAT_SHARED_CIDR;
      process.env.ACS_SNAT_SHARED_CIDRS = '172.16.180.0/24,not-a-cidr';
      expect(() => loadConfigFromEnv()).toThrow(/ACS_SNAT_SHARED_CIDRS/);

      process.env.ACS_SNAT_SHARED_CIDRS = '172.16.0.0/16';
      expect(() => loadConfigFromEnv()).toThrow(/过宽网段/);

      process.env.ACS_SNAT_SHARED_CIDRS = '172.16.180.0/24,172.16.180.128/25';
      expect(() => loadConfigFromEnv()).toThrow(/存在重叠/);

      process.env.ACS_SNAT_SHARED_CIDRS = '172.16.180.0/24,172.16.181.0/24';
      process.env.ACS_SNAT_MAX_MANAGED_ENTRIES = '1';
      expect(() => loadConfigFromEnv()).toThrow(/小于共享网段数/);
    } finally {
      process.env = originalEnv;
    }
  });

  it('uses 24 hours as the default sandbox unused TTL', () => {
    const originalEnv = { ...process.env };
    process.env.ACS_ORCH_AUTH_TOKEN = 'orchestrator-token';
    process.env.ACS_SANDBOX_IMAGE = 'registry.example.com/agent-saas/acs-sandbox:test';
    delete process.env.ACS_SANDBOX_TTL_MS;
    try {
      expect(loadConfigFromEnv().sandboxTtlMs).toBe(2 * 60 * 60_000);
    } finally {
      process.env = originalEnv;
    }
  });

  it('uses six hours as the default sandbox CI TTL (as-ws-ci-* prefix)', () => {
    const originalEnv = { ...process.env };
    process.env.ACS_ORCH_AUTH_TOKEN = 'orchestrator-token';
    process.env.ACS_SANDBOX_IMAGE = 'registry.example.com/agent-saas/acs-sandbox:test';
    delete process.env.ACS_SANDBOX_CI_TTL_MS;
    try {
      expect(loadConfigFromEnv().sandboxCiTtlMs).toBe(60 * 60_000);
    } finally {
      process.env = originalEnv;
    }
  });

  it('honors ACS_SANDBOX_CI_TTL_MS override (including 0 to disable)', () => {
    const originalEnv = { ...process.env };
    process.env.ACS_ORCH_AUTH_TOKEN = 'orchestrator-token';
    process.env.ACS_SANDBOX_IMAGE = 'registry.example.com/agent-saas/acs-sandbox:test';
    try {
      process.env.ACS_SANDBOX_CI_TTL_MS = '1800000';
      expect(loadConfigFromEnv().sandboxCiTtlMs).toBe(1_800_000);
      process.env.ACS_SANDBOX_CI_TTL_MS = '0';
      expect(loadConfigFromEnv().sandboxCiTtlMs).toBe(0);
    } finally {
      process.env = originalEnv;
    }
  });

  it('enables production Agent runtime capabilities by default and allows explicit disable', () => {
    const originalEnv = { ...process.env };
    process.env.ACS_ORCH_AUTH_TOKEN = 'orchestrator-token';
    process.env.ACS_SANDBOX_IMAGE = 'registry.example.com/agent-saas/acs-sandbox:test';
    delete process.env.ACS_CAPABILITY_BROWSER;
    delete process.env.ACS_CAPABILITY_MEDIA;
    try {
      expect(loadConfigFromEnv().capabilities).toEqual({
        browser: true,
        media: true,
        officeDocuments: true,
        pythonBasePackages: true,
      });
      process.env.ACS_CAPABILITY_BROWSER = 'false';
      process.env.ACS_CAPABILITY_MEDIA = '0';
      expect(loadConfigFromEnv().capabilities).toMatchObject({
        browser: false,
        media: false,
      });
    } finally {
      process.env = originalEnv;
    }
  });
});

describe('egress runtime config patch', () => {
  it('接受 server 下发的完整出口配置', () => {
    const parsed = parseEgressConfigPatch({
      proxy: { enabled: true, proxyUrl: 'http://172.16.177.77:7890', noProxy: ['internal.example.com', ' '] },
      packageMirrors: {
        enabled: true,
        pipIndexUrl: 'https://mirrors.aliyun.com/pypi/simple/',
        pipTrustedHost: 'mirrors.aliyun.com',
        npmRegistry: 'https://registry.npmmirror.com',
      },
    });
    expect(parsed.proxy).toEqual({
      enabled: true,
      proxyUrl: 'http://172.16.177.77:7890',
      noProxy: ['internal.example.com'],
    });
    expect(parsed.packageMirrors.enabled).toBe(true);
  });

  it('缺省字段按全关处理，不抛错', () => {
    expect(parseEgressConfigPatch({})).toEqual({
      proxy: { enabled: false, proxyUrl: '', noProxy: [] },
      packageMirrors: { enabled: false, pipIndexUrl: '', pipTrustedHost: '', npmRegistry: '' },
    });
  });

  it('启用但地址非法直接拒绝——静默忽略会让管理员误以为代理已生效', () => {
    expect(() => parseEgressConfigPatch({ proxy: { enabled: true, proxyUrl: '' } }))
      .toThrow(/proxyUrl/);
    expect(() => parseEgressConfigPatch({ proxy: { enabled: true, proxyUrl: '172.16.177.77:7890' } }))
      .toThrow(/proxyUrl/);
    expect(() => parseEgressConfigPatch({ packageMirrors: { enabled: true } }))
      .toThrow(/pipIndexUrl/);
  });

  it('类型不对时报错而不是静默转换', () => {
    expect(() => parseEgressConfigPatch({ proxy: { enabled: 'yes' } })).toThrow(/boolean/);
    expect(() => parseEgressConfigPatch({ proxy: { noProxy: 'a,b' } })).toThrow(/array/);
    expect(() => parseEgressConfigPatch('nope')).toThrow(/object/);
  });

  it('applyRuntimeConfigPatch 只改 egress 时保留原有配额', () => {
    const config = {
      maxRunningSandboxes: 8,
      warnRunningSandboxes: 6,
      drainDeadlineMs: 120_000,
    } as AcsOrchestratorConfig;
    const snapshot = applyRuntimeConfigPatch(config, {
      egress: parseEgressConfigPatch({ proxy: { enabled: true, proxyUrl: 'http://10.0.0.1:8080' } }),
    });
    expect(snapshot.maxRunningSandboxes).toBe(8);
    expect(snapshot.egress.proxy.proxyUrl).toBe('http://10.0.0.1:8080');
    expect(config.egress.proxy.enabled).toBe(true);
  });
});
