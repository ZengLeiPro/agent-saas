import type { MessageItem } from '../types/message';
import type {
  PanelFeedItem,
  PanelTableRow,
  PanelTone,
  PanelView,
  SystemPanelSnapshot,
} from './systemPanel';
import type { ToolPresentation } from './toolPresentation';
import { normalizeDetailLine } from './toolPresentation';
import { normalizeDisplay } from './presentation/registry';
import type { TodoItem } from './extractTodos';
import {
  workflowTraceEventV1Schema,
  type WorkflowTraceEventV1,
  type WorkflowTraceGateRequestedEventV1,
} from '../schemas/workflowTrace';

type TraceEffect = Extract<WorkflowTraceEventV1, { type: 'effect' }>;
type TraceActivity = Extract<WorkflowTraceEventV1, { type: 'activity' }>;

type ViewKey = 'source' | 'records' | 'comms' | 'approval' | 'summary' | 'audit';

const VIEW_ORDER: ViewKey[] = ['source', 'records', 'comms', 'approval', 'summary', 'audit'];

function normalizeEvents(events: WorkflowTraceEventV1[]): WorkflowTraceEventV1[] {
  const byId = new Map<string, WorkflowTraceEventV1>();
  for (const input of events) {
    const event = workflowTraceEventV1Schema.parse(input);
    const existing = byId.get(event.id);
    if (!existing) {
      byId.set(event.id, event);
      continue;
    }
    if (JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new Error(`Workflow Trace 事件 ${event.id} 存在冲突重投`);
    }
  }

  const normalized = [...byId.values()].sort((left, right) => left.sequence - right.sequence);
  const sequences = new Set<number>();
  for (const event of normalized) {
    if (sequences.has(event.sequence)) {
      throw new Error(`Workflow Trace sequence ${event.sequence} 重复`);
    }
    sequences.add(event.sequence);
  }
  return normalized;
}

