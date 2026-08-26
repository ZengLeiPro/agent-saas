#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';

function read(path) {
  return readFileSync(path, 'utf8').trim();
}

function unitMainPid(unit) {
  const value = execFileSync('systemctl', ['show', unit, '--property', 'MainPID', '--value'], {
    encoding: 'utf8',
  }).trim();
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error(`${unit} does not have a live MainPID`);
  return pid;
}

export function buildProductionIdentity(manifest, topology, observedAt, previousIdentity) {
  const deployedAt = (component) => {
    if (manifest.components[component].action === 'deploy') return observedAt;
    const previous = previousIdentity?.components?.[component]?.deployedAt;
    if (typeof previous !== 'string')
      throw new Error(`Kept component ${component} is missing its previous deployment time`);
    return previous;
  };
  return {
    schemaVersion: 1,
    environment: 'production',
    gitSha: manifest.components.api.sourceSha,
    configSchemaVersion: 1,
    configFingerprint: manifest.digest,
    components: {
      web: {
        gitSha: manifest.components.web.sourceSha,
        artifactDigest: manifest.components.web.artifactDigest,
        deployedAt: deployedAt('web'),
      },
      api: {
        gitSha: manifest.components.api.sourceSha,
        artifactDigest: manifest.components.api.artifactDigest,
        deployedAt: deployedAt('api'),
      },
      runtimeWorker: {
        gitSha: manifest.components.runtimeWorker.sourceSha,
        artifactDigest: manifest.components.runtimeWorker.artifactDigest,
        deployedAt: deployedAt('runtimeWorker'),
      },
      acs: {
        gitSha: manifest.components.acs.sourceSha,
        orchestratorArtifactDigest: manifest.components.acs.orchestratorArtifactDigest,
        sandboxImageDigest: manifest.components.acs.sandboxImageDigest,
        deployedAt: deployedAt('acs'),
      },
    },
    topology: { observedAt, ...topology },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestPath, outputPath = '/etc/agent-saas/runtime-identity.json'] =
    process.argv.slice(2);
  if (!manifestPath)
    throw new Error('usage: write-production-identity.mjs <manifest.json> [output]');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const apiColor = read('/etc/agent-saas/active-color');
  const workerColor = read('/etc/agent-saas/runtime-worker-active-color');
  if (!/^(blue|green)$/u.test(apiColor) || !/^(blue|green)$/u.test(workerColor))
    throw new Error('Production active colors are invalid');
  const apiUnit = `agent-saas-server@${apiColor}.service`;
  const workerUnit = `agent-saas-runtime-worker@${workerColor}.service`;
  const apiPidfile = `/run/agent-saas-server-${apiColor}.pid`;
  const workerPidfile = `/run/agent-saas-runtime-worker-${workerColor}.pid`;
  const workerReadyfile = `/run/agent-saas-runtime-worker-${workerColor}.ready`;
  if (Number(read(apiPidfile)) !== unitMainPid(apiUnit))
    throw new Error('API pidfile does not match systemd');
  if (
    Number(read(workerPidfile)) !== unitMainPid(workerUnit) ||
    read(workerPidfile) !== read(workerReadyfile)
  ) {
    throw new Error('Worker pidfile/readyfile does not match systemd');
  }
  const topology = {
    api: {
      activeColor: apiColor,
      activeColorFile: '/etc/agent-saas/active-color',
      unit: apiUnit,
      releaseSymlink: `/opt/agent-saas-app/color/${apiColor}`,
      releaseTarget: realpathSync(`/opt/agent-saas-app/color/${apiColor}`),
      pidfile: apiPidfile,
    },
    runtimeWorker: {
      activeColor: workerColor,
      activeColorFile: '/etc/agent-saas/runtime-worker-active-color',
      unit: workerUnit,
      releaseSymlink: `/opt/agent-saas-app/worker/${workerColor}`,
      releaseTarget: realpathSync(`/opt/agent-saas-app/worker/${workerColor}`),
      pidfile: workerPidfile,
      readyfile: workerReadyfile,
    },
  };
  const previousIdentity = existsSync(outputPath)
    ? JSON.parse(readFileSync(outputPath, 'utf8'))
    : undefined;
  const identity = buildProductionIdentity(
    manifest,
    topology,
    new Date().toISOString(),
    previousIdentity,
  );
  writeFileSync(`${outputPath}.candidate`, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o444,
  });
  renameSync(`${outputPath}.candidate`, outputPath);
  process.stdout.write(`${manifest.releaseId}\n`);
}
