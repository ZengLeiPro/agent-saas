import { describe, expect, it, vi } from 'vitest';
import { Reporter } from '../harness/report.js';
import type { DoctorContext } from './context.js';
import { chapter06 } from './ch06ExternalWrite.js';

describe('只读应用的写入口负向验收', () => {
  it.each([
    [404, 'not_found', 'pass'],
    [200, undefined, 'fail'],
    [403, 'forbidden', 'fail'],
  ] as const)('实际 HTTP %s / %s 判为 %s', async (status, errorCode, expected) => {
    const reporter = new Reporter({ write: () => undefined });
    const invokeCapability = vi.fn().mockResolvedValue({ status, errorCode });
    const ctx = {
      reporter,
      capabilitiesOf: () => [],
      invokeCapability,
    } as unknown as DoctorContext;
    await chapter06(ctx);
    expect(invokeCapability).toHaveBeenCalledWith({
      capabilityId: 'doctor.undeclared.write',
      input: {},
    });
    expect(reporter.checks).toHaveLength(1);
    expect(reporter.checks[0]?.status).toBe(expected);
  });
});
