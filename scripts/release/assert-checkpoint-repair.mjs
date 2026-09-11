#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertCheckpointManifest } from './production-checkpoint.mjs';
const [manifestPath, historyPath] = process.argv.slice(2);
const manifest = assertCheckpointManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
const history = (await readFile(historyPath, 'utf8')).trim().split('\n').map(JSON.parse);
assert(
  history.length > 0 &&
    history.every(
      (entry) => entry.releaseId === manifest.releaseId && entry.manifestDigest === manifest.digest,
    ),
  'Checkpoint repair history binding mismatch',
);
assert.equal(
  history.at(-1).state,
  'completed',
  'Only a completed release can repair its derived checkpoint',
);
console.log('checkpoint');
