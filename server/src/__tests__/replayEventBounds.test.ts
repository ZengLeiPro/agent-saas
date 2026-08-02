import { describe, expect, it } from 'vitest';

import {
  boundReplayToolResultEvents,
  REPLAY_RECENT_TOOL_RESULT_MAX_CHARS,
  REPLAY_TOOL_RESULT_MAX_CHARS,
} from '../runtime/replayEventBounds.js';
import type { PlatformEvent } from '../runtime/types.js';

function toolResult(index: number): Extract<PlatformEvent, { type: 'tool_result' }> {
  return {
    id: `event-${index}`,
    timestamp: new Date(index).toISOString(),
    type: 'tool_result',
    runId: 'run-1',
    sessionId: 'session-1',
    toolCallId: `call-${index}`,
    toolName: 'Shell',
    content: 'x'.repeat(20_000),
  };
}

describe('bounded replay event view', () => {
  it('bounds tool payloads before projection while leaving durable source objects untouched', () => {
    const source = Array.from({ length: 10 }, (_, index) => toolResult(index));
    const bounded = boundReplayToolResultEvents(source);

    expect((bounded[0] as Extract<PlatformEvent, { type: 'tool_result' }>).content)
      .toHaveLength(REPLAY_TOOL_RESULT_MAX_CHARS);
    expect((bounded[1] as Extract<PlatformEvent, { type: 'tool_result' }>).content)
      .toHaveLength(REPLAY_TOOL_RESULT_MAX_CHARS);
    expect((bounded[2] as Extract<PlatformEvent, { type: 'tool_result' }>).content)
      .toHaveLength(REPLAY_RECENT_TOOL_RESULT_MAX_CHARS);
    expect((bounded[9] as Extract<PlatformEvent, { type: 'tool_result' }>).content)
      .toContain('SessionContext(action="trace") toolCallId=call-9');
    expect(source[0]?.content).toHaveLength(20_000);
  });
});
