import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContainerExecutionProvider } from '../agent/containerExecutionProvider.js';
import { MAX_SHELL_CAPTURE_BYTES } from '../agent/toolOutput.js';
import type { AgentOptionsConfig } from '../agent/options.js';
import { buildTenantScopedEnv } from '../agent/tenantEnv.js';
import { WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY } from '../agent/workspaceHandTools.js';
import type { ExecutionInvocationAudit, WorkspaceRef } from '../agent/toolRuntime.js';
import type { ToolInvocationResponse } from '../runtime/handProtocol.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';

const IMAGE = process.env.KY_AGENT_CONTAINER_IMAGE ?? 'node:22-bookworm-slim';

function dockerReady(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10_000, stdio: 'ignore' });
    execFileSync('docker', ['run', '--rm', '--pull=never', '--network', 'none', IMAGE, 'node', '-e', 'process.exit(0)'], { timeout: 30_000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeIfDocker = dockerReady() ? describe : describe.skip;

function workspace(root: string): WorkspaceRef {
  return {
    root,
    userId: 'admin-1',
    username: 'admin',
    sessionId: 'session-1',
    executionTarget: 'server-container',
  };
}

function adminWorkspace(root: string): WorkspaceRef {
  return {
    ...workspace(root),
    username: 'admin',
    tenantId: DEFAULT_TENANT_ID,
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function listContainers(prefix: string): string {
  return execFileSync('docker', [
    'ps',
    '-a',
    '--filter',
    `name=${prefix}`,
    '--format',
    '{{.Names}}',
  ], { timeout: 10_000 }).toString('utf-8').trim();
}

function agentOptions(overrides: Partial<AgentOptionsConfig> = {}): AgentOptionsConfig {
  return {
    agent: { cwd: '/tmp' } as AgentOptionsConfig['agent'],
    ...overrides,
  };
}

/** 跑一次工具调用并返回 response（envelope 形态）。 */
async function invoke(
  provider: ContainerExecutionProvider,
  ws: WorkspaceRef,
  toolName: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<ToolInvocationResponse> {
  return provider.execute({
    toolName,
    input,
    context: { workspace: ws, signal },
  });
}

/** 成功 → 返回 content；失败 → throw（让现有 `.rejects.toThrow(...)` 断言继续生效）。 */
async function invokeOrThrow(
  provider: ContainerExecutionProvider,
  ws: WorkspaceRef,
  toolName: string,
  input: unknown,
  signal?: AbortSignal,
): Promise<{ content: string; audit?: ExecutionInvocationAudit[] }> {
  const response = await invoke(provider, ws, toolName, input, signal);
  if (response.status === 'error') {
    const err = new Error(response.error) as Error & { audit?: ExecutionInvocationAudit[] };
    err.audit = response.audit;
    throw err;
  }
  return { content: response.content, audit: response.audit };
}

describeIfDocker('ContainerExecutionProvider', () => {
  let root: string;
  let outside: string;
  let prefix: string;
  let provider: ContainerExecutionProvider;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-container-workspace-'));
    outside = await mkdtemp(join(tmpdir(), 'agent-container-outside-'));
    prefix = `ky-agent-test-${randomUUID()}`;
    provider = new ContainerExecutionProvider({
      image: IMAGE,
      containerNamePrefix: prefix,
      defaultTimeoutMs: 15_000,
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    try {
      execFileSync('docker', ['rm', '-f', `${prefix}-cleanup`], { timeout: 5_000, stdio: 'ignore' });
    } catch {}
  });

  it('reads, writes and lists files through the container workspace mount', async () => {
    const writeResp = await invoke(provider, workspace(root), 'Write', {
      path: 'assets/20260607/container-file.txt',
      content: 'CONTAINER_OK',
    });
    expect(writeResp.status).toBe('success');

    expect(readFileSync(join(root, 'assets/20260607/container-file.txt'), 'utf-8')).toBe('CONTAINER_OK');

    await expect(invokeOrThrow(provider, workspace(root), 'Read', { path: join(outside, 'secret.txt') }))
      .rejects.toThrow('outside workspace');

    const readResp = await invokeOrThrow(provider, workspace(root), 'Read', { path: 'assets/20260607/container-file.txt' });
    expect(readResp.content).toBe('CONTAINER_OK');

    const listResp = await invokeOrThrow(provider, workspace(root), 'List', { path: 'assets', recursive: true });
    expect(listResp.content).toContain('file assets/20260607/container-file.txt');

    // audit 字段挪到 response 上（不再走 ExecutionAuditRecorder callback）；
    // 这里直接断言 Write 调用的 response.audit。
    expect(writeResp.status === 'success' ? writeResp.audit?.[0] : undefined).toMatchObject({
      provider: 'server-container',
      operation: 'writeFile',
      image: IMAGE,
      timeoutMs: 15_000,
      exitCode: 0,
      signal: null,
      status: 'success',
    });
    const writeAudit = writeResp.status === 'success' ? writeResp.audit?.[0] : undefined;
    expect(writeAudit?.containerName).toContain(prefix);
    expect(writeAudit?.stdoutBytes).toBeGreaterThan(0);
    expect(writeAudit?.stderrBytes).toBe(0);
  });

  it('runs shell without inheriting host environment variables or host cwd files', async () => {
    process.env.KY_AGENT_CONTAINER_SECRET_SHOULD_NOT_LEAK = 'LEAK_ME_20260607';
    await writeFile(join(outside, 'secret.txt'), 'HOST_SECRET', 'utf-8');
    try {
      const envOutput = await invokeOrThrow(provider, workspace(root), 'Shell', { command: 'printenv', timeoutMs: 15_000 });
      expect(envOutput.content).not.toContain('KY_AGENT_CONTAINER_SECRET_SHOULD_NOT_LEAK');
      expect(envOutput.content).not.toContain('LEAK_ME_20260607');
      await expect(invokeOrThrow(provider, workspace(root), 'Shell', {
        command: `cat ${join(outside, 'secret.txt')}`,
        timeoutMs: 15_000,
      })).rejects.toThrow();
    } finally {
      delete process.env.KY_AGENT_CONTAINER_SECRET_SHOULD_NOT_LEAK;
    }
  });

  it('strips platform-sensitive host env before injecting admin container env', async () => {
    const originalEnv = { ...process.env };
    process.env.OPENAI_API_KEY = 'host-openai-key';
    process.env.NPM_TOKEN = 'host-npm-token';
    process.env.RANDOM_VENDOR_SECRET = 'host-random-secret';
    process.env.NON_SENSITIVE_HOST_FLAG = 'host-visible';
    try {
      const scopedProvider = new ContainerExecutionProvider({
        image: IMAGE,
        containerNamePrefix: prefix,
        defaultTimeoutMs: 15_000,
        envBuilder: (ws) => buildTenantScopedEnv({
          agentOptions: agentOptions({
            sharedEnv: {
              ANTHROPIC_API_KEY: 'configured-admin-anthropic',
              SAFE_TOOL_FLAG: 'configured-safe-flag',
            },
          }),
        }, ws),
      });

      const resp = await invokeOrThrow(scopedProvider, adminWorkspace(root), 'Shell', {
        command: 'node -e "const keys=[\'OPENAI_API_KEY\',\'NPM_TOKEN\',\'RANDOM_VENDOR_SECRET\',\'ANTHROPIC_API_KEY\',\'SAFE_TOOL_FLAG\',\'NON_SENSITIVE_HOST_FLAG\']; console.log(JSON.stringify(Object.fromEntries(keys.map((k)=>[k,process.env[k] ?? null]))))"',
        timeoutMs: 15_000,
      });
      const json = resp.content.match(/\{.*\}/s)?.[0] ?? '{}';
      const env = JSON.parse(json) as Record<string, string | null>;

      expect(env.OPENAI_API_KEY).toBeNull();
      expect(env.NPM_TOKEN).toBeNull();
      expect(env.RANDOM_VENDOR_SECRET).toBeNull();
      expect(env.ANTHROPIC_API_KEY).toBe('configured-admin-anthropic');
      expect(env.SAFE_TOOL_FLAG).toBe('configured-safe-flag');
      expect(env.NON_SENSITIVE_HOST_FLAG).toBe('host-visible');
    } finally {
      process.env = originalEnv;
    }
  });

  it('runs Edit, Glob, Grep and CreateArtifact inside the container workspace', async () => {
    await mkdir(join(root, 'src', 'sub'), { recursive: true });
    await writeFile(join(root, 'src', 'a.txt'), 'old value', 'utf-8');
    await writeFile(join(root, 'src', 'sub', 'b.txt'), 'needle line', 'utf-8');

    const editResp = await invokeOrThrow(provider, workspace(root), 'Edit', {
      file_path: 'src/a.txt',
      old_string: 'old',
      new_string: 'new',
    });
    expect(editResp.content).toMatch(/Edited src\/a\.txt/);
    expect(editResp.audit?.[0]).toMatchObject({ provider: 'server-container', operation: 'edit' });
    expect(readFileSync(join(root, 'src', 'a.txt'), 'utf-8')).toBe('new value');

    const globResp = await invokeOrThrow(provider, workspace(root), 'Glob', { pattern: 'src/**/*.txt' });
    expect(globResp.content).toContain('src/a.txt');
    expect(globResp.content).toContain('src/sub/b.txt');
    expect(globResp.audit?.[0]).toMatchObject({ provider: 'server-container', operation: 'glob' });

    const grepResp = await invokeOrThrow(provider, workspace(root), 'Grep', { pattern: 'needle', path: 'src' });
    expect(grepResp.content).toContain('src/sub/b.txt:1:needle line');
    expect(grepResp.audit?.[0]).toMatchObject({ provider: 'server-container', operation: 'grep' });

    const artifactResp = await invoke(provider, workspace(root), 'CreateArtifact', {
      file_path: 'src/sub/b.txt',
      kind: 'log',
      mime_type: 'text/plain',
    });
    expect(artifactResp.status).toBe('success');
    expect(artifactResp.audit?.[0]).toMatchObject({ provider: 'server-container', operation: 'artifactCreate' });
    const payload = artifactResp.status === 'success'
      ? artifactResp.metadata?.[WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY] as { dataBase64?: string; sourcePath?: string; fileName?: string }
      : undefined;
    expect(payload?.sourcePath).toBe('src/sub/b.txt');
    expect(payload?.fileName).toBe('b.txt');
    expect(Buffer.from(payload?.dataBase64 ?? '', 'base64').toString('utf-8')).toBe('needle line');
  });

  it('refuses CreateArtifact on symlinks before reading the target', async () => {
    await writeFile(join(outside, 'secret.txt'), 'HOST_SECRET', 'utf-8');
    try {
      await symlink(join(outside, 'secret.txt'), join(root, 'linked-secret.txt'));
    } catch {
      return;
    }
    await expect(invokeOrThrow(provider, workspace(root), 'CreateArtifact', {
      file_path: 'linked-secret.txt',
      kind: 'log',
    })).rejects.toThrow(/refused symlink/);
  });

  it('does not let shell or workspace hand tools pierce the mounted /workspace boundary', async () => {
    await writeFile(join(root, 'inside.txt'), 'INSIDE_NEEDLE', 'utf-8');
    await writeFile(join(outside, 'MEMORY.md'), 'OTHER_USER_SECRET', 'utf-8');
    try {
      await symlink(join(outside, 'MEMORY.md'), join(root, 'linked-outside-memory.md'));
    } catch {
      // Some filesystems disable symlink creation; the absolute/path traversal checks still run.
    }

    await expect(invokeOrThrow(provider, workspace(root), 'Shell', {
      command: 'cat ../other-user/MEMORY.md',
      timeoutMs: 15_000,
    })).rejects.toThrow();
    await expect(invokeOrThrow(provider, workspace(root), 'Shell', {
      command: `cat ${shellQuote(join(outside, 'MEMORY.md'))}`,
      timeoutMs: 15_000,
    })).rejects.toThrow();
    if (existsSync(join(root, 'linked-outside-memory.md'))) {
      await expect(invokeOrThrow(provider, workspace(root), 'Shell', {
        command: 'cat linked-outside-memory.md',
        timeoutMs: 15_000,
      })).rejects.toThrow();
    }

    await expect(invokeOrThrow(provider, workspace(root), 'Edit', {
      file_path: '../other-user/MEMORY.md',
      old_string: 'OTHER',
      new_string: 'LEAK',
    })).rejects.toThrow(/outside workspace/);
    await expect(invokeOrThrow(provider, workspace(root), 'Edit', {
      file_path: join(outside, 'MEMORY.md'),
      old_string: 'OTHER',
      new_string: 'LEAK',
    })).rejects.toThrow(/outside workspace/);
    if (existsSync(join(root, 'linked-outside-memory.md'))) {
      await expect(invokeOrThrow(provider, workspace(root), 'Edit', {
        file_path: 'linked-outside-memory.md',
        old_string: 'OTHER',
        new_string: 'LEAK',
      })).rejects.toThrow();
    }

    await expect(invokeOrThrow(provider, workspace(root), 'Glob', {
      pattern: '**/*.md',
      path: '../other-user',
    })).rejects.toThrow(/outside workspace/);
    await expect(invokeOrThrow(provider, workspace(root), 'Glob', {
      pattern: '**/*.md',
      path: join(outside),
    })).rejects.toThrow(/outside workspace/);

    await expect(invokeOrThrow(provider, workspace(root), 'Grep', {
      pattern: 'OTHER_USER_SECRET',
      path: '../other-user',
    })).rejects.toThrow(/outside workspace/);
    await expect(invokeOrThrow(provider, workspace(root), 'Grep', {
      pattern: 'OTHER_USER_SECRET',
      path: join(outside),
    })).rejects.toThrow(/outside workspace/);

    await expect(invokeOrThrow(provider, workspace(root), 'CreateArtifact', {
      file_path: '../other-user/MEMORY.md',
      kind: 'log',
    })).rejects.toThrow(/outside workspace/);
    await expect(invokeOrThrow(provider, workspace(root), 'CreateArtifact', {
      file_path: join(outside, 'MEMORY.md'),
      kind: 'log',
    })).rejects.toThrow(/outside workspace/);
    if (existsSync(join(root, 'linked-outside-memory.md'))) {
      await expect(invokeOrThrow(provider, workspace(root), 'CreateArtifact', {
        file_path: 'linked-outside-memory.md',
        kind: 'log',
      })).rejects.toThrow(/refused symlink/);
    }

    const grepResp = await invokeOrThrow(provider, workspace(root), 'Grep', { pattern: 'INSIDE_NEEDLE', path: '.' });
    expect(grepResp.content).toContain('inside.txt:1:INSIDE_NEEDLE');
    expect(grepResp.content).not.toContain('OTHER_USER_SECRET');
    expect(readFileSync(join(outside, 'MEMORY.md'), 'utf-8')).toBe('OTHER_USER_SECRET');
  });

  it('blocks common host-sensitive paths and network access from shell commands', async () => {
    await expect(invokeOrThrow(provider, workspace(root), 'Shell', { command: 'cat ~/.ssh/id_rsa', timeoutMs: 15_000 }))
      .rejects.toThrow();
    await expect(invokeOrThrow(provider, workspace(root), 'Shell', { command: 'cat ~/.git-credentials', timeoutMs: 15_000 }))
      .rejects.toThrow();
    await expect(invokeOrThrow(provider, workspace(root), 'Shell', { command: 'ls ~/code', timeoutMs: 15_000 }))
      .rejects.toThrow();
    await expect(invokeOrThrow(provider, workspace(root), 'Shell', {
      command: `cat ${shellQuote(resolve(process.cwd(), 'data', 'business.sqlite'))}`,
      timeoutMs: 15_000,
    })).rejects.toThrow();
    await expect(invokeOrThrow(provider, workspace(root), 'Shell', {
      command: 'node -e "fetch(\\\"https://example.com\\\").then(() => process.exit(0)).catch((err) => { console.error(err.code || err.message); process.exit(1); })"',
      timeoutMs: 15_000,
    })).rejects.toThrow();
  });

  it('cleans up the container after shell timeout', async () => {
    await expect(invokeOrThrow(provider, workspace(root), 'Shell', { command: 'sleep 10', timeoutMs: 700 }))
      .rejects.toThrow('timed out');

    await sleep(1_000);
    expect(listContainers(prefix)).toBe('');

    // 第二次 timeout：直接 invoke（不 throw 包装），从 response.audit 读 record
    const timeoutResp = await invoke(provider, workspace(root), 'Shell', { command: 'sleep 10', timeoutMs: 700 });
    expect(timeoutResp.status).toBe('error');
    expect(timeoutResp.audit?.[0]).toMatchObject({
      provider: 'server-container',
      operation: 'runShell',
      timeoutMs: 700,
      status: 'error',
      timedOut: true,
    });
    expect(timeoutResp.audit?.[0]?.containerName).toContain(prefix);

    await sleep(1_000);
    expect(listContainers(prefix)).toBe('');
  });

  it('returns truncated shell output without failing at the model-visible budget', async () => {
    const result = await invokeOrThrow(provider, workspace(root), 'Shell', {
      command: 'node -e "process.stdout.write(\\\"x\\\".repeat(70 * 1024))"',
      timeoutMs: 15_000,
    });
    expect(result.content).toContain('Exit code: 0');
    expect(result.content).toContain('Full output files: stdout=tmp/tool-results/');
    expect(result.content).toContain('[stdout]');
    expect(result.content).toContain('truncated');
    expect(result.content.length).toBeLessThan(70 * 1024);
    const match = /stdout=(tmp\/tool-results\/[^ ]+\.txt)/.exec(result.content);
    expect(match?.[1]).toBeTruthy();
    const saved = readFileSync(join(root, match![1]!), 'utf-8');
    expect(saved).toHaveLength(70 * 1024);
    await sleep(1_000);
    expect(listContainers(prefix)).toBe('');
  });

  it('cleans up the container when stdout or stderr exceeds the hard capture cap', async () => {
    await expect(invokeOrThrow(provider, workspace(root), 'Shell', {
      command: `node -e "process.stdout.write(\\\"x\\\".repeat(${MAX_SHELL_CAPTURE_BYTES + 1024}))"`,
      timeoutMs: 15_000,
    })).rejects.toThrow('output exceeded limit');
    await sleep(1_000);
    expect(listContainers(prefix)).toBe('');

    await expect(invokeOrThrow(provider, workspace(root), 'Shell', {
      command: `node -e "process.stderr.write(\\\"x\\\".repeat(${MAX_SHELL_CAPTURE_BYTES + 1024}))"`,
      timeoutMs: 15_000,
    })).rejects.toThrow('output exceeded limit');
    await sleep(1_000);
    expect(listContainers(prefix)).toBe('');
  });
});
