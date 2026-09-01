import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readdir, rm, stat, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import {
  assertSafeOperationalSurface,
  parseMobileTelemetryBatch,
  type MobileTelemetryBatch,
  type MobileTelemetryEvent,
} from '@agent/shared';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MobileTelemetry');
export const MOBILE_TELEMETRY_MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface MobileTelemetryStore {
  write(input: { tenantId: string; userId: string; batch: MobileTelemetryBatch }): Promise<string>;
  prune?(retentionDays: number): Promise<void>;
}

export interface MobileTelemetryProviderAdapter {
  publish(events: readonly MobileTelemetryEvent[]): Promise<void>;
}

export interface MobileTelemetryRouterOptions {
  store: MobileTelemetryStore;
  pseudonymKey?: string;
  signingKey?: string;
  retentionDays: number;
  sampleRate?: number;
  rateLimitPerMinute?: number;
  provider?: MobileTelemetryProviderAdapter;
  providerFacts?: {
    kind?: string;
    owner?: string;
    dashboardId?: string;
    alertPolicyId?: string;
    dsnSecretReference?: string;
    release?: string;
  };
  now?: () => number;
}

function hashIdentity(key: string, release: string, value: string): string {
  return `h1:${createHmac('sha256', `${release}:${key}`).update(value).digest('hex')}`;
}

function signatureFor(key: string, body: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify(body)).digest('hex');
}

