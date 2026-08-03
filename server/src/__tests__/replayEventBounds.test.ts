import { describe, expect, it } from 'vitest';

import {
  boundReplayToolResultEvents,
  LEGACY_MODEL_TOOL_RESULT_MAX_CHARS,
  MODEL_TOOL_RESULT_MAX_CHARS,
  projectToolResultContentForModel,
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
    modelContent: projectToolResultContentForModel('x'.repeat(20_000), `call-${index}`),
  };
}

describe('bounded replay event view', () => {
  it('对每条工具结果使用固定投影且不改 durable source', () => {
    const source = Array.from({ length: 10 }, (_, index) => toolResult(index));
    const bounded = boundReplayToolResultEvents(source);

    expect(bounded.every((event) => (
      event.type !== 'tool_result' || event.content.length === MODEL_TOOL_RESULT_MAX_CHARS
    ))).toBe(true);
    expect((bounded[9] as Extract<PlatformEvent, { type: 'tool_result' }>).content)
      .toContain('SessionContext(action="trace") toolCallId=call-9');
    expect(source[0]?.content).toHaveLength(20_000);
  });

  it('追加新的工具结果不会改变既有事件的模型投影', () => {
    const first = toolResult(0);
    const initial = boundReplayToolResultEvents([first]);
    const extended = boundReplayToolResultEvents([
      first,
      ...Array.from({ length: 20 }, (_, index) => toolResult(index + 1)),
    ]);

    expect(extended[0]).toEqual(initial[0]);
  });

  it('旧事件使用固定兼容上限，追加事件后同样保持不变', () => {
    const legacy = toolResult(0);
    delete legacy.modelContent;
    const initial = boundReplayToolResultEvents([legacy]);
    const extended = boundReplayToolResultEvents([
      legacy,
      ...Array.from({ length: 20 }, (_, index) => toolResult(index + 1)),
    ]);

    expect(initial[0]?.type === 'tool_result' ? initial[0].content.length : Infinity)
      .toBe(LEGACY_MODEL_TOOL_RESULT_MAX_CHARS);
    expect(extended[0]).toEqual(initial[0]);
  });
});
