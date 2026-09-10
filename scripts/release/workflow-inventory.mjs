#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const inventoryPath = 'config/github-workflow-inventory.json';

export function readInventory(root = repositoryRoot) {
  const inventory = JSON.parse(readFileSync(join(root, inventoryPath), 'utf8'));
  assert.equal(inventory.schemaVersion, 1, 'Unsupported workflow inventory schema');
  assert(
    Array.isArray(inventory.workflows) && inventory.workflows.length > 0,
    'Missing workflow allowlist',
  );
  assert(Array.isArray(inventory.retiredWorkflows), 'Missing retired workflow inventory');
  const paths = new Set();
  const names = new Set();
  const ids = new Set();
  for (const item of [...inventory.workflows, ...inventory.retiredWorkflows]) {
    assert(
      /^\.github\/workflows\/[\w-]+\.ya?ml$/u.test(item.path),
      'Invalid workflow inventory path',
    );
    assert(
      typeof item.name === 'string' && item.name.trim() && !/[\r\n]/u.test(item.name),
      'Invalid workflow name',
    );
    assert(
      !paths.has(item.path) && !names.has(item.name),
      'Duplicate or overlapping workflow inventory',
    );
    paths.add(item.path);
    names.add(item.name);
  }
  for (const item of inventory.retiredWorkflows) {
    assert(
      Number.isSafeInteger(item.id) && item.id > 0 && !ids.has(item.id),
      'Invalid retired workflow ID',
    );
    ids.add(item.id);
  }
  return inventory;
}

export function checkWorkflowInventory(root = repositoryRoot) {
  const inventory = readInventory(root);
  const directory = join(root, '.github/workflows');
  const files = readdirSync(directory, { withFileTypes: true });
  // Nested workflows and symlink aliases must not silently create another entrypoint.
  assert(
    files.every((file) => file.isFile()),
    'Workflow directory must contain only regular files',
  );
  const actual = files
    .filter((file) => /\.ya?ml$/iu.test(file.name))
    .map((file) => `.github/workflows/${file.name}`)
    .sort();
  const expected = inventory.workflows.map((workflow) => workflow.path).sort();
  assert.deepEqual(actual, expected, 'Workflow files differ from the reviewed inventory');
  for (const workflow of inventory.workflows) {
    const source = readFileSync(join(root, workflow.path), 'utf8');
    const names = [...source.matchAll(/^name: ([^\r\n]+)\r?$/gmu)];
    assert.equal(names.length, 1, `Expected exactly one top-level name in ${workflow.path}`);
    assert.equal(names[0][1], workflow.name, `Unexpected display name in ${workflow.path}`);
  }
  return inventory;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const inventory = checkWorkflowInventory();
    console.log(
      `Workflow inventory verified: ${inventory.workflows.map((item) => item.name).join(', ')}`,
    );
  } catch (error) {
    console.error(`Workflow inventory rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
