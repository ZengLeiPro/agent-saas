import { readFile } from 'node:fs/promises';
import { validateManifest } from './releaseManifestStore.js';

const path = process.argv[2];
if (!path)
  throw new Error('usage: validateReleaseManifestCli.ts <manifest.json> [expected-release-id]');
const manifest = validateManifest(JSON.parse(await readFile(path, 'utf8')));
if (process.argv[3] && manifest.releaseId !== process.argv[3])
  throw new Error('Release Manifest ID does not match expected release');
process.stdout.write(`${manifest.releaseId} ${manifest.digest}\n`);
