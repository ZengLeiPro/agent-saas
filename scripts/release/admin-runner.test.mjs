import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  ADMIN_RUNNER_ENTRIES,
  GOVERNANCE_BOOTSTRAP_ENTRY,
  LAUNCHER_ENTRY,
  LAUNCHER_SOURCE,
  MANIFEST_KIND,
  MANIFEST_SCHEMA_VERSION,
  RUNTIME_GUARD_ENTRY,
  adminBanner,
  adminEntryFile,
  adminGovernanceBootstrapSource,
  adminRunnerManifest,
  adminRuntimeGuardSource,
  esbuildArgs,
  manifestCommand,
  renderAdminRunnerCommandTable,
  validateAdminRunnerEntries,
  validateAdminRunnerGovernance,
} from '../../server/scripts/build-admin-runner.mjs';
import { assertAdminRunnerShipped } from './build-release.mjs';
import {
  loadRuntimeDependencyContract,
  runtimeDependencyContractDigest,
} from './runtime-dependency.mjs';

const DEPENDENCY_CONTRACT_DIGEST = runtimeDependencyContractDigest(
  await loadRuntimeDependencyContract(),
);

test('admin runner entries reference real one-off operations scripts', async () => {
  const serverRoot = join(process.cwd(), 'server');
  for (const entry of ADMIN_RUNNER_ENTRIES) {
    await stat(join(serverRoot, entry.source));
    assert.match(entry.command, /^[a-z0-9-]+$/u);
    assert.ok(entry.description.length > 0);
  }
  await stat(join(serverRoot, LAUNCHER_SOURCE));
  const commands = ADMIN_RUNNER_ENTRIES.map((entry) => entry.command);
  assert.equal(new Set(commands).size, commands.length);
});

test('every admin runner command declares complete governance metadata', () => {
  validateAdminRunnerEntries(ADMIN_RUNNER_ENTRIES);
  for (const entry of ADMIN_RUNNER_ENTRIES) {
    const governance = entry.governance;
    assert.ok(governance.writeIntents.length > 0 || governance.defaultMode === 'read_only');
    assert.ok(governance.supportedEnvironments.includes('production'));
    // 写 flag 必须真的出现在脚本源码里，metadata 不能凭空声明。
  }
});

test('declared write and escalation flags exist in the script sources', async () => {
  const serverRoot = join(process.cwd(), 'server');
  for (const entry of ADMIN_RUNNER_ENTRIES) {
    const source = await readFile(join(serverRoot, entry.source), 'utf8');
    for (const intent of entry.governance.writeIntents) {
      assert.ok(source.includes(`'${intent.flag}'`), `${entry.command} lacks ${intent.flag}`);
    }
    for (const escalation of entry.governance.escalationFlags) {
      assert.ok(
        source.includes(`'${escalation.flag}'`),
        `${entry.command} lacks ${escalation.flag}`,
      );
    }
    assert.equal(
      source.includes("'--authorization-ref'"),
      entry.governance.acceptsAuthorizationRef,
      `${entry.command} acceptsAuthorizationRef must mirror the script`,
    );
  }
});

test('governance validation fails closed on drift', () => {
  const base = ADMIN_RUNNER_ENTRIES[0].governance;
  assert.throws(
    () => validateAdminRunnerGovernance('x', { ...base, riskLevel: 'extreme' }),
    /riskLevel/u,
  );
  assert.throws(
    () => validateAdminRunnerGovernance('x', { ...base, extra: true }),
    /keys drifted/u,
  );
  assert.throws(
    () =>
      validateAdminRunnerGovernance('x', {
        ...base,
        escalationFlags: [
          { flag: '--force', requiresWriteIntent: '--nope', riskLevel: 'high', description: 'x' },
        ],
      }),
    /must require a declared write intent/u,
  );
  assert.throws(
    () =>
      validateAdminRunnerGovernance('x', {
        ...base,
        defaultMode: 'dry_run',
        writeIntents: [],
        escalationFlags: [],
      }),
    /dry_run but no write intent/u,
  );
  assert.throws(
    () => validateAdminRunnerGovernance('x', { ...base, supportedEnvironments: ['moon'] }),
    /supportedEnvironments/u,
  );
  assert.throws(
    () =>
      validateAdminRunnerEntries([
        ADMIN_RUNNER_ENTRIES[0],
        { ...ADMIN_RUNNER_ENTRIES[1], command: ADMIN_RUNNER_ENTRIES[0].command },
      ]),
    /repeated/u,
  );
});

