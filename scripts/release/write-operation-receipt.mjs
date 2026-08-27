#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson, digestBuffer, DIGEST_PATTERN } from './artifact-lib.mjs';

const COMPONENTS = new Set(['acs', 'api', 'runtimeWorker', 'web']);
const OUTCOMES = new Set(['started', 'succeeded', 'failed', 'skipped']);

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

export async function writeOperationReceipt(options) {
  const manifest = JSON.parse(await readFile(resolve(options.manifest), 'utf8'));
  if (!COMPONENTS.has(options.component) || !OUTCOMES.has(options.outcome))
    throw new Error('Operation receipt component or outcome is invalid');
  if (manifest.digest !== options.digest || !DIGEST_PATTERN.test(options.digest ?? ''))
    throw new Error('Operation receipt does not bind the Manifest digest');
  const component = manifest.components?.[options.component];
  if (!component) throw new Error('Operation receipt component is absent from Manifest');
  const body = {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    component: options.component,
    action: component.action,
    outcome: options.outcome,
    operationKey: options.operation,
    actor: options.actor,
    recordedAt: options['recorded-at'] ?? new Date().toISOString(),
    target: component,
  };
  const receipt = { ...body, digest: digestBuffer(Buffer.from(canonicalJson(body))) };
  const safeOperation = options.operation.replace(/[^A-Za-z0-9_.-]/gu, '-');
  const filename = `operation-${safeOperation}-${options.component}.json`;
  const outputDir = resolve(options.output);
  const target = join(outputDir, filename);
  await mkdir(outputDir, { recursive: true });
  const content = `${canonicalJson(receipt)}\n`;
  try {
    await writeFile(target, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST' || (await readFile(target, 'utf8')) !== content) throw error;
  }
  return { ...receipt, filename, path: target };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const value = await writeOperationReceipt(parse(process.argv));
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
