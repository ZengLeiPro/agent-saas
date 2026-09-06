import type { MessageItem } from './types';
import { PermissionBlock } from './PermissionBlock';

type PermissionMessage = Extract<MessageItem, { type: 'permission_request' }>;

interface PermissionMessageItemProps {
  message: PermissionMessage;
  onPermissionResponse?: (interactionId: string, allow: boolean) => void;
}

/** 把 WS 投影后的审批消息完整交给确认卡片，避免壳层字段在渲染入口丢失。 */
export function PermissionMessageItem({
  message,
  onPermissionResponse,
}: PermissionMessageItemProps) {
  return (
    <PermissionBlock
      toolName={message.toolName}
      toolInput={message.toolInput}
      {...(message.confirmation ? { confirmation: message.confirmation } : {})}
      status={message.status}
      onAllow={() => onPermissionResponse?.(message.interactionId, true)}
      onDeny={() => onPermissionResponse?.(message.interactionId, false)}
    />
  );
}
