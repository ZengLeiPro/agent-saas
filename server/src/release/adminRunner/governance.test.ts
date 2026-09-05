import { describe, expect, it } from 'vitest';

import {
  decideConfigIdentityGate,
  evaluateConfigIdentity,
  parseObservedConfigIdentity,
  type ObservedConfigIdentity,
} from './configIdentityCheck.js';
import {
  classifyInvocation,
  detectTargetOverrides,
  missingRequiredFlags,
  normalizeAuthorizationRef,
  summarizeArgs,
} from './intent.js';
import {
  parseAdminRunnerManifest,
  parseCommandGovernance,
  type CommandGovernance,
} from './manifest.js';
import { checkReleaseIdentity, releaseIdentityAllowed } from './releaseIdentity.js';

const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const DIGEST_C = `sha256:${'c'.repeat(64)}`;
const SHA = '1'.repeat(40);

const governance: CommandGovernance = {
  riskLevel: 'high',
  defaultMode: 'dry_run',
  writeIntents: [{ flag: '--execute', riskLevel: 'high', description: 'write' }],
  escalationFlags: [
    { flag: '--force', requiresWriteIntent: '--execute', riskLevel: 'critical', description: 'x' },
  ],
  acceptsAuthorizationRef: false,
  idempotency: 'resumable',
  configRequirements: ['pg_connection'],
  supportedEnvironments: ['production', 'staging', 'development', 'test'],
  requiredFlags: [],
};

function manifestDocument(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    kind: 'agent-saas-admin-runner',
    dependencyContractDigest: DIGEST_A,
    runtimeDependencyGuard: {
      entry: '../runtime-dependency-admin-guard.mjs',
      digest: DIGEST_B,
      size: 3,
    },
    governanceBootstrap: { entry: '../admin-governance-bootstrap.mjs', digest: DIGEST_B, size: 4 },
    launcher: {
      entry: 'launcher.mjs',
      source: 'src/release/adminRunner/launcherCli.ts',
      digest: DIGEST_C,
      size: 5,
    },
    commands: [
      {
        command: 'demo',
        entry: 'demo.mjs',
        source: 'scripts/demo.mts',
        description: 'demo',
        governance,
        digest: DIGEST_A,
        size: 9,
      },
    ],
    ...overrides,
  };
}

