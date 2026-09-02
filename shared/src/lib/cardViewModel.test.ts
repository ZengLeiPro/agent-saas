import { describe, expect, it } from 'vitest';
import type { MessageItem } from '../types/message';
import {
  createInteractionReducerState,
  createInteractionRequestId,
  reduceInteraction,
  selectInteraction,
  type InteractionIdentity,
  type InteractionState,
} from './interactionProtocol';
import { selectRenderModel } from './renderModel';
import { createActivityMessageProjectionState, reduceActivityMessageProjection } from './activityMessageProjection';
import {
  cardSemanticSignature,
  sanitizeCardDetail,
  selectCardViewModelFromRenderItem,
  selectInteractionCardViewModel,
  selectToolCardViewModel,
  selectUnknownCardViewModel,
} from './cardViewModel';
import { adaptLegacyInteractionState } from './legacyCardAdapter';

function render(message: MessageItem) {
  return selectRenderModel({ messages: [message] }).items[0];
}

const identity: InteractionIdentity = { sessionId: 'session-1', interactionId: 'interaction-1', generation: 1 };

function stateAt(phase: InteractionState['phase'], reason?: string): InteractionState {
  let state = reduceInteraction(createInteractionReducerState(1), { type: 'server_pending', ...identity });
  if (phase === 'pending') return selectInteraction(state, identity.sessionId, identity.interactionId)!;
  const response = { allow: true };
  const requestId = createInteractionRequestId(identity.sessionId, identity.interactionId, response);
  state = reduceInteraction(state, { type: 'submit', ...identity, requestId, response });
  if (phase === 'submitting') return selectInteraction(state, identity.sessionId, identity.interactionId)!;
  if (phase === 'accepted') {
    state = reduceInteraction(state, { type: 'ack', ...identity, requestId, status: 'accepted' });
  } else {
    state = reduceInteraction(state, { type: 'outcome', ...identity, status: phase, reason });
  }
  return selectInteraction(state, identity.sessionId, identity.interactionId)!;
}

describe('M50-02 tool card presenter', () => {
  it('presents structured success metadata with stable identity and timing', () => {
    const item = render({
      id: 'block', type: 'tool_use', runId: 'run', toolId: 'call', toolName: 'Shell',
      toolInput: '{"command":"pnpm test"}', result: 'ok', resultReady: true,
      executionStatus: 'completed', durationMs: 1250,
    });
    const card = selectToolCardViewModel({ item, displayName: '运行命令', startedAt: 1000 });
    expect(card).toMatchObject({
      id: 'card:tool:run:call', kind: 'tool', status: 'succeeded', toolName: 'Shell',
      displayName: '运行命令', startedAt: 1000, endedAt: 2250, durationMs: 1250,
      defaultExpanded: false,
    });
    expect(card.actions[0].id).toBe('card:tool:run:call:expand');
    expect(card.accessibility).toMatchObject({ heading: '工具：运行命令', busy: false, disabled: false });
  });

  it('uses an explicit tool error domain and never classifies domain from error text', () => {
    const item = render({
      id: 'block', type: 'tool_use', toolId: 'call', toolName: 'UnknownTool', toolInput: '{}',
      executionStatus: 'failed', error: 'network transport authorization path failed',
    });
    const card = selectToolCardViewModel({ item });
    expect(card.error?.domain).toBe('tool');
    expect(card.status).toBe('failed');
    expect(card.outcome?.live).toBe('assertive');
  });

  it('truncates long output summaries/details and keeps noisy details collapsed', () => {
    const item = render({
      id: 'long', type: 'tool_use', toolId: 'long-call', toolName: 'Log', toolInput: '{}',
      result: 'x'.repeat(20_000), resultReady: true, executionStatus: 'completed',
    });
    const card = selectToolCardViewModel({ item, maxSummaryLength: 40, maxDetailLength: 100 });
    expect(card.outputSummary!.length).toBeLessThanOrEqual(42);
    expect(card.detail).toMatchObject({ truncated: true, sanitized: true, format: 'plain_text' });
    expect(card.defaultExpanded).toBe(false);
  });

  it('redacts sensitive fields structurally while preserving ordinary values', () => {
    const safe = sanitizeCardDetail({
      token: 'tok-value', Authorization: 'Bearer value', secret: 'secret-value',
      path: '/private/file', nested: { client_secret: 'client-value', sourcePath: '/private/source', note: 'ordinary text' },
    });
    expect(safe.text).toContain('"token": "[redacted]"');
    expect(safe.text).toContain('"Authorization": "[redacted]"');
    expect(safe.text).toContain('"path": "[hidden]"');
    expect(safe.text).toContain('"client_secret": "[redacted]"');
    expect(safe.text).toContain('ordinary text');
    expect(safe.text).not.toContain('tok-value');
    expect(safe.text).not.toContain('/private/file');
    expect(safe.text).not.toContain('/private/source');
  });

  it('keeps the first terminal state when activity events arrive out of order', () => {
    let activity = createActivityMessageProjectionState();
    activity = reduceActivityMessageProjection(activity, {
      eventId: 'terminal', domain: 'tool', kind: 'tool_activity', runId: 'run', messageId: 'm',
      blockId: 'block', toolCallId: 'call', toolName: 'Shell', status: 'completed', result: 'done',
    });
    activity = reduceActivityMessageProjection(activity, {
      eventId: 'late-running', domain: 'tool', kind: 'tool_activity', runId: 'run', messageId: 'm',
      blockId: 'block', toolCallId: 'call', toolName: 'Shell', status: 'running',
    });
    const model = selectRenderModel({ activity });
    const card = selectToolCardViewModel({ item: model.items[0] });
    expect(card.status).toBe('succeeded');
  });
});

