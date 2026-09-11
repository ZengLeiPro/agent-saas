import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureRetirement,
  validateTargets,
  observeRetirement,
  classifyRun,
  assertHandoffIdentity,
  databaseIdentity,
  readWorkProof,
} from './app-retirement-evidence.mjs';

const manifest = { releaseId: 'rc-20260911-01', digest: 'sha256:' + 'a'.repeat(64) };
const bootId = '00000000-0000-0000-0000-000000000001';
const config = {
  runtimeEventStore: {
    backend: 'pg',
    connectionString: 'postgresql://fixture:private@localhost:5432/fixture',
    tablePrefix: 'runtime',
  },
};
function fixture() {
  const units = new Map();
  for (const [role, pid] of [
    ['server', 41],
    ['runtime-worker', 42],
  ])
    units.set(`agent-saas-${role}@blue`, {
      ActiveState: 'active',
      MainPID: String(pid),
      InvocationID: String(pid).padStart(32, '0'),
      ExecMainPID: String(pid),
      Result: 'success',
      UnitFileState: 'disabled',
    });
  const systemd = (unit, property) => {
    assert(units.has(unit), 'must query pinned blue slots even if active colors later change');
    return units.get(unit)[property];
  };
  const startTicks = (pid) => String(1000 + pid);
  const target = captureRetirement({
    manifest,
    active: { api: 'green', runtimeWorker: 'green' },
    runId: '123',
    runAttempt: '1',
    systemd,
    startTicks,
    bootId,
    config,
    serverRoot: '/opt/agent-saas-app/releases/' + 'a'.repeat(64) + '/server',
  });
  const markers = new Map(
    target.components.map((c) => [
      c.marker,
      {
        pid: c.pid,
        bootId,
        processStartTicks: c.processStartTicks,
        inventoryComplete: true,
        drainRuns: [{ runId: c.role + '-run', workerId: 'old-worker', tenantId: 'tenant-a' }],
        drainState: 'draining',
        runtimeQuiesced: false,
        activeStreams: 1,
        activeUploads: 0,
        registeredRuns: 1,
      },
    ]),
  );
  const readMarker = (path) => markers.get(path);
  const workProof = async (inventory) => ({
    total: inventory.length,
    terminal: inventory.length,
    new_owner: 0,
    suspended: 0,
    unverified: 0,
    verified: true,
  });
  const observe = (extra = {}) =>
    observeRetirement({ target, systemd, bootId, startTicks, readMarker, workProof, ...extra });
  function finish() {
    for (const u of units.values()) {
      u.ActiveState = 'inactive';
      u.MainPID = '0';
    }
    for (const m of markers.values())
      Object.assign(m, {
        drainState: 'completed',
        runtimeQuiesced: true,
        activeStreams: 0,
        activeUploads: 0,
        registeredRuns: 0,
      });
  }
  return { target, units, systemd, markers, startTicks, observe, finish };
}

test('pins complete old generation identity and refuses another release or modified target', () => {
  const f = fixture();
  assert.equal(validateTargets(f.target, manifest), f.target);
  assert.throws(() =>
    validateTargets(f.target, { ...manifest, digest: 'sha256:' + 'b'.repeat(64) }),
  );
  assert.throws(() => validateTargets({ ...f.target, runAttempt: '2' }, manifest));
  assert.deepEqual(
    f.target.components.map((c) => c.color),
    ['blue', 'blue'],
  );
  assert.doesNotMatch(JSON.stringify(f.target), /private|fixture:|postgresql/);
});

test('handoff is acknowledged during draining but cannot become completed on zero counters without durable proof', async () => {
  const f = fixture();
  assert.equal((await f.observe()).observation.status, 'acknowledged');
  f.finish();
  const result = await f.observe({ workProof: async () => ({ verified: false, unverified: 1 }) });
  assert.equal(result.observation.retirementPhase, 'draining_or_unverified');
  assert.equal((await f.observe()).observation.retirementPhase, 'completed');
});

test('T06: later slot reuse never attributes the new process or tasks to the earlier release', async () => {
  const f = fixture();
  const first = await f.observe();
  for (const u of f.units.values()) {
    u.InvocationID = 'b'.repeat(32);
    u.MainPID = '99';
    u.UnitFileState = 'enabled';
  }
  for (const m of f.markers.values())
    Object.assign(m, { pid: 99, drainRuns: [], drainState: 'completed', registeredRuns: 0 });
  const result = await f.observe({ prior: first.saved });
  assert.equal(result.observation.status, 'needs_human');
  assert(result.observation.components.every((c) => c.phase === 'generation_changed_unverified'));
});

test('a saved clean exit remains bound after slot reuse or reboot, while work is freshly queried', async () => {
  const f = fixture();
  f.finish();
  const first = await f.observe();
  for (const u of f.units.values()) {
    u.InvocationID = 'c'.repeat(32);
    u.MainPID = '99';
    u.ActiveState = 'active';
    u.UnitFileState = 'enabled';
  }
  f.markers.clear();
  const result = await f.observe({ prior: first.saved, bootId: 'new-boot' });
  assert.equal(result.observation.retirementPhase, 'completed');
  const unknown = await f.observe({
    prior: first.saved,
    bootId: 'new-boot',
    workProof: async () => ({ verified: false }),
  });
  assert.notEqual(unknown.observation.retirementPhase, 'completed');
});

