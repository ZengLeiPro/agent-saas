import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFileSync as defaultReadFileSync, realpathSync as defaultRealpathSync } from 'node:fs';

export const COMPONENTS = Object.freeze(['web', 'api', 'runtimeWorker', 'acs']);
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const COLOR_PATTERN = /^(blue|green)$/u;
const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000;

export function isFullSha(value) {
  return typeof value === 'string' && FULL_SHA_PATTERN.test(value);
}
export function isLocalFilePath(filePath) {
  return (
    typeof filePath === 'string' &&
    filePath.trim().length > 0 &&
    !/^[a-z][a-z0-9+.-]*:/iu.test(filePath)
  );
}
function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateTopology(topology, reasons, now) {
  if (!topology || typeof topology !== 'object' || Array.isArray(topology)) {
    reasons.push('Production runtime identity topology must be an object.');
    return;
  }
  if (!COLOR_PATTERN.test(topology.activeColor ?? ''))
    reasons.push('Production runtime identity topology activeColor must be blue or green.');
  const observedAt = Date.parse(topology.observedAt ?? '');
  if (Number.isNaN(observedAt))
    reasons.push('Production runtime identity topology must have an ISO observedAt timestamp.');
  else if (observedAt > now + 60_000 || now - observedAt > MAX_OBSERVATION_AGE_MS)
    reasons.push('Production runtime identity topology observation is stale or in the future.');
  for (const role of ['api', 'runtimeWorker']) {
    const entry = topology[role];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      reasons.push(`Production runtime identity topology is missing ${role}.`);
      continue;
    }
    for (const field of ['unit', 'releaseSymlink', 'pidfile', 'readyfile']) {
      if (!nonEmpty(entry[field]))
        reasons.push(`Production runtime identity topology ${role}.${field} is required.`);
      else if (
        COLOR_PATTERN.test(topology.activeColor ?? '') &&
        !entry[field].includes(topology.activeColor)
      )
        reasons.push(
          `Production runtime identity topology ${role}.${field} conflicts with activeColor.`,
        );
    }
    if (!/^[A-Za-z0-9_.-]+@(blue|green)\.service$/u.test(entry.unit ?? ''))
      reasons.push(
        `Production runtime identity topology ${role}.unit must be a colored systemd unit.`,
      );
    for (const field of ['releaseSymlink', 'pidfile', 'readyfile']) {
      if (typeof entry[field] === 'string' && !entry[field].startsWith('/'))
        reasons.push(
          `Production runtime identity topology ${role}.${field} must be an absolute path.`,
        );
    }
  }
}

function observeTopology(
  identity,
  reasons,
  { readFileSync, realpathSync, execFileSync, processExists },
) {
  const topology = identity.topology;
  if (!topology || typeof topology !== 'object') return;
  for (const [role, component] of [
    ['api', 'api'],
    ['runtimeWorker', 'runtimeWorker'],
  ]) {
    const entry = topology[role];
    if (!entry || typeof entry !== 'object') continue;
    try {
      const active = String(
        execFileSync('systemctl', ['is-active', entry.unit], { encoding: 'utf8', stdio: 'pipe' }),
      ).trim();
      if (active !== 'active')
        reasons.push(`Production runtime identity topology ${role}.unit is not active.`);
    } catch {
      reasons.push(`Unable to observe active systemd unit for ${role}.`);
    }
    try {
      const target = String(realpathSync(entry.releaseSymlink));
      if (!target.includes(identity.components?.[component]?.gitSha ?? 'invalid'))
        reasons.push(
          `Production runtime identity topology ${role}.releaseSymlink target does not match component SHA.`,
        );
    } catch {
      reasons.push(`Unable to resolve production release symlink for ${role}.`);
    }
    try {
      const pid = Number.parseInt(String(readFileSync(entry.pidfile, 'utf8')).trim(), 10);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !processExists(pid))
        reasons.push(
          `Production runtime identity topology ${role}.pidfile does not identify a live process.`,
        );
    } catch {
      reasons.push(`Unable to read production pidfile for ${role}.`);
    }
    try {
      const ready = String(readFileSync(entry.readyfile, 'utf8')).trim();
      if (!ready.includes(identity.components?.[component]?.gitSha ?? 'invalid'))
        reasons.push(
          `Production runtime identity topology ${role}.readyfile does not match component SHA.`,
        );
    } catch {
      reasons.push(`Unable to read production readyfile for ${role}.`);
    }
  }
}

