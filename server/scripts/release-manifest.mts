import { readFile } from 'node:fs/promises';
import { canonicalJson } from '@agent/shared';
import { calculateManifestDigest, ReleaseManifestStore, validateManifest } from '../src/release/releaseManifestStore.js';

function usage(): never {
  throw new Error('Usage: release-manifest.mts <create|validate|digest|diff> <manifest.json> [other-manifest.json]');
}

async function readManifest(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

const [command, inputPath, otherPath] = process.argv.slice(2);
if (!command || !inputPath) usage();

const input = await readManifest(inputPath);
const parsed = validateManifest(input);
const { digest, ...unsigned } = parsed;
const calculated = calculateManifestDigest(unsigned);

if (command === 'validate') {
  if (digest !== calculated) throw new Error('Release Manifest digest does not match canonical content');
  process.stdout.write(`${canonicalJson({ valid: true, digest })}\n`);
} else if (command === 'digest') {
  process.stdout.write(`${calculated}\n`);
} else if (command === 'create') {
  if (digest !== calculated) throw new Error('Release Manifest digest does not match canonical content');
  const root = process.env.AGENT_SAAS_RELEASE_MANIFEST_DIR;
  if (!root) throw new Error('AGENT_SAAS_RELEASE_MANIFEST_DIR is required for create');
  const stored = await new ReleaseManifestStore(root).create(parsed);
  process.stdout.write(`${canonicalJson(stored)}\n`);
} else if (command === 'diff') {
  if (!otherPath) usage();
  const other = validateManifest(await readManifest(otherPath));
  const changes = Object.fromEntries(Object.keys(parsed.components).map((component) => [
    component,
    { before: other.components[component as keyof typeof other.components], after: parsed.components[component as keyof typeof parsed.components] },
  ]));
  process.stdout.write(`${canonicalJson({ releaseId: parsed.releaseId, comparedTo: other.releaseId, changes })}\n`);
} else {
  usage();
}
