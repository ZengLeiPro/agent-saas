#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

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

/**
 * TASK-318：从 active 色 API release env 读取部署期绑定的 expected config
 * identity。仅当 env 声明的 releaseId 与本次 Manifest 一致时才采用，防止把
 * 旧 release 的配置身份写进新的 trusted identity；env 不存在相关变量时
 * 返回 undefined（兼容旧发布，不阻断写入）。
 */
export function readExpectedConfigIdentityFromReleaseEnv(
  color,
  releaseId,
  options = {},
) {
  const values = readReleaseEnvironment(color, options);
  if (!values || values.AGENT_SAAS_RELEASE_ID !== releaseId) return undefined;
  return parseExpectedConfigIdentity(values);
}

function readReleaseEnvironment(
  color,
  { readFile = readFileSync, envPath = `/etc/agent-saas/server-${color}.release.env` } = {},
) {
  let env;
  try {
    env = readFile(envPath, 'utf8');
  } catch {
    return undefined;
  }
  return Object.fromEntries(
    env
      .split(/\r?\n/u)
      .filter((line) => line && line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1).trim()];
      }),
  );
}

function parseExpectedConfigIdentity(values) {
  const digest = values.AGENT_SAAS_CONFIG_IDENTITY_DIGEST;
  if (!digest) {
    if (
      values.AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION ||
      values.AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST
    ) {
      throw new Error('Release env carries config identity metadata without its digest');
    }
    return undefined;
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
    throw new Error('Release env carries a malformed config identity digest');
  const schemaVersion = Number(values.AGENT_SAAS_CONFIG_IDENTITY_SCHEMA_VERSION ?? '1');
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0)
    throw new Error('Release env carries a malformed config identity schema version');
  const credentialVersionDigest = values.AGENT_SAAS_CONFIG_IDENTITY_CREDENTIAL_VERSION_DIGEST;
  if (credentialVersionDigest && !/^sha256:[a-f0-9]{64}$/u.test(credentialVersionDigest)) {
    throw new Error('Release env carries a malformed config credential version digest');
  }
  return {
    schemaVersion,
    digest,
    ...(credentialVersionDigest ? { credentialVersionDigest } : {}),
  };
}

function validateTrustedExpectedConfigIdentity(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Trusted Production identity carries a malformed configIdentity');
  }
  const unknown = Object.keys(value).filter(
    (key) => !['schemaVersion', 'digest', 'credentialVersionDigest'].includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(`Trusted Production identity configIdentity has unknown fields: ${unknown.join(',')}`);
  }
  if (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion <= 0) {
    throw new Error('Trusted Production identity carries a malformed config identity schema version');
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.digest ?? '')) {
    throw new Error('Trusted Production identity carries a malformed config identity digest');
  }
  if (
    value.credentialVersionDigest !== undefined &&
    !/^sha256:[a-f0-9]{64}$/u.test(value.credentialVersionDigest)
  ) {
    throw new Error('Trusted Production identity carries a malformed config credential version digest');
  }
  return {
    schemaVersion: value.schemaVersion,
    digest: value.digest,
    ...(value.credentialVersionDigest
      ? { credentialVersionDigest: value.credentialVersionDigest }
      : {}),
  };
}

function readActiveReleaseManifest(activeReleaseTarget, options) {
  if (options.activeReleaseManifest) return options.activeReleaseManifest;
  const readManifest = options.readActiveReleaseManifest ?? readFileSync;
  try {
    const value = readManifest(join(activeReleaseTarget, 'manifest.json'), 'utf8');
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    throw new Error('Kept API active release manifest is unavailable or malformed');
  }
}

