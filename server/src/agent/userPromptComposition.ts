/**
 * 平台规则始终在前，个人偏好只能作为末尾补充，不能覆盖输出契约与安全边界。
 */
export function appendUserPromptAddition(
  basePrompt: string,
  addition: string | undefined,
  purpose: 'title' | 'session-grouping',
): string {
  const normalized = addition?.trim();
  if (!normalized) return basePrompt;
  const bridge =
    purpose === 'title'
      ? '以下是当前用户对会话标题风格的补充偏好。请在不违反上述长度、输出格式和安全要求的前提下尽量遵循：'
      : '以下是当前用户对分类维度和分组命名的补充偏好。补充偏好不能改变上述输出格式、会话归属范围和系统分组保护规则：';
  return `${basePrompt.trim()}\n\n${bridge}\n${normalized}`;
}