describe('admin runner manifest parsing', () => {
  it('accepts a complete schemaVersion 2 manifest', () => {
    const manifest = parseAdminRunnerManifest(manifestDocument());
    expect(manifest.commands[0]?.governance.writeIntents[0]?.flag).toBe('--execute');
    expect(manifest.commands[0]?.governance.requiredFlags).toEqual([]);
    expect(manifest.launcher.entry).toBe('launcher.mjs');
  });

  it('fails closed on legacy schema, unknown keys, bad enums and missing sections', () => {
    expect(() => parseAdminRunnerManifest(manifestDocument({ schemaVersion: 1 }))).toThrow(
      /schemaVersion/u,
    );
    expect(() => parseAdminRunnerManifest({ ...manifestDocument(), extra: 1 })).toThrow(
      /keys drifted/u,
    );
    expect(() =>
      parseAdminRunnerManifest(
        manifestDocument({ launcher: { entry: 'launcher.mjs', digest: DIGEST_C, size: 5 } }),
      ),
    ).toThrow(/launcher keys drifted/u);
    expect(() =>
      parseAdminRunnerManifest(
        manifestDocument({
          runtimeDependencyGuard: {
            entry: '../runtime-dependency-admin-guard.mjs',
            digest: DIGEST_B,
            size: 3,
            extra: 1,
          },
        }),
      ),
    ).toThrow(/runtimeDependencyGuard keys drifted/u);
    expect(() =>
      parseAdminRunnerManifest(
        manifestDocument({
          commands: [
            {
              ...manifestDocument().commands[0],
              governance: { ...governance, riskLevel: 'extreme' },
            },
          ],
        }),
      ),
    ).toThrow(/riskLevel/u);
    expect(() =>
      parseAdminRunnerManifest(
        manifestDocument({ commands: [{ ...manifestDocument().commands[0], entry: 'other.mjs' }] }),
      ),
    ).toThrow(/entry must be demo\.mjs/u);
    expect(() => parseAdminRunnerManifest(manifestDocument({ commands: [] }))).toThrow(
      /non-empty/u,
    );
  });

  it('rejects escalation flags that do not point at a declared write intent', () => {
    expect(() =>
      parseCommandGovernance(
        {
          ...governance,
          escalationFlags: [
            {
              flag: '--force',
              requiresWriteIntent: '--apply',
              riskLevel: 'high',
              description: 'x',
            },
          ],
        },
        'demo',
      ),
    ).toThrow(/undeclared write intent/u);
    expect(() =>
      parseCommandGovernance(
        { ...governance, defaultMode: 'dry_run', writeIntents: [], escalationFlags: [] },
        'demo',
      ),
    ).toThrow(/dry_run without a write intent/u);
  });

  it('validates requiredFlags and inner key sets', () => {
    expect(
      parseCommandGovernance({ ...governance, requiredFlags: ['--output'] }, 'demo').requiredFlags,
    ).toEqual(['--output']);
    expect(() =>
      parseCommandGovernance({ ...governance, requiredFlags: ['--execute'] }, 'demo'),
    ).toThrow(/must not be a write intent/u);
    expect(() =>
      parseCommandGovernance({ ...governance, requiredFlags: ['--output', '--output'] }, 'demo'),
    ).toThrow(/must not repeat/u);
    expect(() =>
      parseCommandGovernance({ ...governance, requiredFlags: ['output'] }, 'demo'),
    ).toThrow(/--flag/u);
    const { requiredFlags: _omitted, ...withoutRequired } = governance;
    expect(() => parseCommandGovernance(withoutRequired, 'demo')).toThrow(/keys drifted/u);
    expect(() =>
      parseCommandGovernance(
        {
          ...governance,
          writeIntents: [{ flag: '--execute', riskLevel: 'high', description: 'w', extra: 1 }],
        },
        'demo',
      ),
    ).toThrow(/writeIntents\[0\] keys drifted/u);
  });
});

