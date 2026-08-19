import { describe, expect, it } from 'vitest';
import { workflowTraceEventV1Schema, type WorkflowTraceEventV1 } from '../schemas/workflowTrace';
import { projectBusinessStepEvents } from './extractTodos';
import { projectWorkflowTrace } from './workflowTraceProjector';

const base = {
  schemaVersion: 1 as const,
  workflowId: 'quote-loop',
  instanceId: 'demo-quote-loop',
  authority: 'simulation' as const,
};

function fixture(): WorkflowTraceEventV1[] {
  return [
    { ...base, id: 'entry', sequence: 0, type: 'entry', entryKind: 'business_event', title: '业务事件', content: '客户询价到达。' },
    {
      ...base,
      id: 'plan',
      sequence: 1,
      type: 'plan',
      steps: [
        { id: 'inspect', title: '核对询价事实' },
        { id: 'send', title: '发送获批报价' },
      ],
    },
    { ...base, id: 'inspect-start', sequence: 2, type: 'step', stepId: 'inspect', status: 'in_progress', activeForm: '正在核对询价事实' },
    {
      ...base,
      id: 'inspect-effect',
      sequence: 3,
      type: 'effect',
      stepId: 'inspect',
      effectId: 'source-read',
      effectType: 'source',
      system: '客户资料',
      operation: 'read',
      title: '读取询价来源',
      entity: { type: 'inquiry', id: 'RFQ-001' },
      fields: [
        { label: '客户消息', value: 'IP67', state: 'active' },
        { label: '附件规格', value: 'IP65', state: 'warning' },
      ],
      verification: 'simulated',
    },
    {
      ...base,
      id: 'inspect-done',
      sequence: 4,
      type: 'step',
      stepId: 'inspect',
      status: 'completed',
      outcome: { text: '发现 1 项规格冲突', tone: 'warn', stat: [{ label: '冲突', value: '1' }] },
      display: [{ type: 'comparison', title: '核对规格来源', items: [{ label: '客户消息', value: 'IP67' }, { label: '询价附件', value: 'IP65' }] }],
    },
    { ...base, id: 'send-start', sequence: 5, type: 'step', stepId: 'send', status: 'in_progress' },
    {
      ...base,
      id: 'send-gate',
      sequence: 6,
      type: 'gate_requested',
      stepId: 'send',
      gateId: 'quote-approval',
      title: '确认发送报价',
      description: '批准后才会向客户发送。',
      facts: [{ label: '报价版本', value: 'Q-001' }],
      approveLabel: '批准并发送',
      rejectLabel: '退回修改',
    },
  ];
}

