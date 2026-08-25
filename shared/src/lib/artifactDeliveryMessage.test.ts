import { describe, expect, it } from 'vitest';
import type { MessageItem, MessageItemInput } from '../types/message';
import { handleArtifactDeliveryToolResult } from './artifactDeliveryMessage';
import type { MessagesController } from './wsEventProcessorHelpers';

function controller(): { messages: MessageItem[]; controller: MessagesController } {
  const messages: MessageItem[] = [];
  return {
    messages,
    controller: {
      messagesRef: { current: messages },
      addMessage(message: MessageItemInput) {
        messages.push({ id: `message-${messages.length}`, ...message } as MessageItem);
        return messages.length - 1;
      },
      updateMessageAt() {},
      triggerScroll() {},
    },
  };
}

describe('Artifact 交付实时降级', () => {
  it('旧服务端直推 deliver 工具结果时恢复文件卡片并保持幂等', () => {
    const state = controller();
    const event = {
      toolName: 'Artifact',
      result: JSON.stringify({
        action: 'deliver', artifactId: 'artifact-1', kind: 'file', fileName: '交付结果.docx', sizeBytes: 2048,
      }),
    };

    expect(handleArtifactDeliveryToolResult(event, state.controller)).toBe(true);
    expect(handleArtifactDeliveryToolResult(event, state.controller)).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({
      id: 'artifact-delivery-artifact-1',
      type: 'file_download', artifactId: 'artifact-1', fileName: '交付结果.docx', fileSize: 2048,
    });
  });
});
