export interface SlashCommandDefinition {
  name: '/loop' | '/goal';
  summary: string;
  syntax: string;
  examples: string[];
  budgetHint: string;
}

export const SESSION_AUTOMATION_SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  {
    name: '/loop',
    summary: '按固定周期或自适应节奏持续执行任务',
    syntax: '/loop [1m|5m|1h] [--max-runs N] [--for 2d] -- <任务>',
    examples: ['/loop 5m -- 检查部署并处理失败', '/loop pause', '/loop run'],
    budgetHint: '固定周期最短 1 分钟；可限制运行次数和到期时间。',
  },
  {
    name: '/goal',
    summary: '持续推进，直到可验证的完成条件成立',
    syntax: '/goal set [--max-turns N] [--max-tokens 250k] [--for 8h] -- <完成条件>',
    examples: ['/goal set -- 所有测试通过且 0 个类型错误', '/goal pause', '/goal clear'],
    budgetHint: '建议同时设置轮次、Tokens 和时限预算；裸 /goal 仅查看状态。',
  },
] as const;

export function matchingSlashCommands(input: string): readonly SlashCommandDefinition[] {
  const trimmedStart = input.trimStart();
  if (!trimmedStart.startsWith('/') || trimmedStart.includes('\n')) return [];
  const token = trimmedStart.split(/\s/, 1)[0].toLowerCase();
  return SESSION_AUTOMATION_SLASH_COMMANDS.filter((command) => command.name.startsWith(token));
}
