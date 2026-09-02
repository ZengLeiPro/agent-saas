import { describe, expect, it } from 'vitest';
import {
  assertSafeTelemetrySurface,
  assertSafeOperationalSurface,
  createReleasePseudonymizer,
  mobileTelemetryBatchSchema,
  parseMobileTelemetryBatch,
} from './mobileTelemetry';

const hash = `h1:${'a'.repeat(64)}`;
const release = {
  commit: 'b'.repeat(40),
  appVersion: '1.9.5',
  build: '85',
  profile: 'preview' as const,
};
const event = {
  schemaVersion: 1 as const,
  eventId: '11111111-1111-4111-8111-111111111111',
  kind: 'startup' as const,
  wallTimestamp: '2026-09-01T07:00:00.000Z',
  monotonicMs: 12.5,
  correlation: { correlationId: hash, sessionId: hash },
  release,
  runtime: { deviceClass: 'mid' as const, os: 'ios' as const },
  measurements: { durationMs: 12.5, cold: true },
};
const batch = {
  schemaVersion: 1 as const,
  batchId: '22222222-2222-4222-8222-222222222222',
  nonce: 'c'.repeat(32),
  sentAt: '2026-09-01T07:00:01.000Z',
  owner: { tenantId: hash, userId: hash },
  release,
  events: [event],
};

describe('mobile telemetry shared privacy contract', () => {
  it('accepts the versioned strict allowlist and rejects unknown/proto-like fields', () => {
    expect(parseMobileTelemetryBatch(batch)).toEqual(batch);
    expect(mobileTelemetryBatchSchema.safeParse({ ...batch, prompt: 'secret' }).success).toBe(
      false,
    );
    const malicious = JSON.parse('{"schemaVersion":1,"__proto__":{"polluted":true}}');
    expect(() => assertSafeTelemetrySurface(malicious)).toThrow(/prototype_key/);
  });

  it.each([
    [{ prompt: 'raw prompt' }, 'forbidden_key'],
    [{ value: 'person@example.com' }, 'email'],
    [{ value: '+86 138 1234 5678' }, 'phone'],
    [{ value: 'Bearer secret-token-value' }, 'token'],
    [{ value: 'https://example.test/path?token=secret' }, 'url_query'],
    [{ value: '/private/var/mobile/file.txt' }, 'local_path'],
  ])('rejects malicious raw surfaces %#', (value, code) => {
    expect(() => assertSafeTelemetrySurface(value)).toThrow(code);
  });

  it.each(['telemetry', 'analytics', 'a11y', 'log'] as const)(
    'uses the same scanner for %s projections',
    (channel) => {
      expect(() =>
        assertSafeOperationalSurface(channel, {
          kind: 'safe_kind',
          correlation: hash,
          status: 'ok',
        }),
      ).not.toThrow();
      expect(() => assertSafeOperationalSurface(channel, { message: 'raw secret' })).toThrow(
        /forbidden_key/,
      );
    },
  );

  it('rejects cyclic, excessive depth and oversized values before upload', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => assertSafeTelemetrySurface(cyclic)).toThrow(/cyclic/);
    expect(() =>
      assertSafeTelemetrySurface(
        { a: { b: { c: 1 } } },
        { maxBytes: 100, maxDepth: 1, maxNodes: 10 },
      ),
    ).toThrow(/depth_limit/);
    expect(() =>
      assertSafeTelemetrySurface(
        { value: 'x'.repeat(100) },
        { maxBytes: 20, maxDepth: 8, maxNodes: 10 },
      ),
    ).toThrow(/byte_limit/);
  });

  it('allows only normalized crash frames and rejects raw stacks/locals', () => {
    const crash = {
      ...event,
      kind: 'crash_js' as const,
      stack: [{ moduleHash: hash, inApp: true, line: 12, column: 4 }],
    };
    expect(mobileTelemetryBatchSchema.safeParse({ ...batch, events: [crash] }).success).toBe(true);
    expect(
      mobileTelemetryBatchSchema.safeParse({
        ...batch,
        events: [{ ...crash, stack: [{ ...crash.stack[0], file: '/app/secret.ts' }] }],
      }).success,
    ).toBe(false);
    expect(() => assertSafeTelemetrySurface({ stackLocals: { token: 'secret' } })).toThrow();
  });

  it('fails closed without an external production pseudonym key', () => {
    const keyedDigest = () => 'd'.repeat(64);
    expect(() =>
      createReleasePseudonymizer({
        releaseCommit: release.commit,
        profile: 'production',
        keyedDigest,
      }),
    ).toThrow(/production_pseudonym_key_missing/);
    expect(
      createReleasePseudonymizer({
        releaseCommit: release.commit,
        profile: 'preview',
        externalKey: 'k'.repeat(32),
        keyedDigest,
      }).pseudonym('owner'),
    ).toBe(`h1:${'d'.repeat(64)}`);
  });
});
