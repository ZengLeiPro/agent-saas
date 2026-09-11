import { join } from 'node:path';
import { snapshotRecoveryTree, readSnapshotJson, sha256 } from './recovery-maintenance-files.mjs';

const hex = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const operation = (v) => typeof v === 'string' && /^[1-9]\d*-[1-9]\d*$/u.test(v);
export const validIdentity = (v) => v && /^rc-\d{8}-\d{2,}$/u.test(v.releaseId) &&
  /^sha256:[a-f0-9]{64}$/u.test(v.manifestDigest) &&
  /^[1-9]\d*$/u.test(v.runId) && /^[1-9]\d*$/u.test(v.runAttempt);
const identityEqual = (a, b) => validIdentity(a) && validIdentity(b) &&
  ['releaseId', 'manifestDigest', 'runId', 'runAttempt'].every((key) => a[key] === b[key]);
const recentTime = (v, now) => typeof v === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) &&
  Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v && Date.parse(v) <= now;
const count = (v) => Number.isSafeInteger(v) && v >= 0;
function validReceipt(v, digest) {
  return v?.schemaVersion === 1 && validIdentity(v.identity) && v.capsuleDigest === digest &&
    ['pending', 'committed', 'rolled_back'].includes(v.state);
}
function completeRetirement(target, observed, id, now) {
  const { targetDigest, ...body } = target ?? {};
  if (!hex(targetDigest) || targetDigest !== sha256(JSON.stringify(body)) ||
    target.schemaVersion !== 1 || !validIdentity(target) ||
    `${target.runId}-${target.runAttempt}` !== id || !recentTime(target.startedAt, now) ||
    observed?.schemaVersion !== 1 || !identityEqual(target, observed) ||
    observed.targetDigest !== targetDigest || !recentTime(observed.observedAt, now) ||
    Date.parse(observed.observedAt) < Date.parse(target.startedAt) ||
    observed.status !== 'acknowledged' || observed.retirementPhase !== 'completed' ||
    !Array.isArray(target.components) || !Array.isArray(observed.components) ||
    target.components.length !== 2 || observed.components.length !== 2) return false;
  return ['api', 'runtimeWorker'].every((role) => {
    const originals = target.components.filter((item) => item?.role === role);
    const observations = observed.components.filter((item) => item?.role === role);
    if (originals.length !== 1 || observations.length !== 1) return false;
    const a = originals[0], b = observations[0], proof = b.durable;
    return ['blue', 'green'].includes(a.color) && count(a.pid) && a.pid > 0 &&
      /^[a-f0-9]{32}$/u.test(a.invocationId) &&
      ['color', 'pid', 'invocationId'].every((key) => a[key] === b[key]) &&
      b.phase === 'completed' && b.acknowledged === true && proof?.verified === true &&
      ['total', 'terminal', 'suspended', 'new_owner', 'unverified'].every((key) => count(proof[key])) &&
      proof.unverified === 0 && proof.total === proof.terminal + proof.suspended + proof.new_owner;
  });
}

/** Summaries exclude capsule bodies, raw task IDs, tenants, paths and parser errors. */
export async function inventoryRecovery(root, { now = Date.now(), limits } = {}) {
  if (!Number.isFinite(now)) throw new Error('Invalid inventory clock');
  const snapshot = await snapshotRecoveryTree(root, limits);
  const issues = new Set(), records = [], known = new Set();
  const load = async (path) => {
    known.add(path);
    try { return await readSnapshotJson(root, snapshot, path); } catch { return null; }
  };
  const active = await load('web/active.json');
  const activeValid = hex(active?.capsuleDigest) && validReceipt(active, active.capsuleDigest);
  if (!activeValid) issues.add('active_reference_unverified');
  if (activeValid && active.state === 'pending') issues.add('pending_web_transaction');
  if (activeValid && !snapshot.files.some((file) => file.path === `web/${active.capsuleDigest}.json`))
    issues.add('active_capsule_missing');
  for (const file of snapshot.files) {
    const match = /^web\/([a-f0-9]{64})\.json$/u.exec(file.path);
    if (!match) continue;
    known.add(file.path);
    const digest = match[1], terminal = [];
    for (const state of ['committed', 'rolled_back']) {
      const path = `web/${digest}.${state}.json`;
      if (snapshot.files.some((item) => item.path === path)) terminal.push(await load(path));
    }
    const receipt = terminal[0];
    const valid = file.digest === digest && terminal.length === 1 && validReceipt(receipt, digest) &&
      receipt.state !== 'pending' && recentTime(receipt.verifiedAt, now) &&
      snapshot.files.some((item) => item.path === `web/${digest}.${receipt.state}.json`);
    const isActive = activeValid && active.capsuleDigest === digest;
    const identityMatchesActive = !isActive || (identityEqual(receipt?.identity, active.identity) &&
      receipt?.state === active.state);
    const state = valid && identityMatchesActive ? receipt.state : 'unverified';
    if (state === 'unverified') issues.add('web_terminal_proof_unverified');
    records.push({ kind: 'web', id: digest, releaseId: valid ? receipt.identity.releaseId : null,
      state, completedAt: valid ? receipt.verifiedAt : null, protected: isActive,
      bytes: file.bytes, digest: file.digest });
  }
  for (const directory of snapshot.directories) {
    const match = /^retirements\/([^/]+)$/u.exec(directory.path);
    if (!match) continue;
    if (!operation(match[1])) { issues.add('unknown_retirement_directory'); continue; }
    const id = match[1], prefix = directory.path;
    const target = await load(join(prefix, 'app-retirement-targets.json'));
    const observed = await load(join(prefix, 'app-retirement-observation.json'));
    const related = snapshot.files.filter((file) => file.path.startsWith(prefix + '/'));
    for (const file of related) {
      if (/\/(manifest|app-retirement-(targets|observation|private|alert))\.json$/u.test(file.path))
        known.add(file.path); // Private state is counted/hashed, NEVER parsed or exported.
    }
    const complete = completeRetirement(target, observed, id, now);
    if (!complete) issues.add('retirement_completion_unverified');
    records.push({ kind: 'retirement', id, releaseId: complete ? target.releaseId : null,
      state: complete ? 'completed' : 'unverified',
      completedAt: complete ? observed.observedAt : null, protected: !complete,
      lastObservedAt: recentTime(observed?.observedAt, now) ? observed.observedAt : null,
      bytes: related.reduce((sum, file) => sum + file.bytes, 0),
      digest: sha256(JSON.stringify(related.map(({ path, digest }) => ({ path, digest })))) });
  }
  if (snapshot.files.some((file) => !known.has(file.path))) issues.add('unclassified_files');
  if (snapshot.directories.some(({ path }) => path && !['web', 'retirements'].includes(path) &&
    !/^retirements\/[1-9]\d*-[1-9]\d*$/u.test(path))) issues.add('unclassified_directories');
  return { schemaVersion: 1, mode: 'read-only', observedAt: new Date(now).toISOString(),
    snapshotDigest: snapshot.digest, files: snapshot.files.length, bytes: snapshot.bytes,
    oldestFileAt: snapshot.files.map((file) => file.modifiedAt).sort()[0] ?? null,
    observerUnits: 'not_observed', issues: [...issues].sort(), records };
}

