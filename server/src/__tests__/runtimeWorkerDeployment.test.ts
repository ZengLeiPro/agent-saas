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
  return Object.fromEntries(output.trim().split('\n').map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

describe('Runtime Worker 生产部署契约', () => {
  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('纯 Web/文档/Server 测试变更不滚动 worker，生产 Server 变更必须滚动', async () => {
    await expect(classify([
      'web/src/App.tsx',
      'docs/managed-agents-roadmap.md',
      'server/src/__tests__/runtimeWake.test.ts',
    ])).resolves.toMatchObject({ required: 'false' });

    await expect(classify([
      'web/src/App.tsx',
      'server/src/runtime/rawAgentLoop.ts',
    ])).resolves.toMatchObject({
      required: 'true',
      reason: 'server/src/runtime/rawAgentLoop.ts',
    });
  });

  it('Web 蓝绿固定 ws-only，独立 worker 固定 runtime-worker 并有 pid/ready 门禁', async () => {
    const webUnit = await readFile(
      join(repoRoot, 'daemon-packaging/systemd/agent-saas-server@.service.template'),
      'utf-8',
    );
    const workerUnit = await readFile(
      join(repoRoot, 'daemon-packaging/systemd/agent-saas-runtime-worker@.service.template'),
      'utf-8',
    );
    const workflow = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf-8');

    expect(webUnit).toContain('Environment=AGENT_SAAS_PROCESS_ROLE=ws-only');
    expect(workerUnit).toContain('Environment=AGENT_SAAS_PROCESS_ROLE=runtime-worker');
    expect(workerUnit).toContain('AGENT_SAAS_PIDFILE=/run/agent-saas-runtime-worker-%i.pid');
    expect(workerUnit).toContain('AGENT_SAAS_READYFILE=/run/agent-saas-runtime-worker-%i.ready');
    expect(workerUnit).toContain('WorkingDirectory=/opt/agent-saas-app/worker/%i/server');
    expect(webUnit.indexOf('Environment=AGENT_SAAS_PROCESS_ROLE=ws-only'))
      .toBeGreaterThan(webUnit.lastIndexOf('EnvironmentFile='));
    expect(workerUnit.indexOf('Environment=AGENT_SAAS_PROCESS_ROLE=runtime-worker'))
      .toBeGreaterThan(workerUnit.lastIndexOf('EnvironmentFile='));
    expect(workflow).toContain('runtime worker split blocked because production clientDaemon is configured');
    expect(workflow).toContain('runtime worker split blocked because active clientDaemon devices exist');
    expect(workflow).toContain('if (config?.clientDaemon) process.exit(42)');
  });
});
