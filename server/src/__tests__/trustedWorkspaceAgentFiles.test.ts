import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadMemoryContext, loadPersona } from '../agent/memory.js';
import { MemoryCommandToolProvider } from '../agent/memoryCommandToolProvider.js';
import type { AuthorizedToolCall, ToolCallContext } from '../agent/toolRuntime.js';
import { readLatestPlanContent } from '../channels/web/channelRuntimeHelpers.js';
import { McpConfigStore } from '../data/mcpConfig.js';

const cleanup = new Set<string>();

afterEach(async () => {
  for (const path of cleanup) await rm(path, { recursive: true, force: true });
  cleanup.clear();
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  cleanup.add(root);
  return root;
}

function memoryContext(root: string): ToolCallContext {
  return {
    workspace: { root, executionTarget: 'server-local' },
    channelContext: {
      channel: 'web',
      user: { id: 'u1', username: 'alice', tenantId: 'tenant-a', role: 'user' },
    },
  } as ToolCallContext;
}

function localDate(): string {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

function memoryCall(input: Record<string, unknown>): AuthorizedToolCall {
  return {
    toolId: 'MemoryCommand',
    input,
    authorization: { approved: true, source: 'policy_auto' },
  } as AuthorizedToolCall;
}

describe('trusted workspace memory and persona reads', () => {
  it('loads regular files but rejects final and workspace-root symlinks', async () => {
    const root = await tempRoot('trusted-memory-');
    const outside = await tempRoot('trusted-memory-outside-');
    await writeFile(join(root, 'MEMORY.md'), '# Memory\nregular');
    await writeFile(join(root, 'PERSONA.md'), '# Persona\n> hint\n\nregular persona');
    expect(await loadMemoryContext(root)).toContain('regular');
    expect(await loadPersona(root)).toBe('regular persona');

    await writeFile(join(outside, 'secret.md'), 'outside-secret');
    await rm(join(root, 'MEMORY.md'));
    await symlink(join(outside, 'secret.md'), join(root, 'MEMORY.md'));
    expect(await loadMemoryContext(root)).toBeNull();

    const rootLink = join(outside, 'workspace-link');
    await symlink(root, rootLink);
    expect(await loadPersona(rootLink)).toBeNull();
  });
});

describe('trusted MemoryCommand writes', () => {
  it('writes normal daily memory through the trusted root', async () => {
    const root = await tempRoot('trusted-memory-command-');
    const release = vi.fn(async () => undefined);
    const provider = new MemoryCommandToolProvider({
      store: {
        acquireCommitLock: vi.fn(async () => ({ release })),
        listActiveTombstones: vi.fn(async () => []),
      } as never,
    });

    const result = await provider.invoke(memoryCall({
      action: 'remember', subject: '喜欢蓝色', value: '喜欢蓝色', userQuote: '请记住我喜欢蓝色',
    }), memoryContext(root));

    expect(JSON.parse(result!.content)).toMatchObject({ status: 'applied' });
    const date = localDate();
    expect(await readFile(join(root, 'memory', `${date}.md`), 'utf8')).toContain('喜欢蓝色');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rejects final and ancestor symlinks without changing the outside target', async () => {
    const root = await tempRoot('trusted-memory-command-link-');
    const outside = await tempRoot('trusted-memory-command-outside-');
    const date = localDate();
    const outsideFile = join(outside, 'outside.md');
    await writeFile(outsideFile, 'outside-original');
    await mkdir(join(root, 'memory'));
    await symlink(outsideFile, join(root, 'memory', `${date}.md`));

    const provider = new MemoryCommandToolProvider({
      store: {
        acquireCommitLock: vi.fn(async () => ({ release: async () => undefined })),
        listActiveTombstones: vi.fn(async () => []),
      } as never,
    });
    const invoke = () => provider.invoke(memoryCall({
      action: 'remember', subject: '安全测试内容', value: '安全测试内容', userQuote: '请记住安全测试内容',
    }), memoryContext(root));

    expect(JSON.parse((await invoke())!.content)).toMatchObject({ status: 'error' });
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-original');

    await rm(join(root, 'memory'), { recursive: true, force: true });
    await symlink(outside, join(root, 'memory'));
    expect(JSON.parse((await invoke())!.content)).toMatchObject({ status: 'error' });
    expect(await readFile(outsideFile, 'utf8')).toBe('outside-original');
  });
});

describe('trusted plan reads', () => {
  it('reads the latest regular plan and ignores a final symlink', async () => {
    const root = await tempRoot('trusted-plan-');
    const outside = await tempRoot('trusted-plan-outside-');
    await mkdir(join(root, '.ky-agent', 'plans'), { recursive: true });
    await writeFile(join(root, '.ky-agent', 'plans', 'regular.md'), 'regular-plan');
    expect(await readLatestPlanContent(root)).toBe('regular-plan');

    await writeFile(join(outside, 'secret.md'), 'outside-plan-secret');
    await rename(join(root, '.ky-agent', 'plans', 'regular.md'), join(root, '.ky-agent', 'plans', 'old.txt'));
    await symlink(join(outside, 'secret.md'), join(root, '.ky-agent', 'plans', 'latest.md'));
    expect(await readLatestPlanContent(root)).toBeNull();
  });

  it('rejects a symlinked plans ancestor', async () => {
    const root = await tempRoot('trusted-plan-ancestor-');
    const outside = await tempRoot('trusted-plan-ancestor-outside-');
    await mkdir(join(root, '.ky-agent'), { recursive: true });
    await writeFile(join(outside, 'secret.md'), 'outside-plan-secret');
    await symlink(outside, join(root, '.ky-agent', 'plans'));
    expect(await readLatestPlanContent(root)).toBeNull();
  });
});

describe('trusted workspace MCP settings reads', () => {
  it('loads regular settings and rejects final/ancestor symlinks', async () => {
    const root = await tempRoot('trusted-mcp-');
    const outside = await tempRoot('trusted-mcp-outside-');
    const store = new McpConfigStore(join(root, 'global-mcp-config.json'));
    const settings = JSON.stringify({
      mcpServers: { local: { type: 'streamable-http', url: 'https://local.example/mcp' } },
    });
    await mkdir(join(root, '.ky-agent'), { recursive: true });
    await writeFile(join(root, '.ky-agent', 'settings.json'), settings);
    expect((await store.buildUserMcpServers('alice', root, 'tenant-a')).mcpServers).toHaveProperty('local');

    await writeFile(join(outside, 'settings.json'), settings.replaceAll('local', 'outside'));
    await rm(join(root, '.ky-agent', 'settings.json'));
    await symlink(join(outside, 'settings.json'), join(root, '.ky-agent', 'settings.json'));
    expect((await store.buildUserMcpServers('alice', root, 'tenant-a')).mcpServers).toEqual({});

    await rm(join(root, '.ky-agent'), { recursive: true, force: true });
    await symlink(outside, join(root, '.ky-agent'));
    expect((await store.buildUserMcpServers('alice', root, 'tenant-a')).mcpServers).toEqual({});
  });
});
