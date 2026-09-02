import { describe, expect, it } from 'vitest';
import { createActivityMessageProjectionState, reduceActivityMessageProjection } from './activityMessageProjection';
import { runtimeProjectionFixture } from './__fixtures__/activityMessageProjection.fixture';
import { canonicalTimelineFixture, runtimeTimelineFixture } from './__fixtures__/renderModel.fixture';
import { renderSemanticSignature, selectRenderModel, type RenderTimelineItemKind } from './renderModel';
import type { MessageItem } from '../types/message';

const kinds: RenderTimelineItemKind[] = [
  'user_text', 'assistant_text', 'code', 'tool_activity', 'subagent_activity',
  'system_status', 'error', 'moderation', 'attachment', 'voice_placeholder',
];

describe('M50-01 unified RenderModel presenter', () => {
  it('presents captured canonical message/runtime shapes with stable IDs and structured errors', () => {
    const model = selectRenderModel({ messages: canonicalTimelineFixture, runtime: runtimeTimelineFixture });
    expect(model.items.map((item) => item.id)).toEqual([
      'message:user:user-1', 'message:assistant:run-1:text-1', 'tool:run-1:tool-1',
      'subagent:child-1', 'attachment:assets/report.pdf', 'status:run-2', 'error:run-3',
    ]);
    expect(model.byId['error:run-3']).toMatchObject({
      kind: 'error', error: { domain: 'transport', retryability: 'retryable' },
      actions: { retry: true }, accessibility: { role: 'alert', live: 'assertive' },
    });
  });

  it('covers every required kind without renderer-specific nodes', () => {
    const messages: MessageItem[] = [
      ...canonicalTimelineFixture,
      { id: 'code-1', type: 'text', content: '```ts\nconst x = 1;\n```' },
      { id: 'status-1', type: 'system_event', title: 'Status', content: 'Ready' },
      { id: 'error-1', type: 'system-error', content: 'Failed' },
      { id: 'voice-1', type: 'voice', voiceMarkers: [{ text: 'Hello' }] },
      { id: 'moderated-1', type: 'text', content: 'ordinary text', moderation: { eventId: 'mod-event', moderationId: 'mod-1', runId: 'run-m', messageId: 'message-m', blockId: 'moderated-1', outcome: 'blocked' } },
    ];
    const actual = new Set(selectRenderModel({ messages }).items.map((item) => item.kind));
    for (const kind of kinds) expect(actual.has(kind), kind).toBe(true);
    expect(JSON.stringify([...actual])).not.toMatch(/React|HTMLElement|ViewStyle/);
  });

  it('deduplicates replay and merges tool result by semantic tool identity', () => {
    const use: MessageItem = { id: 'block-a', type: 'tool_use', toolId: 'call-1', toolName: 'Read', toolInput: '{}', executionStatus: 'running' };
    const result: MessageItem = { id: 'block-b', type: 'tool_result', toolId: 'call-1', toolName: 'Read', result: 'ok' };
    const model = selectRenderModel({ messages: [use, use, result, result] });
    expect(model.items).toHaveLength(1);
    expect(model.items[0]).toMatchObject({ id: 'tool:history:call-1', status: 'running' });
    expect(model.items[0].content).toEqual([expect.objectContaining({ type: 'tool', result: 'ok' })]);
  });

  it('uses the M20-06 projection for repeated/out-of-order tool and subagent events', () => {
    const state = runtimeProjectionFixture.reduce(reduceActivityMessageProjection, createActivityMessageProjectionState());
    const model = selectRenderModel({ activity: state });
    expect(model.items.filter((item) => item.kind === 'tool_activity')).toHaveLength(1);
    expect(model.items.filter((item) => item.kind === 'subagent_activity')).toHaveLength(1);
    expect(model.items.find((item) => item.id === 'tool:run-fixture:same-tool')?.status).toBe('failed');
    expect(model.items.find((item) => item.id === 'subagent:agent-call')?.status).toBe('failed');
  });

  it('keeps moderation isolated from tool, permission and workflow strings', () => {
    const model = selectRenderModel({ messages: [
      { id: 'tool', type: 'tool_use', toolId: 'call', toolName: 'Shell', toolInput: 'blocked moderation denied', result: 'policy workflow blocked', executionStatus: 'failed' },
      { id: 'permission', type: 'permission_request', interactionId: 'i-1', toolName: 'Shell', toolInput: 'moderation blocked', status: 'pending' },
      { id: 'workflow', type: 'ask_user', interactionId: 'i-2', questions: [{ question: 'blocked?', header: 'moderation', options: [], multiSelect: false }], status: 'pending' },
      { id: 'text', type: 'text', content: 'blocked denied moderation are text' },
    ] });
    expect(model.items.some((item) => item.kind === 'moderation')).toBe(false);
    expect(model.byId['tool:history:call'].error).toEqual({ domain: 'tool', retryability: 'unknown' });
  });

  it('applies only an explicit moderation projection to its target block', () => {
    const model = selectRenderModel({
      messages: [{ id: 'target', type: 'text', content: 'target' }, { id: 'other', type: 'text', content: 'other' }],
      moderation: [{ eventId: 'event', moderationId: 'mod', runId: 'run', messageId: 'message', blockId: 'target', outcome: 'flagged', reasonCode: 'review' }],
    });
    expect(model.items.find((item) => item.id.endsWith(':target'))).toMatchObject({ kind: 'moderation', status: 'flagged' });
    expect(model.items.find((item) => item.id.endsWith(':other'))?.kind).toBe('assistant_text');
  });

  it('safe-falls back unknown kinds to plain unsupported content with no HTML capability', () => {
    const model = selectRenderModel({ messages: [{ id: 'future', type: 'future_html', html: '<script>alert(1)</script>' }] });
    expect(model.items[0]).toMatchObject({
      kind: 'system_status', content: [{ type: 'plain_text', text: 'Unsupported message：This message type is not supported.' }], actions: { preview: false },
    });
    expect(JSON.stringify(model.items[0].content)).not.toContain('<script>');
  });

  it('does not expose HTML preview capability while retaining safe markdown semantics', () => {
    const model = selectRenderModel({ messages: [
      { id: 'html', type: 'file_download', fileName: 'unsafe.html', fileType: 'text/html', filePath: 'unsafe.html', fileSize: 1, mimeType: 'text/html' },
      { id: 'md', type: 'text', content: '<b>literal html</b>' },
    ] });
    expect(model.items[0].actions.preview).toBe(false);
    expect(model.items[1].content).toEqual([{ type: 'markdown', text: '<b>literal html</b>', allowHtml: false }]);
  });

  it('keeps stable order and unrelated references across stream restart/delta updates', () => {
    const initial = selectRenderModel({ messages: [
      { id: 'stable', type: 'user', content: 'stable' },
      { id: 'block-1', type: 'text', runId: 'run', content: 'first', streaming: true },
      { id: 'block-2', type: 'text', runId: 'run', content: 'second', streaming: true },
    ] });
    const restarted = selectRenderModel({ messages: [
      { id: 'stable', type: 'user', content: 'stable' },
      { id: 'block-1', type: 'text', runId: 'run', content: 'first done', streaming: false },
      { id: 'block-2', type: 'text', runId: 'run', content: 'second + delta', streaming: true },
    ] }, initial);
    expect(restarted.items.map((item) => item.id)).toEqual(initial.items.map((item) => item.id));
    expect(restarted.byId['message:user:stable']).toBe(initial.byId['message:user:stable']);
    expect(restarted.byId['message:assistant:run:block-1']).not.toBe(initial.byId['message:assistant:run:block-1']);
  });

  it('hydrate/live restart converges to identical semantic signatures', () => {
    const hydrate = selectRenderModel({ messages: [{ id: 'block', type: 'text', runId: 'run', content: 'done', streaming: false, timestamp: 123 }] });
    const live = selectRenderModel({ messages: [{ id: 'block', type: 'text', runId: 'run', content: 'done', streaming: false, timestamp: 123 }] });
    expect(live.items.map(renderSemanticSignature)).toEqual(hydrate.items.map(renderSemanticSignature));
  });

  it('1000-item deterministic complexity stays inside the linear work budget', () => {
    const messages: MessageItem[] = Array.from({ length: 1000 }, (_, index) => ({ id: `m-${index}`, type: index % 2 ? 'text' : 'user', content: `message ${index}` }));
    const first = selectRenderModel({ messages });
    const second = selectRenderModel({ messages }, first);
    expect(first.stats).toEqual({ inputCount: 1000, outputCount: 1000, reusedCount: 0, workUnits: 9000 });
    expect(second.stats).toEqual({ inputCount: 1000, outputCount: 1000, reusedCount: 1000, workUnits: 9000 });
    expect(second.items[999]).toBe(first.items[999]);
  });
});
