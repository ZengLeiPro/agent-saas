import { describe, expect, it, vi } from 'vitest';

import {
  PgSessionShareStore,
  type SessionShareSnapshot,
  type UpsertSessionShareInput,
} from '../data/sessionShares/store.js';
import { projectSessionShareSnapshot } from '../data/sessionShares/publicProjection.js';
import { mapSessionDetailToMessages } from '../../../shared/src/lib/sessionsApi.js';
import { groupMessages } from '../../../shared/src/lib/groupMessages.js';
import type { ActivityGroup, BusinessStepSection } from '../../../shared/src/types/message.js';

function snapshotRow(snapshot: SessionShareSnapshot) {
  return {
    share_id: 'share-1',
    token: 'token-1',
    session_id: 'session-1',
    tenant_id: 'tenant-1',
    owner_user_id: 'user-1',
    owner_username: 'alice',
    created_by_user_id: 'user-1',
    created_at: '2026-07-20T00:00:00.000Z',
    updated_at: '2026-07-20T00:00:00.000Z',
    expires_at: null,
    revoked_at: null,
    debug_mode: false,
    snapshot_json: snapshot,
    access_count: 0,
    last_accessed_at: null,
  };
}

function input(snapshot: SessionShareSnapshot): UpsertSessionShareInput {
  return {
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    ownerUserId: 'user-1',
    ownerUsername: 'alice',
    createdByUserId: 'user-1',
    debugMode: false,
    snapshot,
  };
}

function snapshotWithNul(): SessionShareSnapshot {
  return {
    sessionId: 'session-1',
    stats: { lines: 1, parsedLines: 1, parseErrors: 0 },
    blocks: [{
      id: 'block-1',
      kind: 'tool_result',
      title: '工具结果',
      defaultOpen: false,
      content: 'before\u0000after',
      raw: 'literal\\u0000text',
    }],
  };
}

function createStore(existingSnapshot?: SessionShareSnapshot) {
  const writes: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FOR UPDATE')) {
        return { rows: existingSnapshot ? [snapshotRow(existingSnapshot)] : [] };
      }
      if (sql.includes('INSERT INTO')) {
        const serialized = String(params?.[10]);
        writes.push(serialized);
        return { rows: [snapshotRow(JSON.parse(serialized) as SessionShareSnapshot)] };
      }
      if (sql.includes('UPDATE') && sql.includes('snapshot_json')) {
        const serialized = String(params?.[6]);
        writes.push(serialized);
        return { rows: [snapshotRow(JSON.parse(serialized) as SessionShareSnapshot)] };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  return {
    store: new PgSessionShareStore({ pool: pool as never, tablePrefix: 'test' }),
    writes,
  };
}

describe('PgSessionShareStore', () => {
  it.each(['insert', 'update'] as const)('sanitizes nested NUL bytes on %s without corrupting literal escapes', async (mode) => {
    const existing: SessionShareSnapshot | undefined = mode === 'update'
      ? { sessionId: 'session-1', stats: { lines: 0, parsedLines: 0, parseErrors: 0 }, blocks: [] }
      : undefined;
    const { store, writes } = createStore(existing);

    await store.upsertActive(input(snapshotWithNul()));

    expect(writes).toHaveLength(1);
    const persisted = JSON.parse(writes[0]!) as SessionShareSnapshot;
    expect(persisted.blocks[0]?.content).toBe('before\\u0000after');
    expect(persisted.blocks[0]?.raw).toBe('literal\\u0000text');
    expect(writes[0]).not.toContain('\u0000');
  });
});

