import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = resolve(process.cwd(), '..');
const classifierPath = join(repoRoot, '.github/scripts/ecs-release-classify.sh');
const workflowPath = join(repoRoot, '.github/workflows/ci.yml');
const cleanupDirs = new Set<string>();

async function classify(paths: string[]): Promise<Record<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'ecs-release-classifier-'));
  cleanupDirs.add(dir);
  const changedFiles = join(dir, 'changed-files.txt');
  await writeFile(changedFiles, paths.length > 0 ? `${paths.join('\n')}\n` : '', 'utf-8');
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

describe('App 生产部署门禁', () => {
  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it('纯 Web、Mobile、文档与 Server 测试变更不要求滚动 ECS', async () => {
    await expect(
      classify([
        'web/src/App.tsx',
        'web/src/App.test.tsx',
        'mobile/app/index.tsx',
        'docs/deployment.md',
        'README.md',
        'server/src/__tests__/runtimeWake.test.ts',
        'scripts/deploy-recovery-web.sh',
      ]),
    ).resolves.toMatchObject({
      required: 'false',
      reason: 'none',
    });
  });

  it('Server、Shared、技能源、依赖、部署配置与未知路径都保守要求 ECS', async () => {
    const result = await classify([
      'web/src/App.tsx',
      'server/src/index.ts',
      'shared/src/types.ts',
      'workspace-shared/.ky-agent/skills-pool/explore/SKILL.md',
      'workspace-shared/.ky-agent/skills-pool/ky-data-query/references/xiaohongshu-spotlight.md',
      'pnpm-lock.yaml',
      'daemon-packaging/systemd/agent-saas-server@.service.template',
      '.github/workflows/ci.yml',
    ]);

    expect(result.required).toBe('true');
    expect(result.reason).toContain('server/src/index.ts');
    expect(result.reason).toContain('shared/src/types.ts');
    expect(result.reason).toContain('workspace-shared/.ky-agent/skills-pool/explore/SKILL.md');
    expect(result.reason).toContain(
      'workspace-shared/.ky-agent/skills-pool/ky-data-query/references/xiaohongshu-spotlight.md',
    );
    expect(result.reason).toContain('.github/workflows/ci.yml');
  });

  it('生产已在目标 SHA 时允许跳过 ECS，由 Web 发布独立修复入口', async () => {
    await expect(classify([])).resolves.toMatchObject({
      required: 'false',
      reason: 'none',
      skipped: 'none',
    });
  });

  it('仅保留 Web-only compatibility dispatch，并维持固定 RC Promotion 发布入口', async () => {
    const workflow = await readFile(workflowPath, 'utf-8');
    const promotion = await readFile(
      join(repoRoot, '.github/workflows/promote-release.yml'),
      'utf-8',
    );
    const planStart = workflow.indexOf('  deploy_plan:');
    const ecsStart = workflow.indexOf('  deploy-ecs:');
    const webStart = workflow.indexOf('  deploy-web-oss:');
    const plan = workflow.slice(planStart, ecsStart);
    const ecs = workflow.slice(ecsStart, webStart);
    const web = workflow.slice(webStart);
    const triggerBlock = workflow.slice(
      workflow.indexOf('on:\n'),
      workflow.indexOf('\nconcurrency:'),
    );

    expect(planStart).toBeGreaterThan(-1);
    expect(ecsStart).toBeGreaterThan(planStart);
    expect(webStart).toBeGreaterThan(ecsStart);
    expect(triggerBlock).toContain('workflow_dispatch:');
    expect(triggerBlock).toContain('web_only_compatibility:');
    expect(triggerBlock).toContain('required: true');
    expect(triggerBlock).toContain('type: boolean');
    expect(triggerBlock).not.toContain('force_ecs:');
    expect(plan).toContain('Confirm Web-only compatibility scope');
    expect(plan).toContain('block_server_compatibility');
    expect(plan).toContain('cannot atomically compensate ECS + Web across jobs');
    expect(ecs).toContain('needs: [build, deploy_plan]');
    expect(ecs).toContain("github.event_name == 'workflow_dispatch'");
    expect(web).toContain('needs: [build, deploy_plan, deploy-ecs]');
    expect(web).toContain("github.event_name == 'workflow_dispatch'");
    expect(web).toContain("needs.deploy_plan.outputs.ecs_required == 'false'");
    expect(web).not.toContain("needs.deploy_plan.outputs.ecs_required == 'true'");
    expect(promotion).toContain('workflow_dispatch:');
    expect(promotion).toContain('release_id:');
    expect(promotion).toContain('environment: production');
  });
});