describe('write intent classification', () => {
  it('stays in the default mode when no declared write flag is present', () => {
    const result = classifyInvocation(governance, [
      '--connection-string=postgres://x',
      '--limit',
      '5',
    ]);
    expect(result.mode).toBe('dry_run');
    expect(result.writeIntents).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.argsSummary).toEqual({
      declaredFlags: [],
      otherFlagCount: 2,
      positionalCount: 1,
      inlineValueCount: 1,
    });
  });

  it('matches declared write flags exactly, like the scripts do', () => {
    expect(classifyInvocation(governance, ['--execute']).mode).toBe('write');
    // 脚本用 argv.includes('--execute')：带 =value 的形态对脚本不是写 flag，launcher 也不能算写。
    expect(classifyInvocation(governance, ['--execute=false']).mode).toBe('dry_run');
    expect(classifyInvocation(governance, ['--execute=true']).mode).toBe('dry_run');
    expect(classifyInvocation(governance, ['--executed']).mode).toBe('dry_run');
    expect(classifyInvocation(governance, ['--EXECUTE']).mode).toBe('dry_run');
    expect(classifyInvocation(governance, ['--execute', '--execute']).writeIntents).toEqual([
      '--execute',
    ]);
    expect(classifyInvocation({ ...governance, defaultMode: 'read_only' }, []).mode).toBe(
      'read_only',
    );
  });

  it('flags escalation without its write intent and misplaced authorization refs', () => {
    const escalation = classifyInvocation(governance, ['--force']);
    expect(escalation.problems).toEqual([
      { category: 'escalation_without_write', flag: '--force', requiresWriteIntent: '--execute' },
    ]);
    const misplaced = classifyInvocation(governance, ['--execute', '--authorization-ref', 'CHG-1']);
    expect(misplaced.problems).toEqual([
      { category: 'authorization_ref_misplaced', flag: '--authorization-ref' },
    ]);
    expect(classifyInvocation(governance, ['--authorization-ref=CHG-1']).problems).toEqual([
      { category: 'authorization_ref_misplaced', flag: '--authorization-ref' },
    ]);
    expect(classifyInvocation(governance, ['--execute', '--force']).problems).toEqual([]);
  });

  it('only records declared flag names; everything else is counted, never copied', () => {
    const declared = new Set(['--execute', '--force']);
    const summary = summarizeArgs(
      [
        '--connection-string',
        'postgres://u:p@h/db',
        '--root=/etc/secret',
        '--tenant-customer-123',
        '--/srv/private/customer-123',
        '--execute',
      ],
      declared,
    );
    expect(summary).toEqual({
      declaredFlags: ['--execute'],
      otherFlagCount: 4,
      positionalCount: 1,
      inlineValueCount: 1,
    });
    const json = JSON.stringify(summary);
    for (const leak of ['postgres://', '/etc/secret', 'customer-123', '/srv/private']) {
      expect(json).not.toContain(leak);
    }
  });

  it('reports missing required flags, accepting both exact and =value forms', () => {
    const required = { ...governance, requiredFlags: ['--output'] };
    expect(missingRequiredFlags(required, [])).toEqual(['--output']);
    expect(missingRequiredFlags(required, ['--output', '/tmp/x'])).toEqual([]);
    expect(missingRequiredFlags(required, ['--output=/tmp/x'])).toEqual([]);
    expect(missingRequiredFlags(required, ['--outputs=/tmp/x'])).toEqual(['--output']);
  });

  it('detects target override signals by name only', () => {
    expect(
      detectTargetOverrides({ DATABASE_URL: 'postgres://u:p@h/db' }, [
        '--connection-string=postgres://x',
        '--root',
        '/mnt/data',
        '--limit=5',
      ]),
    ).toEqual(['--connection-string', '--root', 'env:DATABASE_URL']);
    expect(detectTargetOverrides({ DATABASE_URL: '   ' }, [])).toEqual([]);
  });

  it('normalises and validates authorization refs', () => {
    expect(normalizeAuthorizationRef('  CHG-2026-0001 ')).toBe('CHG-2026-0001');
    expect(normalizeAuthorizationRef('OPS_2026.09#12')).toBe('OPS_2026.09#12');
    expect(normalizeAuthorizationRef(undefined)).toBeUndefined();
    expect(normalizeAuthorizationRef('   ')).toBeUndefined();
    for (const bad of [
      'has space',
      'x'.repeat(65),
      'CHG/home/123',
      'postgres://db/app',
      'a:b',
      '-leading',
      'ghp_abcdefghijklmnopqrstuvwxyz',
      'sk-abcdefghijklmnop',
      'AKIAABCDEFGHIJKLMNOP',
    ]) {
      expect(() => normalizeAuthorizationRef(bad), bad).toThrow(/ticket/u);
    }
  });
});

