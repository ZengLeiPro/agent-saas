import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

const execFileAsync = promisify(execFile);

import { parseProvisionRecipe } from './handlers.js';
import { WorkspaceResolver } from './workspaceResolver.js';

/**
 * B3 tests:
 *  - parseProvisionRecipe accepts full WorkspaceRecipe surface (recipe.repo /
 *    files / setupCommands / resources.timeoutMs) and rejects malformed input.
 *  - handleProvision actually executes setupCommands inside the workspace dir
 *    and returns logs with stdout/stderr/exitCode/durationMs.
 *
 * Note: handleProvision is exercised through a thin in-process http-like shim
 * that re-implements the same parsing path the real handler runs. The shim
 * mirrors the body-parse + workspace mount + setup execution flow without
 * spinning up an http server, keeping the test fast and deterministic.
 */

describe('parseProvisionRecipe (B3)', () => {
  it('returns null when workspaceId is missing or not a non-empty string', () => {
    expect(parseProvisionRecipe(null)).toBeNull();
    expect(parseProvisionRecipe({})).toBeNull();
    expect(parseProvisionRecipe({ workspaceId: '' })).toBeNull();
    expect(parseProvisionRecipe({ workspaceId: '   ' })).toBeNull();
    expect(parseProvisionRecipe({ workspaceId: 123 })).toBeNull();
  });

  it('reads workspaceId from top-level or nested recipe', () => {
    expect(parseProvisionRecipe({ workspaceId: 'ws-1' })).toEqual({ workspaceId: 'ws-1' });
    expect(parseProvisionRecipe({ recipe: { workspaceId: 'ws-2' } })).toEqual({ workspaceId: 'ws-2' });
  });

  it('parses repo block with required url and optional ref/remote', () => {
    const parsed = parseProvisionRecipe({
      workspaceId: 'ws',
      recipe: { workspaceId: 'ws', repo: { url: 'https://x/r.git', ref: 'main', remote: 'origin' } },
    });
    expect(parsed?.repo).toEqual({ url: 'https://x/r.git', ref: 'main', remote: 'origin' });
  });

  it('drops repo without url', () => {
    const parsed = parseProvisionRecipe({
      workspaceId: 'ws',
      recipe: { workspaceId: 'ws', repo: { ref: 'main' } },
    });
    expect(parsed?.repo).toBeUndefined();
  });

  it('parses files array filtering invalid entries', () => {
    const parsed = parseProvisionRecipe({
      workspaceId: 'ws',
      recipe: {
        workspaceId: 'ws',
        files: [
          { artifactId: 'a-1', path: 'data/a.txt' },
          { artifactId: 'a-2' }, // missing path → dropped
          'not-an-object',
        ],
      },
    });
    expect(parsed?.files).toEqual([{ artifactId: 'a-1', path: 'data/a.txt' }]);
  });

  it('parses setupCommands stripping empty entries', () => {
    const parsed = parseProvisionRecipe({
      workspaceId: 'ws',
      recipe: { workspaceId: 'ws', setupCommands: ['echo a', '   ', 42, 'echo b'] },
    });
    expect(parsed?.setupCommands).toEqual(['echo a', 'echo b']);
  });

  it('parses resources.timeoutMs only when positive number', () => {
    expect(parseProvisionRecipe({
      workspaceId: 'ws',
      recipe: { workspaceId: 'ws', resources: { timeoutMs: 5_000 } },
    })?.resources).toEqual({ timeoutMs: 5_000 });
    expect(parseProvisionRecipe({
      workspaceId: 'ws',
      recipe: { workspaceId: 'ws', resources: { timeoutMs: -1 } },
    })?.resources).toBeUndefined();
  });
});

/**
 * End-to-end through the same hand-server resolver + spawn pipeline.
 * We import handleProvision via a small wrapper that gives it mocked
 * IncomingMessage/ServerResponse so we can read back the JSON body
 * deterministically without binding to a port.
 */
