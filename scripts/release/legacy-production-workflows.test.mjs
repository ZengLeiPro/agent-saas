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

function jobBlock(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing job ${name}`);
  const contentStart = start + marker.length;
  const nextJob = workflow.slice(contentStart).search(/^  [A-Za-z0-9_-]+:$/mu);
  return workflow.slice(contentStart, nextJob >= 0 ? contentStart + nextJob : undefined);
}

test('legacy App and ACS workflows expose explicit manual compatibility deployment', async () => {
  for (const [name, forceInput] of [
    ['ci.yml', 'web_only_compatibility'],
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

test('legacy production jobs bind production Environment and documented secrets', async () => {
  const app = await readFile(new URL('ci.yml', root), 'utf8');
  const acs = await readFile(new URL('acs-sandbox.yml', root), 'utf8');
  for (const [workflow, job] of [
    [app, 'deploy-ecs'],
    [app, 'deploy-web-oss'],
    [acs, 'build-deploy'],
  ]) {
    assert.match(jobBlock(workflow, job), /^    environment: production$/mu, job);
  }

  const docs = await readFile(
    new URL('../../docs/release-workflow-configuration.md', import.meta.url),
    'utf8',
  );
  assert.match(docs, /不得配置同名\s+repository\/organization Secret 作为兜底/u);
  assert.match(docs, /`OSS_WEB_DEPLOY_AK_ID`/u);
  assert.match(docs, /`OSS_WEB_DEPLOY_AK_SECRET`/u);
  assert.match(docs, /静态代码只能证明 job 的\s+Environment 绑定和引用名称/u);
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
