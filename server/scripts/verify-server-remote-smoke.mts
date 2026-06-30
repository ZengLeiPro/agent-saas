/**
 * verify:server-remote-smoke
 *
 * 端到端验证 PR 1.4 + 1.5 的 server-remote 链路：
 *
 *   brain (HttpTransport) ──HTTP──> hand-server ──> ServerLocalExecutionProvider
 *                                       │
 *                                       └─> WorkspaceResolver: id → ${sandboxRoot}/${id}
 *
 * 覆盖：
 *   - Bearer token 鉴权（正确 token、错误 token → 401）
 *   - workspace.id → hand 端 sandbox 路径解析
 *   - Read / Write / List 三件套 end-to-end
 *   - workspace.root 不上线（脚本传一个绝对路径占位，验证 hand 端不使用它）
 *   - workspaceId 缺失 → 400
 *
 * 不覆盖（留后续）：
 *   - container backend 路径（避免依赖 docker）
 *   - approval / Shell（brain 全链路验证留给后续 wire 进 raw runtime）
 *   - ECS 部署
 *
 * 用法：
 *   pnpm -C server exec tsx scripts/verify-server-remote-smoke.mts
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpTransport } from '../src/runtime/httpTransport.js';
import type { WorkspaceRef } from '../src/agent/toolRuntime.js';

const HAND_PORT = 3399; // 避开生产 hand-server 默认 3300
const AUTH_TOKEN = `verify-smoke-${randomUUID()}`;
const HAND_SERVER_DIR = new URL('../../hand-server', import.meta.url).pathname;

async function main(): Promise<void> {
  const sandboxRoot = await mkdtemp(join(tmpdir(), 'hand-server-smoke-'));
  console.log(`[step] sandbox root: ${sandboxRoot}`);

  console.log(`[step] 启动 hand-server: port=${HAND_PORT} backend=local`);
  const handProc = spawn('pnpm', ['exec', 'tsx', 'src/index.ts'], {
    cwd: HAND_SERVER_DIR,
    env: {
      ...process.env,
      HAND_SERVER_PORT: String(HAND_PORT),
      HAND_SERVER_AUTH_TOKEN: AUTH_TOKEN,
      HAND_SERVER_SANDBOX_ROOT: sandboxRoot,
      HAND_SERVER_BACKEND: 'local',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  handProc.stdout?.on('data', (chunk: Buffer) => process.stderr.write(`[hand] ${chunk.toString()}`));
  handProc.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[hand!] ${chunk.toString()}`));

  let exitCode = 0;
  try {
    await waitHealth(HAND_PORT);
    console.log('[step] hand-server health ok');

    const transport = new HttpTransport({
      baseUrl: `http://127.0.0.1:${HAND_PORT}`,
      authToken: AUTH_TOKEN,
    });

    const sessionId = `smoke-${Date.now()}`;
    const workspace: WorkspaceRef = {
      id: sessionId,
      // 故意写一个 brain-local 路径——验证 hand 端不消费此字段：
      root: '/this/should/never/reach/hand-server',
      sessionId,
      executionTarget: 'server-remote',
    };

    // 1. Write
    const writeResp = await transport.invoke({
      toolName: 'Write',
      input: { path: 'smoke-from-brain.txt', content: 'SMOKE_OK' },
      context: { workspace },
    });
    if (writeResp.status !== 'success') {
      throw new Error(`Write 失败: ${JSON.stringify(writeResp)}`);
    }
    console.log(`[step] Write ok content="${writeResp.content}"`);

    // 2. Read
    const readResp = await transport.invoke({
      toolName: 'Read',
      input: { path: 'smoke-from-brain.txt' },
      context: { workspace },
    });
    if (readResp.status !== 'success' || readResp.content !== 'SMOKE_OK') {
      throw new Error(`Read 校验失败: ${JSON.stringify(readResp)}`);
    }
    console.log('[step] Read ok');

    // 3. List
    const listResp = await transport.invoke({
      toolName: 'List',
      input: { path: '.', recursive: false },
      context: { workspace },
    });
    if (listResp.status !== 'success' || !listResp.content.includes('smoke-from-brain.txt')) {
      throw new Error(`List 校验失败: ${JSON.stringify(listResp)}`);
    }
    console.log('[step] List ok');

    // 4. 错 token → 401
    const badTransport = new HttpTransport({
      baseUrl: `http://127.0.0.1:${HAND_PORT}`,
      authToken: 'bad-token-not-authorized',
    });
    const unauthResp = await badTransport.invoke({
      toolName: 'Read',
      input: { path: 'smoke-from-brain.txt' },
      context: { workspace },
    });
    if (unauthResp.status !== 'error' || !unauthResp.error.includes('鉴权失败')) {
      throw new Error(`期望 401 鉴权失败但实际: ${JSON.stringify(unauthResp)}`);
    }
    console.log('[step] auth 401 ok');

    // 5. workspaceId 缺失 → 400
    const noIdResp = await transport.invoke({
      toolName: 'Read',
      input: { path: 'x.txt' },
      context: { workspace: { ...workspace, id: undefined } },
    });
    if (noIdResp.status !== 'error') {
      throw new Error(`期望 workspace.id 缺失 → error，实际: ${JSON.stringify(noIdResp)}`);
    }
    console.log('[step] missing workspaceId 400 ok');

    // 6. workspace 隔离：另一个 sessionId 看不到第一个 session 的文件
    const otherSession: WorkspaceRef = {
      id: `${sessionId}-other`,
      root: '/dummy',
      sessionId: `${sessionId}-other`,
      executionTarget: 'server-remote',
    };
    const otherList = await transport.invoke({
      toolName: 'List',
      input: { path: '.', recursive: false },
      context: { workspace: otherSession },
    });
    if (otherList.status !== 'success' || otherList.content.includes('smoke-from-brain.txt')) {
      throw new Error(`workspace 隔离失败: ${JSON.stringify(otherList)}`);
    }
    console.log('[step] workspace 隔离 ok');

    console.log('[PASS] server-remote smoke 全通过');
    console.log(JSON.stringify({
      sandboxRoot,
      sessionId,
      writeContent: writeResp.content,
      writeAudit: writeResp.audit,
      writeMetadata: writeResp.metadata,
      readContent: readResp.status === 'success' ? readResp.content : null,
      listContent: listResp.status === 'success' ? listResp.content : null,
    }, null, 2));
  } catch (err) {
    exitCode = 1;
    console.error('[FAIL]', err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(err.stack);
  } finally {
    handProc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!handProc.killed) handProc.kill('SIGKILL');
    await rm(sandboxRoot, { recursive: true, force: true });
  }

  process.exit(exitCode);
}

async function waitHealth(port: number): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`hand-server health timeout (port=${port})`);
}

void main();
