#!/usr/bin/env node
// Admin Runner 构建器：把 server 的一次性运维脚本（migration / backfill / repair /
// maintenance）预编译到 dist/admin，与 dist/index.js 在同一次 build 中产出。
//
// 目的：生产 release 只交付 prod 依赖（pnpm --prod deploy），而这类脚本以往依赖
// devDependency tsx + 源码检出才能运行，不满足"使用同一 release、依赖和配置运行"。
// 预编译为 --packages=external 的 ESM 后，脚本在部署目录里直接用该 release 的
// node_modules 解析依赖（pg 等均为 prod dependency），不需要 tsx。
//
// 治理层（manifest schemaVersion 2）：
//   - 每个命令入口 banner 同时导入 Runtime dependency guard 与 governance bootstrap；
//     bootstrap 拒绝未经 launcher 启动的直接执行。
//   - dist/admin/launcher.mjs 是唯一受支持的执行入口：解析 manifest、校验入口 digest、
//     Release/Config/Environment identity、写意图与授权，并写脱敏回执。
//   - manifest 携带每个命令的治理 metadata（唯一真相源 admin-runner-entries.mjs）。
//
// 产物：
//   dist/admin/<command>.mjs(+.map)      命令入口（必须经 launcher 执行）
//   dist/admin/launcher.mjs(+.map)       治理 launcher
//   dist/admin-governance-bootstrap.mjs  命令入口 banner 导入的 bootstrap
//   dist/admin/manifest.json             入口清单 + 治理 metadata + 每个文件的 sha256/size
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRuntimeDependencyContract,
  runtimeDependencyContractDigest,
} from '../../scripts/release/runtime-dependency.mjs';
import { ADMIN_RUNNER_ENTRIES, validateAdminRunnerEntries } from './admin-runner-entries.mjs';

export {
  ADMIN_RUNNER_ENTRIES,
  renderAdminRunnerCommandTable,
  validateAdminRunnerEntries,
  validateAdminRunnerGovernance,
} from './admin-runner-entries.mjs';

export const MANIFEST_KIND = 'agent-saas-admin-runner';
export const MANIFEST_SCHEMA_VERSION = 2;
export const RUNTIME_GUARD_ENTRY = '../runtime-dependency-admin-guard.mjs';
export const GOVERNANCE_BOOTSTRAP_ENTRY = '../admin-governance-bootstrap.mjs';
export const LAUNCHER_ENTRY = 'launcher.mjs';
export const LAUNCHER_SOURCE = 'src/release/adminRunner/launcherCli.ts';

export function adminEntryFile(command) {
  return `${command}.mjs`;
}

export function adminBanner({ bootstrap = true } = {}) {
  const imports = [`import '${RUNTIME_GUARD_ENTRY}';`];
  if (bootstrap) imports.push(`import '${GOVERNANCE_BOOTSTRAP_ENTRY}';`);
  return imports.join('');
}

export function esbuildArgs(source, outfile, { bootstrap = true } = {}) {
  return [
    resolve(source),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node22',
    // 与 build:config-identity-cli 相同的 shared alias，launcher 复用运行期身份实现。
    '--alias:@agent/shared/schemas/configIdentity=../shared/src/schemas/configIdentity.ts',
    '--alias:@agent/shared/schemas/releaseManifest=../shared/src/schemas/releaseManifest.ts',
    '--alias:@agent/shared=../shared/src/index.ts',
    // npm 包保持 external：运行时用该 release 的 prod node_modules 解析，
    // 与 dist/index.js 的外部化策略一致，保证"同一 release、同一依赖"。
    '--packages=external',
    `--banner:js=${adminBanner({ bootstrap })}`,
    `--outfile=${outfile}`,
    '--sourcemap',
  ];
}

export async function digestFile(path) {
  const body = await readFile(path);
  return {
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    size: body.length,
  };
}

export function adminRuntimeGuardSource() {
  return [
    "import { readFile } from 'node:fs/promises';",
    "import { verifyRuntimeEnvironment } from './runtime-dependency.mjs';",
    "const identity = JSON.parse(await readFile(new URL('../runtime-dependencies.json', import.meta.url), 'utf8'));",
    "verifyRuntimeEnvironment({ identity, component: 'adminRunner' });",
    '',
  ].join('\n');
}

