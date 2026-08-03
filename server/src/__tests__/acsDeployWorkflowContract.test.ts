import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const workflowPath = fileURLToPath(
  new URL('../../../.github/workflows/acs-sandbox.yml', import.meta.url),
);
const workflow = readFileSync(workflowPath, 'utf-8');

describe('ACS deploy workflow contract', () => {
  it('在等待镜像前拒绝已经落后于 main 的 dispatch', () => {
    const checkoutIndex = workflow.indexOf('- name: Checkout exact dispatch commit');
    const verifyIndex = workflow.indexOf('- name: Verify dispatch still targets latest main');
    const waitIndex = workflow.indexOf('- name: Wait for ACR auto-build of HEAD');
    const packIndex = workflow.indexOf('- name: Pack orchestrator release');

    expect(checkoutIndex).toBeGreaterThan(-1);
    expect(verifyIndex).toBeGreaterThan(checkoutIndex);
    expect(waitIndex).toBeGreaterThan(verifyIndex);
    expect(packIndex).toBeGreaterThan(waitIndex);
    expect(workflow).toContain('git fetch --quiet --no-tags origin main');
    expect(workflow).toContain('This run targets $GITHUB_SHA, but origin/main is now $latest_main_sha');
    expect(workflow).toContain('main advanced to $latest_main_sha before an ACR build record appeared');
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
    expect(workflow).toContain('tag.endswith(\'-\' + sha6)');
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
