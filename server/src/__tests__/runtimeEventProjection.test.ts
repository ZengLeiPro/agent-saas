import { describe, expect, it } from "vitest";
import { projectRuntimePlatformEvent } from "../channels/web/runtimeEventProjection.js";
import type { PlatformEvent } from "../runtime/types.js";
import {
  businessStepProjectionFixture,
  toolPresentationProjectionFixture,
} from './fixtures/presentationProjection.fixture.js';

function legacyFrames(event: PlatformEvent): object[] {
  return projectRuntimePlatformEvent(event).events.map((frame) => {
    const { projection: _projection, ...legacy } = frame as Record<string, unknown>;
    return legacy;
  });
}

describe("runtimeEventProjection", () => {
  it("user_message 携带 sourceRunId，供前端阻止旧队列状态复活", () => {
    const event: Extract<PlatformEvent, { type: "user_message" }> = {
      id: "event-1",
      timestamp: "2026-08-11T14:00:00.000Z",
      type: "user_message",
      runId: "target-run",
      sessionId: "session-1",
      content: "插话内容",
      interjectionSourceRunId: "source-run",
      clientMsgId: "client-1",
    };

    const projection = projectRuntimePlatformEvent(event);

    expect(legacyFrames(event)).toEqual([{
      type: "user_message",
      sessionId: "session-1",
      content: "插话内容",
      timestamp: Date.parse(event.timestamp),
      sourceRunId: "source-run",
      client_msg_id: "client-1",
    }]);
  });

  it("assistant_tool_calls 的通用工具块携带 runtime runId", () => {
    const event: Extract<PlatformEvent, { type: "assistant_tool_calls" }> = {
      id: "event-tool-1",
      timestamp: "2026-08-19T12:00:00.000Z",
      type: "assistant_tool_calls",
      sessionId: "session-tool-1",
      runId: "run-tool-1",
      content: "",
      toolCalls: [{ id: "todo-1", name: "TodoWrite", arguments: '{"todos":[]}' }],
    };

    expect(legacyFrames(event)[0]).toEqual({
      type: "block_start",
      blockType: "tool_use",
      toolId: "todo-1",
      toolName: "TodoWrite",
      runId: "run-tool-1",
    });
  });

  it("策略拒绝终态把结构化恢复协议投影到 session_status 与 done", () => {
    const event: Extract<PlatformEvent, { type: "run_state_changed" }> = {
      id: "event-policy-1",
      timestamp: "2026-08-23T13:00:00.000Z",
      type: "run_state_changed",
      sessionId: "session-policy-1",
      runId: "run-policy-1",
      status: "failed",
      reason: "当前模型受策略限制，请切换其他模型继续。",
      failureKind: "policy_rejection",
      recoveryAction: "switch_model",
    };

    expect(legacyFrames(event)).toEqual([
      {
        type: "session_status",
        sessionId: "session-policy-1",
        status: "failed",
        runId: "run-policy-1",
        reason: "当前模型受策略限制，请切换其他模型继续。",
        failureKind: "policy_rejection",
        recoveryAction: "switch_model",
      },
      {
        type: "done",
        sessionId: "session-policy-1",
        runId: "run-policy-1",
        error: "当前模型受策略限制，请切换其他模型继续。",
        failureKind: "policy_rejection",
        recoveryAction: "switch_model",
      },
    ]);
  });

  it("策略拒绝子任务投影结构化恢复协议", () => {
    const event: Extract<PlatformEvent, { type: "subagent_finished" }> = {
      id: "event-subagent-policy",
      timestamp: "2026-08-23T13:00:00.000Z",
      type: "subagent_finished",
      sessionId: "parent-session",
      runId: "parent-run",
      toolCallId: "tool-policy",
      agentType: "general",
      description: "策略测试",
      childSessionId: "child-session",
      childRunId: "child-run",
      status: "failed",
      totalTokens: 10,
      toolUseCount: 0,
      durationMs: 500,
      errorMessage: "当前模型受策略限制，请切换其他模型继续。",
      failureKind: "policy_rejection",
      recoveryAction: "switch_model",
    };

    expect(legacyFrames(event)).toEqual([expect.objectContaining({
      type: "subagent_end",
      failureKind: "policy_rejection",
      recoveryAction: "switch_model",
      errorMessage: "当前模型受策略限制，请切换其他模型继续。",
    })]);
  });

  it("interaction_requested 投影为实时 ask_user 事件", () => {
    const event: Extract<PlatformEvent, { type: "interaction_requested" }> = {
      id: "event-ask-1",
      timestamp: "2026-08-18T08:00:00.000Z",
      type: "interaction_requested",
      sessionId: "session-ask-1",
      runId: "run-ask-1",
      toolCallId: "call-ask-1",
      interactionId: "interaction-ask-1",
      interactionType: "ask_user",
      version: 42,
      order: 42,
      userId: "user-1",
      toolName: "AskUserQuestion",
      questions: [{
        question: "继续吗？",
        header: "确认",
        options: [{ label: "继续", description: "继续执行" }],
        multiSelect: false,
      }],
    };

    expect(legacyFrames(event)).toEqual([{
      type: "ask_user",
      interactionId: "interaction-ask-1",
      version: 42,
      order: 42,
      runId: "run-ask-1",
      toolCallId: "call-ask-1",
      toolName: "AskUserQuestion",
      questions: event.questions,
    }]);
  });

  it('interaction_resolved 投影为幂等终态', () => {
    const event: Extract<PlatformEvent, { type: 'interaction_resolved' }> = {
      id: 'event-ask-resolved-1', timestamp: '2026-08-18T08:01:00.000Z', type: 'interaction_resolved',
      sessionId: 'session-ask-1', runId: 'run-ask-1', toolCallId: 'call-ask-1',
      interactionId: 'interaction-ask-1', interactionType: 'ask_user', response: { answers: { '继续吗？': '继续' } },
    };
    expect(legacyFrames(event)).toEqual([{ type: 'interaction_resolved', sessionId: 'session-ask-1', interactionId: 'interaction-ask-1',
      status: 'resolved', response: event.response }]);
  });

  it('为 replay frame 提供稳定 canonical identity 与显式 domain', () => {
    const event: Extract<PlatformEvent, { type: 'tool_result' }> = {
      id: 'event-tool-result', timestamp: '2026-08-30T00:00:00.000Z', type: 'tool_result',
      sessionId: 'session-1', runId: 'run-a', toolCallId: 'same-id', toolName: 'Shell',
      content: 'blocked is ordinary tool output', isError: true,
    };
    expect(projectRuntimePlatformEvent(event).events[0]).toMatchObject({
      type: 'tool_result',
      projection: {
        eventId: 'event-tool-result:0', domain: 'tool', runId: 'run-a',
        messageId: 'assistant:run-a', blockId: 'tool:run-a:same-id', toolCallId: 'same-id',
      },
    });
  });


  it('projects a structured tool presenter input without raw result or showRaw authority', () => {
    const frame = projectRuntimePlatformEvent(toolPresentationProjectionFixture).events[0] as any;
    expect(frame.projection.presentationInputs).toEqual([{
      kind: 'tool',
      source: {
        id: 'tool:fixture-run:fixture-tool-call',
        kind: 'tool_activity', status: 'completed',
        content: [{
          type: 'tool', toolName: 'Shell',
          presentation: toolPresentationProjectionFixture.presentation,
        }],
      },
    }]);
    const serialized = JSON.stringify(frame.projection.presentationInputs);
    expect(serialized).not.toContain('SERVER_RAW_SENTINEL');
    expect(serialized).not.toContain('showRaw');
  });

  it('projects structured BusinessStep inputs and leaves raw disclosure to the client presenter', () => {
    const frame = projectRuntimePlatformEvent(businessStepProjectionFixture).events.find(
      (candidate) => (candidate as any).type === 'tool_input',
    ) as any;
    expect(frame.projection.presentationInputs).toEqual([{
      kind: 'business_step',
      source: {
        kind: 'business', content: '核对发布结果', status: 'completed',
        outcome: { text: '全部通过', tone: 'ok' },
        display: [{ type: 'checklist', title: '发布检查', items: [{ label: '健康检查', status: 'pass' }] }],
        evidenceRefs: ['release-42'],
      },
    }]);
    expect(JSON.stringify(frame.projection.presentationInputs)).not.toContain('showRaw');
  });

  it('stream restart rotates blockId while replayed deltas keep the active block identity', () => {
    const streamStates = new Map();
    const make = (id: string, phase: 'start' | 'delta' | 'end', content?: string): Extract<PlatformEvent, { type: 'assistant_stream_event' }> => ({
      id, timestamp: '2026-08-30T00:00:00.000Z', type: 'assistant_stream_event',
      sessionId: 'session-1', runId: 'run-stream', blockType: 'text', phase, ...(content ? { content } : {}),
    });
    const first = projectRuntimePlatformEvent(make('start-1', 'start'), { streamStates }).events[0] as any;
    const delta = projectRuntimePlatformEvent(make('delta-1', 'delta', 'a'), { streamStates }).events[0] as any;
    projectRuntimePlatformEvent(make('end-1', 'end'), { streamStates });
    const restarted = projectRuntimePlatformEvent(make('start-2', 'start'), { streamStates }).events[0] as any;
    expect(delta.projection.blockId).toBe(first.projection.blockId);
    expect(restarted.projection.blockId).not.toBe(first.projection.blockId);
  });

});
