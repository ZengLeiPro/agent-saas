import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_RAW_TAIL_TOKEN_CAP,
  planContextCheckpoint,
  selectAtomicRawTail,
} from '../runtime/contextCheckpoint.js';
import type { PlatformEvent } from '../runtime/types.js';

const base = {
  timestamp: '2026-08-07T05:00:00.000Z',
  runId: 'run-active',
  sessionId: 'session-1',
};

function user(id: string, content: string): PlatformEvent {
  return { ...base, id, type: 'user_message', content } as PlatformEvent;
}

function assistant(id: string, content: string): PlatformEvent {
  return { ...base, id, type: 'assistant_message', content } as PlatformEvent;
}

function toolCalls(id: string, callIds: string[]): PlatformEvent {
  return {
    ...base,
    id,
    type: 'assistant_tool_calls',
    content: '',
    toolCalls: callIds.map((callId) => ({
      id: callId,
      name: 'Read',
      arguments: '{}',
    })),
  } as PlatformEvent;
}

function toolResult(id: string, callId: string, content = 'ok'): PlatformEvent {
  return {
    ...base,
    id,
    type: 'tool_result',
    toolCallId: callId,
    toolName: 'Read',
    content,
  } as PlatformEvent;
}

describe('context checkpoint planner', () => {
  it('默认压到阈值的一半，摘要 8% 封顶 16K，raw tail 封顶 64K', () => {
    const plan = planContextCheckpoint({
      events: [user('u1', '修复问题'), assistant('a1', '处理中')],
      contextWindow: 272_000,
      thresholdTokens: 217_600,
      baseFixedTokens: 20_000,
      sourceRunId: 'run-active',
    });

    expect(plan.targetTokens).toBe(108_800);
    expect(plan.summaryBudgetTokens).toBe(16_384);
    expect(plan.rawTailBudgetTokens).toBe(CHECKPOINT_RAW_TAIL_TOKEN_CAP);
    expect(plan.userHistoryTokenCap).toBe(60_000);
    // 当前消息已在 raw tail 中，不应再作为 checkpoint task anchor 重复投影。
    expect(plan.taskAnchors).toEqual([]);
  });

  it('只按压缩前缀计费用户轨迹，当前大图文轮次可容纳时保留在 raw tail', () => {
    const current = {
      ...base,
      id: 'u-current',
      type: 'user_message',
      content: '图像理解结果：'.repeat(2_500),
      visionAnalysis: {
        model: 'vision-test',
        attachmentIds: ['attachment-current'],
        content: '当前图片中的关键安全约束',
      },
    } as PlatformEvent;
    const plan = planContextCheckpoint({
      events: [current],
      contextWindow: 272_000,
      thresholdTokens: 217_600,
      baseFixedTokens: 40_000,
      sourceRunId: 'run-active',
    });

    expect(plan.rawTailStartIndex).toBe(0);
    expect(plan.coveredEventCount).toBe(0);
    expect(plan.taskAnchors).toEqual([]);
    expect(plan.fixedTokens).toBeLessThan(50_000);
  });

  it('cutoff 覆盖 memory_context 时把最新 snapshot 持久化到 checkpoint', () => {
    const memory = { ...base, id: 'memory-1', type: 'memory_context', content: '<memory_context>禁止部署</memory_context>' } as PlatformEvent;
    const plan = planContextCheckpoint({
      events: [memory, assistant('a-history', '历史输出'.repeat(12_000)), user('u-current', '当前任务'.repeat(2_000))],
      contextWindow: 272_000,
      thresholdTokens: 217_600,
      baseFixedTokens: 40_000,
      sourceRunId: 'run-active',
    });

    expect(plan.rawTailStartIndex).toBe(2);
    expect(plan.memorySnapshot).toContain('禁止部署');
  });

  it('小窗口模型按目标剩余空间下调用户历史上限，而不是固定占用 60K', () => {
    const plan = planContextCheckpoint({
      events: [user('u1', '长'.repeat(50_000)), assistant('a1', '处理中')],
      contextWindow: 32_000,
      thresholdTokens: 25_600,
      baseFixedTokens: 4_000,
      sourceRunId: 'run-active',
    });

    expect(plan.targetTokens).toBe(12_800);
    expect(plan.summaryBudgetTokens).toBe(2_560);
    expect(plan.userHistoryTokenCap).toBe(5_984);
    expect(plan.userHistoryTokenCap).toBeLessThan(60_000);
  });

  it('raw tail 不会从完整工具批次中间切开', () => {
    const events = [
      user('u1', '执行任务'),
      assistant('a1', '先检查'),
      toolCalls('tc1', ['call-1', 'call-2']),
      toolResult('tr1', 'call-1', 'A'.repeat(2_000)),
      toolResult('tr2', 'call-2', 'B'.repeat(2_000)),
      assistant('a2', '继续'),
    ];
    const fullBatch = selectAtomicRawTail(events, 10_000);
    expect(fullBatch.startIndex).toBe(0);

    const onlyLastAssistant = selectAtomicRawTail(events, 100);
    expect(onlyLastAssistant.startIndex).toBe(5);
    expect(events[onlyLastAssistant.startIndex]?.id).toBe('a2');
  });

  it('未闭合工具调用及已有的部分结果不会形成孤儿 raw tail', () => {
    const events = [
      user('u1', '执行任务'),
      toolCalls('tc1', ['call-1', 'call-2']),
      toolResult('tr1', 'call-1'),
    ];
    const selected = selectAtomicRawTail(events, 100_000);
    expect(selected.startIndex).toBe(events.length);
  });

  it('完整工具范围包住未闭合调用时也不会跨过 unsafe 事件', () => {
    const events = [
      toolCalls('tc-complete', ['call-complete']),
      toolCalls('tc-open', ['call-open']),
      toolResult('tr-complete', 'call-complete'),
    ];

    expect(selectAtomicRawTail(events, 100_000).startIndex).toBe(events.length);
  });

  it('thinking 与 assistant 之间夹着 MCP 加载事件时仍作为一个原子单元', () => {
    const events = [
      { ...base, id: 'thinking-1', type: 'assistant_thinking', content: '关键推理' } as PlatformEvent,
      {
        ...base,
        id: 'mcp-1',
        type: 'mcp_tools_loaded',
        execution: 'server',
        paths: ['mcp_demo.large_tool'],
        tools: [{
          id: 'large_tool',
          name: 'large_tool',
          description: '大'.repeat(10_000),
          parameters: { type: 'object', properties: {} },
        }],
      } as PlatformEvent,
      assistant('a1', '最终回答'),
    ];

    // 预算足够单独容纳 assistant，但不足以容纳 thinking + MCP + assistant；必须全不保留。
    expect(selectAtomicRawTail(events, 100).startIndex).toBe(events.length);
    expect(selectAtomicRawTail(events, 20_000).startIndex).toBe(0);
  });

  it('单轮超长当前任务也可进入摘要段，任务锚点保留完整原文', () => {
    const content = `目标：${'长任务约束'.repeat(20_000)}`;
    const plan = planContextCheckpoint({
      events: [user('u-long', content)],
      contextWindow: 272_000,
      thresholdTokens: 217_600,
      baseFixedTokens: 100_000,
      sourceRunId: 'run-active',
    });
    expect(plan.coveredEventCount).toBe(1);
    expect(plan.rawTailStartIndex).toBe(1);
    expect(plan.taskAnchors).toEqual([
      expect.objectContaining({ eventId: 'u-long', text: content, originalChars: content.length }),
    ]);
  });

  it('task anchors 保留当前 run 用户原文和附件引用，但不持久化视觉分析', () => {
    const message = {
      ...user('u1', '分析附件并继续'),
      attachments: [{
        attachmentId: 'att-1',
        originalName: '需求.pdf',
        relativePath: 'uploads/需求.pdf',
        sizeBytes: 10,
        mimeType: 'application/pdf',
        isImage: false,
      }],
      visionAnalysis: { model: 'vision', attachmentIds: ['att-1'], content: '附件秘密正文' },
    } as PlatformEvent;
    const plan = planContextCheckpoint({
      events: [message],
      contextWindow: 100_000,
      thresholdTokens: 80_000,
      baseFixedTokens: 40_000,
      sourceRunId: 'run-active',
    });
    expect(plan.taskAnchors).toEqual([expect.objectContaining({
      text: '分析附件并继续',
      attachments: [{ attachmentId: 'att-1', originalName: '需求.pdf' }],
    })]);
    expect(JSON.stringify(plan.taskAnchors)).not.toContain('附件秘密正文');
  });
});
