/** chat/blocks 统一出口：MessageItem 的 type 分发从这里取块组件。 */
export { ActivityGroupView } from './ActivityGroupBlock';
export { AskUserBlock } from './AskUserBlock';
export { BusinessStepCard } from './BusinessStepBlock';
export { FileDownloadCard } from './FileDownloadCard';
export { PermissionBlock } from './PermissionBlock';
export { CanonicalPresentationBody } from './PresentationBlock';
export { SubagentBlock } from './SubagentBlock';
export { ModerationMessage, SystemTimelineMessage } from './SystemBlocks';
export { TextMessage } from './TextBlock';
export { ThinkingBlock } from './ThinkingBlock';
export { ToolResultBlock, ToolUseBlock } from './ToolBlock';
export { UserMessage } from './UserMessage';
export { UserVoiceBlock, VoiceBlock } from './VoiceBlocks';
export { CATEGORY_ICON, useMessageStyles, type MessageStyles } from './shared';
