// Diagnostic projection only. Never copy arbitrary receipt properties or command output.
const valid = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : null);
const sha = (value) => valid(value, /^(?:sha256:)?[a-f0-9]{64}$/u);
const release = (value) => valid(value, /^rc-[0-9]{8}-[0-9]{2,}$/u);
const op = (value) => valid(value, /^[A-Za-z0-9_.-]{1,180}$/u);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
export function safeReceipt(value) {
  if (
    !value ||
    !['acs', 'api', 'runtimeWorker', 'web'].includes(value.component) ||
    !['started', 'succeeded', 'failed', 'skipped'].includes(value.outcome)
  )
    return null;
  return {
    releaseId: release(value.releaseId),
    manifestDigest: sha(value.manifestDigest),
    component: value.component,
    operationKey: op(value.operationKey),
    outcome: value.outcome,
    action: ['keep', 'deploy'].includes(value.action) ? value.action : null,
    digest: sha(value.digest),
  };
}
export function safeRecovery(value) {
  if (!value) return null;
  return {
    releaseId: release(value.identity?.releaseId),
    manifestDigest: sha(value.identity?.manifestDigest),
    runId: op(value.identity?.runId),
    runAttempt: op(value.identity?.runAttempt),
    capsuleDigest: sha(value.capsuleDigest),
    state: ['pending', 'committed', 'rolled_back'].includes(value.state) ? value.state : 'unknown',
    pending: value.pending === true,
  };
}
export function safeRestoration(value) {
  if (!value || !Array.isArray(value.objects) || value.objects.length > 1024) return null;
  return {
    verified: value.verified === true,
    objects: value.objects.map((entry) => ({
      key: valid(entry.key, /^[A-Za-z0-9][A-Za-z0-9_./-]{0,511}$/u),
      existed: entry.existed === true,
      beforeDigest: sha(entry.digest),
      targetDigest: sha(entry.targetDigest),
    })),
  };
}
export function safeMatrices(input) {
  const matrix = (value) => {
    if (!value) return null;
    const result = {};
    for (const name of ['acs', 'api', 'runtimeWorker', 'web']) {
      const c = value[name];
      if (!c) return null;
      result[name] = { gitSha: valid(c.gitSha, /^[a-f0-9]{40}$/u) };
      for (const field of name === 'acs'
        ? ['orchestratorArtifactDigest', 'sandboxImageDigest']
        : ['artifactDigest'])
        result[name][field] = sha(c[field]);
    }
    return result;
  };
  return {
    before: matrix(input?.before),
    target: matrix(input?.target),
    observed: matrix(input?.observed),
    observationComplete: input?.observationComplete === true,
    configIdentityConfirmed: input?.configIdentityConfirmed === true,
    externalSideEffects: ['none_observed', 'unknown'].includes(input?.externalSideEffects)
      ? input.externalSideEffects
      : 'unknown',
  };
}
export function safeBudget(value) {
  if (!value) return null;
  return Object.fromEntries(
    [
      'operationSeconds',
      'rollbackSeconds',
      'lockLeaseSeconds',
      'elapsedSeconds',
      'deployExitCode',
      'rollbackExitCode',
    ].map((key) => [key, count(value[key])]),
  );
}
const blockerId = (value) => valid(value, /^[A-Za-z0-9._:@-]{1,256}$/u);
const drainPhase = (value) => valid(value, /^[a-z0-9_]{1,64}$/u);
function safeDrainBlocker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    operationId: blockerId(value.operationId),
    attemptId: blockerId(value.attemptId),
    invocationId: blockerId(value.invocationId),
    kind: valid(value.kind, /^[A-Za-z0-9._-]{1,64}$/u),
    phase: valid(value.phase, /^[A-Za-z0-9._-]{1,64}$/u),
    resource: valid(value.resource, /^[A-Za-z0-9._-]{1,64}$/u),
    sandboxName: valid(value.sandboxName, /^[A-Za-z0-9._:-]{1,180}$/u),
    workspaceId: valid(value.workspaceId, /^[A-Za-z0-9._:-]{1,180}$/u),
    elapsedMs: count(value.elapsedMs),
    reasonCode: valid(value.reasonCode, /^[A-Za-z0-9._-]{1,64}$/u),
    durable: value.durable === true,
  };
}
export function safeAcsDrain(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const truncated = records.length > 256;
  const selected = records.slice(0, 256);
  const projected = [];
  for (const record of selected) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const diagnostics = record.diagnostics && typeof record.diagnostics === 'object' && !Array.isArray(record.diagnostics)
      ? record.diagnostics
      : null;
    projected.push({
      drainPhase: drainPhase(record.drainPhase),
      observedAt: valid(record.observedAt, /^\d{4}-\d{2}-\d{2}T[0-9:.Z+-]{5,40}$/u),
      oldAcsPid: count(record.oldAcsPid),
      snapshotDigest: sha(record.snapshotDigest),
      legacyProtocol: record.legacyProtocol === true,
      requests: count(diagnostics?.requests),
      recovery: count(diagnostics?.recovery),
      unresolvedInvocations: count(diagnostics?.unresolvedInvocations),
      ownedWork: count(diagnostics?.ownedWork),
      journalAvailable: diagnostics?.journalAvailable === true,
      persistedUnresolved: count(diagnostics?.persistedUnresolved),
      blockers: Array.isArray(diagnostics?.blockers)
        ? diagnostics.blockers.slice(0, 20).map(safeDrainBlocker).filter(Boolean)
        : [],
    });
  }
  if (!projected.length) return null;
  return {
    present: true,
    recordCount: records.length,
    truncated,
    phases: projected.map((record) => record.drainPhase).filter(Boolean),
    last: projected.at(-1),
    records: projected.slice(0, 32),
  };
}
export function safeNextAction(value) {
  return [
    'verify_failed_rollback_scope',
    'inspect_external_side_effects_before_resume',
    'inspect_unverified_component_identity',
    'resume_uncommitted_components',
  ].includes(value)
    ? value
    : 'inspect_authoritative_receipts_before_action';
}
