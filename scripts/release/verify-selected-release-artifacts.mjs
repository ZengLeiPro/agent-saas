#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digestBuffer, digestFile } from './artifact-lib.mjs';
import { verifyRuntimeDependencyIdentity } from './runtime-dependency.mjs';

// tar 会折叠前导/内部 `.` 与重复 `/`；必须按实际解包语义拒绝覆盖成员。
const SELECTED_FILES = {
  serverBundle: 'server-bundle.tgz',
  webAssets: 'web-assets.tgz',
  acsOrchestrator: 'acs-orchestrator.tgz',
};
const SERVER_CONTROL_FILES = [
  'server/runtime-dependencies.json',
  'server/daemon-packaging/systemd/agent-saas-server@.service.template',
  'server/daemon-packaging/systemd/agent-saas-runtime-worker@.service.template',
];
const ACS_CONTROL_FILES = [
  'acs-orchestrator/runtime-dependencies.json',
  'acs-orchestrator/daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template',
];

async function verifyFile(path, artifact, label) {
  const actual = await digestFile(path);
  if (actual.digest !== artifact.digest || actual.size !== artifact.size) {
    throw new Error(`${label} does not match the selected Release Manifest artifact`);
  }
}

function normalizeArchiveMember(member) {
  if (member.startsWith('/')) {
    throw new Error(`Selected archive contains an unsafe member: ${member}`);
  }
  const segments = [];
  for (const segment of member.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      throw new Error(`Selected archive contains an unsafe member: ${member}`);
    }
    segments.push(segment);
  }
  return segments.length ? segments.join('/') : null;
}

function extractRegularArchiveFile(archivePath, componentPath) {
  const listing = execFileSync('tar', ['-tzf', archivePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const members = listing
    .split('\n')
    .filter(Boolean)
    .map((raw) => ({ raw, normalized: normalizeArchiveMember(raw) }))
    .filter((member) => member.normalized !== null);
  const seen = new Set();
  for (const member of members) {
    if (seen.has(member.normalized)) {
      throw new Error(`Selected archive contains duplicate normalized member ${member.normalized}`);
    }
    seen.add(member.normalized);
  }
  const matches = members.filter((member) => member.normalized === componentPath);
  if (matches.length !== 1) {
    throw new Error(`Selected archive must contain exactly one ${componentPath}`);
  }
  const metadata = execFileSync(
    'tar',
    [
      '--list',
      '--verbose',
      '--gzip',
      '--file',
      archivePath,
      '--quoting-style=literal',
      '--',
      matches[0].raw,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
    .trimEnd()
    .split('\n');
  if (metadata.length !== 1 || metadata[0][0] !== '-') {
    throw new Error(
      `Selected archive control file must be a unique regular file: ${componentPath}`,
    );
  }
  return execFileSync('tar', ['-xOf', archivePath, '--', matches[0].raw], {
    encoding: null,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

async function verifyRuntime({ directory, descriptor, component, archiveName, embeddedPath }) {
  const runtimePath = join(directory, `runtime-dependencies-${component}.json`);
  await verifyFile(runtimePath, descriptor, `${component} Runtime Dependency Identity`);
  const standalone = await readFile(runtimePath);
  const identity = verifyRuntimeDependencyIdentity(JSON.parse(standalone.toString('utf8')), {
    sourceSha: descriptor.sourceSha,
    contractDigest: descriptor.contractDigest,
  });
  if (
    identity.identityDigest !== descriptor.identityDigest ||
    identity.dependencyDigest !== descriptor.dependencyDigest
  ) {
    throw new Error(`${component} Runtime Dependency Identity disagrees with the Manifest`);
  }
  const embedded = extractRegularArchiveFile(join(directory, archiveName), embeddedPath);
  if (!embedded.equals(standalone) || digestBuffer(embedded) !== descriptor.digest) {
    throw new Error(`${component} archive embeds a different Runtime Dependency Identity`);
  }
}

export async function verifySelectedReleaseArtifacts({ manifestPath, directory }) {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
  const selectedDirectory = resolve(directory);
  if (![1, 2].includes(manifest.schemaVersion) || !manifest.artifacts) {
    throw new Error('Selected Release Manifest schema is unsupported');
  }
  for (const [name, filename] of Object.entries(SELECTED_FILES)) {
    await verifyFile(
      join(selectedDirectory, filename),
      manifest.artifacts[name],
      `Selected ${name}`,
    );
  }
  if (manifest.schemaVersion === 1) return manifest;
  await verifyRuntime({
    directory: selectedDirectory,
    descriptor: manifest.artifacts.runtimeDependencies.server,
    component: 'server',
    archiveName: SELECTED_FILES.serverBundle,
    embeddedPath: 'server/runtime-dependencies.json',
  });
  await verifyRuntime({
    directory: selectedDirectory,
    descriptor: manifest.artifacts.runtimeDependencies.acs,
    component: 'acs',
    archiveName: SELECTED_FILES.acsOrchestrator,
    embeddedPath: 'acs-orchestrator/runtime-dependencies.json',
  });
  // keep 组件沿用不可变兼容基线且不会安装 unit；仅 deploy 组件要求 RC-bound unit。
  if (manifest.components?.api?.action === 'deploy') {
    for (const controlPath of SERVER_CONTROL_FILES.slice(1)) {
      extractRegularArchiveFile(join(selectedDirectory, SELECTED_FILES.serverBundle), controlPath);
    }
  }
  if (manifest.components?.acs?.action === 'deploy') {
    for (const controlPath of ACS_CONTROL_FILES.slice(1)) {
      extractRegularArchiveFile(
        join(selectedDirectory, SELECTED_FILES.acsOrchestrator),
        controlPath,
      );
    }
  }
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestPath, directory] = process.argv.slice(2);
  if (!manifestPath || !directory) {
    throw new Error(
      'usage: verify-selected-release-artifacts.mjs <manifest.json> <selected-directory>',
    );
  }
  verifySelectedReleaseArtifacts({ manifestPath, directory }).then((manifest) =>
    process.stdout.write(`${manifest.releaseId}\n`),
  );
}