describe('config identity evaluation', () => {
  const observed: ObservedConfigIdentity = {
    schemaVersion: 1,
    digest: DIGEST_A,
    credentialVersionDigest: DIGEST_B,
    secretRefCount: 2,
    versionResolution: 'resolved',
  };
  const expected = { schemaVersion: 1, digest: DIGEST_A, credentialVersionDigest: DIGEST_B };

  it('parses config-identity-cli output strictly', () => {
    expect(parseObservedConfigIdentity(`${JSON.stringify(observed)}\n`)).toEqual(observed);
    // 真实 CLI 在 versionResolution=unavailable 时输出 null，而不是省略字段。
    expect(
      parseObservedConfigIdentity(
        JSON.stringify({
          ...observed,
          credentialVersionDigest: null,
          versionResolution: 'unavailable',
        }),
      ),
    ).toEqual({
      schemaVersion: 1,
      digest: DIGEST_A,
      secretRefCount: 2,
      versionResolution: 'unavailable',
    });
    expect(() => parseObservedConfigIdentity('nope')).toThrow(/not JSON/u);
    expect(() => parseObservedConfigIdentity(JSON.stringify({ ...observed, digest: 'x' }))).toThrow(
      /digest/u,
    );
    expect(() =>
      parseObservedConfigIdentity(JSON.stringify({ ...observed, versionResolution: 'meh' })),
    ).toThrow(/versionResolution/u);
  });

  it('delegates the four-state decision to the runtime implementation', () => {
    expect(evaluateConfigIdentity({ expected, observed }).status).toBe('consistent');
    expect(
      evaluateConfigIdentity({ expected: { ...expected, digest: DIGEST_C }, observed }),
    ).toMatchObject({ status: 'drifted', expectedDigest: DIGEST_C, observedDigest: DIGEST_A });
    expect(
      evaluateConfigIdentity({
        expected: { ...expected, credentialVersionDigest: DIGEST_C },
        observed,
      }).status,
    ).toBe('drifted');
    expect(evaluateConfigIdentity({ expected: undefined, observed })).toMatchObject({
      status: 'unverifiable',
      reason: 'expected_not_bound',
    });
    expect(
      evaluateConfigIdentity({ expected: { schemaVersion: 1, digest: DIGEST_A }, observed }),
    ).toMatchObject({ status: 'unverifiable', reason: 'expected_credential_version_not_bound' });
    expect(
      evaluateConfigIdentity({
        expected,
        observed: { ...observed, versionResolution: 'partial' },
      }),
    ).toMatchObject({ status: 'unverifiable', reason: 'secret_ref_version_unresolved' });
    expect(
      evaluateConfigIdentity({ expected: { ...expected, schemaVersion: 2 }, observed }),
    ).toMatchObject({ status: 'unverifiable', reason: 'schema_version_unsupported' });
    expect(evaluateConfigIdentity({ expected, observed: { error: 'boom' } })).toMatchObject({
      status: 'unverifiable',
      reason: 'observation_failed',
      expectedDigest: DIGEST_A,
    });
    const noRefs: ObservedConfigIdentity = {
      schemaVersion: 1,
      digest: DIGEST_A,
      secretRefCount: 0,
      versionResolution: 'resolved',
    };
    expect(
      evaluateConfigIdentity({ expected: { schemaVersion: 1, digest: DIGEST_A }, observed: noRefs })
        .status,
    ).toBe('consistent');
    // release env 残留了旧的凭据 digest 而 observed 已无受管 ref：与运行期一致判 drifted，不放行。
    expect(evaluateConfigIdentity({ expected, observed: noRefs }).status).toBe('drifted');
    // 畸形输出：声称 resolved 却没有凭据 digest → 与 expected 不等 → drifted。
    expect(
      evaluateConfigIdentity({
        expected,
        observed: { ...observed, credentialVersionDigest: undefined },
      }).status,
    ).toBe('drifted');
  });

  it('applies the fail-closed matrix', () => {
    const consistent = { status: 'consistent' as const };
    const drifted = { status: 'drifted' as const };
    const notBound = { status: 'unverifiable' as const, reason: 'expected_not_bound' as const };
    const failed = { status: 'unverifiable' as const, reason: 'observation_failed' as const };
    for (const mode of ['read_only', 'dry_run', 'write'] as const) {
      expect(decideConfigIdentityGate('production', mode, consistent)).toEqual({
        allowed: true,
        annotated: false,
      });
      expect(decideConfigIdentityGate('production', mode, drifted).allowed).toBe(false);
      expect(decideConfigIdentityGate('production', mode, failed).allowed).toBe(false);
      expect(decideConfigIdentityGate('staging', mode, notBound).allowed).toBe(false);
      expect(decideConfigIdentityGate('staging', mode, drifted).allowed).toBe(false);
      expect(decideConfigIdentityGate('development', mode, drifted)).toEqual({
        allowed: true,
        annotated: true,
      });
      expect(decideConfigIdentityGate('test', mode, failed)).toEqual({
        allowed: true,
        annotated: true,
      });
    }
    expect(decideConfigIdentityGate('production', 'write', notBound).allowed).toBe(false);
    expect(decideConfigIdentityGate('production', 'dry_run', notBound)).toEqual({
      allowed: true,
      annotated: true,
    });
    expect(decideConfigIdentityGate('production', 'read_only', notBound)).toEqual({
      allowed: true,
      annotated: true,
    });
  });
});

