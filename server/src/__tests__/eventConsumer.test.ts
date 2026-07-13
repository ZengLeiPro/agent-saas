import { describe, expect, it, vi } from 'vitest';
import type { OutboundEvent } from '../types/index.js';
import { EventConsumer } from '../channels/eventConsumer.js';
import { resolveDisplayToolName } from '../channels/toolNameResolver.js';

async function* createEvents(events: OutboundEvent[]): AsyncGenerator<OutboundEvent> {
  for (const event of events) {
    yield event;
  }
}

describe('EventConsumer tool name resolver', () => {
  const skillEvents: OutboundEvent[] = [
    { type: 'tool_start', toolId: 'tool-1', toolName: 'Skill' },
    { type: 'tool_input_delta', toolId: 'tool-1', toolName: 'Skill', partialJson: '{"skill":"commit"}' },
    { type: 'tool_end', toolId: 'tool-1', toolName: 'Skill' },
    { type: 'tool_result', toolId: 'tool-1', toolResult: 'ok' },
    { type: 'done' },
  ];

  it('keeps core behavior generic without resolver', async () => {
    const consumer = new EventConsumer();
    const onToolEnd = vi.fn();
    const onToolResult = vi.fn();

    await consumer.consume(createEvents(skillEvents), {
      onToolEnd,
      onToolResult,
    });

    expect(onToolEnd).toHaveBeenCalledWith('tool-1', 'Skill', '{"skill":"commit"}');
    expect(onToolResult).toHaveBeenCalledWith('tool-1', 'Skill', 'ok');
  });

  it('resolves Skill display name with channel resolver', async () => {
    const consumer = new EventConsumer({ resolveToolName: resolveDisplayToolName });
    const onToolEnd = vi.fn();
    const onToolResult = vi.fn();

    await consumer.consume(createEvents(skillEvents), {
      onToolEnd,
      onToolResult,
    });

    expect(onToolEnd).toHaveBeenCalledWith('tool-1', '技能：commit', '{"skill":"commit"}');
    expect(onToolResult).toHaveBeenCalledWith('tool-1', '技能：commit', 'ok');
  });

  it('formats MCP tool name from tool_start', async () => {
    const consumer = new EventConsumer({ resolveToolName: resolveDisplayToolName });
    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    await consumer.consume(createEvents([
      { type: 'tool_start', toolId: 'tool-2', toolName: 'mcp__github__create_issue' },
      { type: 'tool_end', toolId: 'tool-2', toolName: 'mcp__github__create_issue' },
      { type: 'done' },
    ]), {
      onToolStart,
      onToolEnd,
    });

    expect(onToolStart).toHaveBeenCalledWith('tool-2', 'MCP:github/create_issue', expect.anything());
    expect(onToolEnd).toHaveBeenCalledWith('tool-2', 'MCP:github/create_issue', '');
  });
});
