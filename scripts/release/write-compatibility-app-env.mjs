#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';

const RELEASE_ID_PATTERN = /^rc-[0-9]{8}-[0-9]{2,}$/u;

export function buildCompatibilityAppEnvironment({ identity, releaseId, sourceSha, serverDigest }) {
  if (!RELEASE_ID_PATTERN.test(releaseId ?? '')) throw new Error('Release ID is invalid');
  if (!SHA_PATTERN.test(sourceSha ?? '')) throw new Error('Source SHA must be complete');
  if (!DIGEST_PATTERN.test(serverDigest ?? '')) throw new Error('Server digest is invalid');
  const webDigest = identity?.components?.web?.artifactDigest;
  const acsOrchestratorDigest = identity?.components?.acs?.orchestratorArtifactDigest;
  const acsSandboxImageDigest = identity?.components?.acs?.sandboxImageDigest;
  for (const [label, digest] of Object.entries({
    webDigest,
    acsOrchestratorDigest,
    acsSandboxImageDigest,
  })) {
    if (!DIGEST_PATTERN.test(digest ?? '')) throw new Error(`Current ${label} is invalid`);
  }
  return {
    AGENT_SAAS_RELEASE_ID: releaseId,
    AGENT_SAAS_RELEASE_SHA: sourceSha,
    AGENT_SAAS_SERVER_DIGEST: serverDigest,
    AGENT_SAAS_WEB_DIGEST: webDigest,
    AGENT_SAAS_ACS_ORCHESTRATOR_DIGEST: acsOrchestratorDigest,
    AGENT_SAAS_ACS_SANDBOX_IMAGE_DIGEST: acsSandboxImageDigest,
  };
}

function writeEnvironment(path, environment) {
  const body = `${Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')}\n`;
  writeFileSync(`${path}.candidate`, body, { mode: 0o600 });
  renameSync(`${path}.candidate`, path);
}

function parse(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    output[key.slice(2)] = value;
  }
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parse(process.argv);
  const required = [
    'identity',
    'api-output',
    'worker-output',
    'release-id',
    'sha',
    'server-digest',
  ];
  if (required.some((name) => !options[name])) {
    throw new Error(`Missing required option: ${required.find((name) => !options[name])}`);
  }
  const environment = buildCompatibilityAppEnvironment({
    identity: JSON.parse(readFileSync(options.identity, 'utf8')),
    releaseId: options['release-id'],
    sourceSha: options.sha,
    serverDigest: options['server-digest'],
  });
  writeEnvironment(options['api-output'], environment);
  writeEnvironment(options['worker-output'], environment);
  process.stdout.write(`${options['release-id']}\n`);
}
