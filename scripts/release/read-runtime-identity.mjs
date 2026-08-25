import { readFileSync as defaultReadFileSync } from 'node:fs';

export const COMPONENTS = Object.freeze(['web', 'api', 'runtimeWorker', 'acs']);
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const COLOR_PATTERN = /^(blue|green)$/u;

export function isFullSha(value) { return typeof value === 'string' && FULL_SHA_PATTERN.test(value); }
export function isLocalFilePath(filePath) { return typeof filePath === 'string' && filePath.trim().length > 0 && !/^[a-z][a-z0-9+.-]*:/iu.test(filePath); }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }

function validateTopology(topology, reasons) {
  if (!topology || typeof topology !== 'object' || Array.isArray(topology)) {
    reasons.push('Production runtime identity topology must be an object.');
    return;
  }
  if (!COLOR_PATTERN.test(topology.activeColor ?? '')) reasons.push('Production runtime identity topology activeColor must be blue or green.');
  if (typeof topology.observedAt !== 'string' || Number.isNaN(Date.parse(topology.observedAt))) reasons.push('Production runtime identity topology must have an ISO observedAt timestamp.');
  for (const role of ['api', 'runtimeWorker']) {
    const entry = topology[role];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      reasons.push(`Production runtime identity topology is missing ${role}.`);
      continue;
    }
    for (const field of ['unit', 'releaseSymlink', 'pidfile', 'readyfile']) {
      if (!nonEmpty(entry[field])) reasons.push(`Production runtime identity topology ${role}.${field} is required.`);
      else if (COLOR_PATTERN.test(topology.activeColor ?? '') && !entry[field].includes(topology.activeColor)) reasons.push(`Production runtime identity topology ${role}.${field} conflicts with activeColor.`);
    }
  }
}

export function validateRuntimeIdentity(identity) {
  const blockingReasons = [];
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return { ok: false, blockingReasons: ['Production runtime identity must be a JSON object.'] };
  if (identity.schemaVersion !== 1) blockingReasons.push('Production runtime identity schemaVersion must be 1.');
  if (identity.environment !== 'production') blockingReasons.push('Runtime identity environment must be "production".');
  if (!isFullSha(identity.gitSha)) blockingReasons.push('Production runtime identity gitSha must be a complete 40-character SHA.');
  if (!identity.components || typeof identity.components !== 'object' || Array.isArray(identity.components)) {
    blockingReasons.push('Production runtime identity components must be an object.');
  } else {
    for (const component of COMPONENTS) {
      const entry = identity.components[component];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { blockingReasons.push(`Production runtime identity is missing component "${component}".`); continue; }
      if (!isFullSha(entry.gitSha)) blockingReasons.push(`Production runtime identity component "${component}" must have a complete gitSha.`);
      if (typeof entry.deployedAt !== 'string' || Number.isNaN(Date.parse(entry.deployedAt))) blockingReasons.push(`Production runtime identity component "${component}" must have an ISO deployedAt timestamp.`);
    }
  }
  validateTopology(identity.topology, blockingReasons);
  return { ok: blockingReasons.length === 0, blockingReasons };
}

export function readRuntimeIdentity({ identityPath, readFileSync = defaultReadFileSync }) {
  if (!isLocalFilePath(identityPath)) return { ok: false, identity: null, blockingReasons: ['Runtime identity must be read from a local file path.'] };
  let identity;
  try { identity = JSON.parse(readFileSync(identityPath, 'utf8')); } catch (error) { return { ok: false, identity: null, blockingReasons: [`Unable to read production runtime identity JSON: ${error.message}`] }; }
  const validation = validateRuntimeIdentity(identity);
  return { ok: validation.ok, identity, blockingReasons: validation.blockingReasons };
}
