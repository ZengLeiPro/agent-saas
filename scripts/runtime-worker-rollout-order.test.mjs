import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

function position(text) {
  const index = workflow.indexOf(text);
  assert.notEqual(index, -1, `missing workflow marker: ${text}`);
  return index;
}

test('runtime worker becomes healthy before Web readiness and traffic switch', () => {
  const workerDrain = position('kill -USR2 "$OLD_WORKER_PID"');
  const healthyHeartbeat = position("AND status='healthy' AND updated_at>=clock_timestamp()-interval '30 seconds'");
  const workerPromoted = position('runtime worker promoted before Web readiness');
  const webStart = position('start idle unit: ${SERVICE_NAME}@${IDLE}');
  const webReady = position('waiting ready: $READY_URL timeout=180s');
  const trafficSwitch = position('rewrite nginx upstream: primary=127.0.0.1:$IDLE_PORT');

  assert.ok(workerDrain < healthyHeartbeat);
  assert.ok(healthyHeartbeat < workerPromoted);
  assert.ok(workerPromoted < webStart);
  assert.ok(webStart < webReady);
  assert.ok(webReady < trafficSwitch);
  assert.equal(workflow.includes('start deferred until Web cutover succeeds'), false);
});
