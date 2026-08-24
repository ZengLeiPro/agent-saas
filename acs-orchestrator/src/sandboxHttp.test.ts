import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import { allowsExecutionMaintenanceBypass } from './sandboxHttp.js';

function request(remoteAddress: string, header?: string): IncomingMessage {
  return {
    headers: header ? { 'x-acs-maintenance-bypass': header } : {},
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

describe('ACS execution maintenance bypass', () => {
  it('allows only the exact deploy smoke marker from loopback', () => {
    expect(allowsExecutionMaintenanceBypass(request('127.0.0.1', 'deploy-smoke-v1'))).toBe(true);
    expect(allowsExecutionMaintenanceBypass(request('::1', 'deploy-smoke-v1'))).toBe(true);
    expect(allowsExecutionMaintenanceBypass(request('127.0.0.1', 'other'))).toBe(false);
  });

  it('rejects the marker from non-loopback callers', () => {
    expect(allowsExecutionMaintenanceBypass(request('172.16.177.77', 'deploy-smoke-v1'))).toBe(false);
  });
});
