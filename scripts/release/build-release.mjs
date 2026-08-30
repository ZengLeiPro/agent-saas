#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { canonicalJson, digestBuffer, digestFile, SHA_PATTERN } from './artifact-lib.mjs';
import {
  ADMIN_RUNNER_ENTRIES,
  MANIFEST_KIND,
  adminRuntimeGuardSource,
} from '../../server/scripts/build-admin-runner.mjs';
import {
  createRuntimeDependencyIdentity,
  loadRuntimeDependencyContract,
  runtimeDependencyContractDigest,
  verifyRuntimeEnvironment,
} from './runtime-dependency.mjs';

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

export function sanitizeSbomInventory(value) {
  if (Array.isArray(value)) return value.map(sanitizeSbomInventory);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'path')
        .map(([key, entry]) => [key, sanitizeSbomInventory(entry)]),
    );
  return value;
}

export function packArgs(directory, target) {
  return ['--no-xattrs', '-czf', target, '-C', directory, '.'];
}

export function packRootedArgs(directory, entry, target) {
  return ['--no-xattrs', '-czf', target, '-C', directory, entry];
}

export const STAGING_SHARED_ASSET_ENTRIES = [
  '.browser-profile-seed',
  '.ky-agent/scripts',
  '.ky-agent/skills-pool',
  'prompts',
  'MEMORY.template.md',
  'PERSONA.template.md',
  'questions.template.md',
];

export async function copyStagingSharedAssets(root, targetRoot) {
  const sourceRoot = join(root, 'workspace-shared');
  for (const entry of STAGING_SHARED_ASSET_ENTRIES) {
    const target = join(targetRoot, entry);
    await mkdir(join(target, '..'), { recursive: true });
    await cp(join(sourceRoot, entry), target, { recursive: true, errorOnExist: true });
  }
}

export function assertProductionBuildPlatform(platform = process.platform) {
  if (platform !== 'linux')
    throw new Error('Production release artifacts must be built on Linux for native dependencies');
}

export function assertProductionRuntimeContract(
  contract,
  runtime = { version: process.versions.node, arch: process.arch, platform: process.platform },
) {
  return verifyRuntimeEnvironment({
    identity: createRuntimeDependencyIdentity(contract, '0'.repeat(40)),
    component: 'server',
    runtime,
    checkTools: false,
  });
}

