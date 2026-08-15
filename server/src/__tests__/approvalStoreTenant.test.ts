import { describe, expect, it, vi } from 'vitest';

import { EventBackedApprovalStore } from '../runtime/approvalStore.js';
import type { EventStore, PlatformEvent } from '../runtime/types.js';

describe('EventBackedApprovalStore tenant context', () => {
  it('passes the source tenant to durable approval events', async () => {
    const events: PlatformEvent[] = [];
    const append = vi.fn(async (...args: Parameters<EventStore['append']>) => {
      const [event] = args;
      const stored = { id: `event-${events.length + 1}`, timestamp: new Date().toISOString(), ...event } as PlatformEvent;
      events.push(stored);
      return stored;
    });
    const eventStore = {
      append,
      list: vi.fn(async () => events),
    } as unknown as EventStore;
    const store = new EventBackedApprovalStore(eventStore, 'session-1', 'tenant-a');

    const approval = await store.create({
      sessionId: 'session-1', runId: 'run-1', toolCallId: 'call-1',
      toolId: 'Shell', toolName: 'Shell', input: { command: 'pwd' },
    });
    await store.resolvePending(approval.id, 'rejected', 'cancelled source run');

    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0]?.[1]).toEqual({ tenantId: 'tenant-a' });
    expect(append.mock.calls[1]?.[1]).toEqual({ tenantId: 'tenant-a' });
  });
});