function assertKeptApiReleaseBinding(values, previousIdentity, activeReleaseTarget, options) {
  const activeManifest = readActiveReleaseManifest(activeReleaseTarget, options);
  const activeReleaseId = values.AGENT_SAAS_RELEASE_ID;
  if (!activeReleaseId || activeReleaseId !== activeManifest?.releaseId) {
    throw new Error('Kept API release env releaseId disagrees with active release manifest');
  }

  const normalizedTarget = activeReleaseTarget.replace(/\/+$/u, '');
  const targetName = basename(normalizedTarget);
  const releaseRoot = options.activeReleasesRoot ?? '/opt/agent-saas-app/releases';
  const targetDigest = dirname(normalizedTarget) === releaseRoot && /^[a-f0-9]{64}$/u.test(targetName)
    ? `sha256:${targetName}`
    : undefined;
  const envDigest = values.AGENT_SAAS_SERVER_DIGEST;
  const manifestDigest = activeManifest?.components?.api?.artifactDigest;
  const trustedDigest = previousIdentity?.components?.api?.artifactDigest;
  if (
    !targetDigest ||
    !/^sha256:[a-f0-9]{64}$/u.test(envDigest ?? '') ||
    envDigest !== targetDigest ||
    envDigest !== manifestDigest ||
    envDigest !== trustedDigest
  ) {
    throw new Error('Kept API server digest is not bound to the active release target');
  }
}

function sameExpectedConfigIdentity(left, right) {
  return left.schemaVersion === right.schemaVersion &&
    left.digest === right.digest &&
    left.credentialVersionDigest === right.credentialVersionDigest;
}

/**
 * API deploy 时绑定本次 release env；API keep 时从当前 active release env 与
 * 已落盘 trusted identity 双向交叉校验后继承，防止 Web/ACS-only promotion
 * 把 expected ConfigIdentity 静默清空。
 */
export function resolveExpectedConfigIdentityForProduction(
  manifest,
  color,
  previousIdentity,
  options = {},
) {
  const previous = validateTrustedExpectedConfigIdentity(previousIdentity?.configIdentity);
  if (manifest.components.api.action === 'deploy') {
    const deployed = readExpectedConfigIdentityFromReleaseEnv(
      color,
      manifest.releaseId,
      options,
    );
    if (previous && !deployed) {
      throw new Error('Deploying API would drop trusted expected configIdentity');
    }
    return deployed;
  }

  const values = readReleaseEnvironment(color, options);
  if (!values) throw new Error('Kept API active release environment is unavailable');
  const activeReleaseTarget = options.activeReleaseTarget
    ?? previousIdentity?.topology?.api?.releaseTarget;
  if (typeof activeReleaseTarget !== 'string' || !activeReleaseTarget) {
    throw new Error('Kept API active release target is unavailable');
  }
  assertKeptApiReleaseBinding(values, previousIdentity, activeReleaseTarget, options);
  const active = parseExpectedConfigIdentity(values);
  if (!previous && !active) return undefined;
  if (!previous || !active) {
    throw new Error('Kept API expected configIdentity is missing from one trusted source');
  }
  if (!sameExpectedConfigIdentity(previous, active)) {
    throw new Error('Kept API expected configIdentity disagrees across trusted sources');
  }
  return previous;
}


export function buildProductionIdentity(
  manifest,
  topology,
  observedAt,
  previousIdentity,
  expectedConfigIdentity,
) {
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
    // legacy 字段：语义不变（绑定 Manifest digest，不是配置身份）。
    configFingerprint: manifest.digest,
    // TASK-318：Release expected config identity（显式新增字段；由部署脚本
    // 在发布时计算并写入 release env，这里从 active 色 env 读取并固化）。
    ...(expectedConfigIdentity ? { configIdentity: expectedConfigIdentity } : {}),
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
    resolveExpectedConfigIdentityForProduction(manifest, apiColor, previousIdentity, {
      activeReleaseTarget: topology.api.releaseTarget,
    }),
  );
  writeFileSync(`${outputPath}.candidate`, `${JSON.stringify(identity, null, 2)}\n`, {
    mode: 0o444,
  });
  renameSync(`${outputPath}.candidate`, outputPath);
  process.stdout.write(`${manifest.releaseId}\n`);
}