test('PID reuse, missing/incomplete inventory and cleanup failure cannot manufacture completion', async () => {
  for (const mode of ['pid-reuse', 'missing', 'incomplete', 'failed', 'timed_out', 'registered']) {
    const f = fixture();
    f.finish();
    for (const m of f.markers.values()) {
      if (mode === 'pid-reuse') m.processStartTicks = 'different';
      if (mode === 'incomplete') m.inventoryComplete = false;
      if (mode === 'failed' || mode === 'timed_out') m.drainState = mode;
      if (mode === 'registered') m.registeredRuns = 1;
    }
    if (mode === 'missing') f.markers.clear();
    assert.notEqual((await f.observe()).observation.retirementPhase, 'completed', mode);
  }
});

test('shrinking retained run inventory is a failure, not an empty successful readback', async () => {
  const f = fixture();
  const first = structuredClone(await f.observe());
  f.finish();
  for (const m of f.markers.values()) m.drainRuns = [];
  assert.equal((await f.observe({ prior: first.saved })).observation.status, 'needs_human');
});

test('inactive systemd garbage collection is not confused with proof: clean marker and exact process disappearance are required', async () => {
  const f = fixture();
  f.finish();
  for (const u of f.units.values()) u.InvocationID = '';
  const gone = () => {
    throw Object.assign(new Error('gone'), { code: 'ENOENT' });
  };
  assert.equal((await f.observe({ startTicks: gone })).observation.retirementPhase, 'completed');
  f.markers.clear();
  assert.notEqual((await f.observe({ startTicks: gone })).observation.retirementPhase, 'completed');
});

test('a failed read-only durable query is not swallowed as completion', async () => {
  const f = fixture();
  f.finish();
  await assert.rejects(
    f.observe({
      workProof: async () => {
        throw new Error('unavailable');
      },
    }),
    /unavailable/,
  );
});

test('fresh handoff identity guard refuses same-PID replacements and another boot before signalling', () => {
  const f = fixture();
  const opts = { systemd: f.systemd, bootId, startTicks: f.startTicks };
  assertHandoffIdentity(f.target, 'api', opts);
  assert.throws(() => assertHandoffIdentity(f.target, 'api', { ...opts, bootId: 'new-boot' }));
  assert.throws(() =>
    assertHandoffIdentity(f.target, 'api', { ...opts, startTicks: () => 'reused' }),
  );
  f.units.get('agent-saas-server@blue').InvocationID = 'd'.repeat(32);
  assert.throws(() => assertHandoffIdentity(f.target, 'api', opts));
});

for (const [name, row, expected] of [
  [
    'completed terminal',
    { status: 'completed', completed_at: 'now', unresolved_total: 0 },
    'terminal',
  ],
  ['failed terminal', { status: 'failed', failed_at: 'now', unresolved_total: 0 }, 'terminal'],
  ['missing terminal timestamp', { status: 'completed', unresolved_total: 0 }, 'unverified'],
  [
    'unknown external side effect',
    {
      status: 'failed',
      failed_at: 'now',
      unresolved_total: 0,
      status_reason: 'external_tool_outcome_unknown',
    },
    'unverified',
  ],
  ['orphaned', { status: 'orphaned', unresolved_total: 0 }, 'unverified'],
  [
    'unresolved cancelled invocation',
    { status: 'cancelled', cancelled_at: 'now', unresolved_total: 1 },
    'unverified',
  ],
  [
    'valid successor',
    { status: 'running', worker_id: 'new', owner_valid: true, unresolved_old: 0 },
    'new_owner',
  ],
  [
    'expired successor',
    { status: 'running', worker_id: 'new', owner_valid: false, unresolved_old: 0 },
    'unverified',
  ],
  [
    'old owner remains',
    { status: 'running', worker_id: 'old', owner_valid: true, unresolved_old: 0 },
    'unverified',
  ],
  [
    'old invocation still running',
    { status: 'running', worker_id: 'new', owner_valid: true, unresolved_old: 1 },
    'unverified',
  ],
  [
    'persisted user wait',
    { status: 'waiting_user', worker_id: null, unresolved_total: 0 },
    'suspended',
  ],
])
  test(`durable work proof: ${name}`, () => assert.equal(classifyRun(row, 'old'), expected));

test('readback uses a read-only transaction, parameters, bounded timeouts and releases the pool on failure', async () => {
  const calls = [];
  let ended = false,
    released = false;
  class Pool {
    constructor(options) {
      assert.match(options.options, /default_transaction_read_only=on/);
      assert.equal(options.max, 1);
    }
    async connect() {
      return {
        query: async (query) => {
          calls.push(query);
          if (typeof query === 'object') throw new Error('fixture query failure');
        },
        release: () => {
          released = true;
        },
      };
    }
    async end() {
      ended = true;
    }
  }
  const target = fixture().target;
  await assert.rejects(
    readWorkProof({
      target,
      inventory: [{ runId: 'r', workerId: 'old', tenantId: 'tenant-a' }],
      config,
      Pool,
    }),
    /fixture query failure/,
  );
  assert(ended && released);
  assert.equal(calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.deepEqual(calls[1].values, [['r'], ['old'], ['tenant-a']]);
  assert.throws(() =>
    databaseIdentity({
      runtimeEventStore: { ...config.runtimeEventStore, tablePrefix: 'runtime;DROP' },
    }),
  );
});

test('legacy failed marker stays failed after systemd forgets the inactive invocation', async () => {
  const f = fixture();
  f.finish();
  for (const u of f.units.values()) u.InvocationID = '';
  for (const m of f.markers.values()) {
    delete m.bootId;
    delete m.processStartTicks;
    delete m.drainRuns;
    m.drainState = 'failed';
  }
  assert.equal((await f.observe()).observation.status, 'needs_human');
});

test('a marker contradicting the pinned boot cannot acknowledge an active handoff', async () => {
  const f = fixture();
  for (const m of f.markers.values()) m.bootId = 'other-boot';
  assert.equal((await f.observe()).observation.status, 'needs_human');
});
