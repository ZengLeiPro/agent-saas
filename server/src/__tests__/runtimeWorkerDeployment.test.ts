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

  it('Web 蓝绿固定 ws-only，独立 worker 固定 runtime-worker 并有 pid/ready 与 retention drain 门禁', async () => {
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
      'AGENT_SAAS_DRAIN_MARKER=/run/agent-saas-runtime-worker-%i.draining',
    );
    expect(workerUnit).toContain(
      'ExecCondition=/usr/bin/test ! -e /run/agent-saas-runtime-worker-%i.draining',
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
    expect(workflow).toContain('"/run/agent-saas-runtime-worker-${WORKER_IDLE}.draining"');
    expect(workflow).toContain('nginx.service.d/agent-saas-nas.conf');
    const rollbackStart = workflow.indexOf('rollback_idle_and_exit()');
    const rollbackEnd = workflow.indexOf('# ── 5.5 Runtime Worker 候选', rollbackStart);
    const rollbackBlock = workflow.slice(rollbackStart, rollbackEnd);
    expect(rollbackStart).toBeGreaterThan(-1);
    expect(rollbackEnd).toBeGreaterThan(rollbackStart);
    expect(rollbackBlock).toContain('systemctl disable --now "${WORKER_SERVICE}@${WORKER_IDLE}"');
    expect(rollbackBlock).toContain('restore previous runtime worker after pre-Web failure');
    expect(rollbackBlock).toContain('echo "$WORKER_ACTIVE" > "$WORKER_ACTIVE_COLOR_FILE"');
    expect(rollbackBlock).toContain('WORKER_ACTIVE_DRAIN_STARTED');
    expect(rollbackBlock).toContain('systemctl enable "${WORKER_SERVICE}@${WORKER_ACTIVE}"');
    expect(rollbackBlock).toContain('systemctl restart "${WORKER_SERVICE}@${WORKER_ACTIVE}"');
    expect(
      rollbackBlock.indexOf('previous runtime worker restored before candidate stop'),
    ).toBeLessThan(rollbackBlock.indexOf('stop runtime worker candidate:'));
    expect(workflow).toContain('WORKER_DRAIN_TIMEOUT=960');
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
    expect(workflow).toContain(
      'rollback drain endpoint unavailable; marker snapshot reports activeUploads=',
    );
    expect(workflow).toContain(
      'rm -f "/run/${SERVICE}-${OTHER}.pid" "/run/${SERVICE}-${OTHER}.draining"',
    );
    expect(serverEntry).toContain(
      'writeDrainMarker({ activeStreams: active, activeUploads, runtimeQuiesced })',
    );
    expect(serverEntry).toContain(
      'projectRuntimeWorkerReadyFile(readyFile, runtime?.getRuntimeAdmissionSnapshot?.())',
    );
    expect(serverEntry).toContain(
      'runtimeReadyFileTimer = setInterval(syncRuntimeWorkerReadyFile, 1_000)',
    );
    expect(runtimeSource).toContain('createRuntimeEventRetentionAdmissionGuard(');
    expect(runtimeSource).toContain('admissionGuard: runtimeAdmissionGuard');
    expect(runtimeSource).toContain('enableSingletonWorkers && config.runtimeEventRetention?.enabled === true');
    expect(runtimeSource).toContain("startupFailureMode: processRole === 'runtime-worker' ? 'throw'");
    expect(retentionSource).toContain('runtime-worker failed to establish RuntimeEventRetention status authority');
    expect(retentionSource).toContain('this.startupRetryTimer = setTimeout(');
    expect(runtimeSource).toContain('await runtimeEventRetention?.quiesce()');
    expect(readinessSource).toContain('runtime_event_retention_status_unavailable');
  });
});
