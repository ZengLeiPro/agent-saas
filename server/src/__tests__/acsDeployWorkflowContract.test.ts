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
    expect(workflow).toContain('main advanced to $latest_main_sha while this run was waiting');
  });

  it('只接受 exact SHA 镜像并对缺失构建记录快速失败', () => {
    expect(workflow).toContain('SHA6="${GITHUB_SHA:0:6}"');
    expect(workflow).toContain('MAX_MISSING_POLLS=6');
    expect(workflow).toContain('MAX_QUERY_ERRORS=3');
    expect(workflow).toContain('MAX_POLLS=40');
    expect(workflow).toContain('tag.endswith(\'-\' + sha6)');
    expect(workflow).toContain('a later image will not be substituted');
    expect(workflow).not.toContain('for i in $(seq 1 60)');
  });
});