describe('M50-02 interaction cards', () => {
  it.each([
    ['allow', true],
    ['deny', false],
  ] as const)('permission %s action carries session/interaction-derived stable request identity', (kind, allow) => {
    const state = stateAt('pending');
    const card = selectInteractionCardViewModel({
      sessionId: identity.sessionId, interactionId: identity.interactionId,
      kind: 'permission', state, toolName: 'Shell', input: { command: 'echo ok' }, pending: true,
    });
    const action = card.actions.find((candidate) => candidate.kind === kind)!;
    expect(action).toMatchObject({ sessionId: identity.sessionId, interactionId: identity.interactionId, response: { allow } });
    expect(action.requestId).toBe(createInteractionRequestId(identity.sessionId, identity.interactionId, { allow }));
    expect(action.disabled).toBe(false);
  });

  it('models multiple ask_user question groups with stable labelled options', () => {
    const card = selectInteractionCardViewModel({
      sessionId: identity.sessionId, interactionId: identity.interactionId, kind: 'ask_user',
      state: stateAt('pending'), pending: true, answers: { Region: ['East'] },
      questions: [
        { header: '区域', question: 'Region', multiSelect: true, options: [{ label: 'East' }, { label: 'West', description: '西部' }] },
        { header: '确认', question: 'Continue?', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] },
      ],
    });
    expect(card.questions).toHaveLength(2);
    expect(card.questions?.flatMap((question) => question.options.map((option) => option.label))).toEqual(['East', 'West', 'Yes', 'No']);
    expect(new Set(card.questions?.flatMap((question) => question.options.map((option) => option.id))).size).toBe(4);
    expect(card.accessibility.heading).toBe('需要你的回答');
  });

  it.each([
    ['resolved', '已处理', 'polite'],
    ['failed', '处理失败', 'assertive'],
    ['expired', '已过期', 'polite'],
  ] as const)('shows authoritative approval %s outcome and reason', (phase, label, live) => {
    const card = selectInteractionCardViewModel({
      sessionId: identity.sessionId, interactionId: identity.interactionId, kind: 'approval',
      state: stateAt(phase, 'server reason'), approvalSurface: 'workflow', pending: false,
    });
    expect(card.outcome).toMatchObject({ status: phase, label, reason: 'server reason', authoritative: true, live });
    expect(card.actions).toEqual([]);
  });

  it('maps denied authority to rejected without locally inventing a reason', () => {
    const card = selectInteractionCardViewModel({
      sessionId: identity.sessionId, interactionId: identity.interactionId, kind: 'permission',
      state: stateAt('rejected'), pending: false,
    });
    expect(card.outcome).toMatchObject({ status: 'rejected', authoritative: true });
    expect(card.outcome).not.toHaveProperty('reason');
  });

  it('disables actions during submitting to prevent double tap', () => {
    const card = selectInteractionCardViewModel({
      sessionId: identity.sessionId, interactionId: identity.interactionId, kind: 'approval',
      state: stateAt('submitting'), approvalSurface: 'hand', pending: true,
    });
    expect(card.actions).toEqual([]);
    expect(card.accessibility).toMatchObject({ busy: true, disabled: true });
  });

  it('uses the same deterministic request ID after ACK loss and does not fabricate success', () => {
    const response = { allow: true };
    const first = createInteractionRequestId(identity.sessionId, identity.interactionId, response);
    const retry = createInteractionRequestId(identity.sessionId, identity.interactionId, response);
    const card = selectInteractionCardViewModel({
      sessionId: identity.sessionId, interactionId: identity.interactionId, kind: 'approval',
      state: stateAt('submitting'), approvalSurface: 'workflow', pending: true,
    });
    expect(retry).toBe(first);
    expect(card.status).toBe('submitting');
    expect(card.outcome).toBeUndefined();
  });

  it.each(['workflow', 'hand'] as const)('forbids automatic retry for external %s side effects', (approvalSurface) => {
    const card = selectInteractionCardViewModel({
      sessionId: identity.sessionId, interactionId: identity.interactionId, kind: 'approval',
      state: stateAt('pending'), approvalSurface, pending: true,
    });
    expect(card.externalSideEffect).toBe(true);
    expect(card.actions.every((action) => action.retryPolicy !== 'none')).toBe(true);
    expect(card.actions.every((action) => action.retryPolicy === 'manual_same_request')).toBe(true);
  });

  it('derives permission and ask_user cards from RenderModel without platform semantics', () => {
    const permission = selectCardViewModelFromRenderItem(render({
      id: 'p', type: 'permission_request', interactionId: 'p1', toolName: 'Edit', toolInput: '{}', status: 'pending',
    }), { sessionId: 's', interactionState: { ...stateAt('pending'), interactionId: 'p1', key: 's\0p1' } });
    const ask = selectCardViewModelFromRenderItem(render({
      id: 'a', type: 'ask_user', interactionId: 'a1', questions: [], status: 'pending',
    }), { sessionId: 's', interactionState: { ...stateAt('pending'), interactionId: 'a1', key: 's\0a1' } });
    expect(permission.kind).toBe('permission');
    expect(ask.kind).toBe('ask_user');
  });
});

