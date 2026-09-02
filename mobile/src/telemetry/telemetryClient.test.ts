import { describe, expect, it, vi } from 'vitest';
import type { MobileTelemetryBatch } from '@agent/shared';
import { EventLoopAnrWatchdog } from './anrWatchdog';
import {
  MOBILE_TELEMETRY_BUFFER_POLICY,
  MobileTelemetryClient,
  type TelemetryStorage,
} from './telemetryClient';

class MemoryStorage implements TelemetryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return Promise.resolve(this.values.get(key) ?? null);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
    return Promise.resolve();
  }
  removeItem(key: string) {
    this.values.delete(key);
    return Promise.resolve();
  }
}
let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
const pseudo = {
  pseudonym: (value: string) => {
    const code = value.split('').reduce((sum, char) => (sum + char.charCodeAt(0)) % 256, 0);
    return `h1:${code.toString(16).padStart(2, '0').repeat(32)}`;
  },
};
const release = {
  commit: 'b'.repeat(40),
  appVersion: '1.9.5',
  build: '85',
  profile: 'preview' as const,
};
function client(
  input: {
    storage?: MemoryStorage;
    send?: (batch: MobileTelemetryBatch) => Promise<{ accepted: boolean }>;
    mono?: () => number;
    owner?: { tenantId: string; userId: string };
  } = {},
) {
  const storage = input.storage ?? new MemoryStorage();
  const sent: MobileTelemetryBatch[] = [];
  const instance = new MobileTelemetryClient({
    storage,
    release,
    runtime: { deviceClass: 'mid', os: 'ios' },
    pseudonymizer: pseudo,
    owner: input.owner ?? { tenantId: 'tenant-a', userId: 'user-a' },
    wallNow: () => Date.parse('2026-09-01T07:00:00.000Z'),
    monotonicNow: input.mono ?? (() => 100),
    uuid,
    nonce: () => 'c'.repeat(32),
    transport: {
      send:
        input.send ??
        (async (batch) => {
          sent.push(batch);
          return { accepted: true };
        }),
    },
  });
  return { instance, storage, sent };
}

describe('mobile telemetry offline owner buffer', () => {
  it('captures startup monotonic duration fields without raw data and flushes foreground offline backlog', async () => {
    const { instance, storage, sent } = client();
    expect(() =>
      instance.capture('startup', {
        correlationId: 'corr',
        measurements: { durationMs: 42, cold: true },
      }),
    ).not.toThrow();
    await instance.settled();
    expect(storage.values.has(instance.bufferKey)).toBe(true);
    expect(await instance.flush()).toBe(1);
    expect(sent[0]?.events[0]).toMatchObject({
      kind: 'startup',
      monotonicMs: 100,
      measurements: { durationMs: 42, cold: true },
    });
    expect(storage.values.has(instance.bufferKey)).toBe(false);
  });

  it('pauses in background and preserves events on provider/network failure or exhausted foreground budget', async () => {
    const { instance, storage } = client({
      send: async () => {
        throw new Error('offline');
      },
    });
    instance.capture('ws_disconnect', { correlationId: 'ws' });
    await instance.settled();
    instance.setForeground(false);
    expect(await instance.flush()).toBe(0);
    instance.setForeground(true);
    expect(await instance.flush()).toBe(0);
    expect(storage.values.has(instance.bufferKey)).toBe(true);

    let tick = 0;
    const budgeted = client({ storage, mono: () => ++tick * 1000 }).instance;
    budgeted.capture('session_start', { correlationId: 'session' });
    await budgeted.settled();
    expect(await budgeted.flush(1)).toBe(0);
  });

  it('bounds buffer pressure by count/bytes and clears exactly the logout owner namespace', async () => {
    const storage = new MemoryStorage();
    const a = client({ storage }).instance;
    const b = client({ storage, owner: { tenantId: 'tenant-b', userId: 'user-b' } }).instance;
    for (let index = 0; index < MOBILE_TELEMETRY_BUFFER_POLICY.maxCount + 25; index += 1) {
      a.capture('screen_ready', { correlationId: `event-${index}` });
    }
    b.capture('screen_ready', { correlationId: 'other-owner' });
    await Promise.all([a.settled(), b.settled()]);
    const values = JSON.parse((await storage.getItem(a.bufferKey)) ?? '[]') as unknown[];
    expect(values.length).toBeLessThanOrEqual(MOBILE_TELEMETRY_BUFFER_POLICY.maxCount);
    expect(new TextEncoder().encode(JSON.stringify(values)).byteLength).toBeLessThanOrEqual(
      MOBILE_TELEMETRY_BUFFER_POLICY.maxBytes,
    );
    await a.clearOwner();
    expect(await storage.getItem(a.bufferKey)).toBeNull();
    expect(await storage.getItem(b.bufferKey)).not.toBeNull();
  });

  it('never throws into a business path for invalid/raw events', () => {
    expect(() =>
      client().instance.capture('voice_error', {
        correlationId: 'corr',
        measurements: { reasonCode: 'invalid secret@example.com' },
      }),
    ).not.toThrow();
  });
});

describe('ANR watchdog lifecycle', () => {
  it('ignores background/debugger stalls and reports a foreground monotonic stall', () => {
    vi.useFakeTimers();
    let current = 0;
    let foreground = false;
    let debuggerAttached = false;
    const emit = vi.fn();
    const watchdog = new EventLoopAnrWatchdog({
      intervalMs: 100,
      thresholdMs: 500,
      now: () => current,
      isForeground: () => foreground,
      isDebuggerAttached: () => debuggerAttached,
      emit,
    });
    watchdog.start();
    current = 1000;
    vi.advanceTimersByTime(100);
    expect(emit).not.toHaveBeenCalled();
    foreground = true;
    debuggerAttached = true;
    current = 2000;
    vi.advanceTimersByTime(100);
    expect(emit).not.toHaveBeenCalled();
    debuggerAttached = false;
    current = 3000;
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledWith(900);
    watchdog.stop();
    vi.useRealTimers();
  });
});
