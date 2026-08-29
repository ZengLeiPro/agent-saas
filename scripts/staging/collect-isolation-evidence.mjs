#!/usr/bin/env node
import OSS from 'ali-oss';
import { readFile, writeFile } from 'node:fs/promises';
import { digestBuffer, canonicalJson } from '../release/artifact-lib.mjs';

const RELEASE_ID_PATTERN = /^rc-\d{8}-\d{2,}$/u;

function options(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    output[key.slice(2)] = value;
  }
  return output;
}

function ossProbe(observed, observedAt) {
  return {
    id: 'oss-identity-cannot-write-production-bucket',
    status: 'denied',
    sourceEnvironment: 'staging',
    targetEnvironment: 'production',
    observed,
    observedAt,
    evidenceDigest: digestBuffer(Buffer.from(canonicalJson(observed))),
  };
}

export function assembleIsolationEvidence(hostEvidence, ossObserved) {
  if (
    hostEvidence?.schemaVersion !== 1 ||
    hostEvidence.environment !== 'staging' ||
    !RELEASE_ID_PATTERN.test(hostEvidence.releaseId ?? '') ||
    !Array.isArray(hostEvidence.probes) ||
    hostEvidence.probes.length !== 6
  ) {
    throw new Error('Host isolation evidence is incomplete');
  }
  return {
    schemaVersion: 1,
    environment: 'staging',
    releaseId: hostEvidence.releaseId,
    manifestDigest: hostEvidence.manifestDigest,
    probes: [
      hostEvidence.probes[0],
      ossProbe(ossObserved, hostEvidence.observedAt),
      ...hostEvidence.probes.slice(1),
    ],
  };
}

async function verifyProductionOssWriteDenied(resourcePlan, credentials) {
  const targets = resourcePlan.resources?.isolationTargets;
  if (!targets) throw new Error('Production OSS isolation target is missing');
  const sentinel = await fetch(targets.productionWebSentinelUrl, {
    method: 'HEAD',
    signal: AbortSignal.timeout(10_000),
  });
  if (!sentinel.ok) throw new Error(`Production OSS sentinel is unavailable: ${sentinel.status}`);
  const client = new OSS({
    region: `oss-${resourcePlan.region}`,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    bucket: targets.productionWebBucket,
    secure: true,
    timeout: 10_000,
  });
  try {
    await client.put(targets.productionWebSentinelKey, Buffer.alloc(0), {
      headers: { 'x-oss-forbid-overwrite': 'true' },
    });
  } catch (error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.res?.status);
    const code = String(error?.code ?? '');
    if (status !== 403 || !/AccessDenied/u.test(code)) {
      throw new Error(`Production OSS write was not denied by authorization: ${status}/${code}`);
    }
    return {
      bucket: targets.productionWebBucket,
      sentinelKey: targets.productionWebSentinelKey,
      sentinelExists: true,
      forbidOverwrite: true,
      responseStatus: status,
      responseCode: code,
    };
  }
  throw new Error('Staging OSS identity unexpectedly wrote to the Production bucket');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = options(process.argv);
  if (
    !RELEASE_ID_PATTERN.test(args['release-id'] ?? '') ||
    !args['resource-plan'] ||
    !args['host-evidence'] ||
    !args.output
  ) {
    throw new Error('release-id, resource-plan, host-evidence and output are required');
  }
  const [resourcePlan, hostEvidence, credentials] = await Promise.all([
    readFile(args['resource-plan'], 'utf8').then(JSON.parse),
    readFile(args['host-evidence'], 'utf8').then(JSON.parse),
    readFile(0, 'utf8').then(JSON.parse),
  ]);
  if (!credentials.accessKeyId || !credentials.accessKeySecret) {
    throw new Error('Staging OSS credentials are required on standard input');
  }
  if (hostEvidence.releaseId !== args['release-id']) {
    throw new Error('Host isolation evidence belongs to another release');
  }
  const evidence = assembleIsolationEvidence(
    hostEvidence,
    await verifyProductionOssWriteDenied(resourcePlan, credentials),
  );
  await writeFile(args.output, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(
    `${JSON.stringify({ releaseId: evidence.releaseId, probeCount: evidence.probes.length })}\n`,
  );
}
