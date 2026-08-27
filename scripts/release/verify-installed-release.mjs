#!/usr/bin/env node
import { lstat, readFile, readdir, readlink, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, digestBuffer, digestFile, DIGEST_PATTERN } from './artifact-lib.mjs';

const COMPONENTS = {
  server: {
    archive: 'server-bundle.tgz',
    content: 'server',
    digest: (manifest) => manifest.components?.api?.artifactDigest,
  },
  acs: {
    archive: 'acs-orchestrator.tgz',
    content: 'acs-orchestrator',
    digest: (manifest) => manifest.components?.acs?.orchestratorArtifactDigest,
  },
};

function parse(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    output[key.slice(2)] = value;
  }
  return output;
}

async function inventoryInstalledTree(rootPath) {
  const root = resolve(rootPath);
  const output = [];
  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (!path.startsWith(`${root}${sep}`))
        throw new Error('Installed artifact path escaped root');
      const itemPath = relative(root, path).split(sep).join('/');
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        output.push({ path: itemPath, type: 'file', ...(await digestFile(path)) });
      else if (entry.isSymbolicLink()) {
        const target = await readlink(path);
        const resolvedTarget = resolve(directory, target);
        if (
          isAbsolute(target) ||
          (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`))
        )
          throw new Error(`Installed artifact contains an escaping symlink: ${itemPath}`);
        const targetDetails = await lstat(resolvedTarget);
        if (!targetDetails.isFile() && !targetDetails.isDirectory())
          throw new Error(`Installed artifact symlink target is unsupported: ${itemPath}`);
        output.push({ path: itemPath, type: 'symlink', target });
      } else throw new Error(`Installed artifact contains an unsupported entry: ${itemPath}`);
    }
  }
  await walk(root);
  return output;
}

async function calculate(root, componentName) {
  const component = COMPONENTS[componentName];
  if (!component) throw new Error('Installed release component must be server or acs');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const archivePath = join(root, '.release', component.archive);
  const archive = await digestFile(archivePath);
  const expectedArtifactDigest = component.digest(manifest);
  if (
    !DIGEST_PATTERN.test(expectedArtifactDigest ?? '') ||
    archive.digest !== expectedArtifactDigest
  )
    throw new Error(`${componentName} installed archive does not match Manifest artifact digest`);
  const inventory = await inventoryInstalledTree(join(root, component.content));
  if (!inventory.length) throw new Error(`${componentName} installed content is empty`);
  return {
    manifest,
    archive,
    inventory,
    contentDigest: digestBuffer(Buffer.from(canonicalJson(inventory))),
    archiveFile: basename(archivePath),
  };
}

export async function sealInstalledRelease(rootPath, componentName) {
  const root = resolve(rootPath);
  const value = await calculate(root, componentName);
  const body = {
    schemaVersion: 1,
    releaseId: value.manifest.releaseId,
    manifestDigest: value.manifest.digest,
    component: componentName,
    artifactDigest: value.archive.digest,
    artifactSize: value.archive.size,
    archiveFile: value.archiveFile,
    contentDigest: value.contentDigest,
    inventory: value.inventory,
  };
  const metadata = { ...body, digest: digestBuffer(Buffer.from(canonicalJson(body))) };
  await writeFile(
    join(root, '.release', `installed-release-${componentName}.json`),
    `${canonicalJson(metadata)}\n`,
    {
      flag: 'wx',
      mode: 0o444,
    },
  );
  return metadata;
}

export async function verifyInstalledRelease(rootPath, componentName) {
  const root = resolve(rootPath);
  const metadata = JSON.parse(
    await readFile(join(root, '.release', `installed-release-${componentName}.json`), 'utf8'),
  );
  const { digest, ...body } = metadata;
  if (
    !DIGEST_PATTERN.test(digest ?? '') ||
    digestBuffer(Buffer.from(canonicalJson(body))) !== digest
  )
    throw new Error('Installed release metadata digest is invalid');
  const value = await calculate(root, componentName);
  if (
    metadata.component !== componentName ||
    metadata.releaseId !== value.manifest.releaseId ||
    metadata.manifestDigest !== value.manifest.digest ||
    metadata.artifactDigest !== value.archive.digest ||
    metadata.artifactSize !== value.archive.size ||
    metadata.contentDigest !== value.contentDigest ||
    canonicalJson(metadata.inventory) !== canonicalJson(value.inventory)
  ) {
    throw new Error(`${componentName} installed bytes do not match sealed release metadata`);
  }
  return metadata;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parse(process.argv);
  if (!options.root || !options.component || !['seal', 'verify'].includes(options.action))
    throw new Error(
      'usage: verify-installed-release.mjs --action <seal|verify> --root <dir> --component <server|acs>',
    );
  const value =
    options.action === 'seal'
      ? await sealInstalledRelease(options.root, options.component)
      : await verifyInstalledRelease(options.root, options.component);
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
