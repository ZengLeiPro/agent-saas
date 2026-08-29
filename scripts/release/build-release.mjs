#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { canonicalJson, digestBuffer, digestFile, SHA_PATTERN } from './artifact-lib.mjs';
import { ADMIN_RUNNER_ENTRIES, MANIFEST_KIND } from '../../server/scripts/build-admin-runner.mjs';

function options(argv) {
  const values = Object.fromEntries(
    argv.slice(2).map((item) => {
      const [key, ...rest] = item.replace(/^--/u, '').split('=');
      return [key, rest.length ? rest.join('=') : true];
    }),
  );
  if (!SHA_PATTERN.test(String(values.sha ?? ''))) throw new Error('--sha must be a complete SHA');
  if (!values.out) throw new Error('--out is required');
  if (values['include-acs'] && !values['acs-image'])
    throw new Error('--include-acs requires an immutable --acs-image=repository@sha256:...');
  if (values['acs-image'] && !/@sha256:[a-f0-9]{64}$/u.test(String(values['acs-image'])))
    throw new Error('--acs-image must use an immutable registry digest');
  return values;
}

function run(command, args, cwd = process.cwd()) {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env });
}

export function productionDeployArgs(project, target) {
  return ['--config.allowUnusedPatches=true', '--filter', project, '--prod', 'deploy', target];
}

export function sbomListArgs() {
  return ['list', '--prod', '--recursive', '--depth', '0', '--json'];
}

export function packArgs(directory, target) {
  return ['--no-xattrs', '-czf', target, '-C', directory, '.'];
}

export function packRootedArgs(directory, entry, target) {
  return ['--no-xattrs', '-czf', target, '-C', directory, entry];
}

export function assertProductionBuildPlatform(platform = process.platform) {
  if (platform !== 'linux')
    throw new Error('Production release artifacts must be built on Linux for native dependencies');
}

// 一次性运维脚本（migration/backfill/repair/maintenance）必须以 Admin Runner 形式
// 随同一 release 交付：manifest 存在、命令集与受控清单一致、每个入口的字节摘要
// 与 manifest 一致。任何一项缺失都拒绝出包，避免“脚本只在源码库里、生产跑不了”。
export async function assertAdminRunnerShipped(
  root,
  entries = ADMIN_RUNNER_ENTRIES,
  manifestKind = MANIFEST_KIND,
) {
  const serverRoot = join(root, 'server');
  const manifestPath = join(serverRoot, 'dist', 'admin', 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error(
      `Admin Runner manifest missing at server/dist/admin/manifest.json; one-off operations scripts must ship with every release`,
    );
  }
  if (manifest.schemaVersion !== 1 || manifest.kind !== manifestKind)
    throw new Error('Admin Runner manifest is not a recognized agent-saas-admin-runner document');
  const commands = manifest.commands;
  if (!Array.isArray(commands) || commands.length === 0)
    throw new Error('Admin Runner manifest must declare at least one command');
  const expected = entries.map((entry) => entry.command).sort();
  const actual = commands.map((command) => command.command).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `Admin Runner command set drifted: expected [${expected.join(', ')}] but built [${actual.join(', ')}]`,
    );
  for (const command of commands) {
    if (command.entry !== `${command.command}.mjs`)
      throw new Error(`Admin Runner command ${command.command} has an unexpected entry file`);
    await stat(join(serverRoot, command.source));
    const details = await digestFile(join(serverRoot, 'dist', 'admin', command.entry));
    if (details.digest !== command.digest || details.size !== command.size)
      throw new Error(`Admin Runner entry ${command.entry} does not match its manifest digest`);
  }
  return manifest;
}

async function pack(directory, target) {
  run('tar', packArgs(directory, target));
  return { path: basename(target), ...(await digestFile(target)) };
}

async function packRooted(directory, entry, target) {
  run('tar', packRootedArgs(directory, entry, target));
  return { path: basename(target), ...(await digestFile(target)) };
}

export async function buildRelease(argv = process.argv) {
  const opts = options(argv);
  assertProductionBuildPlatform();
  const root = process.cwd();
  const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (actualSha !== opts.sha) throw new Error(`Checked out SHA ${actualSha} does not match --sha`);
  const output = resolve(String(opts.out));
  const stage = join(output, '.stage');
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  run('pnpm', ['-F', 'server', 'build'], root);
  await assertAdminRunnerShipped(root);
  run('pnpm', ['-F', 'web', 'build:oss'], root);
  run('pnpm', productionDeployArgs('server', join(stage, 'server')), root);
  await rm(join(stage, 'server/dist'), { recursive: true, force: true });
  run('cp', ['-R', join(root, 'server/dist'), join(stage, 'server/dist')]);
  run('cp', [
    '-R',
    join(root, 'server/src/agent/descriptions'),
    join(stage, 'server/descriptions'),
  ]);
  run('cp', ['-R', join(root, 'web/dist'), join(stage, 'web')]);

  const artifacts = {
    serverBundle: await packRooted(stage, 'server', join(output, 'server-bundle.tgz')),
    webAssets: await pack(join(stage, 'web'), join(output, 'web-assets.tgz')),
  };
  if (opts['include-acs']) {
    run('pnpm', ['-F', 'acs-orchestrator', 'build'], root);
    run('pnpm', productionDeployArgs('acs-orchestrator', join(stage, 'acs-orchestrator')), root);
    await rm(join(stage, 'acs-orchestrator/dist'), { recursive: true, force: true });
    run('cp', ['-R', join(root, 'acs-orchestrator/dist'), join(stage, 'acs-orchestrator/dist')]);
    run('cp', [
      join(root, 'acs-orchestrator/config/staging.env'),
      join(stage, 'acs-orchestrator/staging.env'),
    ]);
    artifacts.acsOrchestrator = await packRooted(
      stage,
      'acs-orchestrator',
      join(output, 'acs-orchestrator.tgz'),
    );
  }

  const sbomBody = {
    schemaVersion: 1,
    sourceSha: opts.sha,
    lockfile: await digestFile(join(root, 'pnpm-lock.yaml')),
    packages: JSON.parse(
      execFileSync('pnpm', sbomListArgs(), {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    ),
  };
  const sbomPath = join(output, 'sbom.json');
  await writeFile(sbomPath, `${canonicalJson(sbomBody)}\n`, { flag: 'wx' });
  const indexBody = {
    schemaVersion: 1,
    sourceSha: opts.sha,
    artifacts,
    sbom: { path: basename(sbomPath), ...(await digestFile(sbomPath)) },
    acsImage: opts['acs-image']
      ? {
          sourceSha: opts.sha,
          reference: String(opts['acs-image']),
          digest: `sha256:${String(opts['acs-image']).split('@sha256:')[1]}`,
        }
      : null,
  };
  const aggregateDigest = digestBuffer(Buffer.from(canonicalJson(indexBody)));
  const index = { ...indexBody, aggregateDigest };
  await writeFile(join(output, 'artifact-index.json'), `${canonicalJson(index)}\n`, { flag: 'wx' });
  await rm(stage, { recursive: true, force: true });
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildRelease().then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`));
}
