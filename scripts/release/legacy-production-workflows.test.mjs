import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../.github/workflows/', import.meta.url);
const repoRoot = new URL('../../', import.meta.url);
const releaseRoot = new URL('./', import.meta.url);

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

test('ECS pack declaration produces an archive containing the compatibility authority helper', async () => {
  const workflow = await readFile(new URL('ci.yml', root), 'utf8');
  const packStart = workflow.indexOf('      - name: Pack and identify ECS release\n');
  const packEnd = workflow.indexOf('\n      - name:', packStart + 1);
  assert.ok(packStart >= 0 && packEnd > packStart);
  const pack = workflow.slice(packStart, packEnd);
  const declaration = pack.match(
    /install -m 0444 ([\s\S]*?) "\$stage\/scripts\/release\/"/u,
  );
  assert.ok(declaration, 'release helper install declaration is missing');
  const sources = declaration[1]
    .replaceAll('\\\n', ' ')
    .trim()
    .split(/\s+/u);
  assert.ok(sources.includes('scripts/release/compat-app-authority.sh'));

  const temporary = await mkdtemp(join(tmpdir(), 'compat-pack-'));
  try {
    const stage = join(temporary, 'stage');
    const destination = join(stage, 'scripts', 'release');
    await mkdir(destination, { recursive: true });
    for (const source of sources) {
      await copyFile(fileURLToPath(new URL(source, repoRoot)), join(destination, source.split('/').at(-1)));
    }
    const archive = join(temporary, 'server-bundle.tgz');
    execFileSync('tar', ['-czf', archive, '-C', stage, '.']);
    const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.match(entries, /(?:^|\n)\.\/scripts\/release\/compat-app-authority\.sh(?:\n|$)/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('legacy manual App deploy publishes immutable rollback before mutation and minimizes authority/nginx windows', async () => {
  const workflow = await readFile(new URL('ci.yml', root), 'utf8');
  const authority = await readFile(new URL('compat-app-authority.sh', releaseRoot), 'utf8');
  assert.match(workflow, /source "\$RELEASE_DIR\/scripts\/release\/compat-app-authority\.sh"/u);
  assert.match(workflow, /publish_compat_deploy_rollback/u);
  assert.match(workflow, /commit_app_active_colors "\$IDLE" "\$APP_WORKER_TARGET"/u);
  assert.doesNotMatch(workflow, /write_worker_active_color "\$WORKER_IDLE"/u);
  assert.match(authority, /This rename is the only new-authority commit/u);
  assert.match(authority, /mv -fT "\$link_candidate" "\$authority_link"/u);
  assert.match(authority, /compat-deploy-attempt-current/u);
  assert.match(authority, /source "\$STATE\/compat-app-authority\.sh"/u);
  assert.match(authority, /API_OLD_ENABLEMENT/u);
  assert.match(authority, /WORKER_NEW_ENABLEMENT/u);

  const publish = workflow.indexOf('publish_compat_deploy_rollback');
  const unitOverwrite = workflow.indexOf(
    'install -m 0644 "$RELEASE_DIR/daemon-packaging/systemd/agent-saas-server@.service.template"',
  );
  const firstCandidateLink = workflow.indexOf('ln -sfn "$RELEASE_DIR" "$COLOR_DIR/$IDLE"');
  assert.ok(publish >= 0 && publish < unitOverwrite && publish < firstCandidateLink);

  const pendingRecovery = workflow.indexOf(
    'pending compatibility attempt detected before active validation',
  );
  const activeValidation = workflow.indexOf(
    'if ! systemctl is-active --quiet "${SERVICE_NAME}@${ACTIVE}"',
  );
  assert.ok(pendingRecovery >= 0 && pendingRecovery < activeValidation);

  const nginxTest = workflow.indexOf('if ! nginx -t; then');
  const newAuthority = workflow.indexOf(
    'if ! commit_app_active_colors "$IDLE" "$APP_WORKER_TARGET"',
    nginxTest,
  );
  const nginxReload = workflow.indexOf('if ! systemctl reload nginx; then', newAuthority);
  assert.ok(nginxTest >= 0 && nginxTest < newAuthority && newAuthority < nginxReload);

  const rollbackStart = authority.indexOf("cat >\"$state_build/rollback.sh\" <<'ROLLBACK'");
  const rollbackEnd = authority.indexOf('\nROLLBACK\n', rollbackStart);
  const rollback = authority.slice(rollbackStart, rollbackEnd);
  assert.ok(rollbackStart >= 0 && rollbackEnd > rollbackStart);
  const restoreUnit = rollback.indexOf('restore_file "$SYSTEMD_DIR/$SERVICE@.service"');
  const daemonReload = rollback.indexOf('systemctl daemon-reload', restoreUnit);
  const apiRestart = rollback.indexOf('systemctl restart "$SERVICE@$API_OLD_COLOR"');
  const workerRestart = rollback.indexOf('systemctl restart "$WORKER_SERVICE@$WORKER_OLD_COLOR"');
  const oldAuthority = rollback.indexOf(
    'commit_compat_app_active_colors "$API_OLD_COLOR" "$WORKER_OLD_COLOR"',
  );
  const oldNginxReload = rollback.indexOf('systemctl reload nginx', oldAuthority);
  assert.ok(restoreUnit >= 0 && restoreUnit < daemonReload && daemonReload < apiRestart);
  assert.ok(apiRestart < oldAuthority && workerRestart < oldAuthority && oldAuthority < oldNginxReload);
  assert.match(rollback, /restore_enablement "\$SERVICE@\$API_OLD_COLOR" "\$API_OLD_ENABLEMENT"/u);
  assert.match(rollback, /restore_enablement "\$SERVICE@\$API_NEW_COLOR" "\$API_NEW_ENABLEMENT"/u);

  assert.doesNotMatch(workflow, /restore_pre_drained_legacy_runtime\(\)/u);
  assert.match(
    workflow,
    /There is intentionally no mutable in-process rollback path[\s\S]*"\$ROLLBACK_STATE_DIR\/rollback\.sh"/u,
  );
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