test('docs/admin-runner.md command table is generated from the entries', async () => {
  const doc = await readFile(join(process.cwd(), 'docs', 'admin-runner.md'), 'utf8');
  const start = '<!-- admin-runner-commands:start -->';
  const end = '<!-- admin-runner-commands:end -->';
  const begin = doc.indexOf(start);
  const finish = doc.indexOf(end);
  assert.ok(begin !== -1 && finish > begin, 'doc must contain the generated table markers');
  // prettier 会对齐列宽，比较前按单元格归一化。
  const normalizeTable = (text) =>
    text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) =>
        line
          .split('|')
          .map((cell) => cell.trim().replace(/^-+$/u, '---'))
          .join('|'),
      )
      .join('\n');
  const actual = normalizeTable(doc.slice(begin + start.length, finish));
  const expected = renderAdminRunnerCommandTable(ADMIN_RUNNER_ENTRIES);
  assert.equal(
    actual,
    normalizeTable(expected),
    `docs/admin-runner.md table drifted; regenerate:\n${expected}`,
  );
  // 文档不得再教人直跑命令入口；唯一入口是 launcher。
  assert.doesNotMatch(
    doc,
    /node dist\/admin\/(?!launcher\.mjs)[a-z<][^\s`]*\.mjs\s+[^\n]*(?:--execute|--apply|…)/u,
  );
  assert.match(doc, /dist\/admin\/launcher\.mjs <command>/u);
  assert.match(doc, /AGENT_SAAS_ADMIN_RECEIPT_DIR/u);
});

test('admin runner bundles keep runtime packages external like dist/index.js', () => {
  const args = esbuildArgs('scripts/migrate-events-file-to-pg.mts', 'dist/admin/out.mjs');
  assert.ok(args.includes('--bundle'));
  assert.ok(args.includes('--platform=node'));
  assert.ok(args.includes('--format=esm'));
  assert.ok(args.includes('--target=node22'));
  assert.ok(args.includes('--packages=external'));
  assert.ok(args.includes(`--banner:js=${adminBanner()}`));
  assert.ok(adminBanner().includes(`import '${RUNTIME_GUARD_ENTRY}';`));
  assert.ok(adminBanner().includes(`import '${GOVERNANCE_BOOTSTRAP_ENTRY}';`));
  assert.ok(!adminBanner({ bootstrap: false }).includes(GOVERNANCE_BOOTSTRAP_ENTRY));
  assert.ok(args.includes('--sourcemap'));
  assert.ok(args.some((item) => item.startsWith('--outfile=')));
});

test('governance bootstrap refuses direct execution and points to the launcher', () => {
  const source = adminGovernanceBootstrapSource();
  assert.match(source, /AGENT_SAAS_ADMIN_LAUNCH_NONCE/u);
  assert.match(source, /AGENT_SAAS_ADMIN_RECEIPT_DIR/u);
  assert.match(source, /process\.exit\(3\)/u);
  assert.match(source, /launcher\.mjs/u);
});

function fakeFile(entry, body) {
  return {
    entry,
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    size: Buffer.byteLength(body),
  };
}

test('admin runner manifest stays deterministic and self-describing', () => {
  const commands = ADMIN_RUNNER_ENTRIES.map((entry) =>
    manifestCommand(entry, { digest: `sha256:${'a'.repeat(64)}`, size: 1 }),
  );
  const guard = fakeFile(RUNTIME_GUARD_ENTRY, 'guard');
  const bootstrap = fakeFile(GOVERNANCE_BOOTSTRAP_ENTRY, 'bootstrap');
  const launcher = { source: LAUNCHER_SOURCE, ...fakeFile(LAUNCHER_ENTRY, 'launcher') };
  const first = adminRunnerManifest(
    MANIFEST_KIND,
    commands,
    DEPENDENCY_CONTRACT_DIGEST,
    guard,
    bootstrap,
    launcher,
  );
  const second = adminRunnerManifest(
    MANIFEST_KIND,
    commands,
    DEPENDENCY_CONTRACT_DIGEST,
    guard,
    bootstrap,
    launcher,
  );
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal(first.kind, MANIFEST_KIND);
  assert.equal(first.commands.length, ADMIN_RUNNER_ENTRIES.length);
  assert.deepEqual(first.commands[0].governance, ADMIN_RUNNER_ENTRIES[0].governance);
  assert.equal(first.launcher.entry, LAUNCHER_ENTRY);
});

function realDigest(body) {
  return {
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    size: Buffer.byteLength(body),
  };
}

async function stageAdminRunner(root, { mutate, mutateManifest } = {}) {
  const serverRoot = join(root, 'server');
  const adminDir = join(serverRoot, 'dist', 'admin');
  await mkdir(adminDir, { recursive: true });
  const guardBody = adminRuntimeGuardSource();
  await writeFile(join(serverRoot, 'dist', 'runtime-dependency-admin-guard.mjs'), guardBody);
  const runtimeDependencyGuard = { entry: RUNTIME_GUARD_ENTRY, ...realDigest(guardBody) };
  const bootstrapBody = adminGovernanceBootstrapSource();
  await writeFile(join(serverRoot, 'dist', 'admin-governance-bootstrap.mjs'), bootstrapBody);
  const governanceBootstrap = { entry: GOVERNANCE_BOOTSTRAP_ENTRY, ...realDigest(bootstrapBody) };
  const launcherBody = `${adminBanner({ bootstrap: false })}\n/* launcher */`;
  await writeFile(join(adminDir, LAUNCHER_ENTRY), launcherBody);
  await mkdir(dirname(join(serverRoot, LAUNCHER_SOURCE)), { recursive: true });
  await writeFile(join(serverRoot, LAUNCHER_SOURCE), '// launcher source\n');
  const launcher = { entry: LAUNCHER_ENTRY, source: LAUNCHER_SOURCE, ...realDigest(launcherBody) };
  const commands = ADMIN_RUNNER_ENTRIES.map((entry) => {
    const body = `${adminBanner()}\n/* ${entry.command} */`;
    return manifestCommand(entry, realDigest(body));
  });
  const staged = mutate ? mutate(commands) : commands;
  for (const command of staged) {
    const sourcePath = join(serverRoot, command.source);
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, '// source\n');
    await writeFile(join(adminDir, command.entry), `${adminBanner()}\n/* ${command.command} */`);
  }
  let manifest = adminRunnerManifest(
    MANIFEST_KIND,
    staged,
    DEPENDENCY_CONTRACT_DIGEST,
    runtimeDependencyGuard,
    governanceBootstrap,
    launcher,
  );
  if (mutateManifest) manifest = mutateManifest(manifest);
  await writeFile(join(adminDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return serverRoot;
}

async function withStaged(prefix, options, run) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    const serverRoot = await stageAdminRunner(root, options);
    await run(root, serverRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('release fails closed when the admin runner did not ship', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-runner-missing-'));
  try {
    await assert.rejects(assertAdminRunnerShipped(root), /Admin Runner manifest missing/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('release accepts a complete admin runner manifest', async () => {
  await withStaged('admin-runner-ok-', {}, async (root) => {
    const verified = await assertAdminRunnerShipped(
      root,
      ADMIN_RUNNER_ENTRIES,
      MANIFEST_KIND,
      DEPENDENCY_CONTRACT_DIGEST,
    );
    assert.equal(verified.kind, MANIFEST_KIND);
    assert.equal(verified.schemaVersion, MANIFEST_SCHEMA_VERSION);
    assert.equal(verified.commands.length, ADMIN_RUNNER_ENTRIES.length);
  });
});

test('release rejects a legacy schemaVersion 1 admin runner manifest', async () => {
  await withStaged(
    'admin-runner-v1-',
    { mutateManifest: (manifest) => ({ ...manifest, schemaVersion: 1 }) },
    async (root) => {
      await assert.rejects(assertAdminRunnerShipped(root), /not a recognized/u);
    },
  );
});

test('release rejects an Admin Runner dependency identity conflict', async () => {
  await withStaged('admin-runner-identity-conflict-', {}, async (root) => {
    await assert.rejects(
      assertAdminRunnerShipped(
        root,
        ADMIN_RUNNER_ENTRIES,
        MANIFEST_KIND,
        `sha256:${'0'.repeat(64)}`,
      ),
      /identity conflicts/u,
    );
  });
});

test('release rejects a runtime dependency guard whose content drifted', async () => {
  await withStaged('admin-runner-guard-tamper-', {}, async (root, serverRoot) => {
    await writeFile(
      join(serverRoot, 'dist', 'runtime-dependency-admin-guard.mjs'),
      '// bypassed\n',
    );
    await assert.rejects(assertAdminRunnerShipped(root), /guard content drifted/u);
  });
});

test('release rejects a governance bootstrap whose content drifted', async () => {
  await withStaged('admin-runner-bootstrap-tamper-', {}, async (root, serverRoot) => {
    await writeFile(join(serverRoot, 'dist', 'admin-governance-bootstrap.mjs'), '// bypassed\n');
    await assert.rejects(assertAdminRunnerShipped(root), /bootstrap content drifted/u);
  });
});

test('release rejects a missing or tampered launcher', async () => {
  await withStaged('admin-runner-launcher-missing-', {}, async (root, serverRoot) => {
    await rm(join(serverRoot, 'dist', 'admin', LAUNCHER_ENTRY));
    await assert.rejects(assertAdminRunnerShipped(root), /ENOENT/u);
  });
  await withStaged('admin-runner-launcher-tamper-', {}, async (root, serverRoot) => {
    await writeFile(
      join(serverRoot, 'dist', 'admin', LAUNCHER_ENTRY),
      `${adminBanner({ bootstrap: false })}\n/* evil */`,
    );
    await assert.rejects(
      assertAdminRunnerShipped(root),
      /launcher does not match its manifest digest/u,
    );
  });
});

test('release rejects a command entry that skips the governance bootstrap', async () => {
  await withStaged('admin-runner-no-bootstrap-', {}, async (root, serverRoot) => {
    const first = ADMIN_RUNNER_ENTRIES[0];
    const body = `${adminBanner({ bootstrap: false })}\n/* ${first.command} */`;
    await writeFile(join(serverRoot, 'dist', 'admin', adminEntryFile(first.command)), body);
    const manifestPath = join(serverRoot, 'dist', 'admin', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.commands[0] = { ...manifest.commands[0], ...realDigest(body) };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(assertAdminRunnerShipped(root), /bypasses the governance bootstrap/u);
  });
});

test('release rejects admin runner command drift', async () => {
  await withStaged(
    'admin-runner-drift-',
    { mutate: (commands) => commands.slice(0, commands.length - 1) },
    async (root) => {
      await assert.rejects(assertAdminRunnerShipped(root), /command set drifted/u);
    },
  );
});

test('release rejects governance metadata drift between manifest and entries', async () => {
  await withStaged(
    'admin-runner-governance-drift-',
    {
      mutate: (commands) =>
        commands.map((command, index) =>
          index === 0
            ? { ...command, governance: { ...command.governance, riskLevel: 'low' } }
            : command,
        ),
    },
    async (root) => {
      await assert.rejects(assertAdminRunnerShipped(root), /governance metadata drifted/u);
    },
  );
  await withStaged(
    'admin-runner-governance-invalid-',
    {
      mutate: (commands) =>
        commands.map((command, index) =>
          index === 0
            ? { ...command, governance: { ...command.governance, riskLevel: 'extreme' } }
            : command,
        ),
    },
    async (root) => {
      await assert.rejects(assertAdminRunnerShipped(root), /riskLevel/u);
    },
  );
});

test('release rejects admin runner entries that no longer match the manifest digest', async () => {
  await withStaged(
    'admin-runner-tamper-',
    {
      mutate: (commands) =>
        commands.map((command, index) =>
          index === 0 ? { ...command, digest: `sha256:${'0'.repeat(64)}` } : command,
        ),
    },
    async (root) => {
      await assert.rejects(assertAdminRunnerShipped(root), /does not match its manifest digest/u);
    },
  );
});

test('release rejects manifests the launcher would refuse (unknown keys, missing description)', async () => {
  await withStaged(
    'admin-runner-extra-key-',
    { mutateManifest: (manifest) => ({ ...manifest, extra: true }) },
    async (root) => {
      await assert.rejects(assertAdminRunnerShipped(root), /document keys drifted/u);
    },
  );
  await withStaged(
    'admin-runner-no-description-',
    {
      mutate: (commands) =>
        commands.map((command, index) => {
          if (index !== 0) return command;
          const { description: _omitted, ...rest } = command;
          return rest;
        }),
    },
    async (root) => {
      await assert.rejects(assertAdminRunnerShipped(root), /keys drifted/u);
    },
  );
});

test('release rejects an entry whose banner imports only appear in a comment', async () => {
  await withStaged('admin-runner-comment-banner-', {}, async (root, serverRoot) => {
    const first = ADMIN_RUNNER_ENTRIES[0];
    const body = `// ${adminBanner()}\n/* ${first.command} */`;
    await writeFile(join(serverRoot, 'dist', 'admin', adminEntryFile(first.command)), body);
    const manifestPath = join(serverRoot, 'dist', 'admin', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.commands[0] = { ...manifest.commands[0], ...realDigest(body) };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(assertAdminRunnerShipped(root), /bypasses the runtime dependency guard/u);
  });
});

