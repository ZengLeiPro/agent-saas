import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compareEnvironments } from './compare-environments.mjs';
import { exportEffectiveConfig } from './export-effective-config.mjs';
import { pathMatches } from './effective-config-lib.mjs';
import { validateEffectiveConfig } from './validate-effective-config.mjs';

test('exports a redacted inventory without exposing inline or referenced secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-config-export-'));
  try {
    await mkdir(join(root, 'data'));
    await writeFile(
      join(root, 'config.json'),
      JSON.stringify({
        agent: { cwd: '/workspace' },
        models: { groups: [{ id: 'g', apiKey: 'plaintext-key', models: [{ id: 'm' }] }] },
        webTools: { enabled: true, search: { apiKeyRef: 'vault/ref-1' } },
      }),
    );
    const report = await exportEffectiveConfig({
      config: join(root, 'config.json'),
      root,
      environment: 'staging',
      contract: 'config/governance/capability-contract.json',
    });
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes('plaintext-key'), false);
    assert.equal(serialized.includes('vault/ref-1'), false);
    assert.equal(report.secretReadiness, 'legacy_inline');
    assert.deepEqual(report.config.models.groups[0].apiKey, { state: 'inline_legacy' });
    assert.deepEqual(report.config.webTools.search.apiKeyRef, { state: 'ref' });
    assert.deepEqual(validateEffectiveConfig(report), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('classifies must-equal, must-differ, approved and unknown differences', () => {
  const policy = {
    mustEqual: ['config.feature.enabled'],
    mustDiffer: ['config.server.port'],
    allowedDifference: [{ path: 'runtime.**' }],
    ignored: ['exportedAt'],
  };
  const report = compareEnvironments(
    {
      environment: 'staging',
      config: { feature: { enabled: false }, server: { port: 3210 }, extra: 1 },
      runtime: { release: 'a' },
    },
    {
      environment: 'production',
      config: { feature: { enabled: true }, server: { port: 3210 }, extra: 2 },
      runtime: { release: 'b' },
    },
    policy,
  );
  assert.deepEqual(report.summary, {
    mustEqualViolations: 1,
    mustDifferViolations: 1,
    approvedDifferences: 1,
    unclassifiedDifferences: 2,
  });
});

test('requires a matching trusted runtime identity for production exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-config-production-export-'));
  try {
    await writeFile(join(root, 'config.json'), JSON.stringify({ agent: { cwd: '/workspace' } }));
    await assert.rejects(
      exportEffectiveConfig({
        config: join(root, 'config.json'),
        root,
        environment: 'production',
        contract: 'config/governance/capability-contract.json',
      }),
      /runtimeIdentity is required/u,
    );
    await writeFile(
      join(root, 'runtime-identity.json'),
      JSON.stringify({ environment: 'staging' }),
    );
    await assert.rejects(
      exportEffectiveConfig({
        config: join(root, 'config.json'),
        root,
        environment: 'production',
        runtimeIdentity: join(root, 'runtime-identity.json'),
        contract: 'config/governance/capability-contract.json',
      }),
      /environment mismatch/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('supports exact, one-segment and recursive path patterns', () => {
  assert.equal(pathMatches('config.models.**', 'config.models.groups.0.id'), true);
  assert.equal(pathMatches('config.hands.*.baseUrl', 'config.hands.0.baseUrl'), true);
  assert.equal(pathMatches('config.hands.*.baseUrl', 'config.hands.0.auth'), false);
});
