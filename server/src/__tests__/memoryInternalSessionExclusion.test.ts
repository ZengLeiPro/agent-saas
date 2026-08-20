import { describe, expect, it, vi } from 'vitest';

import { UserActivityService } from '../runtime/userActivityService.js';
import type { PlatformEvent } from '../runtime/types.js';

function event(partial: Partial<PlatformEvent> & { type: PlatformEvent['type'] }): PlatformEvent {
  return {
    id: `evt-${Math.random()}`,
    timestamp: '2026-08-19T12:00:00.000Z',
    ...partial,
  } as PlatformEvent;
}

function session(sessionId: string, profileBindingKey?: string) {
  return {
    sessionId,
    tenantId: 'kaiyan',
    userId: 'u1',
    kind: 'user' as const,
    updatedAt: '2026-08-19T12:00:00.000Z',
    metaJson: {
      userId: 'u1',
      username: 'alice',
      channel: 'web',
      createdAt: '2026-08-19T11:00:00.000Z',
      ...(profileBindingKey ? { profileBindingKey } : {}),
    },
  };
}

function runEvents(sessionId: string, runId: string, content: string): PlatformEvent[] {
  return [
    event({ type: 'run_started', sessionId, runId, model: 'm', channel: 'web' }),
    event({ type: 'user_message', sessionId, runId, content }),
  ];
}

describe('UserActivityService internal memory session exclusion', () => {
  it('excludes current and legacy L2 sessions from L3 activity aggregation', async () => {
    const events: Record<string, PlatformEvent[]> = {
      normal: runEvents('normal', 'r1', '普通对话'),
      current: runEvents('current', 'r2', '当前提取提示'),
      legacy: runEvents('legacy', 'r3', '旧提取提示'),
    };
    const service = new UserActivityService({
      sessionProjection: {
        list: vi.fn(async () => ({
          items: [
            session('normal'),
            session('current', 'memory_consolidate'),
            session('legacy', 'memory_poll'),
          ],
        })),
      } as never,
      eventStore: {
        append: vi.fn(),
        list: vi.fn(async (sessionId: string) => events[sessionId] ?? []),
      } as never,
    });

    const result = await service.listActivity({
      tenantId: 'kaiyan',
      userId: 'u1',
      sinceIso: '2026-08-19T00:00:00.000Z',
    });

    expect(result.sessions.map((item) => item.sessionId)).toEqual(['normal']);
  });
});
