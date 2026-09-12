import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, link, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fingerprintFile, snapshotRecoveryTree, sha256 } from './recovery-maintenance-files.mjs';
import { inventoryRecovery, planRecoveryMaintenance } from './recovery-maintenance-inventory.mjs';
import { archiveRecovery, verifyRecoveryArchive } from './recovery-maintenance-archive.mjs';

const now = Date.parse('2026-09-11T14:00:00.000Z');
const iso = (t) => new Date(t).toISOString();
const ago = (days) => iso(now - days * 86400000);
const identity = (n) => ({ releaseId: `rc-20260901-${n}`, manifestDigest: 'sha256:' + 'a'.repeat(64),
  runId: String(n), runAttempt: '1' });
const json = (path, value) => writeFile(path, JSON.stringify(value) + '\n');
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'maintenance-fixture-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'source');
  await mkdir(join(root, 'web'), { recursive: true });
  await mkdir(join(root, 'retirements'));
  async function capsule(n, completedAt = ago(20)) {
    const bytes = JSON.stringify({ schemaVersion: 1, snapshot: { identity: identity(n) },
      files: { private: 'NEVER_EXPORT_CAPSULE' } }) + '\n';
    const digest = sha256(bytes);
    await writeFile(join(root, 'web', digest + '.json'), bytes);
    const receipt = { schemaVersion: 1, identity: identity(n), capsuleDigest: digest,
      state: 'committed', verifiedAt: completedAt };
    await json(join(root, 'web', digest + '.committed.json'), receipt);
    return receipt;
  }
  const old = await capsule(11), active = await capsule(12, ago(1));
  await json(join(root, 'web/active.json'), active);
  return { base, root, old, active, capsule };
}
function policy() {
  return { schemaVersion: 1, retentionSeconds: 86400 * 7, capacityWarningBytes: 10000000,
    observerWarningSeconds: 600, references: { complete: true, observedAt: iso(now),
      releaseIds: [], retirementOperations: [], capsuleDigests: [] } };
}
async function retirement(root, id = '47-1', complete = true) {
  const directory = join(root, 'retirements', id);
  await mkdir(directory);
  const body = { schemaVersion: 1, ...identity(47), startedAt: ago(21),
    components: ['api', 'runtimeWorker'].map((role, i) => ({ role, color: 'blue', pid: 40 + i,
      invocationId: (i ? 'b' : 'a').repeat(32), bootId: 'old-boot', processStartTicks: '1234' })) };
  const target = { ...body, targetDigest: sha256(JSON.stringify(body)) };
  const observed = { schemaVersion: 1, ...identity(47), targetDigest: target.targetDigest,
    observedAt: ago(20), status: 'acknowledged', retirementPhase: complete ? 'completed' : 'draining_or_unverified',
    components: body.components.map(({ role, color, pid, invocationId }) => ({ role, color, pid,
      invocationId, phase: complete ? 'completed' : 'generation_changed_unverified', acknowledged: true,
      durable: complete ? { verified: true, total: 3, terminal: 1, new_owner: 1, suspended: 1, unverified: 0 } : null })) };
  await json(join(directory, 'app-retirement-targets.json'), target);
  await json(join(directory, 'app-retirement-observation.json'), observed);
  await json(join(directory, 'app-retirement-private.json'), { tenant: 'NEVER_EXPORT_TENANT', run: 'NEVER_EXPORT_RUN' });
  await writeFile(join(directory, 'app-retirement-alert.json'), '');
  return { directory, target, observed };
}

