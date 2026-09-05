import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd(), '..');
const classifierPath = join(repoRoot, '.github/scripts/runtime-worker-classify.sh');
const cleanupDirs = new Set<string>();

async function classify(paths: string[]): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-worker-classifier-'));
  cleanupDirs.add(dir);
  const changedFiles = join(dir, 'changed-files.txt');
  await writeFile(changedFiles, `${paths.join('\n')}\n`, 'utf-8');
  const output = execFileSync('bash', [classifierPath, changedFiles], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  return Object.fromEntries(
    output
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe('Runtime Worker 生产部署契约', () => {
  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('纯 Web/文档/Server 测试变更不滚动 worker，生产 Server 变更必须滚动', async () => {
    await expect(
      classify([
        'web/src/App.tsx',
        'docs/managed-agents-roadmap.md',
        'server/src/__tests__/runtimeWake.test.ts',
      ]),
    ).resolves.toMatchObject({ required: 'false' });

    await expect(
      classify(['web/src/App.tsx', 'server/src/runtime/rawAgentLoop.ts']),
    ).resolves.toMatchObject({
      required: 'true',
      reason: 'server/src/runtime/rawAgentLoop.ts',
    });
  });

  it('Web 蓝绿固定 ws-only，独立 worker 具备 pid/ready、身份刷新 watchdog 与 retention drain 门禁', async () => {
    const webUnit = await readFile(
      join(repoRoot, 'daemon-packaging/systemd/agent-saas-server@.service.template'),
      'utf-8',
    );
    const workerUnit = await readFile(
      join(repoRoot, 'daemon-packaging/systemd/agent-saas-runtime-worker@.service.template'),
      'utf-8',
    );
    const legacyWebUnit = await readFile(
      join(repoRoot, 'daemon-packaging/systemd/agent-saas-server.service.template'),
      'utf-8',
    );
    const nginxNasDropIn = await readFile(
      join(repoRoot, 'daemon-packaging/systemd/nginx-agent-saas-nas.conf'),
      'utf-8',
    );
    const workflow = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf-8');
    const authorityHelper = await readFile(
      join(repoRoot, 'scripts/release/compat-app-authority.sh'),
      'utf-8',
    );
    const rollbackHelper = await readFile(
      join(repoRoot, 'scripts/release/production-deploy-rollback.sh'),
      'utf-8',
    );
    const compatibilityRollback = await readFile(
      join(repoRoot, 'scripts/release/rollback-compatibility-app.sh'),
      'utf-8',
    );
    const serverEntry = await readFile(join(repoRoot, 'server/src/index.ts'), 'utf-8');
    const runtimeSource = await readFile(join(repoRoot, 'server/src/app/runtime.ts'), 'utf-8');
    const readinessSource = await readFile(
      join(repoRoot, 'server/src/runtime/runtimeWorkerReadiness.ts'),
      'utf-8',
    );
    const retentionSource = await readFile(
      join(repoRoot, 'server/src/runtime/runtimeEventRetention.ts'),
      'utf-8',
    );

    expect(webUnit).toContain('Environment=AGENT_SAAS_ENVIRONMENT=production');
    expect(webUnit).toContain('EnvironmentFile=-/etc/agent-saas/server-%i.release.env');
    expect(webUnit).toContain('ExecStart=/usr/bin/node --enable-source-maps dist/index.js');
    expect(webUnit).toContain('Environment=AGENT_SAAS_PROCESS_ROLE=ws-only');
    expect(webUnit).toContain('AGENT_SAAS_DRAIN_MARKER=/run/agent-saas-server-%i.draining');
    expect(legacyWebUnit).toContain('Environment=AGENT_SAAS_ENVIRONMENT=production');
    expect(webUnit).toContain(
      'ExecCondition=/usr/bin/test ! -e /run/agent-saas-server-%i.draining',
    );
    expect(workerUnit).toContain('Environment=AGENT_SAAS_ENVIRONMENT=production');
    expect(workerUnit).toContain('EnvironmentFile=-/etc/agent-saas/runtime-worker-%i.release.env');
    expect(workerUnit).toContain('ExecStart=/usr/bin/node --enable-source-maps dist/index.js');
    expect(workerUnit).toContain('Environment=AGENT_SAAS_PROCESS_ROLE=runtime-worker');
    expect(workerUnit).toContain('AGENT_SAAS_PIDFILE=/run/agent-saas-runtime-worker-%i.pid');
    expect(workerUnit).toContain('AGENT_SAAS_READYFILE=/run/agent-saas-runtime-worker-%i.ready');
    expect(workerUnit).toContain(
      'AGENT_SAAS_CONFIG_IDENTITY_PATH=/run/agent-saas-runtime-worker-%i.config-identity.json',
    );
    expect(workerUnit).toContain(
      'AGENT_SAAS_DRAIN_MARKER=/run/agent-saas-runtime-worker-%i.draining',
    );
    expect(workerUnit).toContain(
      'ExecCondition=/usr/bin/test ! -e /run/agent-saas-runtime-worker-%i.draining',
    );
    expect(workerUnit).toContain(
      'ExecStartPre=/usr/bin/rm -f /run/agent-saas-runtime-worker-%i.ready /run/agent-saas-runtime-worker-%i.config-identity.json',
    );
    expect(workerUnit).toContain('WorkingDirectory=/opt/agent-saas-app/worker/%i/server');
    expect(workerUnit).toContain('MemoryHigh=45%');
    expect(workerUnit).toContain('MemoryMax=60%');
    expect(workerUnit).toContain('MemorySwapMax=0');
    expect(workerUnit).toContain('OOMPolicy=stop');
    expect(workerUnit).toContain('OOMScoreAdjust=500');
    expect(workerUnit).toContain('RestartSec=30');
    expect(webUnit).toContain('RequiresMountsFor=/mnt/agent-workspaces /mnt/agent-saas');
    expect(workerUnit).toContain('RequiresMountsFor=/mnt/agent-workspaces /mnt/agent-saas');
    expect(nginxNasDropIn).toContain('RequiresMountsFor=/mnt/agent-saas');
    expect(webUnit.indexOf('Environment=AGENT_SAAS_ENVIRONMENT=production')).toBeGreaterThan(
      webUnit.lastIndexOf('EnvironmentFile='),
    );
    expect(workerUnit.indexOf('Environment=AGENT_SAAS_ENVIRONMENT=production')).toBeGreaterThan(
      workerUnit.lastIndexOf('EnvironmentFile='),
    );
    expect(legacyWebUnit.indexOf('Environment=AGENT_SAAS_ENVIRONMENT=production')).toBeGreaterThan(
      legacyWebUnit.lastIndexOf('EnvironmentFile='),
    );
    expect(webUnit.indexOf('Environment=AGENT_SAAS_PROCESS_ROLE=ws-only')).toBeGreaterThan(
      webUnit.lastIndexOf('EnvironmentFile='),
    );
    expect(
      workerUnit.indexOf('Environment=AGENT_SAAS_PROCESS_ROLE=runtime-worker'),
    ).toBeGreaterThan(workerUnit.lastIndexOf('EnvironmentFile='));
    expect(workflow).toContain(
      'runtime worker split blocked because production clientDaemon is configured',
    );
    expect(workflow).toContain(
      'runtime worker split blocked because active clientDaemon devices exist',
    );
    expect(workflow).toContain('if (config?.clientDaemon) process.exit(42)');
    expect(workflow).toContain('systemctl disable "${SERVICE_NAME}@${ACTIVE}"');
    expect(workflow).toContain('systemctl disable "${WORKER_SERVICE}@${WORKER_ACTIVE}"');
    expect(workflow).toContain('runtime worker drain restart guard armed');
    expect(workflow).toContain('source "$RELEASE_DIR/scripts/release/compat-app-authority.sh"');
    expect(workflow).toContain('commit_app_active_colors()');
    expect(authorityHelper).toContain('commit_compat_app_active_colors()');
    expect(workflow).toContain('commit_app_active_colors "$IDLE" "$APP_WORKER_TARGET"');
    expect(workflow).toContain('ready.authority');
    expect(workflow).toContain('"/run/agent-saas-runtime-worker-${WORKER_IDLE}.draining"');
    expect(workflow).toContain('nginx.service.d/agent-saas-nas.conf');
    const rollbackStart = workflow.indexOf('rollback_idle_and_exit()');
    const rollbackEnd = workflow.indexOf('recover_interrupted_runtime_worker_drain()', rollbackStart);
    const rollbackBlock = workflow.slice(rollbackStart, rollbackEnd);
    expect(rollbackStart).toBeGreaterThan(-1);
    expect(rollbackEnd).toBeGreaterThan(rollbackStart);
    expect(rollbackBlock).toContain('COMPAT_ROLLBACK_PUBLISHED');
    expect(rollbackBlock).toContain('compat-deploy-attempt-current');
    expect(rollbackBlock).toContain('restore_pre_drained_legacy_runtime');
    expect(rollbackBlock).toContain('COMPAT_ROLLBACK_STATE_DIR');
    expect(rollbackBlock).toContain('rm -f "$DEPLOY_ROOT/compat-deploy-attempt-current"');
    expect(workflow).toContain(
      'source "$RELEASE_DIR/scripts/release/production-deploy-rollback.sh"',
    );
    expect(rollbackHelper).toContain('production_deploy_rollback()');
    expect(rollbackHelper).toContain('declare -F rollback_idle_and_exit');

    const authorityCommit = workflow.indexOf(
      'if ! commit_app_active_colors "$IDLE" "$APP_WORKER_TARGET"; then',
    );
    const nginxReload = workflow.indexOf('if ! systemctl reload nginx; then', authorityCommit);
    const handoffCall = workflow.indexOf(
      'if ! refresh_worker_candidate_authority; then',
      nginxReload,
    );
    expect(authorityCommit).toBeGreaterThan(-1);
    expect(nginxReload).toBeGreaterThan(authorityCommit);
    expect(handoffCall).toBeGreaterThan(nginxReload);

    const refreshStart = workflow.indexOf('refresh_worker_candidate_authority()');
    const refreshEnd = workflow.indexOf(
      'runtime worker handoff staged until final App authority commit',
      refreshStart,
    );
    const refreshBlock = workflow.slice(refreshStart, refreshEnd);
    const oldWorkerDrain = refreshBlock.indexOf('kill -USR2 "$OLD_WORKER_PID"');
    const authorityRefresh = refreshBlock.indexOf('kill -USR1 "$worker_pid"', oldWorkerDrain);
    expect(refreshStart).toBeGreaterThan(-1);
    expect(refreshEnd).toBeGreaterThan(refreshStart);
    expect(oldWorkerDrain).toBeGreaterThan(-1);
    expect(authorityRefresh).toBeGreaterThan(oldWorkerDrain);
    expect(workflow).toContain('worker_main_pid=$(systemctl show "${WORKER_SERVICE}@${WORKER_IDLE}" -p MainPID --value');
    // 保留主线后续的恢复预算与候选 PID 稳定性门禁；兼容 rollback 已迁入独立 helper。
    expect(workflow).toContain('WORKER_CANDIDATE_INITIAL_PID="$worker_pid"');
    expect(workflow).toContain('WORKER_POST_DRAIN_READY=0');
    expect(workflow).toContain('REMOTE_DEPLOY_START_EPOCH=$(date +%s)');
    expect(workflow).toContain('START_EPOCH=$REMOTE_DEPLOY_START_EPOCH');
    expect(workflow).toContain('DEPLOY_ROLLBACK_RESERVE_SECONDS=300');
    expect(workflow).toContain('invalid REMOTE_DEPLOY_TIMEOUT_SECONDS=');
    expect(workflow).toContain('invalid REMOTE_DEPLOY_START_EPOCH=');
    expect(workflow).toContain('DEPLOY_FAILSAFE_DEADLINE_EPOCH=');
    expect(workflow).toContain('ensure_pre_switch_budget()');
    expect(workflow).toContain('ensure_pre_switch_budget "runtime-worker-authority-refresh"');
    expect(workflow).toContain('ensure_pre_switch_budget "runtime-worker-authority-confirmed"');
    expect(workflow).toContain('ensure_pre_switch_budget "web-readiness"');
    expect(workflow).toContain('ensure_pre_switch_budget "web-warmup"');
    expect(workflow.indexOf('ensure_pre_switch_budget "nginx-config"')).toBeLessThan(
      workflow.indexOf('UPSTREAM_BAK="/tmp/agent-saas-upstream.conf.bak.$$"'),
    );
    expect(workflow).not.toContain('ensure_pre_switch_budget "nginx-switch"');
    expect(workflow).toContain('WORKER_POST_DRAIN_DEADLINE_EPOCH=');
    expect(workflow).toContain('runtime worker candidate restarted during old drain and recovered');
    expect(workflow).toContain('runtime worker candidate failed readiness after old drain');
    expect(workflow).not.toContain(
      'runtime worker candidate identity changed before authority refresh',
    );
    expect(workflow).toContain('kill -USR1 "$worker_pid"');
    expect(workflow).toContain('runtime worker candidate changed after authority refresh');
    expect(workflow).toContain('[ "$worker_current_pid" != "$worker_pid" ]');
    expect(workflow).toContain('deployment failsafe deadline reached before traffic switch');
    expect(workflow).toContain('WORKER_DRAIN_TIMEOUT=960');
    expect(workflow).toContain('WORKER_POST_DRAIN_WAITED=$((WORKER_POST_DRAIN_WAITED + 1))');
    expect(workflow).toContain('WORKER_ACTIVE_DRAIN_COMPLETED=1');
    expect(workflow).toContain('recover interrupted runtime worker drain before rollout');
    expect(workflow).toContain(
      'interrupted runtime worker candidate drained after active recovery',
    );
    expect(
      workflow.split('recover_interrupted_runtime_worker_drain "$WORKER_ACTIVE"'),
    ).toHaveLength(3);
    expect(workflow).not.toContain('WORKER_V3_READY_TIMEOUT');
    expect(workflow).not.toContain('integrationV3ControlPlane');
    expect(workflow).not.toContain('taskboard_integration_activation_heartbeats_v3');
    expect(workflow).not.toContain('runtime worker candidate failed readiness after Web cutover');
    expect(workflow).toContain(
      'idle drain endpoint unavailable; marker snapshot reports activeUploads=',
    );
    expect(workflow).toContain(
      'rm -f "/run/${SERVICE_NAME}-${IDLE}.pid" "/run/${SERVICE_NAME}-${IDLE}.draining"',
    );
    expect(authorityHelper).toContain('wait_api_ready "$API_OLD_COLOR"');
    expect(authorityHelper).toContain(
      'systemctl disable --now "$SERVICE@$API_NEW_COLOR"',
    );
    expect(compatibilityRollback).toContain(
      'TARGET_DRAIN_SNAPSHOT="$(cat "$RUN_DIR/$SERVICE-$OTHER.draining"',
    );
    expect(compatibilityRollback).toContain('state.activeRuns.blocking');
    expect(compatibilityRollback).toContain('safe &&= state.runtimeQuiesced === true');
    expect(compatibilityRollback).toContain(
      'rollback refused: target $OTHER verified drain state is $TARGET_DRAIN_SAFETY',
    );
    expect(compatibilityRollback).toContain('rm -f "$RUN_DIR/$SERVICE-$API_ACTIVE.pid"');
    expect(compatibilityRollback).toContain('target_server_identity_ready');
    expect(compatibilityRollback).toContain(
      'readiness identity does not match rollback release SHA',
    );
    expect(serverEntry).toContain(
      'writeDrainMarker({ activeStreams: active, activeUploads, runtimeQuiesced })',
    );
    expect(serverEntry).toContain('runtime?.getRuntimeAdmissionSnapshot?.(),');
    expect(serverEntry).toContain('await runtime.refreshConfigIdentitySummary()');
    expect(serverEntry).toContain('if (!readyFile || runtimeReadyFileSyncPending) return;');
    expect(serverEntry).toContain('identityRefreshWatchdog = setTimeout(() => {');
    expect(serverEntry).toContain('fs.rmSync(readyFile, { force: true })');
    expect(serverEntry).toContain('await syncRuntimeWorkerReadyFile()');
    expect(serverEntry).toContain(
      'runtimeReadyFileTimer = setInterval(() => { void syncRuntimeWorkerReadyFile(); }, 1_000)',
    );
    expect(runtimeSource).toContain('createRuntimeEventRetentionAdmissionGuard(');
    expect(runtimeSource).toContain('admissionGuard: runtimeAdmissionGuard');
    expect(runtimeSource).toContain(
      'enableSingletonWorkers && config.runtimeEventRetention?.enabled === true',
    );
    expect(runtimeSource).toContain(
      "startupFailureMode: processRole === 'runtime-worker' ? 'throw'",
    );
    expect(runtimeSource).toContain('statusAuthorityTable: systemMetricsStore?.systemMetricsTable');
    expect(retentionSource).toContain(
      'runtime-worker failed to establish RuntimeEventRetention status authority',
    );
    expect(retentionSource).toContain('withExecutionAuthority');
    expect(retentionSource).toContain('this.startupRetryTimer = setTimeout(');
    expect(runtimeSource).toContain('await runtimeEventRetention?.quiesce()');
    expect(readinessSource).toContain('runtime_event_retention_status_unavailable');
  });
});
