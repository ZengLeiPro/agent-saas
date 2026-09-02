import { z } from 'zod';

export const MOBILE_TELEMETRY_SCHEMA_VERSION = 1 as const;
export const MOBILE_TELEMETRY_EVENT_KINDS = [
  'session_start',
  'crash_js',
  'crash_native',
  'anr',
  'startup',
  'screen_ready',
  'chat_submit',
  'chat_ack',
  'first_token',
  'run_terminal',
  'ws_disconnect',
  'ws_recovered',
  'sync_overflow',
  'artifact_error',
  'voice_error',
] as const;

export type MobileTelemetryEventKind = (typeof MOBILE_TELEMETRY_EVENT_KINDS)[number];

const hashSchema = z.string().regex(/^h1:[a-f0-9]{64}$/);
const wallTimestampSchema = z.iso.datetime({ offset: true });
const safeCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/);

export const mobileTelemetryReleaseSchema = z
  .object({
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    appVersion: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/),
    build: z
      .string()
      .trim()
      .min(1)
      .max(32)
      .regex(/^[0-9A-Za-z][0-9A-Za-z.-]*$/),
    profile: z.enum(['development', 'preview', 'production']),
  })
  .strict();

export const mobileTelemetryRuntimeSchema = z
  .object({
    deviceClass: z.enum(['low', 'mid', 'high', 'unknown']),
    os: z.enum(['ios', 'android', 'web']),
  })
  .strict();

export const mobileTelemetryCorrelationSchema = z
  .object({
    correlationId: hashSchema,
    sessionId: hashSchema.optional(),
    runId: hashSchema.optional(),
  })
  .strict();

export const normalizedStackFrameSchema = z
  .object({
    moduleHash: hashSchema,
    inApp: z.boolean(),
    line: z.number().int().nonnegative().max(10_000_000).optional(),
    column: z.number().int().nonnegative().max(10_000_000).optional(),
  })
  .strict();

export const mobileTelemetryMeasurementsSchema = z
  .object({
    durationMs: z.number().finite().nonnegative().max(86_400_000).optional(),
    count: z.number().int().nonnegative().max(1_000_000).optional(),
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024)
      .optional(),
    foreground: z.boolean().optional(),
    cold: z.boolean().optional(),
    sampled: z.boolean().optional(),
    status: safeCodeSchema.optional(),
    reasonCode: safeCodeSchema.optional(),
  })
  .strict();

export const mobileTelemetryEventSchema = z
  .object({
    schemaVersion: z.literal(MOBILE_TELEMETRY_SCHEMA_VERSION),
    eventId: z.uuid(),
    kind: z.enum(MOBILE_TELEMETRY_EVENT_KINDS),
    wallTimestamp: wallTimestampSchema,
    monotonicMs: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    correlation: mobileTelemetryCorrelationSchema,
    release: mobileTelemetryReleaseSchema,
    runtime: mobileTelemetryRuntimeSchema,
    measurements: mobileTelemetryMeasurementsSchema.optional(),
    stack: z.array(normalizedStackFrameSchema).max(64).optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if ((event.kind === 'crash_js' || event.kind === 'crash_native') && !event.stack?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['stack'],
        message: 'Crash events require normalized frames',
      });
    }
    if (event.stack && event.kind !== 'crash_js' && event.kind !== 'crash_native') {
      ctx.addIssue({ code: 'custom', path: ['stack'], message: 'Stack frames are crash-only' });
    }
  });

export const mobileTelemetryBatchSchema = z
  .object({
    schemaVersion: z.literal(MOBILE_TELEMETRY_SCHEMA_VERSION),
    batchId: z.uuid(),
    nonce: z.string().regex(/^[a-f0-9]{32}$/),
    sentAt: wallTimestampSchema,
    owner: z.object({ tenantId: hashSchema, userId: hashSchema }).strict(),
    release: mobileTelemetryReleaseSchema,
    events: z.array(mobileTelemetryEventSchema).min(1).max(100),
  })
  .strict()
  .superRefine((batch, ctx) => {
    for (const [index, event] of batch.events.entries()) {
      if (JSON.stringify(event.release) !== JSON.stringify(batch.release)) {
        ctx.addIssue({
          code: 'custom',
          path: ['events', index, 'release'],
          message: 'Event release must equal batch release',
        });
      }
    }
  });

export type MobileTelemetryRelease = z.infer<typeof mobileTelemetryReleaseSchema>;
export type MobileTelemetryRuntime = z.infer<typeof mobileTelemetryRuntimeSchema>;
export type MobileTelemetryEvent = z.infer<typeof mobileTelemetryEventSchema>;
export type MobileTelemetryBatch = z.infer<typeof mobileTelemetryBatchSchema>;

