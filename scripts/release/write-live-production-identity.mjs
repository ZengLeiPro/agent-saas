#!/usr/bin/env node
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { canonicalJson, digestBuffer, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';
import { validateRuntimeIdentity } from './read-runtime-identity.mjs';

function componentWithoutTime(value) {
  if (!value || typeof value !== 'object') return value;
  const { deployedAt: _deployedAt, ...rest } = value;
  return rest;
}

function withDeploymentTime(component, previous, observedAt) {
  const unchanged =
    previous && canonicalJson(componentWithoutTime(previous)) === canonicalJson(component);
  return { ...component, deployedAt: unchanged ? previous.deployedAt : observedAt };
}

export function buildLiveProductionIdentity({ live, previousIdentity, topology }) {
  if (live?.schemaVersion !== 1 || live.environment !== 'production') {
    throw new Error('Live Production observation is invalid');
  }
  const observedAt = live.observedAt;
  if (typeof observedAt !== 'string' || Number.isNaN(Date.parse(observedAt))) {
    throw new Error('Live Production observation time is invalid');
  }
  const components = live.components;
  if (!components || !SHA_PATTERN.test(components.api?.gitSha ?? '')) {
    throw new Error('Live Production component matrix is invalid');
  }
  const timedComponents = Object.fromEntries(
    Object.entries(components).map(([name, value]) => [
      name,
      withDeploymentTime(value, previousIdentity?.components?.[name], observedAt),
    ]),
  );
  return {
    schemaVersion: 1,
    environment: 'production',
    gitSha: components.api.gitSha,
    configSchemaVersion: 1,
    configFingerprint: digestBuffer(Buffer.from(canonicalJson(components))),
    components: timedComponents,
    topology: { observedAt, ...topology },
  };
}

export function topologyFromLive(live, { readFile = readFileSync, realpath = realpathSync } = {}) {
  const output = {};
  for (const [role, prefix, marker, directory] of [
    ['api', 'agent-saas-server', '/etc/agent-saas/active-color', 'color'],
    [
      'runtimeWorker',
      'agent-saas-runtime-worker',
      '/etc/agent-saas/runtime-worker-active-color',
      'worker',
    ],
  ]) {
    const color = String(readFile(marker, 'utf8')).trim();
    const observed = live.topology?.[role];
    if (!/^(blue|green)$/u.test(color) || observed?.color !== color) {
      throw new Error(`Live ${role} topology changed during observation`);
    }
    const releaseSymlink = `/opt/agent-saas-app/${directory}/${color}`;
    const releaseTarget = String(realpath(releaseSymlink));
    const component = live.components[role];
    if (!DIGEST_PATTERN.test(component?.artifactDigest ?? '')) {
      throw new Error(`Live ${role} artifact digest is invalid`);
    }
    const expectedTarget = `/opt/agent-saas-app/releases/${component.artifactDigest.slice(7)}`;
    if (releaseTarget !== expectedTarget) {
      throw new Error(`Live ${role} release target is not content-addressed`);
    }
    output[role] = {
      activeColor: color,
      activeColorFile: marker,
      unit: `${prefix}@${color}.service`,
      releaseSymlink,
      releaseTarget,
      pidfile: `/run/${prefix}-${color}.pid`,
      ...(role === 'runtimeWorker' ? { readyfile: `/run/${prefix}-${color}.ready` } : {}),
    };
  }
  return output;
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
  const input = options.input;
  const output = options.output ?? '/etc/agent-saas/runtime-identity.json';
  if (!input)
    throw new Error('usage: write-live-production-identity.mjs --input <path> [--output <path>]');
  const live = JSON.parse(readFileSync(input, 'utf8'));
  let previousIdentity;
  try {
    previousIdentity = JSON.parse(readFileSync(output, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const identity = buildLiveProductionIdentity({
    live,
    previousIdentity,
    topology: topologyFromLive(live),
  });
  const validation = validateRuntimeIdentity(identity);
  if (!validation.ok) throw new Error(validation.blockingReasons.join(' '));
  writeFileSync(`${output}.candidate`, `${canonicalJson(identity)}\n`, { mode: 0o444 });
  renameSync(`${output}.candidate`, output);
  process.stdout.write(`${identity.configFingerprint}\n`);
}
