import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFileSync as defaultReadFileSync, realpathSync as defaultRealpathSync } from 'node:fs';

export const COMPONENTS = Object.freeze(['web', 'api', 'runtimeWorker', 'acs']);
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/iu;
const COLOR_PATTERN = /^(blue|green)$/u;
const MAX_OBSERVATION_AGE_MS = 5 * 60 * 1000;
const TOPOLOGY_ROLES = Object.freeze({
  api: { component: 'api', unitPrefix: 'agent-saas-server', readyfile: false },
  runtimeWorker: { component: 'runtimeWorker', unitPrefix: 'agent-saas-runtime-worker', readyfile: true },
});

export function isFullSha(value) { return typeof value === 'string' && FULL_SHA_PATTERN.test(value); }
export function isLocalFilePath(filePath) { return typeof filePath === 'string' && filePath.trim().length > 0 && !/^[a-z][a-z0-9+.-]*:/iu.test(filePath); }
function nonEmpty(value) { return typeof value === 'string' && value.trim().length > 0; }

function validateTopology(topology, reasons, now) {
  if (!topology || typeof topology !== 'object' || Array.isArray(topology)) {
    reasons.push('Production runtime identity topology must be an object.');
    return;
  }
  const observedAt = Date.parse(topology.observedAt ?? '');
  if (Number.isNaN(observedAt)) reasons.push('Production runtime identity topology must have an ISO observedAt timestamp.');
  else if (observedAt > now + 60_000 || now - observedAt > MAX_OBSERVATION_AGE_MS) reasons.push('Production runtime identity topology observation is stale or in the future.');
  for (const [role, contract] of Object.entries(TOPOLOGY_ROLES)) {
    const entry = topology[role];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      reasons.push(`Production runtime identity topology is missing ${role}.`);
      continue;
    }
    if (!COLOR_PATTERN.test(entry.activeColor ?? '')) reasons.push(`Production runtime identity topology ${role}.activeColor must be blue or green.`);
    const required = ['activeColorFile', 'unit', 'releaseSymlink', 'pidfile', ...(contract.readyfile ? ['readyfile'] : [])];
    for (const field of required) {
      if (!nonEmpty(entry[field])) reasons.push(`Production runtime identity topology ${role}.${field} is required.`);
      else if (field !== 'activeColorFile' && COLOR_PATTERN.test(entry.activeColor ?? '') && !entry[field].includes(entry.activeColor)) reasons.push(`Production runtime identity topology ${role}.${field} conflicts with activeColor.`);
    }
    if (entry.unit !== `${contract.unitPrefix}@${entry.activeColor}.service`) reasons.push(`Production runtime identity topology ${role}.unit does not match the deployed systemd template.`);
    const expectedPaths = role === 'api'
      ? { activeColorFile: '/etc/agent-saas/active-color', releaseSymlink: `/opt/agent-saas-app/color/${entry.activeColor}`, pidfile: `/run/agent-saas-server-${entry.activeColor}.pid` }
      : { activeColorFile: '/etc/agent-saas/runtime-worker-active-color', releaseSymlink: `/opt/agent-saas-app/worker/${entry.activeColor}`, pidfile: `/run/agent-saas-runtime-worker-${entry.activeColor}.pid`, readyfile: `/run/agent-saas-runtime-worker-${entry.activeColor}.ready` };
    for (const [field, expected] of Object.entries(expectedPaths)) {
      if (entry[field] !== expected) reasons.push(`Production runtime identity topology ${role}.${field} does not match the deployed path contract.`);
    }
    for (const field of ['activeColorFile', 'releaseSymlink', 'pidfile', ...(contract.readyfile ? ['readyfile'] : [])]) {
      if (typeof entry[field] === 'string' && !entry[field].startsWith('/')) reasons.push(`Production runtime identity topology ${role}.${field} must be an absolute path.`);
    }
  }
}