const FORBIDDEN_KEYS =
  /(?:^|_)(?:prompt|message|tool|raw|input|result|attachment(?:name|path)?|token|email|phone|url|locals?|password|authorization|cookie|dsn)(?:$|_)/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const PHONE = /^\+?[0-9 ()-]+$/;
const TOKEN =
  /(?:bearer\s+[A-Za-z0-9._~+\/=:-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i;
const URL_QUERY = /https?:\/\/[^\s?#]+[?#][^\s]*/i;
const LOCAL_PATH = /(?:file|content):\/\/|(?:^|\s)(?:\/[A-Za-z0-9._-]+){2,}|[A-Za-z]:\\/;

export interface TelemetryScanLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

export const DEFAULT_TELEMETRY_SCAN_LIMITS: TelemetryScanLimits = {
  maxBytes: 64 * 1024,
  maxDepth: 8,
  maxNodes: 2_000,
};

export class TelemetryPrivacyError extends Error {
  constructor(public readonly code: string) {
    super(`Telemetry rejected: ${code}`);
    this.name = 'TelemetryPrivacyError';
  }
}

/** One scanner is used before telemetry, analytics, accessibility and log projections. */
export function assertSafeTelemetrySurface(
  value: unknown,
  limits: TelemetryScanLimits = DEFAULT_TELEMETRY_SCAN_LIMITS,
): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    if (++nodes > limits.maxNodes) throw new TelemetryPrivacyError('node_limit');
    if (depth > limits.maxDepth) throw new TelemetryPrivacyError('depth_limit');
    if (typeof current === 'string') {
      if (EMAIL.test(current)) throw new TelemetryPrivacyError('email');
      if (
        !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(current) &&
        PHONE.test(current.trim()) &&
        (current.match(/\d/g)?.length ?? 0) >= 10
      )
        throw new TelemetryPrivacyError('phone');
      if (TOKEN.test(current)) throw new TelemetryPrivacyError('token');
      if (URL_QUERY.test(current)) throw new TelemetryPrivacyError('url_query');
      if (LOCAL_PATH.test(current)) throw new TelemetryPrivacyError('local_path');
      return;
    }
    if (current === null || typeof current !== 'object') return;
    if (seen.has(current)) throw new TelemetryPrivacyError('cyclic');
    seen.add(current);
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, depth + 1));
      seen.delete(current);
      return;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null)
      throw new TelemetryPrivacyError('prototype');
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype')
        throw new TelemetryPrivacyError('prototype_key');
      if (FORBIDDEN_KEYS.test(key) && !['correlationId', 'sessionId', 'runId'].includes(key)) {
        throw new TelemetryPrivacyError(`forbidden_key:${key.toLowerCase()}`);
      }
      visit(item, depth + 1);
    }
    seen.delete(current);
  };
  visit(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TelemetryPrivacyError('not_serializable');
  }
  if (new TextEncoder().encode(serialized).byteLength > limits.maxBytes)
    throw new TelemetryPrivacyError('byte_limit');
}

export type OperationalSurfaceChannel = 'telemetry' | 'analytics' | 'a11y' | 'log';

/** Channel-labelled entry point prevents analytics/a11y/log from growing weaker redaction paths. */
export function assertSafeOperationalSurface(
  channel: OperationalSurfaceChannel,
  value: unknown,
): void {
  if (!['telemetry', 'analytics', 'a11y', 'log'].includes(channel))
    throw new TelemetryPrivacyError('unknown_channel');
  assertSafeTelemetrySurface(value);
}

export function parseMobileTelemetryBatch(value: unknown): MobileTelemetryBatch {
  assertSafeOperationalSurface('telemetry', value);
  return mobileTelemetryBatchSchema.parse(value);
}

export interface TelemetryPseudonymizer {
  pseudonym(value: string): string;
}

export function createReleasePseudonymizer(input: {
  releaseCommit: string;
  profile: MobileTelemetryRelease['profile'];
  externalKey?: string;
  keyedDigest: (key: string, value: string) => string;
}): TelemetryPseudonymizer {
  if (input.profile === 'production' && !input.externalKey) {
    throw new TelemetryPrivacyError('production_pseudonym_key_missing');
  }
  const key = input.externalKey;
  if (!key || key.length < 32) throw new TelemetryPrivacyError('pseudonym_key_invalid');
  return {
    pseudonym(value: string) {
      return `h1:${input.keyedDigest(`${input.releaseCommit}:${key}`, value)}`;
    },
  };
}
