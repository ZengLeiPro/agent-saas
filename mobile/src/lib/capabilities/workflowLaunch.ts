/**
 * 工作流「试一试 / 接入 / 诊断」的起手消息 —— 对齐 Web `scenarios/workflowUi.ts`
 * 的 `workflowTrialMessage` 与 `ScenariosPanel` 里的诊断话术。
 *
 * 关键约束（与 Web 逐字一致）：D1/D2 尚未接入客户系统，起手消息必须**明确限定
 * 为示例数据**，避免把试用误解为生产执行。
 */
import type { CatalogScenarioPublic } from '@agent/shared';

export function workflowTrialMessage(scenario: CatalogScenarioPublic): string {
  if (scenario.launch.startMode === 'chat') return scenario.launch.starterMessage;
  return [
    `请用示例数据带我体验「${scenario.title}」。`,
    `从这个示例业务事件开始：${scenario.launch.entry.content}`,
    '不要连接或写入任何真实业务系统；请展示会读取什么、如何判断、哪些动作需要人工确认，以及怎样回读并核验结果。',
  ].join('\n');
}

export function workflowDiagnosisMessage(scenario: CatalogScenarioPublic): string {
  return `我想为「${scenario.title}」预约落地诊断，请先确认业务边界、现有系统和所需人审。`;
}
