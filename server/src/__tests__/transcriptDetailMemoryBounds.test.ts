import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS,
  TRANSCRIPT_DETAIL_RAW_MAX_CHARS,
  TRANSCRIPT_DETAIL_TOOL_INPUT_MAX_CHARS,
  TRANSCRIPT_JSON_PARSE_LINE_THRESHOLD_CHARS,
  TRANSCRIPT_JSON_PARSE_LINE_VALUE_BUDGET_CHARS,
  parseTranscriptFile,
  sanitizeOversizedTranscriptJsonLine,
  truncateTranscriptDetailText,
} from '../data/transcripts/parse.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import {
  REPLAY_RECENT_TOOL_RESULT_MAX_CHARS,
  REPLAY_TOOL_RESULT_KEEP_RECENT,
  REPLAY_TOOL_RESULT_MAX_CHARS,
} from '../runtime/replayEventBounds.js';

describe('会话详情内存边界', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    await mkdir(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
    dir = await mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'detail-memory-bounds-'));
    transcriptPath = join(dir, 'session.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('首尾节选有硬上限且保留两端证据', () => {
    const source = `${'头'.repeat(400_000)}${'尾'.repeat(400_000)}`;
    const bounded = truncateTranscriptDetailText(source, TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS);

    expect(bounded.length).toBe(TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS);
    expect(bounded.startsWith('头')).toBe(true);
    expect(bounded.endsWith('尾')).toBe(true);
    expect(bounded).toContain('会话详情已截断；原始记录未改动');
  });

  it('在 JSON.parse 前收口超大字符串值，同时保留完整结构和后置字段', () => {
    const source = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'x'.repeat(TRANSCRIPT_JSON_PARSE_LINE_THRESHOLD_CHARS + 1) }],
        usage: { input_tokens: 123, output_tokens: 45 },
      },
      sessionId: 'session-oversized',
    });

    const bounded = sanitizeOversizedTranscriptJsonLine(source);
    const parsed = JSON.parse(bounded);

    expect(bounded.length).toBeLessThan(TRANSCRIPT_JSON_PARSE_LINE_VALUE_BUDGET_CHARS + 4096);
    expect(parsed.type).toBe('assistant');
    expect(parsed.sessionId).toBe('session-oversized');
    expect(parsed.message.usage).toEqual({ input_tokens: 123, output_tokens: 45 });
    expect(parsed.message.content[0].text).toContain('会话详情已截断；原始记录未改动');
  });

  it('不会在 JSON 转义或 surrogate pair 中间截断', () => {
    const source = `{"type":"user","message":{"content":"${'\\\\u4e2d😀'.repeat(400_000)}"},"tail":7}`;
    const bounded = sanitizeOversizedTranscriptJsonLine(source);
    const parsed = JSON.parse(bounded);

    expect(parsed.type).toBe('user');
    expect(parsed.tail).toBe(7);
    expect(parsed.message.content).toContain('会话详情已截断；原始记录未改动');
  });

  it('工具入参、raw 与结果按展示预算收口，最近结果仍获得较大窗口', async () => {
    const resultCount = REPLAY_TOOL_RESULT_KEEP_RECENT + 4;
    const lines: string[] = [];
    for (let index = 0; index < resultCount; index += 1) {
      const toolId = `call-${index}`;
      lines.push(JSON.stringify({
        type: 'assistant',
        sessionId: 'session-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: toolId,
            name: 'Shell',
            input: { command: `${index}:${'i'.repeat(TRANSCRIPT_DETAIL_TOOL_INPUT_MAX_CHARS * 2)}` },
          }],
        },
      }));
      lines.push(JSON.stringify({
        type: 'user',
        sessionId: 'session-1',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolId,
            content: `${index}:${'r'.repeat(REPLAY_RECENT_TOOL_RESULT_MAX_CHARS * 2)}`,
          }],
        },
      }));
    }
    await writeFile(transcriptPath, `${lines.join('\n')}\n`, 'utf-8');

    const parsed = await parseTranscriptFile(transcriptPath);
    const toolUses = parsed.blocks.filter((block) => block.kind === 'tool_use');
    const toolResults = parsed.blocks.filter((block) => block.kind === 'tool_result');

    expect(toolUses).toHaveLength(resultCount);
    expect(toolUses.every((block) => block.content.length <= TRANSCRIPT_DETAIL_TOOL_INPUT_MAX_CHARS)).toBe(true);
    expect(toolUses.every((block) => (block.raw?.length ?? 0) <= TRANSCRIPT_DETAIL_RAW_MAX_CHARS)).toBe(true);
    expect(toolUses[0]?.content).toContain('会话详情已截断；原始记录未改动');

    expect(toolResults).toHaveLength(resultCount);
    expect(toolResults.slice(0, 4).every((block) => block.content.length <= REPLAY_TOOL_RESULT_MAX_CHARS)).toBe(true);
    expect(toolResults.slice(4).every((block) => block.content.length <= REPLAY_RECENT_TOOL_RESULT_MAX_CHARS)).toBe(true);
    expect(toolResults.slice(0, 4).every((block) => block.raw === undefined)).toBe(true);
    expect(toolResults.slice(4).every((block) => (block.raw?.length ?? 0) <= TRANSCRIPT_DETAIL_RAW_MAX_CHARS)).toBe(true);
    expect(toolResults[0]?.content).toContain('SessionGetToolTrace');
  });
});