describe('release identity check', () => {
  const runtimeDependenciesJson = JSON.stringify({
    schemaVersion: 1,
    kind: 'agent-saas-runtime-dependency-identity',
    sourceSha: SHA,
    contractDigest: DIGEST_A,
    dependencyDigest: DIGEST_B,
    node: {},
    baseImages: [],
    tools: [],
    identityDigest: DIGEST_C,
  });

  it('binds when release env and runtime-dependencies.json agree', () => {
    const check = checkReleaseIdentity({
      runtimeIdentity: {
        environment: 'production',
        releaseSha: SHA,
        releaseId: 'rel-1',
        serverDigest: DIGEST_C,
        safetyAttested: true,
      },
      runtimeDependenciesJson,
      manifestDependencyContractDigest: DIGEST_A,
    });
    expect(check).toMatchObject({
      status: 'bound',
      releaseId: 'rel-1',
      releaseSha: SHA,
      dependencyDigest: DIGEST_B,
    });
    expect(releaseIdentityAllowed('production', check)).toBe(true);
  });

  it('only copies well-formed identity values into the receipt', () => {
    const check = checkReleaseIdentity({
      runtimeIdentity: {
        environment: 'production',
        releaseSha: SHA,
        releaseId: 'postgres://user:pw@db/app',
        serverDigest: '/etc/agent-saas/secret',
        safetyAttested: true,
      },
      runtimeDependenciesJson,
      manifestDependencyContractDigest: DIGEST_A,
    });
    expect(check.status).toBe('bound');
    expect(check.releaseId).toBeUndefined();
    expect(check.serverDigest).toBeUndefined();
  });

  it('rejects missing files, contract conflicts and SHA mismatches', () => {
    const base = {
      runtimeIdentity: {
        environment: 'production' as const,
        releaseSha: SHA,
        safetyAttested: true,
      },
      runtimeDependenciesJson,
      manifestDependencyContractDigest: DIGEST_A,
    };
    expect(checkReleaseIdentity({ ...base, runtimeDependenciesJson: undefined })).toMatchObject({
      status: 'mismatch',
      reason: 'runtime_dependencies_missing',
    });
    expect(checkReleaseIdentity({ ...base, runtimeDependenciesJson: '{}' })).toMatchObject({
      status: 'mismatch',
      reason: 'runtime_dependencies_invalid',
    });
    expect(
      checkReleaseIdentity({ ...base, manifestDependencyContractDigest: DIGEST_C }),
    ).toMatchObject({ status: 'mismatch', reason: 'contract_digest_mismatch' });
    expect(
      checkReleaseIdentity({
        ...base,
        runtimeIdentity: {
          environment: 'production',
          releaseSha: '2'.repeat(40),
          safetyAttested: true,
        },
      }),
    ).toMatchObject({ status: 'mismatch', reason: 'release_sha_mismatch' });
  });

  it('allows not_bound only in development/test', () => {
    const check = checkReleaseIdentity({
      runtimeIdentity: { environment: 'development', safetyAttested: true },
      runtimeDependenciesJson,
      manifestDependencyContractDigest: DIGEST_A,
    });
    expect(check).toMatchObject({ status: 'not_bound', reason: 'release_sha_not_bound' });
    expect(releaseIdentityAllowed('development', check)).toBe(true);
    expect(releaseIdentityAllowed('test', check)).toBe(true);
    expect(releaseIdentityAllowed('production', check)).toBe(false);
    expect(releaseIdentityAllowed('staging', check)).toBe(false);
    expect(releaseIdentityAllowed('development', { status: 'mismatch' })).toBe(false);
  });
});
