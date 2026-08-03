import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TRANSCRIPT_DETAIL_MESSAGE_MAX_CHARS,
  TRANSCRIPT_DETAIL_OLD_TOOL_RESULT_MAX_CHARS,
  TRANSCRIPT_DETAIL_RAW_MAX_CHARS,
  TRANSCRIPT_DETAIL_TOOL_RESULT_KEEP_RECENT,
  TRANSCRIPT_DETAIL_TOOL_RESULT_MAX_CHARS,
  TRANSCRIPT_DETAIL_TOOL_INPUT_MAX_CHARS,
  TRANSCRIPT_JSON_PARSE_LINE_THRESHOLD_CHARS,
  TRANSCRIPT_STREAM_LINE_PREFIX_CHARS,
  TRANSCRIPT_STREAM_LINE_TAIL_CHARS,
  getTokenUsage,
  parseTranscriptFile,
  readTranscriptLinesBounded,
  truncateTranscriptDetailText,
} from '../data/transcripts/parse.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';

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

  it('流式读取超大单行时只保留固定头尾窗口，并继续读取下一行', async () => {
    const oversized = 'a'.repeat(TRANSCRIPT_JSON_PARSE_LINE_THRESHOLD_CHARS + 500_000);
    await writeFile(transcriptPath, `${oversized}\n{"type":"result"}\n`, 'utf-8');

    const records = [];
    for await (const record of readTranscriptLinesBounded(transcriptPath)) records.push(record);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      oversized: true,
      sourceChars: oversized.length,
      prefix: 'a'.repeat(TRANSCRIPT_STREAM_LINE_PREFIX_CHARS),
      tail: 'a'.repeat(TRANSCRIPT_STREAM_LINE_TAIL_CHARS),
    });
    expect(records[1]).toEqual({
      oversized: false,
      line: '{"type":"result"}',
      sourceChars: 17,
    });
  });

  it('超大 assistant 行不整行物化，仍从尾部保留 token 统计', async () => {
    const oversizedAssistant = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'x'.repeat(TRANSCRIPT_JSON_PARSE_LINE_THRESHOLD_CHARS + 1) }],
        model: 'test/model',
        response_mode: 'full',
        response_chained: false,
        usage: {
          input_tokens: 123,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 3,
          output_tokens: 45,
        },
      },
      sessionId: 'session-oversized-stream',
    });
    await writeFile(transcriptPath, `${oversizedAssistant}\n`, 'utf-8');

    const [parsed, usage] = await Promise.all([
      parseTranscriptFile(transcriptPath),
      getTokenUsage(transcriptPath),
    ]);

    expect(parsed.blocks).toHaveLength(1);
    expect(parsed.blocks[0]).toMatchObject({ kind: 'text', title: '输出' });
    expect(parsed.blocks[0]?.content).toContain('原始记录未改动');
    expect(usage).toMatchObject({
      totalInputTokens: 123,
      totalCacheReadTokens: 20,
      totalCacheCreationTokens: 3,
      totalOutputTokens: 45,
    });
  });

  it('工具入参、raw 与结果按展示预算收口，最近结果仍获得较大窗口', async () => {
    const resultCount = TRANSCRIPT_DETAIL_TOOL_RESULT_KEEP_RECENT + 4;
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
            content: `${index}:${'r'.repeat(TRANSCRIPT_DETAIL_TOOL_RESULT_MAX_CHARS * 2)}`,
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
    expect(toolResults.slice(0, 4).every((block) => block.content.length <= TRANSCRIPT_DETAIL_OLD_TOOL_RESULT_MAX_CHARS)).toBe(true);
    expect(toolResults.slice(4).every((block) => block.content.length <= TRANSCRIPT_DETAIL_TOOL_RESULT_MAX_CHARS)).toBe(true);
    expect(toolResults.slice(0, 4).every((block) => block.raw === undefined)).toBe(true);
    expect(toolResults.slice(4).every((block) => (block.raw?.length ?? 0) <= TRANSCRIPT_DETAIL_RAW_MAX_CHARS)).toBe(true);
    expect(toolResults[0]?.content).toContain('SessionContext');
  });
});
