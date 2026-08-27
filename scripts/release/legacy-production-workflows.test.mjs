import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../../.github/workflows/', import.meta.url);

function triggerBlock(workflow) {
  const start = workflow.indexOf('on:\n');
  assert.ok(start >= 0);
  const boundaries = ['\npermissions:', '\nconcurrency:', '\nenv:', '\njobs:']
    .map((marker) => workflow.indexOf(marker, start + 4))
    .filter((index) => index >= 0);
  return workflow.slice(start + 4, Math.min(...boundaries));
}

test('legacy App and ACS workflows cannot be manually dispatched to production', async () => {
  for (const name of ['ci.yml', 'acs-sandbox.yml']) {
    const workflow = await readFile(new URL(name, root), 'utf8');
    assert.doesNotMatch(triggerBlock(workflow), /^\s*workflow_dispatch:/mu, name);
    assert.match(workflow, /github\.event_name == 'workflow_dispatch'/u);
  }
});

test('the immutable RC promotion workflow is the sole production dispatch entry', async () => {
  const workflow = await readFile(new URL('promote-release.yml', root), 'utf8');
  assert.match(triggerBlock(workflow), /^\s*workflow_dispatch:/mu);
  assert.match(workflow, /release_id:/u);
  assert.match(workflow, /environment: production/u);
});
