/**
 * sessionsApi.ts 补充测试（补齐 mapSessionDetailToMessages 未覆盖分支）
 *
 * 既有 sessionsApi.test.ts 只覆盖了 AskUserQuestion 历史恢复，这里补：
 * - prompt：附件剥离 / 语音 STT 前缀 / AI fallback 占位文本 / 结构化 attachments 优先
 * - text：[FILE] 标记提取 file_download（含 path 别名、缺 filePath 跳过、fileName 兜底）
 * - thinking：durationMs 透传
 * - tool_use：普通工具（名字规范化 + result/executionStatus）、Agent → subagent（含 terminal 判定）
 * - EnterPlanMode / ExitPlanMode：allowed/denied、从 result marker 与 input.plan 提取 plan
 * - tool_result：交互工具跳过、已被 toolResultMap 消费的跳过、独立 orphan result 保留
 * - cron 会话：首条 user 消息 displayContent 覆写
 */
import { describe, expect, it } from 'vitest';
import type { ApiSessionDetail, ApiTranscriptBlock } from '../types/session';
import { mapSessionDetailToMessages } from './sessionsApi';

function detail(blocks: ApiTranscriptBlock[], extra: Partial<ApiSessionDetail> = {}): ApiSessionDetail {
  return {
    sessionId: 's',
    stats: { lines: blocks.length, parsedLines: blocks.length, parseErrors: 0 },
    blocks,
    ...extra,
  };
}

function block(b: Partial<ApiTranscriptBlock> & Pick<ApiTranscriptBlock, 'id' | 'kind'>): ApiTranscriptBlock {
  return { title: '', defaultOpen: false, content: '', ...b };
}

describe('mapSessionDetailToMessages - prompt 分支', () => {
  it('剥离附件指令文本并从中提取文件名列表', () => {
    const content = '帮我看看这些\n\n[用户上传了以下附件，请查阅]\n- 报告.pdf (1.2MB)\n- 数据.xlsx (3KB)';
    const [msg] = mapSessionDetailToMessages(detail([block({ id: 'p1', kind: 'prompt', content })]));
    expect(msg).toEqual(expect.objectContaining({
      type: 'user',
      content: '帮我看看这些',
      attachments: [{ name: '报告.pdf' }, { name: '数据.xlsx' }],
    }));
  });

  it('AI fallback 占位文本 + 有附件时正文清空', () => {
    const content = 'Please check the attachments I uploaded\n\n[用户上传了以下附件]\n- a.png (1KB)';
    const [msg] = mapSessionDetailToMessages(detail([block({ id: 'p1', kind: 'prompt', content })]));
    expect(msg).toEqual(expect.objectContaining({ type: 'user', content: '' }));
    expect((msg as { attachments?: unknown }).attachments).toEqual([{ name: 'a.png' }]);
  });

  it('语音 STT 前缀被剥离并标记 isVoiceTranscript', () => {
    const content = '[这是一条语音转文字的消息，可能存在识别准确度问题] 今天天气怎么样';
    const [msg] = mapSessionDetailToMessages(detail([block({ id: 'p1', kind: 'prompt', content })]));
    expect(msg).toEqual(expect.objectContaining({
      type: 'user',
      content: '今天天气怎么样',
      isVoiceTranscript: true,
    }));
  });

  it('结构化 attachments 优先于文本正则解析', () => {
    const b = block({
      id: 'p1', kind: 'prompt', content: '看附件',
      attachments: [{ name: 'structured.pdf' }],
      tsMs: 123,
    });
    const [msg] = mapSessionDetailToMessages(detail([b]));
    expect(msg).toEqual(expect.objectContaining({
      type: 'user',
      content: '看附件',
      attachments: [{ name: 'structured.pdf' }],
      timestamp: 123,
    }));
  });
});

