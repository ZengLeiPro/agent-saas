#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson, digestBuffer, digestFile } from './artifact-lib.mjs';
import {
  RELEASE_EVIDENCE_SCHEMA_REVISION,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
} from './release-evidence-schema.mjs';

const PLACEHOLDER = '__AGENT_SAAS_WRITER_IMPLEMENTATION_DIGEST__';

/** The fingerprint follows bundled executable bytes, independently of the application SHA. */
export async function buildEvidenceWriter(output, { root = process.cwd() } = {}) {
  const directory = resolve(output);
  const bundleRoot = join(directory, 'writer');
  const bundlePath = join(bundleRoot, 'scripts/release/evidence-service.mjs');
  await mkdir(join(bundlePath, '..'), { recursive: true });
  execFileSync(
    'pnpm',
    [
      'exec',
      'esbuild',
      'scripts/release/evidence-service.mjs',
      '--bundle',
      '--platform=node',
      '--format=esm',
      '--target=node22',
      '--define:process.env.AGENT_SAAS_EMBEDDED="true"',
      `--define:process.env.AGENT_SAAS_EVIDENCE_IMPLEMENTATION_DIGEST="${PLACEHOLDER}"`,
      `--outfile=${bundlePath}`,
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const template = await readFile(bundlePath, 'utf8');
  if (!template.includes(PLACEHOLDER))
    throw new Error('Writer bundle omitted its implementation identity');
  const implementationDigest = digestBuffer(Buffer.from(template));
  await writeFile(bundlePath, template.replaceAll(PLACEHOLDER, implementationDigest));
  const identity = {
    schemaVersion: 1,
    implementationDigest,
    releaseEvidenceSchemaVersion: RELEASE_EVIDENCE_SCHEMA_VERSION,
    releaseEvidenceSchemaRevision: RELEASE_EVIDENCE_SCHEMA_REVISION,
  };
  await writeFile(join(bundleRoot, 'writer-identity.json'), `${canonicalJson(identity)}\n`);
  const archivePath = join(directory, 'evidence-writer.tgz');
  // Standard-library tarfile provides the same explicit metadata on Linux and macOS.
  // No source mtimes, temporary paths, users, or gzip wall clock enter the artifact.
  execFileSync(
    'python3',
    [
      '-c',
      `
import gzip, pathlib, sys, tarfile
root, archive = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
with archive.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as zipped:
    with tarfile.open(fileobj=zipped, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        for relative in ['scripts/release/evidence-service.mjs', 'writer-identity.json']:
            path = root / relative
            info = tarfile.TarInfo(relative)
            info.size = path.stat().st_size
            info.mode, info.uid, info.gid, info.mtime = 0o444, 0, 0, 0
            info.uname = info.gname = ''
            with path.open('rb') as source:
                tar.addfile(info, source)
`,
      bundleRoot,
      archivePath,
    ],
    { stdio: 'inherit' },
  );
  const result = {
    ...identity,
    bundleRoot,
    archivePath,
    archiveDigest: (await digestFile(archivePath)).digest,
  };
  await writeFile(join(directory, 'writer-build.json'), `${canonicalJson(result)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv[2]) throw new Error('Usage: build-evidence-writer.mjs <output-directory>');
  process.stdout.write(`${JSON.stringify(await buildEvidenceWriter(process.argv[2]))}\n`);
}
