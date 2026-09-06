/**
 * WP3 Phase A：授权模式自动裁决（`channel.ts` 外提件）的行为钉死。
 *
 * 重点是规范 DoD 第三条的前半：
 * 授权模式开启时 `app__` 的 `read_only` 放行、`external_write` **仍必须弹确认**。
 * 其余用例是外提前后行为一致的回归。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toolName as buildAppToolName } from '@kaiyan/ky-app-contract';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  isAppReadOnlyTool,
  rememberAppCapabilityTool,
  requiresAppWriteConfirmation,
  resetAppCapabilityRiskRegistryForTest,
} from '../../kyapp/gateway/toolRiskRegistry.js';
import { decideAuthorizationModeTool } from './authorizationModeDecision.js';

const AGENT_CWD = join(tmpdir(), 'wp3-auth-mode-agent-cwd');
const USER = { id: 'u-1', username: 'alice', role: 'user' as const, tenantId: 'org-1' };

const READ_TOOL = buildAppToolName('demo-erp', 'order.search');
const WRITE_TOOL = buildAppToolName('demo-erp', 'order.create');
const UNKNOWN_TOOL = buildAppToolName('demo-erp', 'never-registered');

function appToolMeta(risk: 'read_only' | 'external_write', capabilityId: string) {
  return {
    risk,
    systemId: 'demo_erp',
    systemName: '演示 ERP',
    capabilityId,
    capabilityName: risk === 'read_only' ? '查订单' : '建订单',
    installationId: 'iid-1',
  } as const;
}

function decide(
  toolName: string | undefined,
  toolInput?: Record<string, unknown>,
  toolId?: string,
) {
  return decideAuthorizationModeTool({
    toolName,
    toolId,
    toolInput,
    agentCwd: AGENT_CWD,
    user: USER,
  });
}

describe('decideAuthorizationModeTool —— 定制项目能力（规范 §6.1/§6.2）', () => {
  beforeEach(() => {
    resetAppCapabilityRiskRegistryForTest();
    rememberAppCapabilityTool(READ_TOOL, appToolMeta('read_only', 'order_search'));
    rememberAppCapabilityTool(WRITE_TOOL, appToolMeta('external_write', 'order_create'));
  });

  it('工具名走契约包 toolName()，前缀为 app__', () => {
    expect(READ_TOOL).toBe('app__demo_erp__order_search');
    expect(WRITE_TOOL).toBe('app__demo_erp__order_create');
  });

  it('授权模式下 read_only 能力直接放行', () => {
    expect(decide(READ_TOOL)).toEqual({ allow: true });
    expect(isAppReadOnlyTool(READ_TOOL)).toBe(true);
    expect(requiresAppWriteConfirmation(READ_TOOL)).toBe(false);
  });

  it('授权模式下 external_write 能力不表态 → 落人工确认', () => {
    expect(decide(WRITE_TOOL)).toBeUndefined();
    expect(requiresAppWriteConfirmation(WRITE_TOOL)).toBe(true);
  });

  it('风险档未登记的 app__ 工具 fail-closed 按写能力处理', () => {
    expect(decide(UNKNOWN_TOOL)).toBeUndefined();
    expect(requiresAppWriteConfirmation(UNKNOWN_TOOL)).toBe(true);
    expect(isAppReadOnlyTool(UNKNOWN_TOOL)).toBe(false);
  });

  it('toolId 为写能力、toolName 为只读时仍按写处理（取最严）', () => {
    expect(decide(READ_TOOL, undefined, WRITE_TOOL)).toBeUndefined();
    expect(requiresAppWriteConfirmation(READ_TOOL, WRITE_TOOL)).toBe(true);
  });

  it('非 app__ 工具不受登记表影响', () => {
    expect(requiresAppWriteConfirmation('Bash')).toBe(false);
    expect(requiresAppWriteConfirmation(undefined, undefined)).toBe(false);
  });
});

describe('decideAuthorizationModeTool —— 外提前行为回归', () => {
  beforeEach(() => {
    resetAppCapabilityRiskRegistryForTest();
  });

  it('安全工具与 mcp__ 前缀放行', () => {
    expect(decide('WebSearch')).toEqual({ allow: true });
    expect(decide('TodoWrite')).toEqual({ allow: true });
    expect(decide('mcp__github__list_issues')).toEqual({ allow: true });
  });

  it('未知工具兜底拒绝', () => {
    expect(decide('SomeBrandNewTool')).toEqual({
      allow: false,
      message: 'Operation not permitted',
    });
    expect(decide(undefined)).toEqual({ allow: false, message: 'Operation not permitted' });
  });

  it('Bash 环境变量探测被拦截', () => {
    const result = decide('Bash', { command: 'env | grep TOKEN' });
    expect(result?.allow).toBe(false);
    expect(result?.message).toContain('环境变量探测');
  });

  it('Bash 工作目录内的文件操作放行、目录外拒绝', () => {
    const inside = join(AGENT_CWD, 'org-1', 'u-1', 'notes.txt');
    expect(decide('Bash', { command: `cat ${inside}` })).toEqual({ allow: true });
    const outside = decide('Bash', { command: 'cat /etc/passwd' });
    expect(outside?.allow).toBe(false);
    expect(outside?.message).toContain('工作目录外');
  });

  it('Read 缺路径拒绝、工作区内放行、工作区外拒绝', () => {
    expect(decide('Read', {})).toEqual({
      allow: false,
      message: 'Access denied: missing file path',
    });
    expect(decide('Read', { path: join(AGENT_CWD, 'org-1', 'u-1', 'a.md') })).toEqual({
      allow: true,
    });
    expect(decide('Read', { path: '/etc/hosts' })).toEqual({
      allow: false,
      message: 'Access denied: path outside your workspace',
    });
  });

  it('Write 禁止改 agent 设置文件', () => {
    const target = join(AGENT_CWD, 'org-1', 'u-1', '.claude/settings.json');
    expect(decide('Write', { path: target })).toEqual({
      allow: false,
      message: 'Access denied: cannot modify agent settings files',
    });
  });

  it('Edit 用 file_path、NotebookEdit 用 notebook_path', () => {
    expect(decide('Edit', { file_path: join(AGENT_CWD, 'org-1', 'u-1', 'a.ts') })).toEqual({
      allow: true,
    });
    expect(decide('NotebookEdit', { notebook_path: '/tmp/other.ipynb' })).toEqual({
      allow: false,
      message: 'Access denied: path outside your workspace',
    });
  });
});
