import type { EffectiveConfigStatus } from './types';

type SecretItem = NonNullable<EffectiveConfigStatus['secrets']['items']>[number];
export type ConfigTarget = SecretItem['target'];

export const TARGETS: Record<Exclude<ConfigTarget, null>, { label: string; routeId: string }> = {
  models: { label: '模型配置', routeId: 'platform.resource-center.models' },
  tools: { label: '工具配置', routeId: 'platform.resource-center.tools' },
  memory: { label: '记忆策略', routeId: 'platform.governance.memory-policy' },
  system: { label: '系统配置', routeId: 'platform.governance.system-settings' },
  execution: { label: '执行提供方', routeId: 'platform.runtime.execution-providers' },
};

/** 能力展示名。状态页只做汇总与跳转，具体表单在各业务页面。 */
export const CAPABILITY_LABELS: Record<string, string> = {
  models: '模型',
  codex: 'Codex',
  webTools: 'WebTools',
  imageGen: 'ImageGen',
  stt: '语音转写',
  tts: '语音合成',
  memory: 'Memory',
  memoryPolling: '记忆轮询',
  memoryConsolidation: '记忆整合',
  cron: '定时任务',
  systemMonitor: '系统监控',
  eventRetention: '事件保留',
  toolControls: '工具控制',
  acs: 'ACS 执行环境',
};

/** 能力对应的有效配置字段，只用于展示「这项能力读的是哪段配置」。 */
export const CAPABILITY_SOURCES: Record<string, string> = {
  models: 'models.groups',
  codex: 'codexSubscription.enabled',
  webTools: 'webTools.enabled',
  imageGen: 'imageGenTools.enabled',
  stt: 'stt.enabled',
  tts: 'tts',
  memory: 'memory.enabled',
  memoryPolling: 'memory.polling.enabled',
  memoryConsolidation: 'memory.consolidation.enabled',
  cron: 'cron.enabled',
  systemMonitor: 'systemMonitor.enabled',
  eventRetention: 'runtimeEventRetention.enabled',
  toolControls: 'toolControls.enabled',
  acs: 'tenantRemoteHands.hands',
};

export function secretAreaLabel(path: string): string {
  if (path.startsWith('models.')) return '模型';
  if (path.startsWith('codexSubscription.')) return 'Codex';
  if (path.startsWith('webTools.')) return 'WebTools';
  if (path.startsWith('imageGenTools.')) return 'ImageGen';
  if (path.startsWith('stt.')) return '语音转写';
  if (path.startsWith('tts.')) return '语音合成';
  if (path.startsWith('memory.')) return 'Memory';
  if (path.startsWith('tenantRemoteHands.')) return '执行环境';
  return '其他配置';
}
