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

test('legacy App and ACS workflows expose explicit manual compatibility deployment', async () => {
  for (const [name, forceInput] of [
    ['ci.yml', 'force_ecs'],
    ['acs-sandbox.yml', 'force'],
  ]) {
    const workflow = await readFile(new URL(name, root), 'utf8');
    const triggers = triggerBlock(workflow);
    assert.match(triggers, /^\s*workflow_dispatch:/mu, name);
    assert.match(triggers, new RegExp(`^\\s{6}${forceInput}:$`, 'mu'), name);
    assert.match(triggers, /type: boolean/u, name);
    assert.match(workflow, /github\.event_name == 'workflow_dispatch'/u);
    assert.match(workflow, /github\.ref == 'refs\/heads\/main'/u);
  }
});

test('the immutable RC promotion workflow remains the release-bound production entry', async () => {
  const workflow = await readFile(new URL('promote-release.yml', root), 'utf8');
  assert.match(triggerBlock(workflow), /^\s*workflow_dispatch:/mu);
  assert.match(workflow, /release_id:/u);
  assert.match(workflow, /environment: production/u);
});

test('promotion extracts rooted compatibility bundles at the release root', async () => {
  const deploy = await readFile(
    new URL('../../scripts/release/deploy-production-release.sh', import.meta.url),
    'utf8',
  );
  assert.match(deploy, /Production server bundle must contain server\/dist\/index\.js/u);
  assert.match(deploy, /Production ACS bundle must contain acs-orchestrator\/dist\/index\.js/u);
  assert.match(deploy, /tar -xzf "\$candidate\/\.release\/server-bundle\.tgz" -C "\$candidate"/u);
  assert.match(
    deploy,
    /tar -xzf "\$candidate\/\.release\/acs-orchestrator\.tgz" -C "\$candidate"/u,
  );
});
