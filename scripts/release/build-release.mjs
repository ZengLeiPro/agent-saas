#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { canonicalJson, digestBuffer, digestFile, SHA_PATTERN } from './artifact-lib.mjs';

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

async function pack(directory, target) {
  run('tar', packArgs(directory, target));
  return { path: basename(target), ...(await digestFile(target)) };
}

export async function buildRelease(argv = process.argv) {
  const opts = options(argv);
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
    serverBundle: await pack(join(stage, 'server'), join(output, 'server-bundle.tgz')),
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
    artifacts.acsOrchestrator = await pack(
      join(stage, 'acs-orchestrator'),
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
