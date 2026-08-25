import type { WsEvent } from "@agent/shared";

export function acknowledgedInteractionResponse(
  ack: Extract<WsEvent, { type: "respond_ok" }>,
  localResponse: Record<string, unknown>,
): Record<string, unknown> {
  return ack.response && typeof ack.response === "object" ? ack.response : localResponse;
}