describe('mapSessionDetailToMessages - text 与 [FILE] 标记', () => {
  it('text block 产出 text 消息，并从中额外提取 file_download', () => {
    const content = '生成完成 [FILE]{"filePath":"out/报告.pdf","fileSize":2048}[/FILE]';
    const msgs = mapSessionDetailToMessages(detail([block({ id: 't1', kind: 'text', content })]));
    expect(msgs[0]).toEqual(expect.objectContaining({ id: 't1', type: 'text', content }));
    expect(msgs[1]).toEqual(expect.objectContaining({
      type: 'file_download',
      fileName: '报告.pdf',
      filePath: 'out/报告.pdf',
      fileSize: 2048,
    }));
  });

  it('[FILE] 支持 path 别名，fileName 缺省取 basename', () => {
    const content = '[FILE]{"path":"a/b/c.txt"}[/FILE]';
    const msgs = mapSessionDetailToMessages(detail([block({ id: 't1', kind: 'text', content })]));
    const file = msgs.find(m => m.type === 'file_download');
    expect(file).toEqual(expect.objectContaining({ fileName: 'c.txt', filePath: 'a/b/c.txt', fileSize: 0 }));
  });

  it('[FILE] 缺 filePath/path 时跳过该标记', () => {
    const content = '[FILE]{"fileName":"x"}[/FILE]';
    const msgs = mapSessionDetailToMessages(detail([block({ id: 't1', kind: 'text', content })]));
    expect(msgs.some(m => m.type === 'file_download')).toBe(false);
  });

  it('owner 透传到 text 与 file_download', () => {
    const content = '完成 [FILE]{"filePath":"x.pdf"}[/FILE]';
    const msgs = mapSessionDetailToMessages(detail([block({ id: 't1', kind: 'text', content })]), 'alice');
    expect(msgs[0]).toEqual(expect.objectContaining({ type: 'text', owner: 'alice' }));
    expect(msgs[1]).toEqual(expect.objectContaining({ type: 'file_download', owner: 'alice' }));
  });
});

describe('mapSessionDetailToMessages - thinking / 普通 tool_use', () => {
  it('thinking block 透传内容与 durationMs', () => {
    const [msg] = mapSessionDetailToMessages(detail([
      block({ id: 'th1', kind: 'thinking', content: '思考中', durationMs: 1500 }),
    ]));
    expect(msg).toEqual(expect.objectContaining({ type: 'thinking', content: '思考中', durationMs: 1500 }));
  });

  it('普通工具规范化名字，配对 result 后带 executionStatus=completed 与 resultReady', () => {
    const blocks = [
      block({ id: 'tu1', kind: 'tool_use', toolName: 'bash', toolId: 'call-1', content: '{"command":"ls"}' }),
      block({ id: 'tr1', kind: 'tool_result', toolName: 'bash', toolId: 'call-1', content: 'file list' }),
    ];
    const msgs = mapSessionDetailToMessages(detail(blocks));
    // 只应产出 tool_use（result 已被 toolResultMap 消费，tool_result 不重复产出）
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual(expect.objectContaining({
      type: 'tool_use',
      toolName: 'Bash',
      toolId: 'call-1',
      result: 'file list',
      resultReady: true,
      executionStatus: 'completed',
    }));
  });

  it('无配对 result 的 tool_use 不带 result，无 executionStatus', () => {
    const [msg] = mapSessionDetailToMessages(detail([
      block({ id: 'tu1', kind: 'tool_use', toolName: 'Read', toolId: 'call-x', content: '{}' }),
    ]));
    expect(msg).toEqual(expect.objectContaining({ type: 'tool_use', toolName: 'Read' }));
    expect((msg as { result?: unknown }).result).toBeUndefined();
    expect((msg as { executionStatus?: unknown }).executionStatus).toBeUndefined();
  });
});

