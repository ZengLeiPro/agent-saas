#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** ENOENT alone is absence. Permission/transport failures and malformed evidence are not false. */
export async function readRollbackReceipt(path, expected, io = { lstat, readFile }) {
  let stat;
  try {
    stat = await io.lstat(path);
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return { state: 'invalid' };
  let text;
  try {
    text = await io.readFile(path, 'utf8');
  } catch {
    return { state: 'unreadable' };
  }
  try {
    const value = JSON.parse(text);
    if (
      value.schemaVersion !== 1 ||
      !Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue)
    )
      return { state: 'invalid' };
    return { state: 'present', receipt: value };
  } catch {
    return { state: 'invalid' };
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [path, component, state, releaseId, manifestDigest, runId, runAttempt] =
    process.argv.slice(2);
  const result = await readRollbackReceipt(path, {
    component,
    state,
    releaseId,
    manifestDigest,
    runId,
    runAttempt,
  });
  if (result.state === 'present' || result.state === 'absent')
    console.log(result.state === 'present');
  else {
    console.error(`Rollback receipt is ${result.state}`);
    process.exitCode = 1;
  }
}
