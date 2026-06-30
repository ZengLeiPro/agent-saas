import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  applyRuntimeConfigPatch,
  loadConfigFromEnv,
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
      runtimeConfigPath,
    } as AcsOrchestratorConfig;

    const snapshot = applyRuntimeConfigPatch(config, {
      maxRunningSandboxes: 4,
      warnRunningSandboxes: 3,
    });

    expect(snapshot).toMatchObject({
      maxRunningSandboxes: 4,
      warnRunningSandboxes: 3,
      persisted: true,
    });
    expect(runtimeConfigSnapshot(config)).toMatchObject({
      maxRunningSandboxes: 4,
      warnRunningSandboxes: 3,
    });
    expect(JSON.parse(readFileSync(runtimeConfigPath, 'utf-8'))).toEqual({
      maxRunningSandboxes: 4,
      warnRunningSandboxes: 3,
    });
  });

  it('rejects invalid runtime config values', () => {
    expect(() => parseRuntimeConfigPatch({ maxRunningSandboxes: 2, warnRunningSandboxes: 3 }))
      .toThrow(/warnRunningSandboxes/);
    expect(() => parseRuntimeConfigPatch({ maxRunningSandboxes: 1.5 }))
      .toThrow(/integer/);
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
