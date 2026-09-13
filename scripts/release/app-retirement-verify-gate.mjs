import { readFileSync } from 'node:fs';

function emptyWork(marker) {
  if (!marker || typeof marker !== 'object') return false;
  const runs = marker.drainRuns;
  if (runs != null && (!Array.isArray(runs) || runs.length !== 0)) return false;
  if (marker.registeredRuns != null && marker.registeredRuns !== 0) return false;
  if (marker.activeStreams != null && marker.activeStreams !== 0) return false;
  if (marker.activeUploads != null && marker.activeUploads !== 0) return false;
  return true;
}

function bound(observation, manifest, targets) {
  return (
    observation?.releaseId === manifest?.releaseId &&
    observation?.manifestDigest === manifest?.digest &&
    observation?.targetDigest === targets?.targetDigest
  );
}

function workerOf(observation) {
  return observation?.components?.find((item) => item.role === 'runtimeWorker');
}

function othersAcknowledged(observation) {
  return (observation?.components ?? [])
    .filter((item) => item.role !== 'runtimeWorker')
    .every((item) => item.acknowledged === true);
}

function poisonedCleanupAfterComplete({ observation, live }) {
  const worker = workerOf(observation);
  const unit = live?.runtimeWorker;
  const marker = live?.markers?.runtimeWorker;
  if (!worker || worker.acknowledged === true) return false;
  if (!othersAcknowledged(observation)) return false;
  if (marker?.drainState !== 'failed' || marker?.reason !== 'shutdown_cleanup_failed') return false;
  if (!emptyWork(marker)) return false;
  if (
    worker.durable &&
    (worker.durable.verified !== true || (worker.durable.unverified ?? 0) !== 0)
  ) {
    return false;
  }
  if (!unit) return false;
  if (unit.activeState !== 'inactive') return false;
  if (!['disabled', 'masked'].includes(unit.unitFileState)) return false;
  if (unit.result !== 'success') return false;
  if (Number(unit.mainPid) !== 0) return false;
  return unit.processGone === true;
}

function retryable({ live }) {
  const marker = live?.markers?.runtimeWorker;
  if (['failed', 'timed_out'].includes(marker?.drainState)) return false;
  return live?.runtimeWorker?.activeState === 'active';
}

export function classifyRetirementGate({ observation, manifest, targets, live }) {
  if (observation?.status === 'not_required') return { verdict: 'ok', reason: 'not_required' };
  if (!bound(observation, manifest, targets)) {
    return { verdict: 'fail', reason: 'observation_not_bound' };
  }
  if (observation.status === 'acknowledged') return { verdict: 'ok', reason: 'acknowledged' };
  if (poisonedCleanupAfterComplete({ observation, live })) {
    return { verdict: 'ok', reason: 'cleanup_failed_after_drain_complete' };
  }
  if (retryable({ observation, live })) return { verdict: 'retryable', reason: 'still_draining' };
  return {
    verdict: 'fail',
    reason: `status=${String(observation.status)} phase=${String(observation.retirementPhase)}`,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    values[key.slice(2)] = value;
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv);
  if (!args.observation || !args.manifest || !args.targets || !args.live) {
    throw new Error(
      'usage: app-retirement-verify-gate.mjs --observation <json> --manifest <json> --targets <json> --live <json>',
    );
  }
  const result = classifyRetirementGate({
    observation: JSON.parse(readFileSync(args.observation, 'utf8')),
    manifest: JSON.parse(readFileSync(args.manifest, 'utf8')),
    targets: JSON.parse(readFileSync(args.targets, 'utf8')),
    live: JSON.parse(readFileSync(args.live, 'utf8')),
  });
  process.stderr.write(`app-retirement-gate verdict=${result.verdict} reason=${result.reason}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.verdict === 'ok') process.exit(0);
  if (result.verdict === 'retryable') process.exit(75);
  process.exit(1);
}