describe('mapSessionDetailToMessages - Agent → subagent', () => {
  it('有 subagent 元数据时透传，status 用 subagent.status', () => {
    const b = block({
      id: 'ag1', kind: 'tool_use', toolName: 'Agent', toolId: 'call-a',
      content: '{"description":"研究任务"}',
      subagent: {
        agentType: 'Explore', description: '深入研究', childSessionId: 'cs1', childRunId: 'cr1',
        status: 'completed', durationMs: 2000, totalTokens: 100, resultPreview: '结论',
      },
    });
    const [msg] = mapSessionDetailToMessages(detail([b]));
    expect(msg).toEqual(expect.objectContaining({
      type: 'subagent',
      agentType: '深入研究',
      status: 'completed',
      childSessionId: 'cs1',
      childRunId: 'cr1',
      durationMs: 2000,
      totalTokens: 100,
      resultPreview: '结论',
    }));
  });

  it('无 subagent 元数据且无 result 时 status=running，agentType 从 input.description 提取', () => {
    const [msg] = mapSessionDetailToMessages(detail([
      block({ id: 'ag1', kind: 'tool_use', toolName: 'Agent', toolId: 'call-a', content: '{"description":"跑测试"}' }),
    ]));
    expect(msg).toEqual(expect.objectContaining({ type: 'subagent', status: 'running', agentType: '跑测试' }));
  });

  it('executionStatus=failed 时 subagent status=failed', () => {
    const [msg] = mapSessionDetailToMessages(detail([
      block({ id: 'ag1', kind: 'tool_use', toolName: 'Agent', toolId: 'call-a', content: '{}', executionStatus: 'failed' }),
    ]));
    expect(msg).toEqual(expect.objectContaining({ type: 'subagent', status: 'failed', agentType: '子任务' }));
  });

  it('有 result 文本时 terminal=completed 且 resultPreview 取 result 前缀', () => {
    const blocks = [
      block({ id: 'ag1', kind: 'tool_use', toolName: 'Agent', toolId: 'call-a', content: '{"agent_type":"code"}' }),
      block({ id: 'agr1', kind: 'tool_result', toolName: 'Agent', toolId: 'call-a', content: '  子任务输出  ' }),
    ];
    const msgs = mapSessionDetailToMessages(detail(blocks));
    // tool_result 属交互工具，不额外产出，只保留 subagent
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual(expect.objectContaining({
      type: 'subagent',
      status: 'completed',
      agentType: 'code',
      resultPreview: '子任务输出',
    }));
  });
});

describe('mapSessionDetailToMessages - Plan mode', () => {
  it('EnterPlanMode 成功 → permission_request allowed，带固定描述', () => {
    const blocks = [
      block({ id: 'ep1', kind: 'tool_use', toolName: 'EnterPlanMode', toolId: 'call-e', content: '{}' }),
      block({ id: 'epr1', kind: 'tool_result', toolName: 'EnterPlanMode', toolId: 'call-e', content: 'Entered plan mode successfully' }),
    ];
    const msgs = mapSessionDetailToMessages(detail(blocks));
    expect(msgs).toEqual([expect.objectContaining({
      type: 'permission_request',
      toolName: '进入规划模式',
      status: 'allowed',
    })]);
    expect((msgs[0] as { toolInput: string }).toolInput).toContain('规划模式');
  });

  it('EnterPlanMode 非成功前缀 → denied', () => {
    const blocks = [
      block({ id: 'ep1', kind: 'tool_use', toolName: 'EnterPlanMode', toolId: 'call-e', content: '{}' }),
      block({ id: 'epr1', kind: 'tool_result', toolName: 'EnterPlanMode', toolId: 'call-e', content: 'User denied' }),
    ];
    const [msg] = mapSessionDetailToMessages(detail(blocks));
    expect(msg).toEqual(expect.objectContaining({ type: 'permission_request', status: 'denied' }));
  });

  it('ExitPlanMode 批准 → allowed，plan 从 result 的 Approved Plan marker 提取', () => {
    const result = 'User has approved your plan.\n## Approved Plan:\n第一步做 A\n第二步做 B';
    const blocks = [
      block({ id: 'xp1', kind: 'tool_use', toolName: 'ExitPlanMode', toolId: 'call-x', content: '{"plan":"原始计划"}' }),
      block({ id: 'xpr1', kind: 'tool_result', toolName: 'ExitPlanMode', toolId: 'call-x', content: result }),
    ];
    const [msg] = mapSessionDetailToMessages(detail(blocks));
    expect(msg).toEqual(expect.objectContaining({
      type: 'permission_request',
      toolName: '规划方案审批',
      status: 'allowed',
      toolInput: '第一步做 A\n第二步做 B',
    }));
  });

  it('ExitPlanMode 被拒（无 marker）→ denied，plan 从 tool_use input.plan 兜底提取', () => {
    const blocks = [
      block({ id: 'xp1', kind: 'tool_use', toolName: 'ExitPlanMode', toolId: 'call-x', content: '{"plan":"  待审计划  "}' }),
      block({ id: 'xpr1', kind: 'tool_result', toolName: 'ExitPlanMode', toolId: 'call-x', content: 'User denied the plan' }),
    ];
    const [msg] = mapSessionDetailToMessages(detail(blocks));
    expect(msg).toEqual(expect.objectContaining({
      type: 'permission_request',
      status: 'denied',
      toolInput: '待审计划',
    }));
  });
});

