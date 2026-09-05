/**
 * 出包校验（scripts/release/build-release.mjs，纯 JS）与运行时严格解析
 * （manifest.ts）必须对同一批 manifest 给出同样的接受/拒绝结论：出包放行而
 * launcher 拒绝，会让整批运维命令在生产不可用。
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseAdminRunnerManifest, parseCommandGovernance } from './manifest.js';

// 两个 .mjs 是 JS，没有类型声明；用 unknown 接口最小化耦合。
interface BuildAdminRunnerModule {
  ADMIN_RUNNER_ENTRIES: ReadonlyArray<{
    command: string;
    source: string;
    description: string;
    governance: unknown;
  }>;
  MANIFEST_KIND: string;
  RUNTIME_GUARD_ENTRY: string;
  GOVERNANCE_BOOTSTRAP_ENTRY: string;
  LAUNCHER_ENTRY: string;
  LAUNCHER_SOURCE: string;
  adminBanner: (options?: { bootstrap?: boolean }) => string;
  adminRuntimeGuardSource: () => string;
  adminGovernanceBootstrapSource: () => string;
  adminRunnerManifest: (...args: unknown[]) => Record<string, unknown>;
  manifestCommand: (entry: unknown, details: unknown) => Record<string, unknown>;
  validateAdminRunnerGovernance: (command: string, governance: unknown) => unknown;
}
interface BuildReleaseModule {
  assertAdminRunnerShipped: (
    root: string,
    entries?: unknown,
    kind?: string,
    digest?: string,
  ) => Promise<unknown>;
}
interface RuntimeDependencyModule {
  loadRuntimeDependencyContract: (path?: string) => Promise<unknown>;
  runtimeDependencyContractDigest: (contract: unknown) => string;
}

const serverRoot = join(import.meta.dirname, '..', '..', '..');
const repoRoot = join(serverRoot, '..');
const buildAdminRunner = (await import(
  join(serverRoot, 'scripts', 'build-admin-runner.mjs')
)) as unknown as BuildAdminRunnerModule;
const buildRelease = (await import(
  join(repoRoot, 'scripts', 'release', 'build-release.mjs')
)) as unknown as BuildReleaseModule;
const runtimeDependency = (await import(
  join(repoRoot, 'scripts', 'release', 'runtime-dependency.mjs')
)) as unknown as RuntimeDependencyModule;

const CONTRACT_DIGEST = runtimeDependency.runtimeDependencyContractDigest(
  await runtimeDependency.loadRuntimeDependencyContract(
    join(repoRoot, 'config', 'runtime-dependency-contract.json'),
  ),
);

function digestOf(body: string) {
  return {
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    size: Buffer.byteLength(body),
  };
}

const temps: string[] = [];
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function stage(
  mutateManifest: (manifest: Record<string, unknown>) => Record<string, unknown> = (m) => m,
): Promise<{ root: string; manifest: Record<string, unknown> }> {
  const root = await mkdtemp(join(tmpdir(), 'admin-runner-parity-'));
  temps.push(root);
  const stagedServer = join(root, 'server');
  const adminDir = join(stagedServer, 'dist', 'admin');
  await mkdir(adminDir, { recursive: true });
  const guard = buildAdminRunner.adminRuntimeGuardSource();
  const bootstrap = buildAdminRunner.adminGovernanceBootstrapSource();
  const launcher = `${buildAdminRunner.adminBanner({ bootstrap: false })}\n/* launcher */`;
  await writeFile(join(stagedServer, 'dist', 'runtime-dependency-admin-guard.mjs'), guard);
  await writeFile(join(stagedServer, 'dist', 'admin-governance-bootstrap.mjs'), bootstrap);
  await writeFile(join(adminDir, buildAdminRunner.LAUNCHER_ENTRY), launcher);
  await mkdir(dirname(join(stagedServer, buildAdminRunner.LAUNCHER_SOURCE)), { recursive: true });
  await writeFile(join(stagedServer, buildAdminRunner.LAUNCHER_SOURCE), '// src\n');
  const commands = [];
  for (const entry of buildAdminRunner.ADMIN_RUNNER_ENTRIES) {
    // 真实 esbuild 产物：源码带 shebang 时 shebang 保留在 banner 之前（三个脚本如此）。
    const sourceHead = (await readFile(join(serverRoot, entry.source), 'utf8')).split('\n')[0]!;
    const shebang = sourceHead.startsWith('#!') ? `${sourceHead}\n` : '';
    const body = `${shebang}${buildAdminRunner.adminBanner()}\n/* ${entry.command} */`;
    await writeFile(join(adminDir, `${entry.command}.mjs`), body);
    await mkdir(dirname(join(stagedServer, entry.source)), { recursive: true });
    await writeFile(join(stagedServer, entry.source), '// source\n');
    commands.push(buildAdminRunner.manifestCommand(entry, digestOf(body)));
  }
  const manifest = mutateManifest(
    buildAdminRunner.adminRunnerManifest(
      buildAdminRunner.MANIFEST_KIND,
      commands,
      CONTRACT_DIGEST,
      { entry: buildAdminRunner.RUNTIME_GUARD_ENTRY, ...digestOf(guard) },
      { entry: buildAdminRunner.GOVERNANCE_BOOTSTRAP_ENTRY, ...digestOf(bootstrap) },
      {
        entry: buildAdminRunner.LAUNCHER_ENTRY,
        source: buildAdminRunner.LAUNCHER_SOURCE,
        ...digestOf(launcher),
      },
    ),
  );
  await writeFile(join(adminDir, 'manifest.json'), JSON.stringify(manifest));
  return { root, manifest };
}

describe('build-time and runtime manifest validation agree', () => {
  it('the manifest produced by the build helpers is accepted by both sides', async () => {
    const { root, manifest } = await stage();
    await expect(buildRelease.assertAdminRunnerShipped(root)).resolves.toBeTruthy();
    const parsed = parseAdminRunnerManifest(manifest);
    expect(parsed.commands.map((command) => command.command)).toEqual(
      buildAdminRunner.ADMIN_RUNNER_ENTRIES.map((entry) => entry.command),
    );
  });

  it('both sides reject the same structural mutations', async () => {
    const mutations: Array<[string, (m: Record<string, unknown>) => Record<string, unknown>]> = [
      ['unknown top-level key', (m) => ({ ...m, extra: true })],
      ['legacy schemaVersion', (m) => ({ ...m, schemaVersion: 1 })],
      [
        'command without description',
        (m) => ({
          ...m,
          commands: (m.commands as Record<string, unknown>[]).map((command, index) => {
            if (index !== 0) return command;
            const { description: _omitted, ...rest } = command;
            return rest;
          }),
        }),
      ],
      [
        'command with unknown key',
        (m) => ({
          ...m,
          commands: (m.commands as Record<string, unknown>[]).map((command, index) =>
            index === 0 ? { ...command, note: 'x' } : command,
          ),
        }),
      ],
      [
        'launcher without source',
        (m) => {
          const { source: _omitted, ...launcher } = m.launcher as Record<string, unknown>;
          return { ...m, launcher };
        },
      ],
      [
        'guard file with unknown key',
        (m) => ({
          ...m,
          runtimeDependencyGuard: {
            ...(m.runtimeDependencyGuard as Record<string, unknown>),
            extra: 1,
          },
        }),
      ],
      [
        'write intent with unknown key',
        (m) => ({
          ...m,
          commands: (m.commands as Record<string, unknown>[]).map((command, index) => {
            if (index !== 0) return command;
            const governance = command.governance as Record<string, unknown>;
            const writeIntents = (governance.writeIntents as Record<string, unknown>[]).map(
              (intent, intentIndex) => (intentIndex === 0 ? { ...intent, extra: 1 } : intent),
            );
            return { ...command, governance: { ...governance, writeIntents } };
          }),
        }),
      ],
      [
        'governance without requiredFlags',
        (m) => ({
          ...m,
          commands: (m.commands as Record<string, unknown>[]).map((command, index) => {
            if (index !== 0) return command;
            const { requiredFlags: _omitted, ...governance } = command.governance as Record<
              string,
              unknown
            >;
            return { ...command, governance };
          }),
        }),
      ],
      [
        'governance with invalid enum',
        (m) => ({
          ...m,
          commands: (m.commands as Record<string, unknown>[]).map((command, index) =>
            index === 0
              ? {
                  ...command,
                  governance: {
                    ...(command.governance as Record<string, unknown>),
                    riskLevel: 'extreme',
                  },
                }
              : command,
          ),
        }),
      ],
    ];
    for (const [label, mutate] of mutations) {
      const { root, manifest } = await stage(mutate);
      await expect(buildRelease.assertAdminRunnerShipped(root), label).rejects.toThrow();
      expect(() => parseAdminRunnerManifest(manifest), label).toThrow();
    }
  });

  it('governance validators agree on every shipped entry and on drift', () => {
    for (const entry of buildAdminRunner.ADMIN_RUNNER_ENTRIES) {
      expect(() =>
        buildAdminRunner.validateAdminRunnerGovernance(entry.command, entry.governance),
      ).not.toThrow();
      expect(() => parseCommandGovernance(entry.governance, entry.command)).not.toThrow();
    }
    const base = buildAdminRunner.ADMIN_RUNNER_ENTRIES[0]!.governance as Record<string, unknown>;
    const drifts: Record<string, unknown>[] = [
      { ...base, riskLevel: 'extreme' },
      { ...base, extra: true },
      { ...base, supportedEnvironments: [] },
      { ...base, acceptsAuthorizationRef: 'yes' },
      { ...base, writeIntents: [], escalationFlags: [] },
    ];
    for (const drift of drifts) {
      expect(() => buildAdminRunner.validateAdminRunnerGovernance('x', drift)).toThrow();
      expect(() => parseCommandGovernance(drift, 'x')).toThrow();
    }
  });
});
