#!/usr/bin/env node
// Admin Runner 构建器：把 server 的一次性运维脚本（migration / backfill / repair /
// maintenance）预编译到 dist/admin，与 dist/index.js 在同一次 build 中产出。
//
// 目的：生产 release 只交付 prod 依赖（pnpm --prod deploy），而这类脚本以往依赖
// devDependency tsx + 源码检出才能运行，不满足"使用同一 release、依赖和配置运行"。
// 预编译为 --packages=external 的 ESM 后，脚本在部署目录里直接用该 release 的
// node_modules 解析依赖（pg 等均为 prod dependency），不需要 tsx。
//
// 产物：
//   dist/admin/<command>.mjs(+.map)  可直接 node 执行的入口
//   dist/admin/manifest.json         入口清单 + 每个入口的 sha256/size
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_KIND = 'agent-saas-admin-runner';

// 受控清单：只有具备 dry-run / 幂等 / 门禁语义的一次性运维脚本才允许进入
// Admin Runner。新增条目时同步更新 docs/admin-runner.md。
export const ADMIN_RUNNER_ENTRIES = Object.freeze([
  {
    command: 'migrate-events-file-to-pg',
    source: 'scripts/migrate-events-file-to-pg.mts',
    description:
      'file EventStore jsonl -> PG runtime_events 一次性 ETL；默认 dry-run，--execute 写入',
  },
  {
    command: 'migrate-platform-tenant-pantheon',
    source: 'scripts/migrate-platform-tenant-pantheon.mts',
    description: '平台租户目录迁移到 pantheon 布局；默认 dry-run，--apply 写入',
  },
  {
    command: 'backfill-runtime-sessions',
    source: 'scripts/backfill-runtime-sessions.mts',
    description: 'runtime session 背填到 PG；默认 dry-run，--execute 写入',
  },
  {
    command: 'repair-taskboard-workflow',
    source: 'scripts/repairTaskboardWorkflow.ts',
    description: 'taskboard workflow 状态修复；默认 dry-run，--apply 写入',
  },
  {
    command: 'runtime-events-maintenance',
    source: 'src/scripts/runtime-events-maintenance.mts',
    description:
      'runtime events retention 维护；默认严格只读 dry-run，写操作需 --authorization-ref',
  },
  {
    command: 'context-derived-replay',
    source: 'scripts/context-derived-replay.mts',
    description: 'derived context 投影重放修复；默认 dry-run，--apply 写入',
  },
]);

export function adminEntryFile(command) {
  return `${command}.mjs`;
}

export function esbuildArgs(source, outfile) {
  return [
    resolve(source),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node22',
    // npm 包保持 external：运行时用该 release 的 prod node_modules 解析，
    // 与 dist/index.js 的外部化策略一致，保证"同一 release、同一依赖"。
    '--packages=external',
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

export function adminRunnerManifest(kind, commands) {
  return { schemaVersion: 1, kind, commands };
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
  const outDir = join(root, 'dist', 'admin');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const commands = [];
  for (const entry of entries) {
    const sourcePath = join(root, entry.source);
    await stat(sourcePath);
    const outfile = join(outDir, adminEntryFile(entry.command));
    exec('pnpm', ['exec', 'esbuild', ...esbuildArgs(sourcePath, outfile)], root);
    const details = await digestFile(outfile);
    commands.push({
      command: entry.command,
      entry: adminEntryFile(entry.command),
      source: entry.source,
      description: entry.description,
      ...details,
    });
  }
  const manifest = adminRunnerManifest(manifestKind, commands);
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
  });
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildAdminRunner().then((manifest) => {
    process.stdout.write(
      `admin-runner: ${manifest.commands.length} command(s) -> dist/admin/manifest.json\n`,
    );
  });
}