function sameSignature(expected: string, received: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

function sampled(batchId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  const bucket = createHash('sha256').update(batchId).digest().readUInt32BE(0) / 0xffffffff;
  return bucket < sampleRate;
}

export function createMobileTelemetryRouter(options: MobileTelemetryRouterOptions): Router {
  const router = Router();
  const now = options.now ?? Date.now;
  const seenNonces = new Map<string, number>();
  const receipts = new Map<string, string>();
  const rates = new Map<string, { minute: number; count: number }>();

  router.get('/mobile/telemetry/health', (req, res) => {
    if (!req.user) return void res.status(401).json({ error: 'Authentication required' });
    const facts = options.providerFacts;
    const complete =
      !!facts &&
      Object.values(facts).every(
        (value) =>
          typeof value === 'string' && value.length >= 3 && value !== 'pending_external_approval',
      );
    if (!complete)
      return void res
        .status(503)
        .json({ status: 'blocked', code: 'TELEMETRY_PROVIDER_FACTS_MISSING' });
    return void res.json({
      status: 'ready',
      provider: facts.kind,
      owner: facts.owner,
      dashboardId: facts.dashboardId,
      alertPolicyId: facts.alertPolicyId,
      release: facts.release,
    });
  });

  router.post('/mobile/telemetry', async (req, res) => {
    const user = req.user;
    if (!user) return void res.status(401).json({ error: 'Authentication required' });
    if (
      !options.pseudonymKey ||
      options.pseudonymKey.length < 32 ||
      !options.signingKey ||
      options.signingKey.length < 32 ||
      !Number.isInteger(options.retentionDays) ||
      options.retentionDays < 1 ||
      options.retentionDays > 365 ||
      typeof options.sampleRate !== 'number' ||
      !Number.isFinite(options.sampleRate) ||
      options.sampleRate < 0 ||
      options.sampleRate > 1 ||
      !Number.isInteger(options.rateLimitPerMinute) ||
      options.rateLimitPerMinute! < 1
    ) {
      return void res
        .status(503)
        .json({ error: 'Telemetry intake is not configured', code: 'TELEMETRY_CONFIG_MISSING' });
    }
    const rawBytes = Buffer.byteLength(JSON.stringify(req.body ?? {}));
    if (rawBytes > MOBILE_TELEMETRY_MAX_BODY_BYTES)
      return void res.status(413).json({ error: 'Telemetry body too large' });
    let batch: MobileTelemetryBatch;
    try {
      batch = parseMobileTelemetryBatch(req.body);
    } catch {
      return void res.status(400).json({ error: 'Invalid telemetry schema' });
    }

    const releaseHeader = req.header('X-Telemetry-Release');
    if (releaseHeader !== batch.release.commit)
      return void res.status(400).json({ error: 'Release mismatch' });
    const signature = req.header('X-Telemetry-Signature')?.replace(/^v1=/, '') ?? '';
    if (!sameSignature(signatureFor(options.signingKey, req.body), signature)) {
      return void res.status(401).json({ error: 'Invalid telemetry signature' });
    }
    const idempotencyKey = req.header('Idempotency-Key');
    if (idempotencyKey !== batch.batchId)
      return void res.status(400).json({ error: 'Idempotency mismatch' });
    const expectedOwner = {
      tenantId: hashIdentity(options.pseudonymKey, batch.release.commit, user.tenantId),
      userId: hashIdentity(options.pseudonymKey, batch.release.commit, user.sub),
    };
    if (
      batch.owner.tenantId !== expectedOwner.tenantId ||
      batch.owner.userId !== expectedOwner.userId
    ) {
      return void res.status(403).json({ error: 'Telemetry owner mismatch' });
    }
    const sentAt = Date.parse(batch.sentAt);
    if (!Number.isFinite(sentAt) || Math.abs(now() - sentAt) > MAX_CLOCK_SKEW_MS) {
      return void res.status(400).json({ error: 'Telemetry timestamp outside replay window' });
    }
    const existing = receipts.get(batch.batchId);
    if (existing)
      return void res.status(200).json({ accepted: true, duplicate: true, receiptId: existing });
    const nonceKey = `${user.tenantId}:${user.sub}:${batch.nonce}`;
    if (seenNonces.has(nonceKey))
      return void res.status(409).json({ error: 'Telemetry replay rejected' });

    const minute = Math.floor(now() / 60_000);
    const rateKey = `${user.tenantId}:${user.sub}`;
    const rate = rates.get(rateKey);
    const current = !rate || rate.minute !== minute ? { minute, count: 0 } : rate;
    current.count += 1;
    rates.set(rateKey, current);
    if (current.count > options.rateLimitPerMinute!)
      return void res.status(429).json({ error: 'Telemetry rate limit exceeded' });
    seenNonces.set(nonceKey, now());
    for (const [key, timestamp] of seenNonces)
      if (now() - timestamp > MAX_CLOCK_SKEW_MS) seenNonces.delete(key);

    if (!sampled(batch.batchId, options.sampleRate!)) {
      const receiptId = `sampled:${batch.batchId}`;
      receipts.set(batch.batchId, receiptId);
      return void res.status(202).json({ accepted: true, sampled: false, receiptId });
    }
    try {
      const receiptId = await options.store.write({
        tenantId: user.tenantId,
        userId: user.sub,
        batch,
      });
      receipts.set(batch.batchId, receiptId);
      void options.store.prune?.(options.retentionDays).catch(() => undefined);
      // Adapter degradation never changes first-party acceptance or any business endpoint.
      void options.provider?.publish(batch.events).catch(() => {
        logger.warn(
          `event=provider_delivery correlation=${batch.events[0]?.correlation.correlationId ?? 'none'} status=failed`,
        );
      });
      for (const event of batch.events) {
        const logFields = {
          kind: event.kind,
          correlation: event.correlation.correlationId,
          status: 'accepted',
        };
        assertSafeOperationalSurface('log', logFields);
        logger.info(
          `event=${logFields.kind} correlation=${logFields.correlation} status=${logFields.status}`,
        );
      }
      return void res.status(202).json({ accepted: true, receiptId });
    } catch {
      logger.warn(
        `event=intake correlation=${batch.events[0]?.correlation.correlationId ?? 'none'} status=store_failed`,
      );
      return void res.status(503).json({ error: 'Telemetry store unavailable' });
    }
  });

  return router;
}

export class FileMobileTelemetryStore implements MobileTelemetryStore {
  constructor(private readonly root: string) {}

  async write(input: {
    tenantId: string;
    userId: string;
    batch: MobileTelemetryBatch;
  }): Promise<string> {
    const owner = createHash('sha256').update(`${input.tenantId}:${input.userId}`).digest('hex');
    const directory = join(this.root, owner);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${input.batch.release.commit}.jsonl`);
    await appendFile(path, `${JSON.stringify(input.batch)}\n`, { encoding: 'utf8', mode: 0o600 });
    return `first-party:${input.batch.batchId}`;
  }

  async prune(retentionDays: number): Promise<void> {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) return;
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const owners = await readdir(this.root, { withFileTypes: true }).catch(() => []);
    for (const owner of owners) {
      if (!owner.isDirectory()) continue;
      const directory = join(this.root, owner.name);
      const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const file of files) {
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const path = join(directory, file.name);
        if ((await stat(path)).mtimeMs < cutoff) await rm(path, { force: true });
      }
    }
  }
}

export function configuredMobileTelemetryRouter(dataRoot: string): Router {
  const retentionDays = Number(process.env.MOBILE_TELEMETRY_RETENTION_DAYS);
  return createMobileTelemetryRouter({
    store: new FileMobileTelemetryStore(join(dataRoot, 'mobile-telemetry')),
    pseudonymKey: process.env.MOBILE_TELEMETRY_PSEUDONYM_KEY,
    signingKey: process.env.MOBILE_TELEMETRY_INTAKE_SIGNING_KEY,
    retentionDays,
    sampleRate: Number(process.env.MOBILE_TELEMETRY_SAMPLE_RATE),
    rateLimitPerMinute: Number(process.env.MOBILE_TELEMETRY_RATE_LIMIT_PER_MINUTE),
    providerFacts: {
      kind: process.env.MOBILE_TELEMETRY_PROVIDER_KIND,
      owner: process.env.MOBILE_TELEMETRY_OWNER,
      dashboardId: process.env.MOBILE_TELEMETRY_DASHBOARD_ID,
      alertPolicyId: process.env.MOBILE_TELEMETRY_ALERT_POLICY_ID,
      dsnSecretReference: process.env.MOBILE_TELEMETRY_DSN_SECRET_REFERENCE,
      release: process.env.MOBILE_RELEASE_COMMIT,
    },
  });
}
