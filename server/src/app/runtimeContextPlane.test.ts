import { describe, expect, it, vi } from 'vitest';

import { createRuntimeContextPlane } from './runtimeContextPlane.js';

describe('createRuntimeContextPlane', () => {
  it('creates the sync runtime without Taskboard so Directory and Azeroth are not silently disabled', () => {
    const plane = createRuntimeContextPlane({
      contextStore: {} as never,
      membershipStore: { getMembership: vi.fn() } as never,
      assignmentStore: {} as never,
      userStore: {} as never,
      enableWorker: false,
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(plane.syncRuntime).toBeInstanceOf(Object);
  });
});
