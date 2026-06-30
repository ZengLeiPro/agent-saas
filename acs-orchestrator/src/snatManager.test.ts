import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl, KubectlResult } from './kubectl.js';
import { SnatManager } from './snatManager.js';

describe('SnatManager', () => {
  it('creates one /32 SNAT entry for a probe sandbox and reuses existing entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acs-snat-test-'));
    const statePath = join(root, 'state.json');
    const logPath = join(root, 'calls.log');
    writeFileSync(statePath, JSON.stringify({ entries: [] }), 'utf-8');
    const cliPath = writeFakeAliyun(root, statePath, logPath);
    const kubectl = podKubectl('172.16.177.139');
    const manager = new SnatManager({ ...baseConfig(cliPath), snat: { ...baseConfig(cliPath).snat, mode: 'probe-only' } }, kubectl, noopLogger);

    const ref = { name: 'as-probe-123', workspaceId: 'network-probe', sandboxScopeId: 'network-probe', sessionId: 'probe-123', mountSubPath: 'network-probe' };
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
    writeFileSync(statePath, JSON.stringify({
      entries: [
        { SnatEntryId: 'snat-managed-active', SnatEntryName: 'agent-saas-acs-as-active', SourceCIDR: '172.16.177.10/32', SnatIp: '120.77.218.94', Status: 'Available' },
        { SnatEntryId: 'snat-managed-orphan', SnatEntryName: 'agent-saas-acs-as-orphan', SourceCIDR: '172.16.177.11/32', SnatIp: '120.77.218.94', Status: 'Available' },
        { SnatEntryId: 'snat-manual', SnatEntryName: 'manual-entry', SourceCIDR: '172.16.177.12/32', SnatIp: '120.77.218.94', Status: 'Available' },
      ],
    }), 'utf-8');
    const cliPath = writeFakeAliyun(root, statePath, logPath);
    const manager = new SnatManager({ ...baseConfig(cliPath), snat: { ...baseConfig(cliPath).snat, mode: 'probe-only' } }, podKubectl('172.16.177.10'), noopLogger);

    const report = await manager.cleanupOrphans(new Set(['172.16.177.10/32']));

    expect(report.deleted).toEqual(['snat-managed-orphan']);
    expect(report.unexpected.map((entry) => entry.id)).toEqual(['snat-manual']);
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { entries: Array<{ SnatEntryId: string }> };
    expect(state.entries.map((entry) => entry.SnatEntryId).sort()).toEqual(['snat-managed-active', 'snat-manual']);
  });
});

function writeFakeAliyun(root: string, statePath: string, logPath: string): string {
  const cliPath = join(root, 'aliyun-fake.cjs');
  writeFileSync(cliPath, `#!/usr/bin/env node
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
  console.log(JSON.stringify({ SnatTableEntries: { SnatTableEntry: entries }, TotalCount: entries.length }));
  process.exit(0);
}
if (args[1] === 'CreateSnatEntry') {
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
  state.entries = state.entries.filter((entry) => entry.SnatEntryId !== id);
  fs.writeFileSync(statePath, JSON.stringify(state));
  console.log(JSON.stringify({ RequestId: 'ok' }));
  process.exit(0);
}
console.error('unexpected args ' + args.join(' '));
process.exit(2);
`, 'utf-8');
  chmodSync(cliPath, 0o755);
  return cliPath;
}

function podKubectl(podIp: string): Kubectl {
  return {
    async run(args: string[]): Promise<KubectlResult> {
      if (args[0] === 'get' && args[1] === 'pod') {
        return {
          stdout: JSON.stringify({
            items: [{
              metadata: { name: 'as-probe-123-pod' },
              status: { podIP: podIp },
            }],
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
    skipProvisionOnSameRecipe: true,
    lifecycleEnabled: true,
    sandboxCleanupIntervalMs: 300_000,
    sandboxIdlePauseMs: 900_000,
    sandboxTtlMs: 21_600_000,
    sandboxOrphanGraceMs: 1_800_000,
    maxRunningSandboxes: 8,
    warnRunningSandboxes: 6,
    networkPolicy: { mode: 'public-egress', denyPrivateNetworks: true },
    snat: {
      mode: 'probe-only',
      aliyunCliPath,
      regionId: 'cn-shenzhen',
      snatTableId: 'stb-test',
      snatIp: '120.77.218.94',
      entryNamePrefix: 'agent-saas-acs',
      maxManagedEntries: 12,
      requestTimeoutMs: 1_000,
      stabilizeAfterCreateMs: 0,
    },
    alertMinIntervalMs: 300_000,
    capabilities: {
      browser: true,
      media: true,
      officeDocuments: true,
      pythonBasePackages: true,
    },
    logLevel: 'info',
  };
}