/** This is a review plan, NOT permission to delete. All policy values must be explicit. */
export function planRecoveryMaintenance(inventory, policy, now = Date.now()) {
  const refs = policy?.references;
  if (inventory?.schemaVersion !== 1 || !Array.isArray(inventory.records) ||
    !Array.isArray(inventory.issues) || !hex(inventory.snapshotDigest)) throw new Error('Invalid maintenance inventory');
  if (!Number.isFinite(now) || policy?.schemaVersion !== 1 ||
    !Number.isSafeInteger(policy.retentionSeconds) || policy.retentionSeconds < 1 ||
    policy.retentionSeconds > 315360000 || !Number.isSafeInteger(policy.capacityWarningBytes) ||
    policy.capacityWarningBytes < 1 || !Number.isSafeInteger(policy.observerWarningSeconds) ||
    policy.observerWarningSeconds < 1) throw new Error('Explicit maintenance policy required');
  const fresh = (v) => recentTime(v, now) && now - Date.parse(v) <= 300000;
  const refsValid = refs?.complete === true && fresh(refs.observedAt) &&
    Array.isArray(refs.releaseIds) && refs.releaseIds.every((v) => typeof v === 'string' && /^rc-\d{8}-\d{2,}$/u.test(v)) &&
    Array.isArray(refs.retirementOperations) && refs.retirementOperations.every(operation) &&
    Array.isArray(refs.capsuleDigests) && refs.capsuleDigests.every(hex);
  const blockers = [...inventory.issues];
  if (!refsValid) blockers.push('references_missing_stale_or_incomplete');
  if (!fresh(inventory.observedAt)) blockers.push('inventory_stale');
  const records = inventory.records.map((record) => {
    const reasons = [...blockers];
    if (record.protected || (refsValid && (refs.releaseIds.includes(record.releaseId) ||
      (record.kind === 'web' ? refs.capsuleDigests : refs.retirementOperations).includes(record.id))))
      reasons.push('protected_reference');
    if (!['completed', 'committed', 'rolled_back'].includes(record.state)) reasons.push('nonterminal_or_unknown');
    if (!recentTime(record.completedAt, now) ||
      now - Date.parse(record.completedAt) < policy.retentionSeconds * 1000) reasons.push('retention_not_elapsed');
    return { ...record, action: reasons.length ? 'retain' : 'archive_review', reasons: [...new Set(reasons)].sort() };
  });
  const alerts = [...inventory.issues];
  if (inventory.bytes >= policy.capacityWarningBytes) alerts.push('recovery_capacity_warning');
  for (const record of inventory.records)
    if (record.kind === 'retirement' && record.state === 'unverified') {
      alerts.push('retirement_needs_review');
      if (!recentTime(record.lastObservedAt, now) ||
        now - Date.parse(record.lastObservedAt) > policy.observerWarningSeconds * 1000)
        alerts.push('retirement_observer_stale_or_missing');
    }
  if (now - Date.parse(inventory.observedAt) > policy.observerWarningSeconds * 1000)
    alerts.push('inventory_monitor_stale');
  return { schemaVersion: 1, mode: 'dry-run', cleanupAuthorized: false,
    snapshotDigest: inventory.snapshotDigest, policyDigest: sha256(JSON.stringify(policy)),
    blockers: [...new Set(blockers)].sort(), alerts: [...new Set(alerts)].sort(),
    alertDelivery: 'not_attempted', records };
}