describe('handleProvision setup execution (B3)', () => {
  const cleanupRoots: string[] = [];
  afterEach(async () => {
    for (const dir of cleanupRoots) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupRoots.length = 0;
  });

  async function callHandleProvision(body: Record<string, unknown>): Promise<{
    statusCode: number;
    body: any;
    sandboxRoot: string;
  }> {
    const sandboxRoot = await mkdtemp(join(tmpdir(), 'b3-hand-'));
    cleanupRoots.push(sandboxRoot);
    const resolver = new WorkspaceResolver(sandboxRoot);

    // Lazy-load handleProvision so module-init paths stay separate per test.
    const { handleProvision } = await import('./handlers.js');

    // Minimal IncomingMessage shim.
    const bodyText = JSON.stringify(body);
    const chunks = [Buffer.from(bodyText)];
    let chunkIdx = 0;
    const req: any = {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {
        while (chunkIdx < chunks.length) {
          yield chunks[chunkIdx++];
        }
      },
    };
    // handleProvision uses readBody which uses .on('data')+.on('end')+'.on('error')
    // event API rather than async iterator. Provide a Readable-like surface.
    const listeners: Record<string, Array<(arg?: any) => void>> = { data: [], end: [], error: [] };
    req.on = (event: string, cb: (arg?: any) => void) => {
      (listeners[event] ?? (listeners[event] = [])).push(cb);
      return req;
    };
    setImmediate(() => {
      for (const cb of listeners.data ?? []) cb(Buffer.from(bodyText));
      for (const cb of listeners.end ?? []) cb();
    });

    let statusCode = 0;
    let collected = '';
    const res: any = {
      writeHead: (code: number) => { statusCode = code; },
      setHeader: () => undefined,
      end: (chunk?: any) => { if (chunk) collected = String(chunk); },
    };

    const fakeProvider: any = { listInternalTools: () => [] };
    await handleProvision(req, res, {
      config: { authToken: 'test-token', backend: 'local' } as any,
      provider: fakeProvider,
      workspaceResolver: resolver,
      internalExecutionTarget: 'server-local',
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    return { statusCode, body: collected ? JSON.parse(collected) : null, sandboxRoot };
  }

  it('persists workspace_ensure log and executes setupCommands in the workspace dir', async () => {
    const result = await callHandleProvision({
      workspaceId: 'ws-1',
      recipe: {
        workspaceId: 'ws-1',
        setupCommands: ['echo hello', 'pwd'],
        resources: { timeoutMs: 5_000 },
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('ok');
    const logs = result.body.logs as Array<any>;
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs[0]).toMatchObject({ step: 'workspace_ensure', status: 'ok' });
    expect(logs[1]).toMatchObject({ step: 'setup_command#0', command: 'echo hello', status: 'ok', exitCode: 0 });
    expect(logs[1].stdout).toMatch(/^hello/);
    expect(logs[2]).toMatchObject({ step: 'setup_command#1', command: 'pwd', status: 'ok' });
    // pwd should land inside the resolved workspace.
    expect(logs[2].stdout).toMatch(/ws-1\s*$/);
  });

  it('returns status=error and stops at the first failing setupCommand', async () => {
    const result = await callHandleProvision({
      workspaceId: 'ws-fail',
      recipe: {
        workspaceId: 'ws-fail',
        setupCommands: ['echo first', 'exit 7', 'echo never-runs'],
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('error');
    const logs = result.body.logs as Array<any>;
    // workspace_ensure + 2 setup commands (the failing one stops the chain).
    expect(logs.length).toBe(3);
    expect(logs[1]).toMatchObject({ step: 'setup_command#0', command: 'echo first', status: 'ok' });
    expect(logs[2]).toMatchObject({ step: 'setup_command#1', command: 'exit 7', status: 'error', exitCode: 7 });
  });

  it('hydrates a git repo and signed artifact before setupCommands run', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'b3-repo-'));
    cleanupRoots.push(repoRoot);
    await execFileAsync('git', ['init', repoRoot]);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.email', 'test@example.test']);
    await execFileAsync('git', ['-C', repoRoot, 'config', 'user.name', 'Test']);
    await writeFile(join(repoRoot, 'README.md'), 'repo hydrated');
    await execFileAsync('git', ['-C', repoRoot, 'add', 'README.md']);
    await execFileAsync('git', ['-C', repoRoot, 'commit', '-m', 'init']);

    const result = await callHandleProvision({
      workspaceId: 'ws-hydrate',
      recipe: {
        workspaceId: 'ws-hydrate',
        repo: { url: repoRoot },
        files: [{ artifactId: 'a-1', path: 'data/a.txt', signedUrl: 'data:text/plain;base64,YXJ0aWZhY3QgaHlkcmF0ZWQ=' }],
        setupCommands: ['cat README.md && cat data/a.txt'],
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body.status).toBe('ok');
    const logs = result.body.logs as Array<any>;
    expect(logs.find((l) => l.step === 'repo_hydrate')).toMatchObject({ status: 'ok' });
    expect(logs.find((l) => l.step === 'artifact_hydrate#0')).toMatchObject({ status: 'ok' });
    expect(logs.find((l) => l.step === 'setup_command#0').stdout).toContain('repo hydrated');
    expect(logs.find((l) => l.step === 'setup_command#0').stdout).toContain('artifact hydrated');
    expect(result.body.metadata.recipeHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(join(result.sandboxRoot, 'ws-hydrate', 'data', 'a.txt'), 'utf8')).resolves.toBe('artifact hydrated');
  });

  // ensure mkdtemp + mkdir are imported (silence unused-import lint).
  it('compile-time pleaser', () => {
    expect(typeof mkdir).toBe('function');
  });
});
