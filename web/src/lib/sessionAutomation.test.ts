import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('@/lib/authFetch', () => ({ authFetch }));

import {
  getAutomationTranscriptLabel,
  getSessionAutomationBadge,
} from './sessionAutomation';
import { isSessionAutomationCommand } from './sessionAutomationCommand';
import { submitAutomationCommand } from './sessionAutomationApi';
import { matchingSlashCommands } from './slashCommandRegistry';

describe('session automation slash command registry', () => {
  it('only intercepts loop and goal platform commands', () => {
    expect(isSessionAutomationCommand('/goal set -- done')).toBe(true);
    expect(isSessionAutomationCommand('  /loop pause')).toBe(true);
    expect(isSessionAutomationCommand('/goals are useful')).toBe(false);
    expect(isSessionAutomationCommand('/compact')).toBe(false);
  });

  it('provides slash completion and help metadata', () => {
    expect(matchingSlashCommands('/').map((item) => item.name)).toEqual(['/loop', '/goal']);
    expect(matchingSlashCommands('/go')[0]?.syntax).toContain('--max-turns');
    expect(matchingSlashCommands('hello')).toEqual([]);
  });
});

describe('submitAutomationCommand', () => {
  beforeEach(() => authFetch.mockReset());

  it('uses clientMsgId as both body identity and Idempotency-Key', async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({
      status: 'committed', sessionId: 'session-1', automation: null,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    await submitAutomationCommand({
      clientMsgId: 'stable-command-id',
      sessionId: null,
      rawCommand: '/goal set -- ship it',
      attachmentIds: ['attachment-1'],
    });

    const [, init] = authFetch.mock.calls[0];
    expect(init.headers['Idempotency-Key']).toBe('stable-command-id');
    expect(JSON.parse(init.body)).toMatchObject({
      clientMsgId: 'stable-command-id',
      sessionId: null,
      rawCommand: '/goal set -- ship it',
      attachments: [{ attachmentId: 'attachment-1' }],
    });
  });
});

describe('session automation projections', () => {
  it('labels hidden continuation output without changing its assistant message type', () => {
    expect(getAutomationTranscriptLabel({ automation: { kind: 'goal', turn: 4 } })).toBe('Goal turn 4');
    expect(getAutomationTranscriptLabel({ automationKind: 'loop', automationRun: 7 })).toBe('Loop run 7');
  });

  it('formats goal progress and loop next wake', () => {
    expect(getSessionAutomationBadge({ automation: { kind: 'goal', status: 'active', runCount: 8, maxRuns: 20 } }))
      .toBe('Goal · 8/20 · active');
    expect(getSessionAutomationBadge({ automation: { kind: 'loop', nextActionAt: '2026-08-30T07:12:00.000Z' } }, Date.parse('2026-08-30T07:00:00.000Z')))
      .toBe('Loop · 12m 后');
  });
});
