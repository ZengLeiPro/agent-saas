#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

function fail(message) {
  throw new Error(`[M00-01] router export verification failed: ${message}`);
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const root = resolve(import.meta.dirname, '..');
if (existsSync(resolve(root, 'src/app'))) {
  fail('mobile/src/app must not exist because Expo Router would select it over mobile/app');
}
if (!existsSync(resolve(root, 'app/_layout.tsx'))) {
  fail('mobile/app/_layout.tsx is missing');
}

const outputs = process.argv.slice(2);
if (outputs.length !== 2) fail('expected iOS and Android export directories');
for (const output of outputs) {
  const directory = resolve(output);
  if (!existsSync(directory)) fail(`export directory is missing: ${output}`);
  const files = walk(directory);
  const bundles = files.filter((file) => /\.(?:js|hbc)$/u.test(file));
  if (!bundles.length) fail(`no JavaScript/Hermes bundle found in ${output}`);
  for (const file of files.filter((item) => /\.(?:js|json|map)$/u.test(item))) {
    const source = readFileSync(file, 'utf8');
    if (/v1(?:RouteInventory|Capabilities|RouteGate|UiNavigationScan)\.test/u.test(source)) {
      fail(`test module leaked into export: ${file}`);
    }
  }
}

process.stdout.write('M00-01 Router root and iOS/Android exports verified\n');
