import { describe, expect, it } from 'vitest';

import { ExternalApiAdmissionController } from '../externalAgent/admissionController.js';

describe('ExternalApiAdmissionController', () => {
  it('limits each API Client independently and resets after a minute', () => {
    let now = 1_000;
    const controller = new ExternalApiAdmissionController({
      maxRequestsPerMinute: 2,
      now: () => now,
    });
    expect(controller.check('client-a')).toEqual({ allowed: true });
    expect(controller.check('client-a')).toEqual({ allowed: true });
    expect(controller.check('client-a')).toMatchObject({ allowed: false, retryAfterSeconds: 60 });
    expect(controller.check('client-b')).toEqual({ allowed: true });
    now += 60_000;
    expect(controller.check('client-a')).toEqual({ allowed: true });
  });

  it('releases per-client concurrency leases exactly once', () => {
    const controller = new ExternalApiAdmissionController({
      maxRequestsPerMinute: 10,
      maxConcurrentRequests: 1,
    });
    const first = controller.acquire('client-a');
    expect(first.allowed).toBe(true);
    expect(controller.acquire('client-a')).toMatchObject({
      allowed: false,
      reason: 'concurrency_limit',
    });
    first.release?.();
    first.release?.();
    expect(controller.acquire('client-a').allowed).toBe(true);
  });
});
