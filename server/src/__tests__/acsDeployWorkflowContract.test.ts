import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(
  new URL('../../../.github/workflows/acs-sandbox.yml', import.meta.url),
);
const workflow = readFileSync(workflowPath, 'utf-8');
const classifierPath = fileURLToPath(
  new URL('../../../.github/scripts/acs-classify.sh', import.meta.url),
);

function classify(paths: string[]): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'acs-impact-'));
  const fixture = join(directory, 'changed-files.txt');
  try {
    writeFileSync(fixture, `${paths.join('\n')}\n`, 'utf8');
    const output = execFileSync('bash', [classifierPath, fixture], { encoding: 'utf8' });
    return Object.fromEntries(
      output
        .trim()
        .split('\n')
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('ACS deploy workflow contract', () => {
  it('为所有 main PR 提供固定名称且不读取生产 secret 的 ACS Impact Gate', () => {
    expect(workflow).toContain('pull_request:\n    branches: [main]');
    expect(workflow).toContain('acs-impact-gate:');
    expect(workflow).toContain('name: ACS Impact Gate');
    expect(workflow).toContain("if: github.event_name == 'pull_request'");
    expect(workflow).toContain("if: github.event_name != 'pull_request'");
    expect(workflow).toContain('result: \\`not_required\\`');

    const gateStart = workflow.indexOf('  acs-impact-gate:');
    const changesStart = workflow.indexOf('  changes:', gateStart);
    const gate = workflow.slice(gateStart, changesStart);
    expect(gate).not.toContain('secrets.');
    expect(gate).not.toContain('workflow_dispatch');
  });

  it('对普通 UI、ACS 源码和 ACS Workflow fixture 给出稳定分类', () => {
    expect(classify(['web/src/App.tsx'])).toMatchObject({
      publish: 'false',
      contract_check: 'false',
      reason: 'none',
    });
    expect(classify(['acs-orchestrator/src/config.ts'])).toMatchObject({
      publish: 'true',
      contract_check: 'false',
    });
    expect(classify(['.github/workflows/acs-sandbox.yml'])).toMatchObject({
      publish: 'true',
      contract_check: 'false',
    });
  });

  it('在等待镜像前拒绝已经落后于 main 的 dispatch', () => {
    const checkoutIndex = workflow.indexOf('- name: Checkout exact dispatch commit');
    const verifyIndex = workflow.indexOf('- name: Verify dispatch still targets latest main');
    const waitIndex = workflow.indexOf('- name: Wait for ACR auto-build of HEAD');
    const packIndex = workflow.indexOf('- name: Pack and identify orchestrator release');

    expect(checkoutIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(checkoutIndex);
    expect(waitIndex).toBeGreaterThan(verifyIndex);
    expect(packIndex).toBeGreaterThan(waitIndex);
    expect(workflow).toContain('git fetch --quiet --no-tags origin main');
    expect(workflow).toContain(
      'This run targets $GITHUB_SHA, but origin/main is now $latest_main_sha',
    );
    expect(workflow).toContain(
      'main advanced to $latest_main_sha before an ACR build record appeared',
    );
  });

  it('发现 exact SHA 构建记录后不因 main 推进中断等待', () => {
    expect(workflow).toContain('build_record_found=false');
    expect(workflow).toContain('if [ "$build_record_found" = "true" ]; then');
    expect(workflow).toContain('ACR build record disappeared');
    expect(workflow).toContain('build_record_found=true');
    expect(workflow).toContain('后续 main 推进不影响本次代码与镜像仍使用同一个 GITHUB_SHA');
    expect(workflow).not.toContain('while this run was waiting for image');
  });

  it('串行化生产部署且不取消正在进行的发布', () => {
    expect(workflow).toContain('group: acs-production-deploy');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('只接受 exact SHA 镜像并对缺失构建记录快速失败', () => {
    expect(workflow).toContain('SHA6="${GITHUB_SHA:0:6}"');
    expect(workflow).toContain('MAX_MISSING_POLLS=6');
    expect(workflow).toContain('MAX_QUERY_ERRORS=3');
    expect(workflow).toContain("tag.endswith('-' + sha6)");
    expect(workflow).toContain('a later image will not be substituted');
    expect(workflow).not.toContain('for i in $(seq 1 60)');
  });

  it('为 ACR 排队和实际构建保留独立等待预算', () => {
    expect(workflow).toContain('timeout-minutes: 75');
    expect(workflow).toContain('MAX_PENDING_POLLS=40');
    expect(workflow).toContain('MAX_BUILDING_POLLS=60');
    expect(workflow).toContain('pending_polls=$((pending_polls + 1))');
    expect(workflow).toContain('building_polls=$((building_polls + 1))');
    expect(workflow).toContain('ACR build queue timeout');
    expect(workflow).toContain('ACR build timeout');
    expect(workflow).not.toContain('MAX_POLLS=40');
  });
});
