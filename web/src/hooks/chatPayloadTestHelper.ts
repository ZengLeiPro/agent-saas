import type { CanonicalChatSubmissionWireMessage } from '@agent/shared';

type SendMock = {
  mock: { calls: readonly (readonly unknown[])[] };
};

export function createChatPayloadReader(sends: SendMock) {
  return (): CanonicalChatSubmissionWireMessage[] => sends.mock.calls
    .map(([payload]) => payload as CanonicalChatSubmissionWireMessage)
    .filter((payload) => payload.action === 'chat');
}
