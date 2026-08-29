import { describe, expect, it } from 'vitest';

import { resolveDwsBusinessRisk } from './businessToolProvider.js';
import { DWS_READ_COMMAND_PATHS, DWS_WRITE_COMMAND_PATHS } from './readCommands.js';

/**
 * TASK-256（三轮 review 返工）：DWS references 查询命令契约。
 * DWS_READ_COMMAND_PATHS 的每一项均逐条对照当前技能池 references/products/*.md 核实为
 * 纯查询；本测试确保登记表扩展后不会被分类器的 destructive/write 全路径扫描重新否决。
 * 未登记命令与真实写/破坏性命令保留 fail-closed 反例。
 */
describe('DWS reference 命令风险登记契约', () => {
  it('所有已登记纯查询路径都解析为 safe', () => {
    for (const path of DWS_READ_COMMAND_PATHS) {
      expect(resolveDwsBusinessRisk({ args: path.split('.') }), path).toBe('safe');
    }
  });

  it('review 复现的四条纯查询不再判 dangerous', () => {
    expect(resolveDwsBusinessRisk({ args: ['attendance', 'approve', 'list', '--users', 'u1'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['attendance', 'approve', 'templates', '--type', 'leave'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['aitable', 'view', 'get', 'frozen-cols', '--view-id', 'v1'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'suggest', '--users', 'u1,u2'] })).toBe('safe');
  });

  it('显式写路径、真实写/破坏性命令与未知命令不得降档', () => {
    for (const path of DWS_WRITE_COMMAND_PATHS) {
      expect(resolveDwsBusinessRisk({ args: path.split('.') }), path).toBe('workspace_write');
    }
    expect(resolveDwsBusinessRisk({ args: ['chat', 'message', 'send', 'all', '--group', 'cid'] })).toBe('workspace_write');
    expect(resolveDwsBusinessRisk({ args: ['oa', 'approval', 'approve', '--task-id', 't1'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'delete', '--event-id', 'e1'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'future-query-shape'] })).toBe('dangerous');
  });
});
