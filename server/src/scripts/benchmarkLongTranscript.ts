import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { parseTranscriptFile, parseTranscriptWindow } from '../data/transcripts/parse.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { buildSessionDetailPayload } from '../routes/sessions.js';

const mode = process.argv.includes('--full') ? 'full' : 'window';
const lineCountArg = process.argv.find((arg) => arg.startsWith('--lines='));
const lineCount = Math.max(1, Number(lineCountArg?.split('=')[1] ?? 50_000));

function transcriptLine(index: number): string {
  const assistant = index % 2 === 1;
  return JSON.stringify({
    type: assistant ? 'assistant' : 'user',
    sessionId: 'long-session-benchmark',
    timestamp: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    message: {
      role: assistant ? 'assistant' : 'user',
      content: assistant
        ? [{ type: 'text', text: `回答 ${index} ${'y'.repeat(480)}` }]
        : `问题 ${index} ${'x'.repeat(240)}`,
    },
  });
}

async function writeTranscript(path: string, start: number, count: number): Promise<void> {
  const stream = createWriteStream(path, { flags: start === 1 ? 'w' : 'a' });
  for (let index = start; index < start + count; index += 1) {
    if (!stream.write(`${transcriptLine(index)}\n`)) await once(stream, 'drain');
  }
  stream.end();
  await once(stream, 'finish');
}

function result(label: string, startedAt: number, heapBefore: number, data: Record<string, unknown>): void {
  console.log(JSON.stringify({
    label,
    elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
    heapDeltaMB: Number(((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(2)),
    ...data,
  }));
}

await mkdir(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
const directory = await mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'long-session-benchmark-'));
const transcriptPath = join(directory, 'session.jsonl');

try {
  await writeTranscript(transcriptPath, 1, lineCount);

  if (mode === 'full') {
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    const parsed = await parseTranscriptFile(transcriptPath);
    const tail = parsed.blocks.slice(-100);
    result('full-parse-tail-response', startedAt, heapBefore, {
      parsedLines: parsed.stats.lines,
      returnedBlocks: tail.length,
      responseKB: Number((Buffer.byteLength(JSON.stringify({ ...parsed, blocks: tail })) / 1024).toFixed(2)),
    });
  } else {
    const runWindow = async (
      label: string,
      options: { limit: number; before?: string; after?: string },
    ) => {
      const heapBefore = process.memoryUsage().heapUsed;
      const startedAt = performance.now();
      const parsed = await parseTranscriptWindow(transcriptPath, options);
      const payload = buildSessionDetailPayload({
        ...parsed,
        sessionId: parsed.sessionId ?? 'long-session-benchmark',
      }, {
        ...options,
        windowStartsAtBeginning: parsed.window.startsAtBeginning,
        latestCursor: parsed.window.latestCursor,
      });
      result(label, startedAt, heapBefore, {
        indexMs: parsed.timing.indexDurationMs,
        readParseMs: parsed.timing.readParseDurationMs,
        parsedLines: parsed.stats.parsedLines,
        totalLines: parsed.stats.lines,
        returnedBlocks: payload.blocks.length,
        responseMode: payload.mode,
        responseKB: Number((Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(2)),
      });
      return payload;
    };

    const tail = await runWindow('cold-index-tail-window', { limit: 100 });
    await runWindow('warm-tail-window', { limit: 100 });
    await runWindow('before-page-window', { limit: 100, before: tail.oldestCursor });
    await appendFile(
      transcriptPath,
      `${Array.from({ length: 25 }, (_, index) => transcriptLine(lineCount + index + 1)).join('\n')}\n`,
      'utf8',
    );
    await runWindow('after-append-window', { limit: 100, after: tail.cursor });
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
