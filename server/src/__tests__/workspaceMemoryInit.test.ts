/**
 * ensureUserWorkspace → MEMORY.md 初始化渲染测试
 *
 * 覆盖 {{displayName}} / {{positionNote}} / {{createdDate}} 占位符：
 * 岗位有值时拼「（岗位：xxx）」，无值时占位符干净移除（不留残渣）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureUserWorkspace, resolveUserCwd } from '../workspace/resolver.js';

const TEMPLATE = [
  '# 长期记忆',
  '',
  '## 当前用户',
  '',
  '- {{displayName}}{{positionNote}}：账号创建于 {{createdDate}}',
  '',
].join('\n');

describe('ensureUserWorkspace MEMORY.md 初始化', () => {
  let tmpRoot: string;
  let agentCwd: string;
  let sharedDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'workspace-memory-init-'));
    agentCwd = join(tmpRoot, 'workspaces');
    sharedDir = join(tmpRoot, 'shared');
    mkdirSync(agentCwd, { recursive: true });
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, 'MEMORY.template.md'), TEMPLATE, 'utf-8');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('岗位有值：写入「（岗位：xxx）」', async () => {
    const user = { id: 'ky000000000001', username: 'chenyx', role: 'user' as const, tenantId: 'kaiyan' };
    const userCwd = resolveUserCwd(agentCwd, user);
    await ensureUserWorkspace(userCwd, agentCwd, sharedDir, user, { realName: '陈育新', position: '销售' });

    const memory = readFileSync(join(userCwd, 'MEMORY.md'), 'utf-8');
    expect(memory).toContain('- 陈育新（岗位：销售）：账号创建于 ');
    expect(memory).not.toContain('{{');
  });

  it('岗位无值：占位符干净移除，不留残渣', async () => {
    const user = { id: 'ky000000000002', username: 'nopos', role: 'user' as const, tenantId: 'kaiyan' };
    const userCwd = resolveUserCwd(agentCwd, user);
    await ensureUserWorkspace(userCwd, agentCwd, sharedDir, user, { realName: '无岗位' });

    const memory = readFileSync(join(userCwd, 'MEMORY.md'), 'utf-8');
    expect(memory).toContain('- 无岗位：账号创建于 ');
    expect(memory).not.toContain('（岗位：');
    expect(memory).not.toContain('{{');
  });

  it('岗位为纯空白：视为无岗位', async () => {
    const user = { id: 'ky000000000003', username: 'blankpos', role: 'user' as const, tenantId: 'kaiyan' };
    const userCwd = resolveUserCwd(agentCwd, user);
    await ensureUserWorkspace(userCwd, agentCwd, sharedDir, user, { realName: '空白岗位', position: '  ' });

    const memory = readFileSync(join(userCwd, 'MEMORY.md'), 'utf-8');
    expect(memory).toContain('- 空白岗位：账号创建于 ');
    expect(memory).not.toContain('（岗位：');
  });
});