export function validateRuntimeIdentity(identity, options = {}) {
  const blockingReasons = [];
  if (!identity || typeof identity !== 'object' || Array.isArray(identity))
    return { ok: false, blockingReasons: ['Production runtime identity must be a JSON object.'] };
  if (identity.schemaVersion !== 1)
    blockingReasons.push('Production runtime identity schemaVersion must be 1.');
  if (identity.environment !== 'production')
    blockingReasons.push('Runtime identity environment must be "production".');
  if (!isFullSha(identity.gitSha))
    blockingReasons.push('Production runtime identity gitSha must be a complete 40-character SHA.');
  if (!Number.isSafeInteger(identity.configSchemaVersion) || identity.configSchemaVersion <= 0)
    blockingReasons.push(
      'Production runtime identity configSchemaVersion must be a positive integer.',
    );
  if (!DIGEST_PATTERN.test(identity.configFingerprint ?? ''))
    blockingReasons.push('Production runtime identity configFingerprint must be a SHA-256 digest.');
  if (
    !identity.components ||
    typeof identity.components !== 'object' ||
    Array.isArray(identity.components)
  ) {
    blockingReasons.push('Production runtime identity components must be an object.');
  } else {
    for (const component of COMPONENTS) {
      const entry = identity.components[component];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        blockingReasons.push(`Production runtime identity is missing component "${component}".`);
        continue;
      }
      if (!isFullSha(entry.gitSha))
        blockingReasons.push(
          `Production runtime identity component "${component}" must have a complete gitSha.`,
        );
      if (typeof entry.deployedAt !== 'string' || Number.isNaN(Date.parse(entry.deployedAt)))
        blockingReasons.push(
          `Production runtime identity component "${component}" must have an ISO deployedAt timestamp.`,
        );
      if (component === 'acs') {
        if (!DIGEST_PATTERN.test(entry.orchestratorArtifactDigest ?? ''))
          blockingReasons.push(
            'Production ACS identity must have an Orchestrator artifact digest.',
          );
        if (!DIGEST_PATTERN.test(entry.sandboxImageDigest ?? ''))
          blockingReasons.push('Production ACS identity must have a Sandbox image digest.');
      } else if (!DIGEST_PATTERN.test(entry.artifactDigest ?? '')) {
        blockingReasons.push(
          `Production runtime identity component "${component}" must have an artifact digest.`,
        );
      }
    }
  }
  const now = options.now ?? Date.now();
  validateTopology(identity.topology, blockingReasons, now);
  observeTopology(identity, blockingReasons, {
    readFileSync: options.topologyReadFileSync ?? defaultReadFileSync,
    realpathSync: options.topologyRealpathSync ?? defaultRealpathSync,
    execFileSync: options.topologyExecFileSync ?? defaultExecFileSync,
    processExists:
      options.topologyProcessExists ??
      ((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }),
  });
  return { ok: blockingReasons.length === 0, blockingReasons };
}

export function readRuntimeIdentity({
  identityPath,
  readFileSync = defaultReadFileSync,
  ...validationOptions
}) {
  if (!isLocalFilePath(identityPath))
    return {
      ok: false,
      identity: null,
      blockingReasons: ['Runtime identity must be read from a local file path.'],
    };
  let identity;
  try {
    identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      identity: null,
      blockingReasons: [`Unable to read production runtime identity JSON: ${error.message}`],
    };
  }
  const validation = validateRuntimeIdentity(identity, { readFileSync, ...validationOptions });
  return { ok: validation.ok, identity, blockingReasons: validation.blockingReasons };
}