function observeTopology(identity, reasons, { readFileSync, realpathSync, execFileSync, processExists }) {
  for (const [role, contract] of Object.entries(TOPOLOGY_ROLES)) {
    const entry = identity.topology?.[role];
    if (!entry || typeof entry !== 'object') continue;
    let pid;
    try {
      const observedColor = String(readFileSync(entry.activeColorFile, 'utf8')).trim();
      if (observedColor !== entry.activeColor) reasons.push(`Production runtime identity topology ${role}.activeColor does not match its color file.`);
    } catch { reasons.push(`Unable to read production active-color file for ${role}.`); }
    try {
      const target = String(realpathSync(entry.releaseSymlink));
      if (!target.includes(identity.components?.[contract.component]?.gitSha ?? 'invalid')) reasons.push(`Production runtime identity topology ${role}.releaseSymlink target does not match component SHA.`);
    } catch { reasons.push(`Unable to resolve production release symlink for ${role}.`); }
    try {
      pid = Number.parseInt(String(readFileSync(entry.pidfile, 'utf8')).trim(), 10);
      if (!Number.isSafeInteger(pid) || pid <= 0 || !processExists(pid)) reasons.push(`Production runtime identity topology ${role}.pidfile does not identify a live process.`);
    } catch { reasons.push(`Unable to read production pidfile for ${role}.`); }
    try {
      const mainPid = Number.parseInt(String(execFileSync('systemctl', ['show', entry.unit, '--property', 'MainPID', '--value'], { encoding: 'utf8', stdio: 'pipe' })).trim(), 10);
      const controlGroup = String(execFileSync('systemctl', ['show', entry.unit, '--property', 'ControlGroup', '--value'], { encoding: 'utf8', stdio: 'pipe' })).trim();
      const pidCgroup = String(readFileSync(`/proc/${pid}/cgroup`, 'utf8'));
      if (!Number.isSafeInteger(mainPid) || mainPid <= 0 || !processExists(mainPid) || !controlGroup || !pidCgroup.includes(controlGroup)) reasons.push(`Production runtime identity topology ${role} pidfile is not bound to the systemd unit cgroup.`);
    } catch { reasons.push(`Unable to observe systemd process identity for ${role}.`); }
    if (contract.readyfile) {
      try {
        const readyPid = Number.parseInt(String(readFileSync(entry.readyfile, 'utf8')).trim(), 10);
        if (!Number.isSafeInteger(readyPid) || readyPid !== pid) reasons.push(`Production runtime identity topology ${role}.readyfile does not match its pidfile.`);
      } catch { reasons.push(`Unable to read production readyfile for ${role}.`); }
    }
  }
}

export function validateRuntimeIdentity(identity, options = {}) {
  const blockingReasons = [];
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return { ok: false, blockingReasons: ['Production runtime identity must be a JSON object.'] };
  if (identity.schemaVersion !== 1) blockingReasons.push('Production runtime identity schemaVersion must be 1.');
  if (identity.environment !== 'production') blockingReasons.push('Runtime identity environment must be "production".');
  if (!isFullSha(identity.gitSha)) blockingReasons.push('Production runtime identity gitSha must be a complete 40-character SHA.');
  if (!identity.components || typeof identity.components !== 'object' || Array.isArray(identity.components)) blockingReasons.push('Production runtime identity components must be an object.');
  else for (const component of COMPONENTS) {
    const entry = identity.components[component];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { blockingReasons.push(`Production runtime identity is missing component "${component}".`); continue; }
    if (!isFullSha(entry.gitSha)) blockingReasons.push(`Production runtime identity component "${component}" must have a complete gitSha.`);
    if (typeof entry.deployedAt !== 'string' || Number.isNaN(Date.parse(entry.deployedAt))) blockingReasons.push(`Production runtime identity component "${component}" must have an ISO deployedAt timestamp.`);
  }
  validateTopology(identity.topology, blockingReasons, options.now ?? Date.now());
  observeTopology(identity, blockingReasons, {
    readFileSync: options.topologyReadFileSync ?? defaultReadFileSync,
    realpathSync: options.topologyRealpathSync ?? defaultRealpathSync,
    execFileSync: options.topologyExecFileSync ?? defaultExecFileSync,
    processExists: options.topologyProcessExists ?? ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }),
  });
  return { ok: blockingReasons.length === 0, blockingReasons };
}

export function readRuntimeIdentity({ identityPath, readFileSync = defaultReadFileSync, ...validationOptions }) {
  if (!isLocalFilePath(identityPath)) return { ok: false, identity: null, blockingReasons: ['Runtime identity must be read from a local file path.'] };
  let identity;
  try { identity = JSON.parse(readFileSync(identityPath, 'utf8')); } catch (error) { return { ok: false, identity: null, blockingReasons: [`Unable to read production runtime identity JSON: ${error.message}`] }; }
  const validation = validateRuntimeIdentity(identity, validationOptions);
  return { ok: validation.ok, identity, blockingReasons: validation.blockingReasons };
}