function effectResultText(effect: TraceEffect): string {
  const target = `${effect.system} · ${effect.entity.type}`;
  if (effect.verification === 'none') return `${target}动作已执行，尚未独立核对`;
  const summary = effect.summary ?? `${target}已${effect.operation}`;
  if (effect.authority === 'simulation' && !/[（(]?(演示|模拟)/.test(summary)) return `${summary}（模拟）`;
  return summary;
}

function toneForState(state?: NonNullable<TraceEffect['fields']>[number]['state']): PanelTone {
  if (state === 'success') return 'pass';
  if (state === 'warning') return 'warn';
  if (state === 'active') return 'info';
  return 'pending';
}

function activityStatus(status: TraceActivity['status']): ToolPresentation['status'] {
  if (status === 'error') return 'warn';
  if (status === 'blocked') return 'blocked';
  if (status === 'waiting' || status === 'running') return 'waiting';
  return 'ok';
}

function effectView(effect: TraceEffect): ViewKey {
  if (effect.effectType === 'source') return 'source';
  if (effect.effectType === 'communication') return 'comms';
  if (effect.effectType === 'metric' || effect.effectType === 'verification') return 'summary';
  return 'records';
}

function createView(key: ViewKey): PanelView {
  if (key === 'source') {
    return {
      key,
      label: '来源资料',
      winTitle: '资料来源 · 本次读取',
      toolbar: { title: '资料来源 · 本次读取', sub: '等待业务事实' },
      widget: { kind: 'rows', rows: [], empty: { title: '尚未读取任何资料' } },
    };
  }
  if (key === 'records') {
    return {
      key,
      label: '业务系统',
      winTitle: '业务系统 · 记录明细',
      toolbar: { title: '业务系统 · 记录明细', sub: '等待系统变化' },
      widget: {
        kind: 'table',
        cols: [
          { key: 'field', label: '字段' },
          { key: 'value', label: '当前值' },
          { key: 'state', label: '状态', align: 'right' },
        ],
        rows: [],
        empty: { title: '业务系统尚未发生变化' },
      },
    };
  }
  if (key === 'comms') {
    return {
      key,
      label: '沟通',
      winTitle: '对外沟通 · 邮件与消息',
      toolbar: { title: '对外沟通 · 邮件与消息', sub: '等待沟通事件' },
      widget: { kind: 'cards', cards: [], empty: { title: '尚未发生任何对外沟通' } },
    };
  }
  if (key === 'approval') {
    return {
      key,
      label: '审批',
      winTitle: '审批中心 · 待确认事项',
      toolbar: { title: '审批中心 · 待确认事项', sub: '当前没有待确认事项' },
      widget: { kind: 'rows', rows: [], empty: { title: '当前没有待确认事项' } },
    };
  }
  if (key === 'summary') {
    return {
      key,
      label: '终态核对',
      winTitle: '跨系统终态核对',
      toolbar: { title: '跨系统终态核对', sub: '等待独立核对' },
      widget: {
        kind: 'table',
        cols: [
          { key: 'object', label: '业务对象' },
          { key: 'value', label: '终态' },
          { key: 'state', label: '核对', align: 'right' },
        ],
        rows: [],
        empty: { title: '尚未回读业务终态' },
      },
    };
  }
  return {
    key,
    label: '操作留痕',
    winTitle: '操作留痕 · 本次工作流',
    toolbar: { title: '本次工作流动作', sub: '尚无系统动作' },
    widget: { kind: 'feed', items: [], empty: { title: '尚无系统动作' } },
  };
}

function projectPanel(events: WorkflowTraceEventV1[]): SystemPanelSnapshot | null {
  const views = new Map<ViewKey, PanelView>();
  const systems = new Set<string>();
  const pendingGates = new Map<string, WorkflowTraceGateRequestedEventV1>();
  let activeView: ViewKey = 'audit';
  let auditCount = 0;

  const ensureView = (key: ViewKey): PanelView => {
    const existing = views.get(key);
    if (existing) return existing;
    const created = createView(key);
    views.set(key, created);
    return created;
  };
  const appendAudit = (event: WorkflowTraceEventV1, text: string) => {
    const audit = ensureView('audit');
    if (audit.widget.kind !== 'feed') return;
    const item: PanelFeedItem = {
      id: `audit-${event.id}`,
      from: event.authority === 'simulation' ? 'AI 同事 · 演示' : 'AI 同事',
      time: `事件 ${event.sequence}`,
      text,
    };
    audit.widget.items.push(item);
    auditCount += 1;
    audit.toolbar = { title: '本次工作流动作', sub: `${auditCount} 条` };
  };

  for (const event of events) {
    if (event.type === 'activity') {
      if (event.system) systems.add(event.system);
      appendAudit(event, `${event.system ? `${event.system} · ` : ''}${event.title}`);
      continue;
    }
    if (event.type === 'gate_requested') {
      pendingGates.set(event.gateId, event);
      const approval = ensureView('approval');
      if (approval.widget.kind === 'rows') {
        approval.widget.rows = event.facts.map((fact, index) => ({
          id: `${event.gateId}-${index + 1}`,
          text: fact.label,
          sub: fact.value,
          tone: 'pending',
          badge: { text: '待确认', tone: 'pending' },
        }));
      }
      approval.toolbar = { title: event.title, sub: '等待有权人明确确认' };
      activeView = 'approval';
      appendAudit(event, `审批中心 · ${event.title}：等待确认`);
      continue;
    }
    if (event.type === 'gate_resolved') {
      const request = pendingGates.get(event.gateId);
      pendingGates.delete(event.gateId);
      const approval = ensureView('approval');
      const approved = event.decision === 'approved';
      if (approval.widget.kind === 'rows') {
        approval.widget.rows = approval.widget.rows.map((row) => ({
          ...row,
          tone: approved ? 'pass' : 'warn',
          badge: { text: approved ? '已批准' : '已退回', tone: approved ? 'pass' : 'warn' },
        }));
      }
      approval.toolbar = {
        title: request?.title ?? '审批结果',
        sub: approved ? '已由有权人确认' : '已退回，未执行后续写入',
      };
      activeView = 'approval';
      appendAudit(event, `审批中心 · ${request?.title ?? event.gateId}：${approved ? '已批准' : '已退回'}`);
      continue;
    }
    if (event.type !== 'effect') continue;

    systems.add(event.system);
    const key = effectView(event);
    const view = ensureView(key);
    const fields = event.fields ?? [];
    const resultText = effectResultText(event);
    const unverifiedWrite = event.operation !== 'read' && event.verification === 'none';
    const sub = event.authority === 'simulation' ? `${resultText}；不进入真实审计` : resultText;
    view.toolbar = { title: `${event.system} · ${event.title}`, sub };

    if (key === 'source' && view.widget.kind === 'rows') {
      for (const [index, field] of fields.entries()) {
        view.widget.rows.push({
          id: `${event.id}-${index + 1}`,
          text: field.label,
          sub: field.value,
          tone: toneForState(field.state),
          badge: { text: field.before ? '已变化' : '已读取', tone: toneForState(field.state) },
        });
      }
    } else if (key === 'records' && view.widget.kind === 'table') {
      const rows: PanelTableRow[] = fields.map((field, index) => ({
        id: `${event.id}-${index + 1}`,
        cells: {
          field: field.label,
          value: field.value,
          state: unverifiedWrite ? '待核对' : field.before ? '已变化' : event.operation === 'read' ? '已读取' : '已写入',
        },
        tone: unverifiedWrite ? 'warn' : toneForState(field.state),
        flags: {
          // 状态文字已在 cell 中显示；flag 只保留语义色，避免“已变化 已变化”。
          state: { tone: unverifiedWrite ? 'warn' : toneForState(field.state) },
        },
      }));
      view.widget.rows.push(...rows);
    } else if (key === 'comms' && view.widget.kind === 'cards') {
      view.widget.cards.push({
        id: event.id,
        title: event.title,
        body: resultText || fields.map((field) => `${field.label}：${field.value}`).join('\n'),
        meta: [
          { text: event.system },
          {
            text: unverifiedWrite ? '已提交，待核对' : event.operation === 'send' ? '已发送' : '已读取',
            tone: unverifiedWrite ? 'warn' : 'pass',
          },
          ...(event.authority === 'simulation' ? [{ text: '演示', tone: 'pending' as const }] : []),
        ],
      });
    } else if (key === 'summary' && view.widget.kind === 'table') {
      view.widget.rows.push(...fields.map((field, index) => ({
        id: `${event.id}-${index + 1}`,
        cells: { object: field.label, value: field.value, state: '已核对' },
        tone: toneForState(field.state),
        // 状态文字只显示一次；flag 负责着色，不再重复“已核对”。
        flags: { state: { tone: toneForState(field.state) } },
      })));
    }
    activeView = key;
    appendAudit(event, `${event.system} · ${event.title}：${resultText}`);
  }

  if (views.size === 0) return null;
  const hasSimulation = events.some((event) => event.authority === 'simulation');
  const hasLiveAuthority = events.some((event) => event.authority === 'platform' || event.authority === 'connector');
  const live = hasLiveAuthority && !hasSimulation;
  return {
    title: '企业系统实况',
    live,
    activeView,
    foot: systems.size
      ? `${hasSimulation ? '演示来源' : live ? '已连接' : '来源'}：${[...systems].join(' · ')}${hasSimulation ? '（不进入真实审计）' : ''}`
      : hasSimulation ? '模拟事件，不进入真实审计' : undefined,
    views: VIEW_ORDER.flatMap((key) => {
      const view = views.get(key);
      return view ? [view] : [];
    }),
  };
}

function normalizeLines(raw?: unknown[]): ToolPresentation['detail'] {
  if (!raw) return undefined;
  const lines = raw.map(normalizeDetailLine).filter((line): line is NonNullable<typeof line> => line !== null);
  return lines.length ? lines : undefined;
}

function todoSnapshotMessage(event: WorkflowTraceEventV1, todos: TodoItem[]): MessageItem {
  return {
    id: `trace-${event.id}`,
    type: 'tool_use',
    toolName: 'TodoWrite',
    toolInput: JSON.stringify({ todos }),
    toolId: `trace-${event.id}`,
    executionStatus: 'completed',
    result: JSON.stringify({ persisted: true }),
    resultReady: true,
  };
}

function projectMessages(events: WorkflowTraceEventV1[]): MessageItem[] {
  const messages: MessageItem[] = [];
  const order: string[] = [];
  const todos = new Map<string, TodoItem>();

  const snapshot = (event: WorkflowTraceEventV1) => {
    messages.push(todoSnapshotMessage(event, order.flatMap((id) => {
      const todo = todos.get(id);
      return todo ? [todo] : [];
    })));
  };

  for (const event of events) {
    if (event.type === 'entry') {
      messages.push({
        id: `trace-${event.id}`,
        type: 'system_event',
        title: event.title,
        content: event.content,
      });
      continue;
    }
    if (event.type === 'plan') {
      order.length = 0;
      todos.clear();
      for (const step of event.steps) {
        order.push(step.id);
        todos.set(step.id, {
          id: step.id,
          kind: 'business',
          content: step.title,
          status: 'pending',
          ...(step.activeForm ? { activeForm: step.activeForm } : {}),
        });
      }
      snapshot(event);
      continue;
    }
    if (event.type === 'step') {
      const previous = todos.get(event.stepId);
      if (!previous) continue;
      const detail = normalizeLines(event.detail);
      const display = normalizeDisplay(event.display);
      todos.set(event.stepId, {
        ...previous,
        status: event.status,
        ...(event.activeForm ? { activeForm: event.activeForm } : {}),
        ...(event.outcome ? { outcome: event.outcome } : {}),
        ...(detail ? { detail } : {}),
        ...(display ? { display } : {}),
        ...(event.evidenceRefs?.length ? { evidenceRefs: [...event.evidenceRefs] } : {}),
      });
      snapshot(event);
      continue;
    }
    if (event.type === 'activity') {
      const detail = normalizeLines(event.detail);
      messages.push({
        id: `trace-${event.id}`,
        type: 'tool_use',
        toolName: event.system ?? 'WorkflowActivity',
        toolInput: JSON.stringify({ activityId: event.activityId, operation: event.operation }),
        toolId: `trace-${event.id}`,
        executionStatus: event.status === 'error' ? 'failed' : event.status === 'running' ? 'running' : 'completed',
        resultReady: event.status !== 'running',
        ...(event.status !== 'running' ? { result: JSON.stringify({ authority: event.authority, status: event.status }) } : {}),
        presentation: {
          title: event.title,
          ...(detail ? { detail } : {}),
          status: activityStatus(event.status),
        },
      });
      continue;
    }
    if (event.type !== 'effect') continue;

    const fields = event.fields ?? [];
    const detail = fields.length >= 2
      ? [{ fields: fields.map((field) => ({ k: field.label, v: field.value })) }]
      : fields.map((field) => ({ k: field.label, v: field.value }));
    const write = event.operation !== 'read' && event.operation !== 'verify';
    messages.push({
      id: `trace-${event.id}`,
      type: 'tool_use',
      toolName: event.system,
      toolInput: JSON.stringify({ effectId: event.effectId, operation: event.operation }),
      toolId: `trace-${event.id}`,
      executionStatus: 'completed',
      result: JSON.stringify({ authority: event.authority, verification: event.verification }),
      resultReady: true,
      presentation: {
        title: event.title,
        ...(detail.length ? { detail } : {}),
        status: (write && event.verification === 'none') || fields.some((field) => field.state === 'warning') ? 'warn' : 'ok',
        ...(event.receipt ? {
          receipt: {
            id: event.receipt.id,
            system: event.receipt.system,
            ...(event.verification === 'read_back' ? { readBack: true } : {}),
          },
        } : {}),
        connector: { system: event.system, write },
      },
    });
  }

  return messages;
}

export interface WorkflowTraceProjection {
  events: WorkflowTraceEventV1[];
  messages: MessageItem[];
  panel: SystemPanelSnapshot | null;
  pendingGate: WorkflowTraceGateRequestedEventV1 | null;
}

/** 同一事件前缀永远得到同一组会话消息、系统面板和审批门禁。 */
export function projectWorkflowTrace(input: readonly WorkflowTraceEventV1[]): WorkflowTraceProjection {
  const events = normalizeEvents([...input]);
  const pending = new Map<string, WorkflowTraceGateRequestedEventV1>();
  for (const event of events) {
    if (event.type === 'gate_requested') pending.set(event.gateId, event);
    else if (event.type === 'gate_resolved') pending.delete(event.gateId);
  }
  const pendingGate = [...pending.values()].at(-1) ?? null;
  return {
    events,
    messages: projectMessages(events),
    panel: projectPanel(events),
    pendingGate,
  };
}
