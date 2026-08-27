#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson, digestBuffer, DIGEST_PATTERN } from './artifact-lib.mjs';

const RELEASE_ID_PATTERN = /^rc-\d{8}-\d{2,}$/u;

function parseLines(content, source) {
  return content
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${source} line ${index + 1} is not valid JSON`);
      }
    });
}

function validateEntries(entries) {
  if (!entries.length) throw new Error('Attestation snapshot cannot be empty');
  const { releaseId, manifestDigest } = entries[0];
  if (!RELEASE_ID_PATTERN.test(releaseId ?? '') || !DIGEST_PATTERN.test(manifestDigest ?? ''))
    throw new Error('Attestation snapshot identity is invalid');
  const operations = new Set();
  let previousTime = 0;
  for (const [index, entry] of entries.entries()) {
    if (entry.releaseId !== releaseId || entry.manifestDigest !== manifestDigest)
      throw new Error(`Attestation snapshot line ${index + 1} changed immutable identity`);
    if (!entry.id || !entry.operationKey || operations.has(entry.operationKey))
      throw new Error(`Attestation snapshot line ${index + 1} has an invalid operation identity`);
    operations.add(entry.operationKey);
    const recordedAt = Date.parse(entry.recordedAt ?? '');
    if (!Number.isFinite(recordedAt) || recordedAt < previousTime)
      throw new Error(`Attestation snapshot line ${index + 1} is not ordered`);
    previousTime = recordedAt;
  }
  return { releaseId, manifestDigest };
}

function canonicalLines(entries) {
  return `${entries.map((entry) => canonicalJson(entry)).join('\n')}\n`;
}

export async function createAttestationSnapshot(logPath, outputDir) {
  const entries = parseLines(await readFile(resolve(logPath), 'utf8'), basename(logPath));
  const identity = validateEntries(entries);
  const content = canonicalLines(entries);
  const contentDigest = digestBuffer(Buffer.from(content));
  const sequence = String(entries.length).padStart(6, '0');
  const state = String(entries.at(-1).state).replace(/[^a-z0-9_-]/gu, '-');
  const filename = `attestation-${sequence}-${state}-${contentDigest.slice(7)}.jsonl`;
  const target = join(resolve(outputDir), filename);
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(target, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST' || (await readFile(target, 'utf8')) !== content) throw error;
  }
  return { ...identity, sequence: entries.length, state, contentDigest, filename, path: target };
}

export async function selectAttestationSnapshot(snapshotPaths, outputPath) {
  if (!snapshotPaths.length) throw new Error('At least one attestation snapshot is required');
  const snapshots = [];
  for (const snapshotPath of snapshotPaths) {
    const content = await readFile(resolve(snapshotPath), 'utf8');
    const entries = parseLines(content, basename(snapshotPath));
    const identity = validateEntries(entries);
    snapshots.push({ path: snapshotPath, entries, identity, content: canonicalLines(entries) });
  }
  const expected = snapshots[0].identity;
  for (const snapshot of snapshots) {
    if (
      snapshot.identity.releaseId !== expected.releaseId ||
      snapshot.identity.manifestDigest !== expected.manifestDigest
    )
      throw new Error('Attestation snapshots do not bind the same immutable RC');
  }
  snapshots.sort((left, right) => right.entries.length - left.entries.length);
  const selected = snapshots[0];
  for (const snapshot of snapshots.slice(1)) {
    const prefix = selected.entries.slice(0, snapshot.entries.length);
    if (canonicalJson(prefix) !== canonicalJson(snapshot.entries))
      throw new Error('Attestation snapshot fork detected');
  }
  await writeFile(resolve(outputPath), selected.content, { flag: 'wx', mode: 0o600 });
  return {
    ...selected.identity,
    sequence: selected.entries.length,
    state: selected.entries.at(-1).state,
    contentDigest: digestBuffer(Buffer.from(selected.content)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [action, ...args] = process.argv.slice(2);
  if (action === 'create' && args.length === 2) {
    process.stdout.write(`${JSON.stringify(await createAttestationSnapshot(args[0], args[1]))}\n`);
  } else if (action === 'select' && args.length >= 2) {
    const output = args.at(-1);
    process.stdout.write(
      `${JSON.stringify(await selectAttestationSnapshot(args.slice(0, -1), output))}\n`,
    );
  } else {
    throw new Error(
      'usage: attestation-snapshot.mjs create <log.jsonl> <output-dir> | select <snapshot...> <output.jsonl>',
    );
  }
}
