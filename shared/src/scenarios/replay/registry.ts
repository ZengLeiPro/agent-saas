import { knowledgeQaScript } from "./knowledgeQaScript";
import { meetingActionScript } from "./meetingActionScript";
import { presentationToReplayScript } from "./presentationReplayScript";
import type { CatalogScenarioPublic } from "../../types";
import type { ReplayScript } from "./types";

/**
 * 场景演示剧本注册表。
 *
 * 单独成文件（不与回放视图同模块导出），让场景卡片查询剧本时不会把
 * MessageList 整棵组件树拉进 bundle。
 *
 * 未登记的场景维持原有分章演示对话框，不受影响。首批只登记 1 个——
 * 目的是把底层建起来，不是铺覆盖率。
 */
const SCRIPTS: ReplayScript[] = [
  knowledgeQaScript,
  meetingActionScript,
];

const BY_SCENARIO_ID = new Map(SCRIPTS.map((script) => [script.scenarioId, script]));

export function getReplayScript(
  scenarioId: string,
  scenario?: CatalogScenarioPublic,
): ReplayScript | null {
  return BY_SCENARIO_ID.get(scenarioId)
    ?? (scenario ? presentationToReplayScript(scenario) : null);
}

/**
 * 能力中心卡片必须都有可看的演示。没有专门剧本时，用公开业务定义生成一条
 * 六步合成回放；它沿用正式回放组件，并始终标注为演示，不暗示已连接客户系统。
 */
export function getWorkflowCardReplayScript(scenario: CatalogScenarioPublic): ReplayScript {
  const existing = getReplayScript(scenario.id, scenario);
  if (existing) return existing;

  const reads = scenario.detail.reads.slice(0, 6);
  const acts = scenario.detail.acts.slice(0, 6);
  const fallbackScenario: CatalogScenarioPublic = {
    ...scenario,
    presentation: {
      version: 1,
      dataLabel: "合成场景演示",
      limitation: "本演示只使用公开定义中的示例业务数据，不会连接或写入你的真实业务系统。",
      chapters: [
        {
          id: "quick-event",
          title: "接收业务事件",
          narration: "先确认这次要处理的业务对象和触发原因。",
          result: "业务事件已登记，开始读取处理所需信息。",
          interaction: { kind: "next", label: "读取业务信息" },
          surface: {
            kind: "browser_panel",
            title: "示例业务事件",
            items: [{ label: "触发内容", value: scenario.launch.entry.content, state: "active", changed: true }],
          },
        },
        {
          id: "quick-read",
          title: "读取业务事实",
          narration: "只依据已列明的信息来源整理事实，不补造缺失数据。",
          result: "处理所需的业务事实已汇总。",
          interaction: { kind: "next", label: "开始判断" },
          surface: {
            kind: "browser_panel",
            title: "需要读取的信息",
            items: reads.map((value, index) => ({
              label: `信息 ${index + 1}`,
              value,
              state: "success" as const,
            })),
          },
        },
        {
          id: "quick-decide",
          title: "判断风险与缺口",
          narration: scenario.detail.decides,
          result: "判断依据和仍需确认的边界已经列明。",
          interaction: { kind: "next", label: "查看确认项" },
          surface: {
            kind: "summary",
            title: "判断结果",
            items: [{ label: "判断与边界", value: scenario.detail.decides, state: "active", changed: true }],
          },
        },
        {
          id: "quick-approve",
          title: "确认关键动作",
          narration: "涉及关键业务动作时，先把依据和影响范围交给有权人确认。",
          result: "关键动作已经获得示例确认，可以继续执行。",
          interaction: { kind: "confirm", label: "确认并继续" },
          surface: {
            kind: "approval_card",
            title: "人工确认",
            items: [{ label: "确认边界", value: scenario.detail.approval, state: "pending", changed: true }],
          },
        },
        {
          id: "quick-act",
          title: "执行获批动作",
          narration: "只执行已经确认的动作，并逐项保留处理结果。",
          result: "获批动作已经执行并留下示例记录。",
          interaction: { kind: "next", label: "核验处理结果" },
          surface: {
            kind: "task_list",
            title: "执行记录",
            items: acts.map((value, index) => ({
              label: `动作 ${index + 1}`,
              value,
              state: "success" as const,
              changed: true,
            })),
          },
        },
        {
          id: "quick-verify",
          title: "回读业务终态",
          narration: "执行后重新读取业务状态，用可核对的结果证明工作已完成。",
          result: scenario.detail.beforeAfter,
          interaction: { kind: "next", label: "演示完成" },
          surface: {
            kind: "summary",
            title: "完成核验",
            items: [
              { label: "业务终态", value: scenario.detail.beforeAfter, state: "success", changed: true },
              { label: "完成证明", value: scenario.detail.valueProof, state: "success" },
            ],
          },
        },
      ],
    },
  };
  const fallback = presentationToReplayScript(fallbackScenario);
  if (!fallback) throw new Error(`无法生成工作流演示：${scenario.id}`);
  return { ...fallback, mode: "quick" };
}

export function allReplayScripts(): ReplayScript[] {
  return SCRIPTS;
}
