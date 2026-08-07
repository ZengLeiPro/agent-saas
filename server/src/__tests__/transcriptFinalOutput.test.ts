import { mkdir, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  collectFinalOutputEventIds,
  enrichTranscriptFinalOutputs,
} from '../data/transcripts/finalOutput.js';
import { parseTranscriptFile, type ParsedTranscript } from '../data/transcripts/parse.js';
import { AGENT_LEGACY_TRANSCRIPTS_ROOT } from '../data/transcripts/projectKey.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import type { PlatformEvent } from '../runtime/types.js';

function event(input: Partial<PlatformEvent> & Pick<PlatformEvent, 'id' | 'type'>): PlatformEvent {
  return {
    timestamp: '2026-08-07T05:00:00.000Z',
    runId: 'run-1',
    sessionId: 'session-1',
    ...input,
  } as PlatformEvent;
}

describe('final output transcript projection', () => {
  let dir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    await mkdir(AGENT_LEGACY_TRANSCRIPTS_ROOT, { recursive: true });
    dir = await mkdtemp(join(AGENT_LEGACY_TRANSCRIPTS_ROOT, 'transcript-final-output-'));
    transcriptPath = join(dir, 'session-1.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('persists source event and run ids on assistant text blocks', async () => {
    const projection = new LegacyTranscriptProjection(transcriptPath);
    await projection.project(event({
      id: 'assistant-final',
      type: 'assistant_message',
      content: '最终回答',
    }));

    const parsed = await parseTranscriptFile(transcriptPath);
    expect(parsed.blocks).toContainEqual(expect.objectContaining({
      kind: 'text',
      content: '最终回答',
      sourceEventId: 'assistant-final',
      runId: 'run-1',
    }));
  });

  it('only selects the last complete assistant_message of a successful run', () => {
    const events = [
      event({ id: 'commentary', type: 'assistant_tool_calls', content: '我先检查', toolCalls: [] }),
      event({ id: 'early-answer', type: 'assistant_message', content: '第一段回答' }),
      event({ id: 'final-answer', type: 'assistant_message', content: '插话后的最终回答' }),
      event({ id: 'run-success', type: 'run_finished', subtype: 'success', numTurns: 3 }),
      event({ id: 'partial', type: 'assistant_message', runId: 'run-2', content: '未完成', incomplete: true }),
      event({ id: 'run-error', type: 'run_finished', runId: 'run-2', subtype: 'error', numTurns: 1, error: 'boom' }),
    ];

    expect([...collectFinalOutputEventIds(events)]).toEqual(['final-answer']);
  });

  it('marks only transcript blocks backed by the selected runtime event', () => {
    const parsed: ParsedTranscript = {
      sessionId: 'session-1',
      blocks: [
        { id: 'b1', kind: 'text', title: '输出', defaultOpen: true, content: '过程', sourceEventId: 'commentary' },
        { id: 'b2', kind: 'text', title: '输出', defaultOpen: true, content: '最终', sourceEventId: 'final-answer' },
        { id: 'b3', kind: 'text', title: '输出', defaultOpen: true, content: '旧历史' },
      ],
      stats: { lines: 3, parsedLines: 3, parseErrors: 0 },
    };

    const enriched = enrichTranscriptFinalOutputs(parsed, new Set(['final-answer']));
    expect(enriched.blocks[0]).not.toHaveProperty('finalOutput');
    expect(enriched.blocks[1]).toMatchObject({ finalOutput: true });
    expect(enriched.blocks[2]).not.toHaveProperty('finalOutput');
  });
});