// bootstrap 是防误用而非防对抗：有 root 的操作者可以伪造 env 与 marker。它保证
// 文档化路径之外“顺手直跑入口文件”会被明确拒绝并指向 launcher。
export function adminGovernanceBootstrapSource() {
  return [
    "import { readFileSync } from 'node:fs';",
    "import { basename, join } from 'node:path';",
    'function refuse(reason) {',
    '  process.stderr.write(',
    '    `[admin-governance] refused: ${reason}. One-off operations must run through dist/admin/launcher.mjs <command> -- <args>.\\n`,',
    '  );',
    '  process.exit(3);',
    '}',
    'const nonce = process.env.AGENT_SAAS_ADMIN_LAUNCH_NONCE;',
    'const receiptDir = process.env.AGENT_SAAS_ADMIN_RECEIPT_DIR;',
    "if (!nonce || !/^[a-f0-9]{32}$/u.test(nonce)) refuse('missing launcher nonce');",
    "if (!receiptDir) refuse('missing AGENT_SAAS_ADMIN_RECEIPT_DIR');",
    'let marker;',
    'try {',
    "  marker = JSON.parse(readFileSync(join(receiptDir, '.launch', `${nonce}.json`), 'utf8'));",
    '} catch {',
    "  refuse('launch marker missing');",
    '}',
    "if (marker?.entry !== basename(process.argv[1] ?? '')) refuse('launch marker does not match this entry');",
    '',
  ].join('\n');
}

export function adminRunnerManifest(
  kind,
  commands,
  dependencyContractDigest,
  runtimeDependencyGuard,
  governanceBootstrap,
  launcher,
) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind,
    dependencyContractDigest,
    runtimeDependencyGuard,
    governanceBootstrap,
    launcher,
    commands,
  };
}

export function manifestCommand(entry, details) {
  return {
    command: entry.command,
    entry: adminEntryFile(entry.command),
    source: entry.source,
    description: entry.description,
    governance: entry.governance,
    ...details,
  };
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env });
}

export async function buildAdminRunner({
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  entries = ADMIN_RUNNER_ENTRIES,
  manifestKind = MANIFEST_KIND,
  exec = run,
} = {}) {
  validateAdminRunnerEntries(entries);
  const outDir = join(root, 'dist', 'admin');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const commands = [];
  for (const entry of entries) {
    const sourcePath = join(root, entry.source);
    await stat(sourcePath);
    const outfile = join(outDir, adminEntryFile(entry.command));
    exec('pnpm', ['exec', 'esbuild', ...esbuildArgs(sourcePath, outfile)], root);
    commands.push(manifestCommand(entry, await digestFile(outfile)));
  }
  const launcherSource = join(root, LAUNCHER_SOURCE);
  await stat(launcherSource);
  const launcherOut = join(outDir, LAUNCHER_ENTRY);
  exec(
    'pnpm',
    ['exec', 'esbuild', ...esbuildArgs(launcherSource, launcherOut, { bootstrap: false })],
    root,
  );
  const launcher = {
    entry: LAUNCHER_ENTRY,
    source: LAUNCHER_SOURCE,
    ...(await digestFile(launcherOut)),
  };
  const guardPath = join(outDir, '..', 'runtime-dependency-admin-guard.mjs');
  await writeFile(guardPath, adminRuntimeGuardSource(), { flag: 'w' });
  const runtimeDependencyGuard = {
    entry: RUNTIME_GUARD_ENTRY,
    ...(await digestFile(guardPath)),
  };
  const bootstrapPath = join(outDir, '..', 'admin-governance-bootstrap.mjs');
  await writeFile(bootstrapPath, adminGovernanceBootstrapSource(), { flag: 'w' });
  const governanceBootstrap = {
    entry: GOVERNANCE_BOOTSTRAP_ENTRY,
    ...(await digestFile(bootstrapPath)),
  };
  const dependencyContractDigest = runtimeDependencyContractDigest(
    await loadRuntimeDependencyContract(
      join(root, '..', 'config', 'runtime-dependency-contract.json'),
    ),
  );
  const manifest = adminRunnerManifest(
    manifestKind,
    commands,
    dependencyContractDigest,
    runtimeDependencyGuard,
    governanceBootstrap,
    launcher,
  );
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildAdminRunner().then((manifest) => {
    process.stdout.write(
      `admin-runner: ${manifest.commands.length} command(s) + launcher -> dist/admin/manifest.json\n`,
    );
  });
}
