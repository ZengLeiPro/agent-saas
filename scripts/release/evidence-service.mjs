#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { canonicalJson, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';
import { validateReleaseEvidenceDocument } from './release-evidence-schema.mjs';
import { evaluateObservationSamples } from './observe-production.mjs';
import { assertIsolationEvidence } from '../staging/assert-isolation.mjs';

const RELEASE_ID_PATTERN = /^rc-\d{8}-\d{2,}$/u;
const MAX_BODY_BYTES = 1024 * 1024;

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(`${JSON.stringify(body)}\n`);
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('Evidence body exceeds 1 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function writeImmutable(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true });
  const content = `${canonicalJson(value)}\n`;
  try {
    await writeFile(path, content, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST' || (await readFile(path, 'utf8')) !== content) throw error;
  }
}

export function validateReleaseEvidence(value, expectedSha) {
  if (!SHA_PATTERN.test(expectedSha ?? ''))
    throw new Error('Release evidence is not bound to the requested complete SHA');
  return validateReleaseEvidenceDocument(value, { expectedSha });
}

export function validateObservationSample(value, releaseId, manifestDigest, now = Date.now()) {
  const collectedAt = new Date(now).toISOString();
  const sample = { ...value, collectedAt };
  const evaluation = evaluateObservationSamples([sample], releaseId, manifestDigest, {
    requiredDurationMs: 0,
    maxSampleClockSkewMs: 60_000,
  });
  if (!evaluation.ok) throw new Error(evaluation.blockingReasons.join('; '));
  return value;
}

async function latestJson(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  if (!names.length) throw Object.assign(new Error('Evidence not found'), { code: 'ENOENT' });
  return JSON.parse(await readFile(join(directory, names.at(-1)), 'utf8'));
}

export function createEvidenceService({ root, readToken, writeToken, now = () => Date.now() }) {
  if (!readToken || readToken.length < 32 || !writeToken || writeToken.length < 32)
    throw new Error('Evidence service read/write tokens must each contain 32+ characters');
  if (safeEqual(readToken, writeToken))
    throw new Error('Evidence service read and write identities must be separate');
  const dataRoot = resolve(root);
  return createServer(async (req, res) => {
    try {
      const authorization = String(req.headers.authorization ?? '');
      const method = req.method ?? 'GET';
      const expectedToken = method === 'POST' ? writeToken : readToken;
      if (
        !authorization.startsWith('Bearer ') ||
        !safeEqual(authorization.slice(7), expectedToken)
      ) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      const url = new URL(req.url ?? '/', 'http://evidence.local');
      if (url.pathname === '/release-evidence') {
        const sha = url.searchParams.get('sha') ?? '';
        if (!SHA_PATTERN.test(sha)) throw new Error('sha must be a complete lowercase SHA');
        const path = join(dataRoot, 'release', `${sha}.json`);
        if (method === 'POST') {
          const value = validateReleaseEvidence(await readBody(req), sha);
          await writeImmutable(path, value);
          json(res, 201, value);
          return;
        }
        if (method === 'GET') {
          json(res, 200, validateReleaseEvidence(JSON.parse(await readFile(path, 'utf8')), sha));
          return;
        }
      }
      if (url.pathname === '/staging-isolation') {
        const releaseId = url.searchParams.get('releaseId') ?? '';
        if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error('releaseId is invalid');
        const directory = join(dataRoot, 'staging-isolation', releaseId);
        if (method === 'POST') {
          const value = await readBody(req);
          const summary = assertIsolationEvidence(value, { now: now() });
          const filename = `${String(now()).padStart(16, '0')}-${summary.evidenceDigest.slice(7, 23)}.json`;
          await writeImmutable(join(directory, filename), value);
          json(res, 201, value);
          return;
        }
        if (method === 'GET') {
          const value = await latestJson(directory);
          assertIsolationEvidence(value, { now: now() });
          json(res, 200, value);
          return;
        }
      }
      if (url.pathname === '/production-observation') {
        const releaseId = url.searchParams.get('releaseId') ?? '';
        const manifestDigest = url.searchParams.get('manifestDigest') ?? '';
        if (!RELEASE_ID_PATTERN.test(releaseId) || !DIGEST_PATTERN.test(manifestDigest))
          throw new Error('Production observation identity is invalid');
        const directory = join(
          dataRoot,
          'production-observation',
          releaseId,
          manifestDigest.slice(7),
        );
        if (method === 'POST') {
          const value = validateObservationSample(
            await readBody(req),
            releaseId,
            manifestDigest,
            now(),
          );
          const content = `${canonicalJson(value)}\n`;
          const filename = `${String(now()).padStart(16, '0')}-${createHash('sha256').update(content).digest('hex').slice(0, 16)}.json`;
          await writeImmutable(join(directory, filename), value);
          json(res, 201, value);
          return;
        }
        if (method === 'GET') {
          const value = await latestJson(directory);
          validateObservationSample(value, releaseId, manifestDigest, now());
          json(res, 200, value);
          return;
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (error) {
      const status =
        error?.code === 'ENOENT'
          ? 404
          : /invalid|required|incomplete|bound|fresh|cover|check|rate|execution/u.test(
                String(error?.message),
              )
            ? 400
            : 500;
      json(res, status, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.env.RELEASE_EVIDENCE_ROOT;
  const readTokenFile = process.env.RELEASE_EVIDENCE_READ_TOKEN_FILE;
  const writeTokenFile = process.env.RELEASE_EVIDENCE_WRITE_TOKEN_FILE;
  const host = process.env.RELEASE_EVIDENCE_HOST ?? '127.0.0.1';
  const port = Number(process.env.RELEASE_EVIDENCE_PORT ?? 3420);
  if (
    !root ||
    !readTokenFile ||
    !writeTokenFile ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  )
    throw new Error(
      'Evidence root, separate read/write token files, and a valid port are required',
    );
  const [readToken, writeToken] = await Promise.all([
    readFile(readTokenFile, 'utf8').then((value) => value.trim()),
    readFile(writeTokenFile, 'utf8').then((value) => value.trim()),
  ]);
  createEvidenceService({ root, readToken, writeToken }).listen(port, host, () => {
    process.stdout.write(`release evidence service listening on ${host}:${port}\n`);
  });
}
