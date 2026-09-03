#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const RUNTIME_COMPONENTS = ['api', 'runtimeWorker', 'acs'];

export function verifyPromotionEntry(manifest) {
  if (![1, 2].includes(manifest?.schemaVersion)) {
    throw new Error('Promotion manifest schemaVersion must be 1 or 2');
  }
  if (!manifest.components || typeof manifest.components !== 'object') {
    throw new Error('Promotion manifest components are required');
  }
  const runtimeDeploys = RUNTIME_COMPONENTS.filter(
    (component) => manifest.components[component]?.action === 'deploy',
  );
  if (manifest.schemaVersion === 1 && runtimeDeploys.length > 0) {
    throw new Error(
      `Historical Manifest v1 cannot deploy Runtime components (${runtimeDeploys.join(', ')}); rebuild the same source as a v2 RC`,
    );
  }
  return { schemaVersion: manifest.schemaVersion, runtimeDeploys };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestPath] = process.argv.slice(2);
  if (!manifestPath) throw new Error('usage: verify-promotion-entry.mjs <manifest.json>');
  const manifest = JSON.parse(await readFile(resolve(manifestPath), 'utf8'));
  process.stdout.write(`${JSON.stringify(verifyPromotionEntry(manifest))}\n`);
}
