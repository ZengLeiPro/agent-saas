import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const deploy = readFileSync(
  new URL('./deploy-production-release.sh', import.meta.url),
  'utf8',
);
const appStart = deploy.indexOf('deploy_app() {');
const appEnd = deploy.indexOf('case "$PHASE" in', appStart);
const deployApp = deploy.slice(appStart, appEnd);

test('deploy_app 在 governance fence 与任何生产写入之前等待上一次交接的旧色腾出槽位', () => {
  const wait = deployApp.indexOf(
    'wait_for_idle_app_slots "$(other_color "$planned_api_active")" "$(other_color "$planned_worker_active")"',
  );
  const begin = deployApp.indexOf('begin_app_deploy_transaction');
  const firstMutation = deployApp.indexOf('install -m 0644 "$SERVER_UNIT_TEMPLATE" "$server_unit"');
  const colorRecheck = deployApp.indexOf("echo 'Active colors changed while waiting for idle slots; refusing to continue'");
  assert.ok(wait > -1, 'idle slot wait is missing');
  assert.ok(wait < begin, 'idle slot wait must run before the config governance fence is taken');
  assert.ok(begin < colorRecheck && colorRecheck < firstMutation, 'colors must be re-read after the wait and before mutation');
});

test('wait_for_idle_app_slots 只等待带 drain marker 的旧色，超时或未知状态 fail closed，绝不强停', () => {
  const start = deploy.indexOf('wait_for_idle_app_slots() {');
  const end = deploy.indexOf('hand_off_retired_authority() {', start);
  const fn = deploy.slice(start, end);
  assert.match(deploy, /^IDLE_SLOT_DRAIN_WAIT_SECONDS=1800$/mu);
  assert.match(fn, /is active without a drain marker; refusing to reuse the slot/u);
  assert.match(fn, /refusing to interrupt durable work/u);
  assert.match(fn, /systemctl reset-failed "agent-saas-server@\$api_idle"/u);
  assert.doesNotMatch(fn, /systemctl (?:stop|kill|disable --now)|kill -(?:TERM|KILL|9|15)/u);
});

test('authority 提交后旧 generation 后台交接：marker + disable + SIGUSR2，不等待、不 --now、committed 点前移', () => {
  const marker = deployApp.indexOf('commit_app_active_colors "$api_idle" "$worker_idle" "$api_active"');
  const committed = deployApp.indexOf('DEPLOY_APP_ROLLBACK_COMMITTED=true', marker);
  const worker = deployApp.indexOf('hand_off_retired_authority "agent-saas-runtime-worker@$worker_active"', committed);
  const api = deployApp.indexOf('hand_off_retired_authority "agent-saas-server@$api_active"', worker);
  const finalCheck = deployApp.indexOf("'Committed candidate App final API ConfigIdentity'", api);
  assert.ok(marker > -1 && committed > marker && worker > committed && api > worker && finalCheck > api);
  assert.doesNotMatch(deployApp, /retire_systemd_authority/u);
  assert.doesNotMatch(deployApp, /kill -USR2 "\$old_(?:worker|api)_pid"/u);

  const start = deploy.indexOf('hand_off_retired_authority() {');
  const end = deploy.indexOf('deploy_app() {', start);
  const fn = deploy.slice(start, end);
  assert.match(fn, /install -m 0644 \/dev\/null "\$marker"/u);
  assert.match(fn, /systemctl disable "\$unit"/u);
  assert.match(fn, /kill -USR2 "\$pid"/u);
  assert.doesNotMatch(fn, /--now|sleep|systemctl (?:stop|kill)|seq 1/u);
});

test('systemd 模板用 drain marker 的 ExecCondition 阻止后台 drain 的旧色被重新拉起', () => {
  for (const [template, marker] of [
    ['agent-saas-runtime-worker@.service.template', 'ExecCondition=/usr/bin/test ! -e /run/agent-saas-runtime-worker-%i.draining'],
    ['agent-saas-server@.service.template', 'ExecCondition=/usr/bin/test ! -e /run/agent-saas-server-%i.draining'],
  ]) {
    const unit = readFileSync(new URL(`../../daemon-packaging/systemd/${template}`, import.meta.url), 'utf8');
    assert.ok(unit.includes(marker), `${template} lacks ${marker}`);
    assert.match(unit, /Restart=on-failure/u);
  }
});
