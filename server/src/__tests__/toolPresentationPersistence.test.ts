import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseTranscriptFile } from '../data/transcripts/parse.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import type { PlatformEvent } from '../runtime/types.js';

/**
 * 工具摘要的持久化闭环：
 * tool_result event（带 presentation）→ legacy transcript tool_result 行
 * → parseTranscriptFile → **反向嫁接到 tool_use block** → 前端 mapBlock 读到。
 *
 * 为什么必须嫁接：tool_use 的 JSONL 行在工具执行**之前**就写出了（那时还不知道
 * 结果），所以摘要只能落在 tool_result 行；而前端只在 tool_use 分支读 presentation
 * （配对过的 tool_result 会被 mapBlock 丢弃）。这条测试是整条通道唯一的本质断言——
 * 没有它，服务端产出与前端渲染各自「通过」，合起来仍然是断的。
 */

let dir: string;
let transcriptPath: string;

beforeEach(async () => {
  await mkdir(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
  dir = await mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'presentation-test-'));
  transcriptPath = join(dir, 'session.jsonl');
});

afterEach(async () => {
  // 只删本用例自己 mkdtemp 出来的目录
  await rm(dir, { recursive: true, force: true });
});

function toolCallEvent(): PlatformEvent {
  return {
    id: 'event-1',
    timestamp: new Date(2026, 6, 25, 21, 0, 0).toISOString(),
    type: 'assistant_tool_calls',
    runId: 'run-1',
    sessionId: 'session-1',
    content: '',
    toolCalls: [{ id: 'call-1', name: 'Read', arguments: JSON.stringify({ file_path: '/w/差旅.md' }) }],
  } as PlatformEvent;
}

function toolResultEvent(presentation?: unknown): PlatformEvent {
  return {
    id: 'event-2',
    timestamp: new Date(2026, 6, 25, 21, 0, 1).toISOString(),
    type: 'tool_result',
    runId: 'run-1',
    sessionId: 'session-1',
    toolCallId: 'call-1',
    toolName: 'Read',
    content: '差旅管理办法正文……',
    ...(presentation ? { presentation } : {}),
  } as PlatformEvent;
}

describe('工具摘要持久化闭环', () => {
  it('presentation 落盘在 tool_result 行，解析后嫁接到 tool_use block', async () => {
    const projection = new LegacyTranscriptProjection(transcriptPath);
    await projection.project(toolCallEvent());
    await projection.project(toolResultEvent({
      title: '读取 差旅.md',
      detail: [{ k: '路径', v: '/w/差旅.md' }],
    }));

    const parsed = await parseTranscriptFile(transcriptPath);
    const toolUse = parsed.blocks.find((block) => block.kind === 'tool_use');
    expect(toolUse).toBeTruthy();
    expect(toolUse!.presentation).toEqual({
      title: '读取 差旅.md',
      detail: [{ k: '路径', v: '/w/差旅.md' }],
    });
  });

  it('摘要不写进 raw——raw 的语义是「给模型看的原始 payload」', async () => {
    const projection = new LegacyTranscriptProjection(transcriptPath);
    await projection.project(toolCallEvent());
    await projection.project(toolResultEvent({ title: '读取 差旅.md' }));

    const parsed = await parseTranscriptFile(transcriptPath);
    const toolResult = parsed.blocks.find((block) => block.kind === 'tool_result');
    expect(toolResult?.raw ?? '').not.toContain('读取 差旅.md');
  });

  it('无 presentation 的事件：block 上整个 key 不出现（现状零破坏）', async () => {
    const projection = new LegacyTranscriptProjection(transcriptPath);
    await projection.project(toolCallEvent());
    await projection.project(toolResultEvent());

    const parsed = await parseTranscriptFile(transcriptPath);
    const toolUse = parsed.blocks.find((block) => block.kind === 'tool_use');
    expect(toolUse).toBeTruthy();
    expect('presentation' in toolUse!).toBe(false);
  });

  it('老 JSONL（无该字段）解析不崩，向后兼容', async () => {
    const legacy = [
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call-9', name: 'Read', input: {} }] },
        sessionId: 'session-1',
        timestamp: new Date().toISOString(),
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-9', content: 'ok', is_error: false }] },
        sessionId: 'session-1',
        timestamp: new Date().toISOString(),
      }),
    ].join('\n') + '\n';
    await writeFile(transcriptPath, legacy, 'utf-8');

    const parsed = await parseTranscriptFile(transcriptPath);
    const toolUse = parsed.blocks.find((block) => block.kind === 'tool_use');
    expect(toolUse).toBeTruthy();
    expect(toolUse!.presentation).toBeUndefined();
  });

  it('孤儿 tool_result（找不到对应 tool_use）不崩，也不误挂到别的 block', async () => {
    const orphan = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-missing', content: 'ok', is_error: false, presentation: { title: '孤儿' } }],
      },
      sessionId: 'session-1',
      timestamp: new Date().toISOString(),
    }) + '\n';
    await writeFile(transcriptPath, orphan, 'utf-8');

    const parsed = await parseTranscriptFile(transcriptPath);
    expect(parsed.blocks.every((block) => block.kind !== 'tool_use')).toBe(true);
    expect(parsed.blocks.length).toBeGreaterThan(0);
  });

  it('多个工具调用各自嫁接到自己的 tool_use，不串台', async () => {
    const projection = new LegacyTranscriptProjection(transcriptPath);
    await projection.project({
      id: 'e1',
      timestamp: new Date().toISOString(),
      type: 'assistant_tool_calls',
      runId: 'run-1',
      sessionId: 'session-1',
      content: '',
      toolCalls: [
        { id: 'call-a', name: 'Read', arguments: '{}' },
        { id: 'call-b', name: 'Write', arguments: '{}' },
      ],
    } as PlatformEvent);
    await projection.project({ ...toolResultEvent({ title: 'A 的摘要' }), toolCallId: 'call-a' } as PlatformEvent);
    await projection.project({ ...toolResultEvent({ title: 'B 的摘要' }), toolCallId: 'call-b' } as PlatformEvent);

    const parsed = await parseTranscriptFile(transcriptPath);
    const uses = parsed.blocks.filter((block) => block.kind === 'tool_use');
    expect(uses).toHaveLength(2);
    expect((uses[0].presentation as { title: string }).title).toBe('A 的摘要');
    expect((uses[1].presentation as { title: string }).title).toBe('B 的摘要');
  });
});
