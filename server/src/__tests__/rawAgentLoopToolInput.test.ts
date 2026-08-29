import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it } from 'vitest';
import { PlatformToolRuntime } from '../agent/toolRuntime.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import { FileEventStore } from '../runtime/fileEventStore.js';
import { LegacyTranscriptProjection } from '../runtime/legacyTranscriptProjection.js';
import { RawAgentLoop } from '../runtime/rawAgentLoop.js';
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  ModelToolCall,
  RunContext,
} from '../runtime/types.js';
import type { OutboundEvent } from '../types/index.js';

class SingleToolCallThenTextAdapter implements ModelAdapter {
  private emitted = false;

  constructor(private readonly toolCall: ModelToolCall) {}

  async *stream(_request: ModelRequest, _context: RunContext): AsyncIterable<ModelEvent> {
    if (!this.emitted) {
      this.emitted = true;
      yield { type: 'completed', content: '', toolCalls: [this.toolCall] };
      return;
    }
    yield { type: 'completed', content: 'done', toolCalls: [] };
  }
}

async function collect(stream: AsyncIterable<OutboundEvent>): Promise<OutboundEvent[]> {
  const events: OutboundEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('RawAgentLoop tool input preparation', () => {
  it('uses prepareInput output consistently for approval display and stored execution input', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'raw-loop-edit-prepare-'));
    try {
      const eventStore = new FileEventStore(
        join(cwd, 'session.runtime-events.jsonl'),
        DEFAULT_TENANT_ID,
      );
      const approvalStore = new EventBackedApprovalStore(
        eventStore,
        'session-edit-prepare',
        DEFAULT_TENANT_ID,
      );
      let shownInput: Record<string, unknown> | undefined;
      const loop = new RawAgentLoop({
        modelAdapter: new SingleToolCallThenTextAdapter({
          id: 'call_edit_prepared',
          name: 'Edit',
          arguments: JSON.stringify(
            JSON.stringify({
              path: 'a.txt',
              edits: JSON.stringify({ oldText: 'old', newText: 'new' }),
            }),
          ),
        }),
        eventStore,
        approvalStore,
        transcriptProjection: new LegacyTranscriptProjection(join(cwd, 'session.jsonl')),
        toolRuntime: new PlatformToolRuntime(),
      });

      await collect(
        loop.run(
          {
            message: { channel: 'web', chatId: 'chat-1', content: '编辑文件' },
            prompt: '编辑文件',
            instructions: '必须调用工具。',
            maxTurns: 2,
            connection: { apiKey: 'sk-test', baseUrl: 'https://example.invalid/v1' },
          },
          {
            runId: 'run-edit-prepare',
            sessionId: 'session-edit-prepare',
            model: 'gpt-5.5',
            cwd,
            tenantId: DEFAULT_TENANT_ID,
            channelContext: {
              channel: 'web',
              user: { id: 'admin-1', username: 'admin', role: 'admin' },
            },
            hooks: {
              onInteraction: async (event) => {
                if (event.type === 'permission_request') shownInput = event.toolInput;
                return { allow: false, message: 'test only' };
              },
            },
          },
        ),
      );

      const expected = {
        file_path: 'a.txt',
        edits: [{ old_string: 'old', new_string: 'new' }],
      };
      expect(shownInput).toEqual(expected);
      expect((await approvalStore.list('session-edit-prepare'))[0]?.input).toEqual(expected);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
