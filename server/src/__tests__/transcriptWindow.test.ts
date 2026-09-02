import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  encodeTranscriptWindowCursor,
  parseTranscriptFile,
  parseTranscriptWindow,
  readTranscriptLinesBounded,
} from '../data/transcripts/parse.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { buildSessionDetailPayload } from '../routes/sessions.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

function transcriptLine(index: number, content = `message ${index}`): string {
  return JSON.stringify({
    type: 'user',
    sessionId: SESSION_ID,
    message: { content },
  });
}

function transcriptText(count: number, trailingNewline = true): string {
  if (count === 0) return '';
  const text = Array.from({ length: count }, (_, index) => transcriptLine(index + 1)).join('\n');
  return trailingNewline ? `${text}\n` : text;
}

function payloadFromWindow(
  parsed: Awaited<ReturnType<typeof parseTranscriptWindow>>,
  options: { after?: string; before?: string; limit: number },
) {
  return buildSessionDetailPayload(
    { sessionId: parsed.sessionId ?? SESSION_ID, stats: parsed.stats, blocks: parsed.blocks },
    {
      ...options,
      windowStartsAtBeginning: parsed.window.startsAtBeginning,
      latestCursor: parsed.window.latestCursor,
    },
  );
}

describe('transcript physical-line windows', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    await mkdir(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
    dir = await mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'window-'));
    transcriptPath = join(dir, 'session.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([0, 1, 99, 100, 101, 620])(
    'tail window/page handles %i physical lines',
    async (lineCount) => {
      await writeFile(transcriptPath, transcriptText(lineCount), 'utf8');

      const parsed = await parseTranscriptWindow(transcriptPath, { limit: 100 });
      const payload = payloadFromWindow(parsed, { limit: 100 });

      expect(parsed.stats.lines).toBe(lineCount);
      expect(payload.blocks).toHaveLength(Math.min(100, lineCount));
      expect(payload.blocks.at(-1)?.id).toBe(lineCount === 0 ? undefined : `line-${lineCount}-user`);
      expect(payload.historyComplete).toBe(lineCount <= 100);
      if (lineCount > 100) {
        expect(parsed.stats.scannedLines).toBeLessThan(lineCount);
        expect(payload.blocks[0]?.id).toBe(`line-${lineCount - 99}-user`);
      }
    },
  );

  it('incrementally indexes the first append after an empty snapshot', async () => {
    await writeFile(transcriptPath, '', 'utf8');
    const empty = await parseTranscriptWindow(transcriptPath, { limit: 100 });
    expect(empty.stats.lines).toBe(0);

    await appendFile(transcriptPath, transcriptText(1, false), 'utf8');
    const parsed = await parseTranscriptWindow(transcriptPath, { limit: 100 });
    expect(parsed.stats.lines).toBe(1);
    expect(parsed.blocks[0]?.id).toBe('line-1-user');
  });

  it('incrementally indexes append and returns bounded after delta without duplicates', async () => {
    await writeFile(transcriptPath, transcriptText(500), 'utf8');
    const initial = await parseTranscriptWindow(transcriptPath, { limit: 100 });
    const after = encodeTranscriptWindowCursor(
      initial.window.cursorGeneration,
      initial.window.latestCursor,
    );
    expect(after).toMatch(/^tw2\./);
    await appendFile(transcriptPath, transcriptText(25), 'utf8');

    const parsed = await parseTranscriptWindow(transcriptPath, { after, limit: 100 });
    expect(parsed.window.cursorGeneration).toBe(initial.window.cursorGeneration);
    expect(parsed.window.resolvedAfter).toBe('line-500-user');
    const payload = payloadFromWindow(parsed, {
      after: parsed.window.resolvedAfter,
      limit: 100,
    });

    expect(parsed.stats.lines).toBe(525);
    expect(payload.mode).toBe('delta');
    expect(payload.blocks[0]?.id).toBe('line-469-user');
    expect(payload.blocks.at(-1)?.id).toBe('line-525-user');
    expect(new Set(payload.blocks.map((block) => block.id)).size).toBe(payload.blocks.length);
  });

  it('reads before page with its boundary overlap and keeps the real latest cursor', async () => {
    await writeFile(transcriptPath, transcriptText(620), 'utf8');

    const parsed = await parseTranscriptWindow(transcriptPath, {
      before: 'line-401-user',
      limit: 100,
    });
    const payload = payloadFromWindow(parsed, { before: 'line-401-user', limit: 100 });

    expect(payload.mode).toBe('before');
    expect(payload.blocks).toHaveLength(101);
    expect(payload.blocks[0]?.id).toBe('line-301-user');
    expect(payload.blocks.at(-1)?.id).toBe('line-401-user');
    expect(payload.cursor).toBe('line-620-user');
    expect(payload.historyComplete).toBe(false);
    expect(parsed.window.endsAtEnd).toBe(false);
  });

  it('falls back to a latest tail page for a stale or far-behind after cursor', async () => {
    await writeFile(transcriptPath, transcriptText(620), 'utf8');

    for (const after of ['line-519-user', 'line-999-user', 'not-a-line-cursor']) {
      const parsed = await parseTranscriptWindow(transcriptPath, { after, limit: 100 });
      const payload = payloadFromWindow(parsed, { after, limit: 100 });
      expect(payload.mode).toBe('full');
      expect(payload.blocks).toHaveLength(100);
      expect(payload.blocks[0]?.id).toBe('line-521-user');
      expect(payload.cursor).toBe('line-620-user');
    }
  });

  it('keeps tool presentation enrichment across a before-page boundary', async () => {
    const lines = Array.from({ length: 100 }, (_, index) => transcriptLine(index + 1));
    lines[49] = JSON.stringify({
      type: 'assistant',
      sessionId: SESSION_ID,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-boundary', name: 'Read', input: {} }],
      },
    });
    lines[50] = JSON.stringify({
      type: 'user',
      sessionId: SESSION_ID,
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'call-boundary',
          content: 'ok',
          presentation: { title: '边界工具结果' },
        }],
      },
    });
    await writeFile(transcriptPath, `${lines.join('\n')}\n`, 'utf8');

    const full = await parseTranscriptFile(transcriptPath);
    const before = full.blocks.find((block) => block.kind === 'tool_use')?.id;
    expect(before).toBeTruthy();
    const parsed = await parseTranscriptWindow(transcriptPath, { before, limit: 20 });
    const payload = payloadFromWindow(parsed, { before, limit: 20 });
    const boundaryTool = payload.blocks.find((block) => block.id === before);

    expect(payload.mode).toBe('before');
    expect(boundaryTool?.kind).toBe('tool_use');
    expect(boundaryTool?.presentation).toEqual({ title: '边界工具结果' });
  });

  it('rebuilds the in-memory index after truncate and same-size rewrite', async () => {
    await writeFile(transcriptPath, transcriptText(500), 'utf8');
    const initial = await parseTranscriptWindow(transcriptPath, { limit: 100 });
    const oldCursor = encodeTranscriptWindowCursor(
      initial.window.cursorGeneration,
      initial.window.latestCursor,
    );

    await writeFile(transcriptPath, transcriptText(20), 'utf8');
    let parsed = await parseTranscriptWindow(transcriptPath, { after: oldCursor, limit: 100 });
    expect(parsed.window.cursorInvalidated).toBe(true);
    expect(parsed.window.cursorGeneration).not.toBe(initial.window.cursorGeneration);
    expect(parsed.window.resolvedAfter).toBeUndefined();
    const resetPayload = payloadFromWindow(parsed, {
      after: parsed.window.resolvedAfter,
      limit: 100,
    });
    expect(resetPayload.mode).toBe('full');
    expect(parsed.stats.lines).toBe(20);
    expect(parsed.blocks[0]?.id).toBe('line-1-user');
    expect(parsed.blocks.at(-1)?.id).toBe('line-20-user');

    const before = transcriptText(20);
    const after = before.replace('message 1', 'rewrite 1');
    expect(after.length).toBe(before.length);
    await writeFile(transcriptPath, after, 'utf8');
    const future = new Date(Date.now() + 2_000);
    await utimes(transcriptPath, future, future);
    parsed = await parseTranscriptWindow(transcriptPath, { limit: 100 });
    expect(parsed.blocks[0]?.content).toBe('rewrite 1');
  });

  it('keeps global line ids across malformed lines and a final line without newline', async () => {
    await writeFile(
      transcriptPath,
      `${transcriptLine(1)}\n{bad json\n${transcriptLine(3)}`,
      'utf8',
    );

    const parsed = await parseTranscriptWindow(transcriptPath, { limit: 100 });

    expect(parsed.stats).toMatchObject({ lines: 3, parsedLines: 2, parseErrors: 1, scannedLines: 3 });
    expect(parsed.blocks.map((block) => block.id)).toEqual([
      'line-1-user',
      'line-2',
      'line-3-user',
    ]);
  });

  it('readTranscriptLinesBounded honors byte start/end ranges', async () => {
    const lines = [transcriptLine(1), transcriptLine(2), transcriptLine(3)];
    const text = `${lines.join('\n')}\n`;
    await writeFile(transcriptPath, text, 'utf8');
    const start = Buffer.byteLength(`${lines[0]}\n`);
    const end = start + Buffer.byteLength(`${lines[1]}\n`);

    const records = [];
    for await (const record of readTranscriptLinesBounded(transcriptPath, { start, end })) {
      records.push(record);
    }
    expect(records).toEqual([{ oversized: false, line: lines[1], sourceChars: lines[1]!.length }]);
  });

  it('parseTranscriptFile remains the full-scan compatibility path', async () => {
    await writeFile(transcriptPath, transcriptText(101, false), 'utf8');

    const parsed = await parseTranscriptFile(transcriptPath);

    expect(parsed.blocks).toHaveLength(101);
    expect(parsed.stats).toEqual({ lines: 101, parsedLines: 101, parseErrors: 0 });
  });
});