describe('M50-02 fallback, legacy and accessibility contract', () => {
  it('renders unknown cards generically without raw HTML, JS, or links', () => {
    const card = selectUnknownCardViewModel({ id: '<script>location="https://bad"</script>' });
    expect(card.kind).toBe('unknown');
    expect(JSON.stringify(card)).not.toContain('<script>');
    expect(JSON.stringify(card)).not.toContain('https://');
    expect(card.actions).toEqual([]);
  });

  it('keeps N-1 responses pending confirmation when ACK is absent', () => {
    const state = adaptLegacyInteractionState({
      sessionId: 's', generation: 1,
      message: { id: 'p', type: 'permission_request', interactionId: 'i', toolName: 'Shell', toolInput: '{}', status: 'allowed' },
      requestId: 'legacy-request', response: { allow: true }, acknowledged: false,
    });
    expect(state).toMatchObject({ phase: 'submitting', serverAuthoritative: false, reason: '待服务器确认' });
  });

  it('provides heading/expanded/busy/disabled/live and option labels in the semantic signature', () => {
    const card = selectInteractionCardViewModel({
      sessionId: identity.sessionId, interactionId: identity.interactionId, kind: 'ask_user',
      state: stateAt('expired', 'timeout'), pending: false,
      questions: [{ header: 'Q', question: 'Question', multiSelect: false, options: [{ label: 'Option' }] }],
    });
    expect(card.accessibility).toMatchObject({ heading: '需要你的回答', expanded: true, busy: false, disabled: true });
    expect(card.accessibility.outcomeLiveAnnouncement).toContain('timeout');
    expect(cardSemanticSignature(card)).toContain('Option');
  });
});