test('inventory binds terminal Web receipts and never exports private contents', async (t) => {
  const f = await fixture(t);
  await retirement(f.root);
  const before = await snapshotRecoveryTree(f.root);
  const inventory = await inventoryRecovery(f.root, { now });
  const plan = planRecoveryMaintenance(inventory, policy(), now);
  assert.deepEqual(inventory.issues, []);
  assert.equal(inventory.observerUnits, 'not_observed');
  assert.equal(plan.cleanupAuthorized, false);
  assert.equal(plan.records.filter((r) => r.action === 'archive_review').length, 2);
  assert.equal(plan.records.find((r) => r.id === f.active.capsuleDigest).action, 'retain');
  assert.doesNotMatch(JSON.stringify({ inventory, plan }), /NEVER_EXPORT|app-retirement-private|old-boot/);
  assert.equal((await snapshotRecoveryTree(f.root)).digest, before.digest);
});
for (const kind of ['releaseIds', 'capsuleDigests', 'retirementOperations']) {
  test(`explicit ${kind} protects retained evidence`, async (t) => {
    const f = await fixture(t); await retirement(f.root);
    const p = policy();
    p.references[kind] = [kind === 'releaseIds' ? f.old.identity.releaseId :
      kind === 'capsuleDigests' ? f.old.capsuleDigest : '47-1'];
    const plan = planRecoveryMaintenance(await inventoryRecovery(f.root, { now }), p, now);
    const record = plan.records.find((r) => r.id === (kind === 'retirementOperations' ? '47-1' : f.old.capsuleDigest));
    assert.equal(record.action, 'retain');
    assert.ok(record.reasons.includes('protected_reference'));
  });
}
for (const mode of ['pending', 'missing-active', 'bad-active', 'orphan', 'contradictory', 'wrong-identity', 'future', 'bad-encoding']) {
  test(`Web ${mode} fails closed without inferring completion`, async (t) => {
    const f = await fixture(t), path = join(f.root, 'web', f.old.capsuleDigest + '.committed.json');
    if (mode === 'pending') await json(join(f.root, 'web/active.json'), { ...f.active, state: 'pending' });
    if (mode === 'missing-active') await rm(join(f.root, 'web/active.json'));
    if (mode === 'bad-active') await writeFile(join(f.root, 'web/active.json'), '{"secret":undefined}');
    if (mode === 'orphan') await rm(path);
    if (mode === 'contradictory') await json(join(f.root, 'web', f.old.capsuleDigest + '.rolled_back.json'), { ...f.old, state: 'rolled_back' });
    if (mode === 'wrong-identity') await json(path, { ...f.old, identity: {} });
    if (mode === 'future') await json(path, { ...f.old, verifiedAt: iso(now + 1) });
    if (mode === 'bad-encoding') await writeFile(path, Buffer.from([255, 254]));
    const plan = planRecoveryMaintenance(await inventoryRecovery(f.root, { now }), policy(), now);
    assert.ok(plan.blockers.length > 0);
    assert.ok(plan.records.every((r) => r.action === 'retain'));
  });
}
for (const mode of ['legacy', 'target-changed', 'wrong-generation', 'wrong-operation', 'bad-counts', 'missing-proof', 'late-observation', 'duplicate-role']) {
  test(`retirement ${mode} cannot turn PID exit or acknowledgement into task completion`, async (t) => {
    const f = await fixture(t); const r = await retirement(f.root, '47-1', mode !== 'legacy');
    if (mode === 'target-changed') r.target.components[0].pid++;
    if (mode === 'wrong-generation') r.observed.components[0].invocationId = 'c'.repeat(32);
    if (mode === 'wrong-operation') r.observed.runAttempt = '2';
    if (mode === 'bad-counts') r.observed.components[0].durable.total++;
    if (mode === 'missing-proof') r.observed.components[0].durable = null;
    if (mode === 'late-observation') r.observed.observedAt = iso(now + 1);
    if (mode === 'duplicate-role') r.observed.components[1].role = 'api';
    await json(join(r.directory, 'app-retirement-targets.json'), r.target);
    await json(join(r.directory, 'app-retirement-observation.json'), r.observed);
    const inventory = await inventoryRecovery(f.root, { now });
    assert.equal(inventory.records.find((v) => v.kind === 'retirement').state, 'unverified');
    const plan = planRecoveryMaintenance(inventory, policy(), now);
    assert.ok(plan.records.every((v) => v.action === 'retain'));
    assert.ok(plan.alerts.includes('retirement_needs_review'));
    assert.ok(plan.alerts.includes('retirement_observer_stale_or_missing'));
  });
}
for (const mode of ['missing', 'incomplete', 'stale', 'future', 'bad-identifiers']) {
  test(`reference inventory ${mode} prevents cleanup recommendations`, async (t) => {
    const f = await fixture(t), p = policy();
    if (mode === 'missing') delete p.references;
    if (mode === 'incomplete') p.references.complete = false;
    if (mode === 'stale') p.references.observedAt = iso(now - 300001);
    if (mode === 'future') p.references.observedAt = iso(now + 1);
    if (mode === 'bad-identifiers') p.references.capsuleDigests = ['*'];
    const plan = planRecoveryMaintenance(await inventoryRecovery(f.root, { now }), p, now);
    assert.ok(plan.records.every((v) => v.action === 'retain'));
  });
}
test('policy requires explicit limits and produces capacity/staleness alerts without delivering them', async (t) => {
  const f = await fixture(t), inventory = await inventoryRecovery(f.root, { now });
  for (const field of ['retentionSeconds', 'capacityWarningBytes', 'observerWarningSeconds']) {
    for (const value of [undefined, 0, -1, '10', Infinity])
      assert.throws(() => planRecoveryMaintenance(inventory, { ...policy(), [field]: value }, now));
  }
  const plan = planRecoveryMaintenance(inventory, { ...policy(), capacityWarningBytes: 1 }, now + 900000);
  assert.ok(plan.alerts.includes('recovery_capacity_warning'));
  assert.ok(plan.alerts.includes('inventory_monitor_stale'));
  assert.equal(plan.alertDelivery, 'not_attempted');
  assert.ok(plan.blockers.includes('inventory_stale'));
});
for (const mode of ['symlink-file', 'symlink-directory', 'hardlink', 'fifo', 'entries', 'bytes', 'depth']) {
  test(`bounded filesystem rejects ${mode}`, async (t) => {
    const f = await fixture(t);
    let limits;
    if (mode === 'symlink-file') await symlink(join(f.root, 'web/active.json'), join(f.root, 'linked'));
    if (mode === 'symlink-directory') await symlink(join(f.root, 'web'), join(f.root, 'linked'));
    if (mode === 'hardlink') await link(join(f.root, 'web/active.json'), join(f.root, 'linked'));
    if (mode === 'fifo') assert.equal(spawnSync('mkfifo', [join(f.root, 'pipe')]).status, 0);
    if (mode === 'entries') limits = { entries: 2 };
    if (mode === 'bytes') limits = { totalBytes: 1 };
    if (mode === 'depth') { limits = { depth: 1 }; await mkdir(join(f.root, 'web/child/grandchild'), { recursive: true }); }
    await assert.rejects(snapshotRecoveryTree(f.root, limits));
  });
}
test('changed file is rejected during the real bounded stream', async (t) => {
  const f = await fixture(t), path = join(f.root, 'change');
  await writeFile(path, 'original');
  await assert.rejects(fingerprintFile(path, 1000, async () => writeFile(path, 'changed')));
});
test('unknown files, empty operation directories and nested entries stay visible and protected', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'mystery.json'), 'NEVER_EXPORT_CONTENT');
  await mkdir(join(f.root, 'retirements/99-1'));
  const inventory = await inventoryRecovery(f.root, { now });
  assert.ok(inventory.issues.includes('unclassified_files'));
  assert.ok(inventory.issues.includes('retirement_completion_unverified'));
  assert.doesNotMatch(JSON.stringify(inventory), /NEVER_EXPORT_CONTENT/);
});
test('archive is copy-only, create-only, private, byte verified and does not correct invalid evidence', async (t) => {
  const f = await fixture(t); await retirement(f.root, '47-1', false);
  await writeFile(join(f.root, 'malformed.json'), '{"postconditionsDigest":undefined}');
  const snapshot = await snapshotRecoveryTree(f.root), archive = join(f.base, 'archive');
  const receipt = await archiveRecovery(f.root, archive);
  assert.equal(receipt.sourceDeleted, false);
  assert.equal(receipt.sourceSnapshotDigest, snapshot.digest);
  assert.equal((await verifyRecoveryArchive(archive, snapshot.digest)).verified, true);
  assert.equal((await stat(archive)).mode & 0o777, 0o700);
  assert.equal((await stat(join(archive, 'files/malformed.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(join(archive, 'files/malformed.json')), await readFile(join(f.root, 'malformed.json')));
  await assert.rejects(archiveRecovery(f.root, archive));
  await assert.rejects(verifyRecoveryArchive(archive, 'f'.repeat(64)));
  assert.equal((await snapshotRecoveryTree(f.root)).digest, snapshot.digest);
  await json(join(archive, 'archive-receipt.json'), { ...receipt, token: 'NEVER_EXPORT_RECEIPT' });
  assert.doesNotMatch(JSON.stringify(await verifyRecoveryArchive(archive, snapshot.digest)), /NEVER_EXPORT_RECEIPT/);
  await writeFile(join(archive, 'files/malformed.json'), 'tampered');
  await assert.rejects(verifyRecoveryArchive(archive, snapshot.digest));
});
test('archive rejects overlap, incomplete output and extra content', async (t) => {
  const f = await fixture(t), archive = join(f.base, 'archive');
  await assert.rejects(archiveRecovery(f.root, join(f.root, 'child')));
  const receipt = await archiveRecovery(f.root, archive);
  await mkdir(join(archive, 'unknown'));
  await assert.rejects(verifyRecoveryArchive(archive, receipt.sourceSnapshotDigest));
  await rm(join(archive, 'unknown'), { recursive: true });
  await rm(join(archive, 'archive-receipt.json'));
  await assert.rejects(verifyRecoveryArchive(archive, receipt.sourceSnapshotDigest));
});
test('CLI executes actual inventory/plan/archive/verify and rejects deletion or path leaks', async (t) => {
  const f = await fixture(t), cli = fileURLToPath(new URL('./recovery-maintenance.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
  const initial = run('inventory', f.root);
  assert.equal(initial.status, 0, initial.stderr);
  const p = policy(); p.references.observedAt = new Date().toISOString();
  await json(join(f.base, 'policy.json'), p);
  const plan = run('plan', f.root, join(f.base, 'policy.json'));
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).cleanupAuthorized, false);
  const copied = run('archive', f.root, join(f.base, 'archive'));
  assert.equal(copied.status, 0, copied.stderr);
  const verify = run('verify-archive', join(f.base, 'archive'), JSON.parse(copied.stdout).sourceSnapshotDigest);
  assert.equal(verify.status, 0, verify.stderr);
  for (const args of [['delete', f.root], ['apply', f.root], ['inventory', f.root, '--force'],
    ['inventory', join(f.root, 'SECRET_HOST_PATH')]]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /SECRET_HOST_PATH|NEVER_EXPORT/);
    assert.equal(result.stdout, '');
  }
});