describe('Workflow Trace V1', () => {
  it('拒绝把 simulation effect 伪装成真实回读', () => {
    const event = fixture().find((item) => item.type === 'effect')!;
    expect(workflowTraceEventV1Schema.safeParse({ ...event, verification: 'read_back' }).success).toBe(false);
  });

  it('同一事件前缀确定性投影为正式 Todo/BusinessStep 消息与系统面板', () => {
    const events = fixture();
    const before = JSON.stringify(events);
    const first = projectWorkflowTrace(events);
    const second = projectWorkflowTrace(events);

    expect(second).toEqual(first);
    expect(JSON.stringify(events)).toBe(before);
    expect(first.messages.some((message) => message.type === 'tool_use' && message.toolName === 'TodoWrite')).toBe(true);

    const business = projectBusinessStepEvents(first.messages, false);
    expect(business.events.map((event) => event.kind)).toEqual(['plan', 'start', 'complete', 'start']);
    expect(business.events.find((event) => event.kind === 'plan')?.todos?.map((todo) => todo.status))
      .toEqual(['completed', 'in_progress']);
    expect(business.events.find((event) => event.kind === 'complete')?.todo?.outcome?.text).toBe('发现 1 项规格冲突');

    expect(first.panel?.live).toBe(false);
    expect(first.panel?.foot).toContain('演示来源');
    expect(first.panel?.foot).not.toContain('已连接');
    expect(first.panel?.views.map((view) => view.key)).toEqual(['source', 'approval', 'audit']);
    expect(first.pendingGate?.gateId).toBe('quote-approval');
  });

  it('重复重投同一事件会去重，冲突重投和重复 sequence 会拒绝', () => {
    const events = fixture();
    expect(projectWorkflowTrace([...events, events[3]!])).toEqual(projectWorkflowTrace(events));
    expect(() => projectWorkflowTrace([
      ...events,
      { ...events[3]!, title: '冲突内容' } as WorkflowTraceEventV1,
    ])).toThrow('存在冲突重投');
    expect(() => projectWorkflowTrace([
      ...events,
      { ...events[3]!, id: 'other-effect' } as WorkflowTraceEventV1,
    ])).toThrow('sequence 3 重复');
  });

  it('终态核对的状态文字只显示一次，flag 仅承担语义着色', () => {
    const verification: WorkflowTraceEventV1 = {
      ...base,
      id: 'verify-final-state',
      sequence: 7,
      type: 'effect',
      stepId: 'send',
      effectId: 'final-check',
      effectType: 'verification',
      system: '订单中心',
      operation: 'verify',
      title: '核对订单终态',
      entity: { type: 'order', id: 'SO-001' },
      fields: [{ label: '订单状态', value: '已生效', state: 'success' }],
      verification: 'simulated',
    };
    const summary = projectWorkflowTrace([...fixture(), verification]).panel?.views.find((view) => view.key === 'summary');
    expect(summary?.widget.kind).toBe('table');
    if (summary?.widget.kind !== 'table') throw new Error('缺少终态核对表');
    expect(summary.widget.rows[0]?.cells.state).toBe('已核对');
    expect(summary.widget.rows[0]?.flags?.state).toEqual({ tone: 'pass' });
  });

  it('真实写入没有回执或回读时只能显示待核对，不能声称系统已写入', () => {
    const unverified: WorkflowTraceEventV1 = {
      ...base,
      authority: 'platform',
      id: 'unverified-write',
      sequence: 7,
      type: 'effect',
      stepId: 'send',
      effectId: 'quote-write',
      effectType: 'record',
      system: 'CRM',
      operation: 'update',
      title: '更新报价状态',
      summary: '报价状态已写入',
      entity: { type: 'quote', id: 'Q-001' },
      fields: [{ label: '报价状态', value: '已批准', state: 'success' }],
      verification: 'none',
    };
    const projected = projectWorkflowTrace([...fixture(), unverified]);
    const effectMessage = projected.messages.find((message) => message.id === 'trace-unverified-write');
    expect(effectMessage?.type === 'tool_use' ? effectMessage.presentation?.status : null).toBe('warn');
    expect(projected.panel?.views.find((view) => view.key === 'records')?.toolbar?.sub ?? '').toContain('尚未独立核对');
    expect(JSON.stringify(projected.panel)).not.toContain('已写入');
  });

  it('真实 receipt/read_back 必须携带对应回执或证据', () => {
    const effect = fixture().find((item) => item.type === 'effect')!;
    expect(workflowTraceEventV1Schema.safeParse({
      ...effect,
      authority: 'connector',
      verification: 'receipt',
    }).success).toBe(false);
    expect(workflowTraceEventV1Schema.safeParse({
      ...effect,
      authority: 'connector',
      verification: 'read_back',
    }).success).toBe(false);
  });

  it('批准和退回都由追加事件决定，删除分支事件即可无损回退', () => {
    const events = fixture();
    const approved: WorkflowTraceEventV1 = {
      ...base,
      id: 'gate-approved',
      sequence: 7,
      type: 'gate_resolved',
      stepId: 'send',
      gateId: 'quote-approval',
      decision: 'approved',
    };
    expect(projectWorkflowTrace([...events, approved]).pendingGate).toBeNull();
    expect(projectWorkflowTrace(events).pendingGate?.gateId).toBe('quote-approval');
  });
});