describe('mapSessionDetailToMessages - tool_result 与 cron', () => {
  it('无 toolId 的 tool_result 保留为独立 tool_result 消息（名字规范化）', () => {
    // 注意：带 toolId 的 tool_result 一定会先进 toolResultMap，随后被 has(toolId) 命中而 return null；
    // 只有无 toolId 的 tool_result 才走到「产出 tool_result 消息」这条真实分支。
    const [msg] = mapSessionDetailToMessages(detail([
      block({ id: 'orphan', kind: 'tool_result', toolName: 'grep', content: 'match output' }),
    ]));
    expect(msg).toEqual(expect.objectContaining({
      type: 'tool_result',
      toolName: 'Grep',
      result: 'match output',
      toolId: '',
    }));
  });

  it('带 toolId 但无配对 tool_use 的 tool_result 仍被抑制（进入 toolResultMap 后被 has 命中）', () => {
    const msgs = mapSessionDetailToMessages(detail([
      block({ id: 'orphan', kind: 'tool_result', toolName: 'grep', toolId: 'lonely', content: 'x' }),
    ]));
    expect(msgs).toEqual([]);
  });

  it('交互工具的 tool_result（AskUserQuestion 等）被跳过', () => {
    const msgs = mapSessionDetailToMessages(detail([
      block({ id: 'ir', kind: 'tool_result', toolName: 'AskUserQuestion', toolId: 't', content: '{}' }),
    ]));
    expect(msgs).toEqual([]);
  });

  it('meta block 被忽略', () => {
    const msgs = mapSessionDetailToMessages(detail([block({ id: 'm', kind: 'meta', content: 'x' })]));
    expect(msgs).toEqual([]);
  });

  it('cron 会话首条 user 消息 displayContent 被覆写为「正在执行「label」」', () => {
    const msgs = mapSessionDetailToMessages(detail(
      [block({ id: 'p1', kind: 'prompt', content: '原始任务提示' })],
      { source: { type: 'cron', label: '每日简报' } },
    ));
    expect(msgs[0]).toEqual(expect.objectContaining({
      type: 'user',
      content: '原始任务提示',
      displayContent: '正在执行「每日简报」',
    }));
  });

  it('非 cron 会话不设置 displayContent', () => {
    const msgs = mapSessionDetailToMessages(detail(
      [block({ id: 'p1', kind: 'prompt', content: '普通提示' })],
      { source: { type: 'web', label: '' } },
    ));
    expect((msgs[0] as { displayContent?: unknown }).displayContent).toBeUndefined();
  });
});
