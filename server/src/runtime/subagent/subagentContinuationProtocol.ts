export const SUBAGENT_CONTINUATION_PROTOCOL_VERSION = 1 as const;

export function supportsSubagentContinuationProtocol(metadata: Record<string, unknown>): boolean {
  return metadata.subagentContinuationProtocolVersion === SUBAGENT_CONTINUATION_PROTOCOL_VERSION;
}
