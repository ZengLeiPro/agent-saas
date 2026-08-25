import { describe, expect, it } from "vitest";
import { acknowledgedInteractionResponse } from "./interactionResponseAck";

describe("mobile interaction response ACK", () => {
  it("uses the durable canonical response after the first ACK was lost and a changed retry was sent", () => {
    const retryResponse = { allow: false, message: "changed retry" };
    const canonicalResponse = { allow: true, message: "first persisted response" };

    expect(acknowledgedInteractionResponse({
      type: "respond_ok",
      interactionId: "approval-1",
      clientAttemptId: "attempt-2",
      response: canonicalResponse,
    }, retryResponse)).toEqual(canonicalResponse);
  });

  it("keeps compatibility with an older ACK that has no canonical response", () => {
    const localResponse = { answers: { choice: "retry" } };
    expect(acknowledgedInteractionResponse({
      type: "respond_ok",
      interactionId: "ask-1",
    }, localResponse)).toBe(localResponse);
  });
});
