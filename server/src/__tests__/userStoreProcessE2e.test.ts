import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { UsersFileData } from '../data/users/types.js';

const cleanupRoots: string[] = [];
const testDirectory = dirname(fileURLToPath(import.meta.url));
const tsxCli = resolve(testDirectory, '../../../node_modules/tsx/dist/cli.mjs');
const worker = resolve(testDirectory, 'fixtures/userStoreProcessWorker.ts');

async function waitForFiles(files: string[]): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (files.some((file) => !existsSync(file))) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for user store workers');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startWorker(input: {
  filePath: string;
  readyPath: string;
  barrierPath: string;
  username: string;
}): Promise<{ code: number | null; output: string; error: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [tsxCli, worker, input.filePath, input.readyPath, input.barrierPath, input.username],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      error += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => resolveResult({ code, output, error }));
  });
}

async function runPair(usernames: [string, string]): Promise<{
  results: Array<{ ok: boolean; username?: string; error?: string }>;
  data: UsersFileData;
}> {
  const root = await mkdtemp(join(tmpdir(), 'user-store-process-e2e-'));
  cleanupRoots.push(root);
  const filePath = join(root, 'users.json');
  const barrierPath = join(root, 'start');
  const readyPaths = [join(root, 'ready-a'), join(root, 'ready-b')];
  const processes = usernames.map((username, index) =>
    startWorker({
      filePath,
      readyPath: readyPaths[index],
      barrierPath,
      username,
    }),
  );
  await waitForFiles(readyPaths);
  await writeFile(barrierPath, 'start');
  const outputs = await Promise.all(processes);
  for (const result of outputs) {
    expect(result.code, result.error).toBe(0);
  }
  return {
    results: outputs.map((result) => JSON.parse(result.output.trim())),
    data: JSON.parse(await readFile(filePath, 'utf8')) as UsersFileData,
  };
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('UserStore real process boundary', () => {
  it('allows one normalized username winner across two independent Node processes', async () => {
    const { results, data } = await runPair(['ProcessUser', 'processuser']);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ error: 'Username already exists' }),
    ]);
    expect(data.users).toHaveLength(1);
  });

  it('retains both different users created from two preloaded process snapshots', async () => {
    const { results, data } = await runPair(['process-a', 'process-b']);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(data.users.map((user) => user.username).sort()).toEqual(['process-a', 'process-b']);
  });
});
