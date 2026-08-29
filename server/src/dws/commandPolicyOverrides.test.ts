import { describe, expect, it } from 'vitest';

import { resolveDwsBusinessRisk } from './businessToolProvider.js';
import {
  DWS_READ_COMMAND_OVERRIDES,
  DWS_WRITE_COMMAND_OVERRIDES,
} from './commandPolicyOverrides.js';

/**
 * DWS schema 只读例外契约。每一项均已对照当前技能池文档或 CLI 契约核实为纯查询；
 * 正常叶子命令由生成的 manifest 覆盖，未知命令与真实写/破坏性命令继续 fail-closed。
 */
describe('DWS schema 只读覆盖契约', () => {
  it('所有已登记纯查询例外都解析为 safe', () => {
    for (const path of DWS_READ_COMMAND_OVERRIDES) {
      expect(resolveDwsBusinessRisk({ args: path.split('.') }), path).toBe('safe');
    }
  });

  it('review 复现的四条纯查询不再判 dangerous', () => {
    expect(
      resolveDwsBusinessRisk({ args: ['attendance', 'approve', 'list', '--users', 'u1'] }),
    ).toBe('safe');
    expect(
      resolveDwsBusinessRisk({ args: ['attendance', 'approve', 'templates', '--type', 'leave'] }),
    ).toBe('safe');
    expect(
      resolveDwsBusinessRisk({
        args: ['aitable', 'view', 'get', 'frozen-cols', '--view-id', 'v1'],
      }),
    ).toBe('safe');
    expect(
      resolveDwsBusinessRisk({ args: ['calendar', 'event', 'suggest', '--users', 'u1,u2'] }),
    ).toBe('safe');
  });

  it('真实写/破坏性命令与未知命令不得降档', () => {
    for (const path of DWS_WRITE_COMMAND_OVERRIDES) {
      expect(resolveDwsBusinessRisk({ args: path.split('.') }), path).toBe('workspace_write');
    }
    expect(
      resolveDwsBusinessRisk({ args: ['chat', 'message', 'send', 'all', '--group', 'cid'] }),
    ).toBe('workspace_write');
    expect(resolveDwsBusinessRisk({ args: ['oa', 'approval', 'approve', '--task-id', 't1'] })).toBe(
      'dangerous',
    );
    expect(
      resolveDwsBusinessRisk({ args: ['calendar', 'event', 'delete', '--event-id', 'e1'] }),
    ).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'future-query-shape'] })).toBe(
      'dangerous',
    );
  });
});
