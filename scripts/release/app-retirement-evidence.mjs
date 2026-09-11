#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { open, rename, unlink, link } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sys = (unit, property) =>
  execFileSync('systemctl', ['show', unit, `--property=${property}`, '--value'], {
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
const boot = () => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const ticks = (pid) => {
  const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
};
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export function databaseIdentity(config) {
  const store = config?.runtimeEventStore;
  assert(
    store?.backend === 'pg' && store.connectionString,
    'Durable retirement requires the configured PostgreSQL store',
  );
  const url = new URL(store.connectionString);
  assert(
    /^[A-Za-z_][A-Za-z0-9_]*$/u.test(store.tablePrefix ?? 'runtime'),
    'Invalid database table prefix',
  );
  return hash({
    host: url.hostname,
    port: url.port || '5432',
    database: url.pathname,
    prefix: store.tablePrefix ?? 'runtime',
  });
}
export async function writeEvidence(path, value, exclusive = false) {
  const temporary = `${path}.${randomUUID()}.candidate`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(value) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
    const dir = await open(resolve(path, '..'), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
export function captureRetirement({
  manifest,
  active,
  runId,
  runAttempt,
  systemd = sys,
  bootId = boot(),
  startTicks = ticks,
  config,
  serverRoot,
}) {
  assert(
    /^rc-\d{8}-\d{2,}$/u.test(manifest.releaseId) && /^sha256:[a-f0-9]{64}$/u.test(manifest.digest),
  );
  assert(/^[1-9]\d*$/u.test(runId) && /^[1-9]\d*$/u.test(runAttempt));
  const components = ['api', 'runtimeWorker'].map((role) => {
    assert(['blue', 'green'].includes(active[role]), 'Invalid active slot');
    const color = active[role] === 'blue' ? 'green' : 'blue';
    const name = role === 'api' ? 'server' : 'runtime-worker';
    const unit = `agent-saas-${name}@${color}`;
    const state = systemd(unit, 'ActiveState');
    assert(['active', 'inactive', 'failed'].includes(state), 'Unknown old generation state');
    const pid = Number(systemd(unit, 'MainPID'));
    assert(Number.isSafeInteger(pid) && pid >= 0);
    const invocationId = systemd(unit, 'InvocationID');
    assert(!invocationId || /^[a-f0-9]{32}$/u.test(invocationId), 'Invalid systemd generation');
    return {
      role,
      color,
      unit,
      pid,
      invocationId,
      bootId,
      processStartTicks: pid > 0 ? startTicks(pid) : null,
      marker: `/run/agent-saas-${name}-${color}.draining`,
    };
  });
  const target = {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    runId,
    runAttempt,
    startedAt: new Date().toISOString(),
    active,
    components,
    databaseIdentity: databaseIdentity(config),
    serverRoot,
  };
  return { ...target, targetDigest: hash(target) };
}
export function validateTargets(target, manifest) {
  const { targetDigest, ...value } = target;
  assert(targetDigest === hash(value), 'Retirement target digest mismatch');
  assert(
    target.releaseId === manifest.releaseId && target.manifestDigest === manifest.digest,
    'Retirement belongs to another release',
  );
  assert(
    target.components?.length === 2 && new Set(target.components.map((c) => c.role)).size === 2,
  );
  for (const c of target.components) {
    assert(['api', 'runtimeWorker'].includes(c.role) && ['blue', 'green'].includes(c.color));
    const name = c.role === 'api' ? 'server' : 'runtime-worker';
    assert(
      c.unit === `agent-saas-${name}@${c.color}` &&
        c.marker === `/run/agent-saas-${name}-${c.color}.draining`,
    );
  }
  return target;
}
export function boundMarker(target, marker) {
  return (
    target.pid > 0 &&
    marker?.pid === target.pid &&
    marker.bootId === target.bootId &&
    marker.processStartTicks === target.processStartTicks &&
    marker.inventoryComplete === true &&
    Array.isArray(marker.drainRuns) &&
    marker.drainRuns.length <= 10_000 &&
    marker.drainRuns.every(
      (r) =>
        typeof r.runId === 'string' &&
        r.runId.length > 0 &&
        r.runId.length <= 256 &&
        (r.workerId === null ||
          (typeof r.workerId === 'string' && r.workerId.length > 0 && r.workerId.length <= 256)) &&
        (r.tenantId === null ||
          (typeof r.tenantId === 'string' && r.tenantId.length > 0 && r.tenantId.length <= 256)),
    ) &&
    new Set(marker.drainRuns.map((r) => r.runId)).size === marker.drainRuns.length
  );
}
export function classifyRun(row, oldWorkerId) {
  if (!row || row.status_reason === 'external_tool_outcome_unknown') return 'unverified';
  if (['completed', 'failed', 'cancelled'].includes(row.status)) {
    const terminalAt = row[`${row.status}_at`];
    return terminalAt && Number(row.unresolved_total) === 0 ? 'terminal' : 'unverified';
  }
  if (
    ['waiting_approval', 'waiting_user'].includes(row.status) &&
    !row.worker_id &&
    Number(row.unresolved_total) === 0
  )
    return 'suspended';
  if (
    oldWorkerId &&
    row.worker_id &&
    row.worker_id !== oldWorkerId &&
    row.owner_valid === true &&
    ['running', 'waiting_hand'].includes(row.status) &&
    Number(row.unresolved_old) === 0
  )
    return 'new_owner';
  return 'unverified';
}
export async function readWorkProof({ target, inventory, config, Pool }) {
  assert(
    databaseIdentity(config) === target.databaseIdentity,
    'Configured database changed since handoff',
  );
  const prefix = config.runtimeEventStore.tablePrefix ?? 'runtime';
  const pool = new Pool({
    connectionString: config.runtimeEventStore.connectionString,
    max: 1,
    connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000',
  });
  let client;
  const counts = {
    total: inventory.length,
    terminal: 0,
    suspended: 0,
    new_owner: 0,
    unverified: 0,
  };
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await client.query({
      name: 'retirement-work-readback',
      text: `
      WITH tracked AS (SELECT * FROM unnest($1::text[], $2::text[], $3::text[]) AS t(run_id, old_owner, tenant_id))
      SELECT t.run_id, r.status, r.status_reason, r.worker_id, r.completed_at, r.failed_at, r.cancelled_at,
        (r.lease_expires_at > clock_timestamp()) AS owner_valid,
        (SELECT count(*) FROM ${prefix}_tool_invocations i WHERE i.run_id=t.run_id AND (i.tenant_id=t.tenant_id OR i.tenant_id IS NULL)
          AND (i.status NOT IN ('completed','failed','cancelled') OR i.completed_at IS NULL
            OR (i.cancel_requested_at IS NOT NULL AND i.cancel_delivered_at IS NULL AND i.status='cancelled'))) AS unresolved_total,
        (SELECT count(*) FROM ${prefix}_tool_invocations i WHERE i.run_id=t.run_id AND (i.tenant_id=t.tenant_id OR i.tenant_id IS NULL)
          AND (i.status NOT IN ('completed','failed','cancelled') OR i.completed_at IS NULL
            OR (i.cancel_requested_at IS NOT NULL AND i.cancel_delivered_at IS NULL AND i.status='cancelled'))
          AND (COALESCE(i.metadata->>'invokeClaimedByWorkerId', i.metadata->>'workerId', '') <> COALESCE(r.worker_id, '')
            OR COALESCE(i.metadata->>'invokeClaimedByWorkerId', i.metadata->>'workerId', '') = COALESCE(t.old_owner, ''))) AS unresolved_old
      FROM tracked t LEFT JOIN ${prefix}_runs r ON r.run_id=t.run_id AND r.tenant_id=t.tenant_id`,
      values: [
        inventory.map((r) => r.runId),
        inventory.map((r) => r.workerId),
        inventory.map((r) => r.tenantId),
      ],
    });
    assert(result.rows.length === inventory.length, 'Incomplete durable work readback');
    const byId = new Map(result.rows.map((r) => [r.run_id, r]));
    for (const record of inventory) counts[classifyRun(byId.get(record.runId), record.workerId)]++;
    return { ...counts, verified: counts.unverified === 0 };
  } finally {
    await client?.query('ROLLBACK').catch(() => undefined);
    client?.release();
    await pool.end();
  }
}
export function assertHandoffIdentity(
  target,
  role,
  { systemd = sys, bootId = boot(), startTicks = ticks } = {},
) {
  const c = target.components.find((value) => value.role === role);
  assert(c && bootId === c.bootId, 'Handoff host generation changed');
  const state = systemd(c.unit, 'ActiveState');
  const pid = Number(systemd(c.unit, 'MainPID'));
  const invocation = systemd(c.unit, 'InvocationID');
  if (state === 'inactive' && pid === 0 && (!invocation || invocation === c.invocationId)) return;
  if (state === 'failed' && pid === 0 && invocation === c.invocationId && c.pid === 0) return;
  assert(
    state === 'active' &&
      pid === c.pid &&
      pid > 0 &&
      invocation === c.invocationId &&
      startTicks(pid) === c.processStartTicks,
    'Refusing to signal a replaced generation',
  );
}
export async function observeRetirement({
  target,
  prior = {},
  systemd = sys,
  bootId = boot(),
  readMarker = readJson,
  workProof,
  startTicks = ticks,
}) {
  const components = [];
  const saved = {};
  for (const c of target.components) {
    const old = prior[c.role]?.targetDigest === target.targetDigest ? prior[c.role] : undefined;
    const invocation = systemd(c.unit, 'InvocationID');
    const generationMatches = bootId === c.bootId && invocation === c.invocationId;
    const state = systemd(c.unit, 'ActiveState');
    const disabled = ['disabled', 'masked'].includes(systemd(c.unit, 'UnitFileState'));
    const pid = Number(systemd(c.unit, 'MainPID'));
    let oldProcessGone = bootId !== c.bootId;
    let sameProcess = false;
    if (!oldProcessGone && c.pid > 0) {
      try {
        const actualTicks = startTicks(c.pid);
        oldProcessGone = actualTicks !== c.processStartTicks;
        sameProcess = generationMatches && pid === c.pid && !oldProcessGone;
      } catch (error) {
        oldProcessGone = error.code === 'ENOENT';
      }
    }
    let current;
    try {
      current = readMarker(c.marker);
    } catch {
      /* No marker is not a completion proof. */
    }
    let marker = boundMarker(c, current) ? current : null;
    const priorMarker = boundMarker(c, old?.marker) ? old.marker : null;
    // A run disappearing from a later marker must not turn a partial inventory into proof.
    const shrunk =
      marker &&
      priorMarker &&
      priorMarker.drainRuns.some(
        (r) =>
          !marker.drainRuns.some(
            (n) => n.runId === r.runId && n.workerId === r.workerId && n.tenantId === r.tenantId,
          ),
      );
    if (shrunk) marker = null;
    if (!marker && !shrunk && (!generationMatches || (!current && oldProcessGone)))
      marker = priorMarker;
    const legacyAcknowledged =
      sameProcess &&
      current?.pid === c.pid &&
      (current.bootId === undefined || current.bootId === c.bootId) &&
      (current.processStartTicks === undefined ||
        current.processStartTicks === c.processStartTicks) &&
      typeof current.runtimeQuiesced === 'boolean' &&
      Number.isFinite(current.activeStreams) &&
      current.activeStreams >= 0 &&
      Number.isFinite(current.activeUploads) &&
      current.activeUploads >= 0;
    const oldMarkerIdentity =
      bootId === c.bootId &&
      current?.pid === c.pid &&
      (current.bootId === undefined || current.bootId === c.bootId) &&
      (current.processStartTicks === undefined ||
        current.processStartTicks === c.processStartTicks) &&
      (invocation === c.invocationId || (!invocation && state === 'inactive' && pid === 0));
    const failedMarker =
      (oldMarkerIdentity && ['failed', 'timed_out'].includes(current?.drainState)) ||
      ['failed', 'timed_out'].includes(marker?.drainState);
    const cleanMarker =
      marker?.drainState === 'completed' &&
      marker.runtimeQuiesced === true &&
      marker.activeStreams === 0 &&
      marker.activeUploads === 0 &&
      marker.registeredRuns === 0;
    // systemd may garbage-collect an inactive unit's InvocationID. A bound post-cleanup
    // marker plus disappearance of the exact boot/PID/start-ticks is an alternative proof.
    const managerExit =
      generationMatches &&
      state === 'inactive' &&
      pid === 0 &&
      c.pid > 0 &&
      Number(systemd(c.unit, 'ExecMainPID')) === c.pid &&
      systemd(c.unit, 'Result') === 'success';
    const exitVerified =
      old?.exitVerified === true || managerExit || (oldProcessGone && cleanMarker);
    let durable = null;
    if (marker && workProof) durable = await workProof(marker.drainRuns);
    let phase = 'unverified';
    if (shrunk || failedMarker) phase = 'needs_human';
    else if (exitVerified && cleanMarker && durable?.verified && (oldProcessGone || disabled))
      phase = 'completed';
    else if (generationMatches && !disabled && current) phase = 'needs_human';
    else if (sameProcess && state === 'active' && disabled && legacyAcknowledged)
      phase = 'draining';
    else if (!generationMatches) phase = 'generation_changed_unverified';
    const safeInactive =
      disabled &&
      state === 'inactive' &&
      pid === 0 &&
      bootId === c.bootId &&
      (!invocation || invocation === c.invocationId) &&
      !failedMarker &&
      !shrunk;
    const acknowledged = phase === 'completed' || phase === 'draining' || safeInactive;
    saved[c.role] = {
      targetDigest: target.targetDigest,
      exitVerified,
      marker: marker ?? priorMarker,
    };
    components.push({
      role: c.role,
      color: c.color,
      pid: c.pid,
      invocationId: c.invocationId,
      phase,
      acknowledged,
      durable,
    });
  }
  return {
    saved,
    observation: {
      schemaVersion: 1,
      releaseId: target.releaseId,
      manifestDigest: target.manifestDigest,
      runId: target.runId,
      runAttempt: target.runAttempt,
      targetDigest: target.targetDigest,
      observedAt: new Date().toISOString(),
      status: components.every((c) => c.acknowledged) ? 'acknowledged' : 'needs_human',
      retirementPhase: components.every((c) => c.phase === 'completed')
        ? 'completed'
        : 'draining_or_unverified',
      components,
    },
  };
}
async function main() {
  const [mode, directory, api, worker, runId, runAttempt] = process.argv.slice(2);
  const manifest = readJson(join(directory, 'manifest.json'));
  const targetPath = join(directory, 'app-retirement-targets.json');
  if (mode === 'capture') {
    try {
      const existing = validateTargets(readJson(targetPath), manifest);
      assert(existing.runId === runId && existing.runAttempt === runAttempt);
      assert.deepEqual(
        existing.active,
        { api, runtimeWorker: worker },
        'Active slots changed since this handoff',
      );
      return; // Never recalculate targets from a later active-color pointer.
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const target = captureRetirement({
      manifest,
      active: { api, runtimeWorker: worker },
      runId,
      runAttempt,
      config: readJson('/etc/agent-saas/config.json'),
      serverRoot: join(realpathSync(`/opt/agent-saas-app/color/${api}`), 'server'),
    });
    await writeEvidence(targetPath, target, true);
    return;
  }
  const target = validateTargets(readJson(targetPath), manifest);
  if (mode === 'check-handoff') {
    assertHandoffIdentity(target, api);
    return;
  }
  assert(mode === 'observe', 'Invalid retirement command');
  assert(
    /^\/opt\/agent-saas-app\/releases\/[a-f0-9]{64}\/server$/u.test(target.serverRoot),
    'Invalid query runtime root',
  );
  const { Pool } = createRequire(join(target.serverRoot, 'package.json'))('pg');
  const statePath = join(directory, 'app-retirement-private.json');
  let prior = {};
  try {
    prior = readJson(statePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const result = await observeRetirement({
    target,
    prior,
    workProof: (inventory) =>
      readWorkProof({ target, inventory, config: readJson('/etc/agent-saas/config.json'), Pool }),
  });
  await writeEvidence(statePath, result.saved);
  await writeEvidence(join(directory, 'app-retirement-observation.json'), result.observation);
  console.log(JSON.stringify(result.observation)); // Counts/identities only; never raw run IDs or credentials.
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  main().catch(() => {
    console.error(
      'Retirement proof unavailable; preserve the pinned generation and private evidence',
    );
    process.exitCode = 1;
  });
