import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { AgentsFileData } from '../data/agents/types.js';

const cleanupRoots: string[] = [];
const testDirectory = dirname(fileURLToPath(import.meta.url));
const tsxCli = resolve(testDirectory, '../../../node_modules/tsx/dist/cli.mjs');
const worker = resolve(testDirectory, 'fixtures/agentStoreProcessWorker.ts');

async function waitForFiles(files: string[]): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (files.some((file) => !existsSync(file))) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for agent store workers');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startWorker(root: string, side: string, rounds: number): Promise<void> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [tsxCli, worker, root, side, String(rounds)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      error += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) reject(new Error(error || `agent worker exited ${code}`));
      else if (!JSON.parse(output.trim()).ok) reject(new Error(output));
      else resolveResult();
    });
  });
}

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('AgentStore real process boundary', () => {
  it('retains both different Agent updates in 20 synchronized cross-process races', async () => {
    const rounds = 20;
    const root = await mkdtemp(join(tmpdir(), 'agent-store-process-e2e-'));
    cleanupRoots.push(root);
    const processes = [startWorker(root, 'a', rounds), startWorker(root, 'b', rounds)];

    for (let index = 0; index < rounds; index += 1) {
      await waitForFiles([join(root, `ready-a-${index}`), join(root, `ready-b-${index}`)]);
      await writeFile(join(root, `start-${index}`), 'start');
    }
    await Promise.all(processes);

    for (let index = 0; index < rounds; index += 1) {
      const data = JSON.parse(
        await readFile(join(root, `agents-${index}.json`), 'utf8'),
      ) as AgentsFileData;
      expect(Object.keys(data.agents).sort(), `race ${index}`).toEqual(['agent-a', 'agent-b']);
    }
  });
});