test('required flags exist in the script sources and taskboard demands an explicit --output', async () => {
  const serverRoot = join(process.cwd(), 'server');
  for (const entry of ADMIN_RUNNER_ENTRIES) {
    const source = await readFile(join(serverRoot, entry.source), 'utf8');
    for (const flag of entry.governance.requiredFlags) {
      assert.ok(source.includes(`'${flag}'`), `${entry.command} lacks required flag ${flag}`);
    }
  }
  const taskboard = ADMIN_RUNNER_ENTRIES.find(
    (entry) => entry.command === 'repair-taskboard-workflow',
  );
  assert.deepEqual(taskboard.governance.requiredFlags, ['--output']);
});

test('release accepts entries whose real esbuild output keeps a shebang before the banner', async () => {
  await withStaged('admin-runner-shebang-', {}, async (root, serverRoot) => {
    const first = ADMIN_RUNNER_ENTRIES[0];
    const body = `#!/usr/bin/env tsx\n${adminBanner()}\n/* ${first.command} */`;
    await writeFile(join(serverRoot, 'dist', 'admin', adminEntryFile(first.command)), body);
    const manifestPath = join(serverRoot, 'dist', 'admin', 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.commands[0] = { ...manifest.commands[0], ...realDigest(body) };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assertAdminRunnerShipped(root);
  });
});

test('the real server build output, when present, passes the release assertion', async () => {
  // 只在本地/CI 已经跑过 pnpm -F server build 时执行；没有产物不算失败（避免测试顺序耦合）。
  try {
    await stat(join(process.cwd(), 'server', 'dist', 'admin', 'manifest.json'));
  } catch {
    return;
  }
  await assertAdminRunnerShipped(
    process.cwd(),
    ADMIN_RUNNER_ENTRIES,
    MANIFEST_KIND,
    DEPENDENCY_CONTRACT_DIGEST,
  );
});
