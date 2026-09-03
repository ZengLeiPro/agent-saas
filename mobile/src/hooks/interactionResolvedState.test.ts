import { describe, expect, it } from "vitest";
import {
  processWsEvent,
  type MessageItem,
  type MessageItemInput,
  type MessagesController,
  type WsEvent,
  type WsProcessingContext,
} from "@agent/shared";

function apply(
  initial: MessageItem,
  event: Extract<WsEvent, { type: "interaction_resolved" }>,
): MessageItem {
  const messages = [initial];
  const msg: MessagesController = {
    messagesRef: { current: messages },
    addMessage: (input: MessageItemInput) => { messages.push(input as MessageItem); return messages.length - 1; },
    updateMessageAt: (index, updater) => { messages[index] = updater(messages[index]); },
    setMessages: () => {},
    triggerScroll: () => {},
  };
  const ctx = {
    msg,
    session: {},
    selectedModelRef: { current: "" },
    voiceCallbackRef: { current: null },
    streamIdRef: { current: null },
    userMsgIndex: -1,
  } as unknown as WsProcessingContext;
  processWsEvent(event, ctx, { currentBlockIndex: -1, currentBlockType: null }, { value: event.sessionId }, event.sessionId);
  return messages[0];
}

describe("mobile cross-connection interaction resolution", () => {
  it.each([[true, "allowed"], [false, "denied"]] as const)("applies canonical allow=%s", (allow, status) => {
    const message = apply(
      { id: "p", type: "permission_request", interactionId: "approval", toolName: "Shell", toolInput: "{}", status: "pending" },
      { type: "interaction_resolved", sessionId: "s", interactionId: "approval", response: { allow } },
    );
    expect(message).toMatchObject({ type: "permission_request", status });
  });

  it("keeps the durable first AskUser answer when an ACK was lost and a retry changed it", () => {
    const message = apply(
      { id: "a", type: "ask_user", interactionId: "ask", questions: [], status: "pending" },
      { type: "interaction_resolved", sessionId: "s", interactionId: "ask", response: { answers: { q: "first" } } },
    );
    expect(message).toMatchObject({ type: "ask_user", status: "answered", answers: { q: "first" } });
  });

  it("does not revive an interaction when its terminal event arrives before the request", () => {
    const messages: MessageItem[] = [];
    const msg: MessagesController = {
      messagesRef: { current: messages },
      addMessage: (input: MessageItemInput) => { messages.push(input as MessageItem); return messages.length - 1; },
      updateMessageAt: (index, updater) => { messages[index] = updater(messages[index]); },
      setMessages: (next) => { messages.splice(0, messages.length, ...(next as MessageItem[])); },
      triggerScroll: () => {},
    };
    const ctx = {
      msg,
      session: {},
      selectedModelRef: { current: "" },
      voiceCallbackRef: { current: null },
      streamIdRef: { current: null },
      resolvedInteractionIdsRef: { current: new Set<string>() },
      userMsgIndex: -1,
    } as unknown as WsProcessingContext;
    const block = { currentBlockIndex: -1, currentBlockType: null };
    processWsEvent(
      { type: "interaction_resolved", sessionId: "s", interactionId: "late", status: "resolved", response: { answers: { q: "done" } } },
      ctx,
      block,
      { value: "s" },
      "s",
    );
    processWsEvent(
      { type: "ask_user", interactionId: "late", questions: [] },
      ctx,
      block,
      { value: "s" },
      "s",
    );
    expect(messages.some((message) => message.type === "ask_user" && message.interactionId === "late")).toBe(false);
  });
});