describe('session share public projection', () => {
  function projectContent(content: string, title = '用户'): string {
    return projectSessionShareSnapshot({
      sessionId: 'sensitive-session',
      stats: { lines: 1, parsedLines: 1, parseErrors: 0 },
      blocks: [{
        id: 'prompt-1',
        kind: 'prompt',
        title,
        defaultOpen: true,
        content,
      }],
    }).blocks[0]!.content;
  }

  it.each([
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
    [`aws_access_key_id=${'AK' + 'IA'}IOSFODNN7EXAMPLE`, `${'AK' + 'IA'}IOSFODNN7EXAMPLE`],
    ['postgresql://tester:secret-password@example.com/test', 'secret-password'],
    ['密码：Abcdef1234567890abc', 'Abcdef1234567890abc'],
    ['token=Abcdef1234567890abc', 'Abcdef1234567890abc'],
    ['Bearer AbCdEfGhIjKlMnOpQrStUvWxYz123456', 'AbCdEfGhIjKlMnOpQrStUvWxYz123456'],
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g', 'eyJhbGci'],
  ])('凭据就地打码而不阻断：%s', (content, secret) => {
    const projected = projectContent(content);
    expect(projected).not.toContain(secret);
    expect(projected).toContain('[已脱敏]');
  });

  it('私钥打码吃掉整个 PEM 块，不只是 BEGIN 行', () => {
    const pem = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ',
      '-----END PRIVATE KEY-----',
    ].join('\n');
    const projected = projectContent(`私钥如下：\n${pem}\n以上。`);
    expect(projected).not.toContain('MIIEvQIBADAN');
    expect(projected).toBe('私钥如下：\n[已脱敏]\n以上。');
  });

  it.each([
    '请联系 13800138000',
    '银行卡 6222021234567890123',
    '联系邮箱 demo@example.com',
    '身份证 350503198510281234',
    '失败详情 requestId=req_01HXYZ',
    '错误码：E_PROVIDER_502，HTTP 502',
    '上游模型返回失败',
    'token: 用于鉴权的凭证',
    'skillsManagementSync 已完成',
  ])('已收窄的规则不再改写正文：%s', (content) => {
    expect(projectContent(content)).toBe(content);
  });

  it('标题同样走脱敏', () => {
    expect(projectSessionShareSnapshot({
      sessionId: 'sensitive-session',
      stats: { lines: 1, parsedLines: 1, parseErrors: 0 },
      blocks: [{
        id: 'block-1',
        kind: 'text',
        title: '结果 token=Abcdef1234567890abc',
        defaultOpen: true,
        content: '正文',
      }],
    }).blocks[0]!.title).toBe('结果 token=[已脱敏]');
  });

  it('Markdown 仅保留已公开的本地媒体与远程 https 媒体', () => {
    const projected = projectSessionShareSnapshot({
      sessionId: 'media-session',
      stats: { lines: 1, parsedLines: 1, parseErrors: 0 },
      blocks: [{
        id: 'text-1', kind: 'text', title: '正文', defaultOpen: true,
        content: [
          '![公开](assets/public.png)',
          '![未选](assets/private.png)',
          '![远程](https://cdn.example.com/public.png)',
          '![内联](data:image/png;base64,AAAA)',
          '![绝对](/assets/private.png)',
          '![越界](../assets/private.png)',
        ].join('\n'),
      }],
      allowedFiles: [{ relativePath: 'assets/public.png', fileName: 'public.png' }],
    });

    expect(projected.blocks[0]!.content).toContain('![公开](assets/public.png)');
    expect(projected.blocks[0]!.content).toContain('![远程](https://cdn.example.com/public.png)');
    expect(projected.blocks[0]!.content.match(/\[正文媒体未公开\]/g)).toHaveLength(4);
  });

  it('TodoWrite 只公开归一化脱敏后的业务步骤，并用匿名 runId 保持快照归属', () => {
    const secret = 'Abcdef1234567890abc';
    const todoContent = (status: 'in_progress' | 'completed') => JSON.stringify({
      todos: [
        { id: 'internal', kind: 'task', content: '内部任务', status: 'pending' },
        {
          id: 'verify',
          kind: 'business',
          content: `核验 token=${secret}`,
          status,
          ...(status === 'completed' ? {
            outcome: { text: `完成 token=${secret}` },
            evidenceRefs: [`receipt token=${secret}`],
          } : {}),
        },
      ],
    });
    const projected = projectSessionShareSnapshot({
      sessionId: 'private-session',
      stats: { lines: 4, parsedLines: 4, parseErrors: 0 },
      blocks: [
        {
          id: 'todo-1', kind: 'tool_use', title: 'TodoWrite', defaultOpen: false,
          content: todoContent('in_progress'), raw: 'raw-secret', toolName: 'TodoWrite',
          toolId: 'tool-todo-1', runId: 'private-run-id',
        },
        {
          id: 'shell-1', kind: 'tool_use', title: 'Shell', defaultOpen: false,
          content: 'cat .env', raw: 'raw-shell', toolName: 'Shell',
          toolId: 'tool-shell-1', runId: 'private-run-id',
          presentation: {
            title: '读取公开数据', status: 'ok',
            detail: ['UNSELECTED_PRESENTATION_CONTENT_42'],
            connector: { system: '钉钉', write: true },
            receipt: { id: 'DING-42', system: '钉钉', readBack: true },
          },
          toolMetadata: { exitCode: 0, diff: 'UNSELECTED_FILE_CONTENT_42' },
        },
        {
          id: 'artifact-1', kind: 'tool_use', title: 'Artifact', defaultOpen: false,
          content: '', toolName: 'Artifact', toolId: 'tool-artifact-1',
          toolMetadata: {
            artifactAction: 'deliver', artifactId: 'artifact-public', artifactKind: 'file',
            fileName: '交付报告.pdf', sizeBytes: 42, mimeType: 'application/pdf',
            diff: 'UNSELECTED_ARTIFACT_CONTENT_42', sha256: 'private-hash',
          },
        },
        {
          id: 'todo-2', kind: 'tool_use', title: 'TodoWrite', defaultOpen: false,
          content: todoContent('completed'), raw: 'raw-secret', toolName: 'TodoWrite',
          toolId: 'tool-todo-2', runId: 'private-run-id',
        },
      ],
    });

    const todoBlocks = projected.blocks.filter((block) => block.toolName === 'TodoWrite');
    expect(todoBlocks.map((block) => block.runId)).toEqual(['shared-run-1', 'shared-run-1']);
    expect(JSON.stringify(todoBlocks)).not.toContain('private-run-id');
    expect(JSON.stringify(todoBlocks)).not.toContain(secret);
    const firstTodos = JSON.parse(todoBlocks[0]!.content) as {
      todos: Array<{ id?: string; content: string }>;
    };
    expect(firstTodos.todos).toEqual([
      expect.objectContaining({ id: 'verify', content: '核验 token=[已脱敏]' }),
    ]);
    const shell = projected.blocks.find((block) => block.toolName === 'Shell')!;
    expect(shell.content).toBe('');
    expect(shell).not.toHaveProperty('runId');
    expect(shell).not.toHaveProperty('toolMetadata');
    expect(shell.presentation).toEqual({
      title: '读取公开数据', status: 'ok',
      connector: { system: '钉钉', write: true },
      receipt: { id: 'DING-42', system: '钉钉', readBack: true },
    });
    const artifact = projected.blocks.find((block) => block.toolName === 'Artifact')!;
    expect(artifact.toolMetadata).toEqual({
      artifactAction: 'deliver', artifactId: 'artifact-public', artifactKind: 'file',
      fileName: '交付报告.pdf', sizeBytes: 42, mimeType: 'application/pdf',
    });
    expect(JSON.stringify(projected)).not.toContain('UNSELECTED_');
    expect(JSON.stringify(projected)).not.toContain('private-hash');
    expect(projected.blocks.every((block) => !('raw' in block))).toBe(true);

    const projectedAgain = projectSessionShareSnapshot(projected);
    const repeatedTodos = projectedAgain.blocks.filter((block) => block.toolName === 'TodoWrite');
    expect(repeatedTodos.map((block) => block.runId)).toEqual(['shared-run-1', 'shared-run-1']);
    expect(repeatedTodos.map((block) => block.content)).toEqual(todoBlocks.map((block) => block.content));
    expect(JSON.stringify(projectedAgain)).not.toContain('UNSELECTED_');
  });

  it('公开投影保留匿名 reset，确保映射后的最终正文留在旧步骤节外', () => {
    const projected = projectSessionShareSnapshot({
      sessionId: 'private-session',
      stats: { lines: 5, parsedLines: 5, parseErrors: 0 },
      blocks: [
        {
          id: 'todo-start', kind: 'tool_use', title: 'TodoWrite', defaultOpen: false,
          content: JSON.stringify({ todos: [{
            id: 'verify', kind: 'business', content: '核验分享', status: 'in_progress',
          }] }), toolName: 'TodoWrite', toolId: 'todo-start', runId: 'private-run-1',
        },
        {
          id: 'read-before', kind: 'tool_use', title: '读取前', defaultOpen: false,
          content: '{}', toolName: 'Read', toolId: 'read-before',
        },
        {
          id: 'todo-reset', kind: 'tool_use', title: 'TodoWrite', defaultOpen: false,
          content: JSON.stringify({ todos: [] }), toolName: 'TodoWrite', toolId: 'todo-reset', runId: 'private-run-2',
        },
        {
          id: 'read-after', kind: 'tool_use', title: '读取后', defaultOpen: false,
          content: '{}', toolName: 'Read', toolId: 'read-after',
        },
        { id: 'final', kind: 'text', title: '正文', defaultOpen: true, content: 'FINAL' },
      ],
    });

    const reset = projected.blocks.find((block) => block.id === 'todo-reset')!;
    expect(reset.content).toBe('{"todos":[]}');
    expect(reset.runId).toBe('shared-run-2');
    expect(JSON.stringify(projected)).not.toContain('private-run');
    expect(projectSessionShareSnapshot(projected).blocks.find((block) => block.id === 'todo-reset'))
      .toMatchObject({ content: '{"todos":[]}', runId: 'shared-run-2' });

    const publicDetail = projected as Parameters<typeof mapSessionDetailToMessages>[0];
    const grouped = groupMessages(mapSessionDetailToMessages(publicDetail), false, { sectioning: true });
    expect(grouped.map((item) => item.type)).toEqual([
      'business_step', 'business_step_section', 'activity_group', 'text',
    ]);
    const section = grouped[1] as BusinessStepSection;
    expect((section.items[0] as ActivityGroup).items.map((item) => item.id)).toEqual(['read-before']);
    expect((grouped[2] as ActivityGroup).items.map((item) => item.id)).toEqual(['read-after']);
    expect(grouped[3]).toMatchObject({ type: 'text', content: 'FINAL' });
  });
});