// 一次性运维脚本（migration/backfill/repair/maintenance）必须以 Admin Runner 形式
// 随同一 release 交付：manifest 存在、命令集与受控清单一致、每个入口的字节摘要
// 与 manifest 一致。任何一项缺失都拒绝出包，避免“脚本只在源码库里、生产跑不了”。
export async function assertAdminRunnerShipped(
  root,
  entries = ADMIN_RUNNER_ENTRIES,
  manifestKind = MANIFEST_KIND,
  expectedDependencyContractDigest,
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
  if (
    expectedDependencyContractDigest &&
    manifest.dependencyContractDigest !== expectedDependencyContractDigest
  )
    throw new Error('Admin Runner runtime dependency identity conflicts with the release contract');
  const commands = manifest.commands;
  if (!Array.isArray(commands) || commands.length === 0)
    throw new Error('Admin Runner manifest must declare at least one command');
  const expected = entries.map((entry) => entry.command).sort();
  const actual = commands.map((command) => command.command).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(
      `Admin Runner command set drifted: expected [${expected.join(', ')}] but built [${actual.join(', ')}]`,
    );
  const guardPath = join(serverRoot, 'dist', 'runtime-dependency-admin-guard.mjs');
  await stat(guardPath);
  if ((await readFile(guardPath, 'utf8')) !== adminRuntimeGuardSource())
    throw new Error('Admin Runner runtime dependency guard content drifted');
  const guardDetails = await digestFile(guardPath);
  if (
    manifest.runtimeDependencyGuard?.entry !== '../runtime-dependency-admin-guard.mjs' ||
    manifest.runtimeDependencyGuard.digest !== guardDetails.digest ||
    manifest.runtimeDependencyGuard.size !== guardDetails.size
  )
    throw new Error('Admin Runner runtime dependency guard does not match its manifest digest');
  for (const command of commands) {
    if (command.entry !== `${command.command}.mjs`)
      throw new Error(`Admin Runner command ${command.command} has an unexpected entry file`);
    await stat(join(serverRoot, command.source));
    const entryPath = join(serverRoot, 'dist', 'admin', command.entry);
    if (
      !(await readFile(entryPath, 'utf8')).includes(
        "import '../runtime-dependency-admin-guard.mjs'",
      )
    )
      throw new Error(`Admin Runner entry ${command.entry} bypasses the runtime dependency guard`);
    const details = await digestFile(entryPath);
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
  const runtimeContract = await loadRuntimeDependencyContract(
    join(root, 'config', 'runtime-dependency-contract.json'),
  );
  assertProductionRuntimeContract(runtimeContract);
  const dependencyContractDigest = runtimeDependencyContractDigest(runtimeContract);
  const runtimeIdentity = createRuntimeDependencyIdentity(runtimeContract, opts.sha);
  const runtimeIdentityPath = join(output, 'runtime-dependencies.json');
  await writeFile(runtimeIdentityPath, `${canonicalJson(runtimeIdentity)}\n`, { flag: 'wx' });
  const stage = join(output, '.stage');
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  run('pnpm', ['-F', 'server', 'build'], root);
  await assertAdminRunnerShipped(
    root,
    ADMIN_RUNNER_ENTRIES,
    MANIFEST_KIND,
    dependencyContractDigest,
  );
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
  await copyStagingSharedAssets(root, join(stage, 'staging-runtime-assets'));
  run('cp', [runtimeIdentityPath, join(stage, 'server', 'runtime-dependencies.json')]);
  run('cp', [
    join(root, 'scripts/release/runtime-dependency.mjs'),
    join(stage, 'server/dist/runtime-dependency.mjs'),
  ]);
  run('cp', [
    join(root, 'scripts/release/artifact-lib.mjs'),
    join(stage, 'server/dist/artifact-lib.mjs'),
  ]);
  await mkdir(join(stage, 'server/daemon-packaging/systemd'), { recursive: true });
  run('cp', [
    join(root, 'daemon-packaging/systemd/agent-saas-server@.service.template'),
    join(stage, 'server/daemon-packaging/systemd/agent-saas-server@.service.template'),
  ]);
  run('cp', [
    join(root, 'daemon-packaging/systemd/agent-saas-runtime-worker@.service.template'),
    join(stage, 'server/daemon-packaging/systemd/agent-saas-runtime-worker@.service.template'),
  ]);

  const artifacts = {
    serverBundle: await packRooted(stage, 'server', join(output, 'server-bundle.tgz')),
    webAssets: await pack(join(stage, 'web'), join(output, 'web-assets.tgz')),
    stagingRuntimeAssets: await pack(
      join(stage, 'staging-runtime-assets'),
      join(output, 'staging-runtime-assets.tgz'),
    ),
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
    run('cp', [runtimeIdentityPath, join(stage, 'acs-orchestrator', 'runtime-dependencies.json')]);
    run('cp', [
      join(root, 'scripts/release/runtime-dependency.mjs'),
      join(stage, 'acs-orchestrator/dist/runtime-dependency.mjs'),
    ]);
    run('cp', [
      join(root, 'scripts/release/artifact-lib.mjs'),
      join(stage, 'acs-orchestrator/dist/artifact-lib.mjs'),
    ]);
    await mkdir(join(stage, 'acs-orchestrator/daemon-packaging/systemd'), {
      recursive: true,
    });
    run('cp', [
      join(root, 'daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template'),
      join(
        stage,
        'acs-orchestrator/daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template',
      ),
    ]);
    artifacts.acsOrchestrator = await packRooted(
      stage,
      'acs-orchestrator',
      join(output, 'acs-orchestrator.tgz'),
    );
  }

  const sbomBody = {
    schemaVersion: 2,
    sourceSha: opts.sha,
    lockfile: await digestFile(join(root, 'pnpm-lock.yaml')),
    runtimeDependencies: {
      sourceSha: opts.sha,
      identityDigest: runtimeIdentity.identityDigest,
      contractDigest: dependencyContractDigest,
      dependencyDigest: runtimeIdentity.dependencyDigest,
    },
    packages: sanitizeSbomInventory(
      JSON.parse(
        execFileSync('pnpm', sbomListArgs(), {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        }),
      ),
    ),
  };
  const sbomPath = join(output, 'sbom.json');
  await writeFile(sbomPath, `${canonicalJson(sbomBody)}\n`, { flag: 'wx' });
  const indexBody = {
    schemaVersion: 2,
    sourceSha: opts.sha,
    artifacts,
    sbom: { path: basename(sbomPath), ...(await digestFile(sbomPath)) },
    runtimeDependencies: {
      path: basename(runtimeIdentityPath),
      ...(await digestFile(runtimeIdentityPath)),
      sourceSha: opts.sha,
      identityDigest: runtimeIdentity.identityDigest,
      contractDigest: dependencyContractDigest,
      dependencyDigest: runtimeIdentity.dependencyDigest,
    },
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
