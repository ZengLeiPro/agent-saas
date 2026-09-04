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

function jobBlock(workflow, name) {
  const marker = `\n  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.ok(start >= 0, `missing job ${name}`);
  const contentStart = start + marker.length;
  const nextJob = workflow.slice(contentStart).search(/^  [A-Za-z0-9_-]+:$/mu);
  return workflow.slice(contentStart, nextJob >= 0 ? contentStart + nextJob : undefined);
}

function jobNames(workflow) {
  return [...workflow.matchAll(/^  ([A-Za-z0-9_-]+):$/gmu)].map((match) => match[1]);
}

test('legacy App and ACS workflows expose explicit manual compatibility entrypoints', async () => {
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

test('ACS triggers and docs keep production deployment manual on latest main without top-level paths', async () => {
  const workflow = await readFile(new URL('acs-sandbox.yml', root), 'utf8');
  const triggers = triggerBlock(workflow);
  const deploy = jobBlock(workflow, 'build-deploy');
  assert.doesNotMatch(triggers, /^\s+paths:/mu);
  assert.match(
    deploy,
    /if: github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/u,
  );
  assert.match(deploy, /Verify dispatch still targets latest main/u);
  assert.match(deploy, /latest_main_sha[\s\S]*"\$latest_main_sha" != "\$GITHUB_SHA"/u);
  assert.match(
    deploy,
    /PRODUCTION_SSH_HOST_KEY_SHA256: \$\{\{ vars\.PRODUCTION_SSH_HOST_KEY_SHA256 \}\}/u,
  );

  assert.match(deploy, /ssh-keyscan -T 10 -t ed25519 -H "\$ECS_HOST"/u);
  assert.match(deploy, /ssh-keygen -lf "\$scan_path" -E sha256/u);
  assert.match(deploy, /cat "\$scan_path" >> ~\/\.ssh\/known_hosts/u);
  assert.doesNotMatch(deploy, /ssh-keyscan -H "\$ECS_HOST" >> ~\/\.ssh\/known_hosts/u);

  const [acsDocs, releaseDocs] = await Promise.all([
    readFile(new URL('../../docs/acs-sandbox-release.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/release-workflow-configuration.md', import.meta.url), 'utf8'),
  ]);
  assert.match(acsDocs, /`main` push 只进入分类与测试，不部署生产/u);
  assert.match(acsDocs, /非 `main` dispatch 同样不会进入该生产 job/u);
  assert.match(acsDocs, /workflow 顶层没有 `paths` 过滤/u);
  assert.doesNotMatch(acsDocs, /非 main 手动触发只 build，不 deploy/u);
  assert.match(releaseDocs, /`main` push 顶层不使用 `paths`/u);
  assert.match(releaseDocs, /`\.github\/scripts\/acs-classify\.sh` 是唯一影响\s*分类真源/u);
});

test('all legacy jobs reading production Secrets bind exactly one production Environment and match docs', async () => {
  const app = await readFile(new URL('ci.yml', root), 'utf8');
  const acs = await readFile(new URL('acs-sandbox.yml', root), 'utf8');
  const productionSecrets = [
    'ALIYUN_ACCESS_KEY_ID',
    'ALIYUN_ACCESS_KEY_SECRET',
    'ACR_READ_ACCESS_KEY_ID',
    'ACR_READ_ACCESS_KEY_SECRET',
    'ECS_HOST',
    'ECS_USER',
    'ECS_SSH_KEY',
    'OSS_WEB_DEPLOY_AK_ID',
    'OSS_WEB_DEPLOY_AK_SECRET',
    'PRODUCTION_OBSERVATION_TOKEN',
    'RELEASE_EVIDENCE_WRITE_TOKEN',
    'ACS_WEBHOOK_REDELIVERY_TOKEN',
  ];

  for (const [name, workflow, expectedReaders] of [
    ['ci.yml', app, ['deploy_plan', 'deploy-ecs', 'deploy-web-oss']],
    ['acs-sandbox.yml', acs, ['build-deploy']],
  ]) {
    const readers = jobNames(workflow).filter((job) =>
      productionSecrets.some((secret) => jobBlock(workflow, job).includes(`secrets.${secret}`)),
    );
    assert.deepEqual(readers, expectedReaders, `${name} production Secret readers`);
    for (const job of readers) {
      const block = jobBlock(workflow, job);
      assert.match(block, /^    environment: production$/mu, `${name}:${job}`);
      assert.equal(
        block.match(/^    environment: production$/gmu)?.length,
        1,
        `${name}:${job} must bind production Environment exactly once`,
      );
    }
  }

  const releaseDocs = await readFile(
    new URL('../../docs/release-workflow-configuration.md', import.meta.url),
    'utf8',
  );
  const githubDocs = await readFile(new URL('../../docs/github配置.md', import.meta.url), 'utf8');
  const acsDocs = await readFile(
    new URL('../../docs/acs-sandbox-release.md', import.meta.url),
    'utf8',
  );
  for (const docs of [releaseDocs, githubDocs]) {
    assert.match(docs, /删除同名\s+(?:Repository|repository)\/organization Secrets?/u);
    assert.match(docs, /`ACR_READ_ACCESS_KEY_ID`/u);
    assert.match(docs, /`ACR_READ_ACCESS_KEY_SECRET`/u);
    assert.match(docs, /`OSS_WEB_DEPLOY_AK_ID`/u);
    assert.match(docs, /`OSS_WEB_DEPLOY_AK_SECRET`/u);
    assert.match(docs, /`ACS_WEBHOOK_REDELIVERY_TOKEN`/u);
  }
  assert.match(releaseDocs, /`deploy_plan`、`deploy-ecs`、`deploy-web-oss`/u);
  assert.match(releaseDocs, /可选恢复 Secret：`ACS_WEBHOOK_REDELIVERY_TOKEN`/u);
  assert.match(releaseDocs, /静态代码只能证明 job 的\s+Environment 绑定和引用名称/u);
  assert.match(acsDocs, /`ACS_WEBHOOK_REDELIVERY_TOKEN` 是可选恢复凭据/u);
  assert.doesNotMatch(githubDocs, /不得删除同名 Repository Secrets/u);
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
    /install -m 0444 (scripts\/release\/artifact-lib\.mjs[\s\S]*?) "\$stage\/scripts\/release\/"/u,
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

  const legacyRollbackStart = workflow.indexOf('restore_pre_drained_legacy_runtime()');
  const legacyRollbackEnd = workflow.indexOf('rollback_idle_and_exit()', legacyRollbackStart);
  const legacyRollback = workflow.slice(legacyRollbackStart, legacyRollbackEnd);
  assert.ok(legacyRollbackStart >= 0 && legacyRollbackEnd > legacyRollbackStart);
  assert.ok(
    legacyRollback.indexOf('systemctl disable --now "${WORKER_SERVICE}@${WORKER_IDLE}"') <
      legacyRollback.indexOf('systemctl restart "${WORKER_SERVICE}@${WORKER_ACTIVE}"'),
  );
  assert.match(workflow, /private ConfigIdentity fallback snapshot published before first App mutation/u);
  assert.match(workflow, /atomic App rollback remains authoritative/u);
  assert.match(workflow, /main rollback transaction and private identity fallback both own this candidate attempt/u);
  assert.match(workflow, /"\$COMPAT_ROLLBACK_STATE_DIR\/rollback\.sh"/u);
  assert.doesNotMatch(
    workflow,
    /install -m 0755 "\$RELEASE_DIR\/scripts\/release\/rollback-compatibility-app\.sh"/u,
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
