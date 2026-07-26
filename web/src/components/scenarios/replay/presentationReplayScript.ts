import type {
  ApiTranscriptBlock,
  CatalogScenarioPublic,
  PanelPatch,
  PanelTone,
  SystemPanelSnapshot,
} from "@agent/shared";
import type { ReplayScript, ReplayStep } from "./types";

/**
 * 把 Workflow V3 已有的分章演示投影到产品原生会话回放。
 *
 * 这里不另造一套 UI：每章仍生成真实 ApiTranscriptBlock，走
 * MessageList → ToolBlock；右侧状态来自同一条 presentation 的 panel patch。
 * 原分章弹窗只作为历史组件保留，不再承担推荐区演示。
 */

type Presentation = NonNullable<CatalogScenarioPublic["presentation"]>;
type Chapter = Presentation["chapters"][number];
type SurfaceState = Chapter["surface"]["items"][number]["state"];

const TOOL_BY_SURFACE: Record<Chapter["surface"]["kind"], string> = {
  crm_table: "CRM",
  erp_table: "ERP",
  im_thread: "DWS",
  mail_panel: "Mail",
  approval_card: "Approval",
  browser_panel: "Read",
  task_list: "Task",
  finance_ledger: "Finance",
  summary: "ReadBack",
};

const PRODUCER_BY_SURFACE: Record<Chapter["surface"]["kind"], string> = {
  crm_table: "CRM 连接器",
  erp_table: "ERP 连接器",
  im_thread: "钉钉 DWS",
  mail_panel: "企业邮箱连接器",
  approval_card: "业务审批执行器",
  browser_panel: "企业资料读取工具",
  task_list: "任务与待办连接器",
  finance_ledger: "财务系统连接器",
  summary: "业务终态回读器",
};

const TONE_BY_STATE: Record<SurfaceState, PanelTone> = {
  neutral: "pending",
  pending: "pending",
  active: "info",
  success: "pass",
  warning: "warn",
};

function makePanelBase(): SystemPanelSnapshot {
  return {
    title: "企业系统实况",
    live: true,
    activeView: "state",
    foot: "演示状态与会话动作来自同一份回放数据",
    views: [
      {
        key: "state",
        label: "当前系统",
        winTitle: "企业系统 · 当前业务对象",
        toolbar: { title: "等待第一步", sub: "尚未触达" },
        widget: {
          kind: "rows",
          rows: [],
        },
      },
      {
        key: "audit",
        label: "操作留痕",
        winTitle: "操作留痕 · 本次演示",
        toolbar: { title: "本次工作流动作", sub: "0 条" },
        widget: {
          kind: "feed",
          items: [],
          empty: { title: "尚无系统动作" },
        },
      },
    ],
  };
}

function chapterPanelPatches(chapter: Chapter, index: number, total: number): PanelPatch[] {
  const patches: PanelPatch[] = [
    { op: "focus", view: "state" },
    {
      op: "toolbar",
      view: "state",
      title: chapter.surface.title,
      sub: `第 ${index + 1} / ${total} 步`,
    },
    {
      op: "rowsSet",
      view: "state",
      rows: chapter.surface.items.map((item, slot) => ({
        id: `slot-${slot + 1}`,
        text: item.label,
        sub: item.value,
        state: item.changed ? "hit" : "normal",
        tone: TONE_BY_STATE[item.state],
        badge: {
          text: item.changed ? "刚刚变化" : item.state === "pending" ? "待处理" : "当前状态",
          tone: item.changed ? "info" : TONE_BY_STATE[item.state],
        },
      })),
    },
  ];

  patches.push(
    {
      op: "feedAppend",
      view: "audit",
      item: {
        id: `chapter-${index + 1}`,
        from: "ai",
        time: `步骤 ${index + 1}`,
        text: `${chapter.title}：${chapter.result}`,
      },
    },
    {
      op: "toolbar",
      view: "audit",
      title: "本次工作流动作",
      sub: `${index + 1} 条`,
    },
  );
  return patches;
}

function approvedPanelPatches(chapter: Chapter, index: number): PanelPatch[] {
  return [
    { op: "focus", view: "state" },
    {
      op: "rowsSet",
      view: "state",
      rows: chapter.surface.items.map((item, slot) => ({
        id: `slot-${slot + 1}`,
        text: item.label,
        sub: item.value.startsWith("待") ? "已由有权人确认" : item.value,
        state: "hit" as const,
        tone: "pass" as const,
        badge: { text: "已确认", tone: "pass" as const },
      })),
    },
    {
      op: "feedAppend",
      view: "audit",
      item: {
        id: `approval-${index + 1}`,
        from: "负责人",
        time: `步骤 ${index + 1}`,
        text: `${chapter.interaction.label}：已确认，原审批依据与结果完整留痕。`,
      },
    },
  ];
}

function stepTextBlock(chapter: Chapter, index: number, isLast: boolean): ApiTranscriptBlock {
  const content = isLast
    ? [
        "### 本次会话改变了什么",
        "",
        ...chapter.surface.items.map((item) => `- ${item.label}：${item.value}`),
        "",
        `**业务结果：**${chapter.result}`,
      ].join("\n")
    : chapter.interaction.kind === "confirm"
      ? "审批材料已经准备完成。下一步必须由有权人明确确认，不会自动越过。"
      : `这一步完成后：${chapter.result}`;

  return {
    id: `presentation-step-${index + 1}-text`,
    kind: "text",
    title: "业务进展",
    defaultOpen: true,
    content,
  };
}

function approvedBlocks(chapter: Chapter, index: number): ApiTranscriptBlock[] {
  return [
    {
      id: `presentation-step-${index + 1}-approval`,
      kind: "tool_use",
      title: "Approval",
      defaultOpen: false,
      toolName: "Approval",
      toolId: `approval-${index + 1}`,
      content: JSON.stringify({ chapterId: chapter.id, decision: "approved" }),
      executionStatus: "completed",
      presentation: {
        title: `${chapter.interaction.label} · 已确认`,
        detail: [
          { k: "审批结果", v: "已批准" },
          { k: "生效范围", v: chapter.result },
          { tree: "└", k: "留痕", v: "审批人、依据与业务版本均已记录" },
        ],
        status: "ok",
        panel: approvedPanelPatches(chapter, index),
      },
    },
    {
      id: `presentation-step-${index + 1}-approval-text`,
      kind: "text",
      title: "审批结果",
      defaultOpen: true,
      content: `人工确认已记录。${chapter.result}`,
    },
  ];
}

function buildStep(
  scenario: CatalogScenarioPublic,
  chapter: Chapter,
  index: number,
  total: number,
  panelBase: SystemPanelSnapshot,
): ReplayStep {
  const toolName = TOOL_BY_SURFACE[chapter.surface.kind];
  const blocks: ApiTranscriptBlock[] = [];

  if (index === 0) {
    blocks.push({
      id: "presentation-user-prompt",
      kind: "prompt",
      title: "用户消息",
      defaultOpen: true,
      content: scenario.launch.starterMessage,
    });
  }

  blocks.push({
    id: `presentation-step-${index + 1}-tool`,
    kind: "tool_use",
    title: toolName,
    defaultOpen: false,
    toolName,
    toolId: `presentation-${index + 1}`,
    content: JSON.stringify({ scenarioId: scenario.id, chapterId: chapter.id }),
    executionStatus: chapter.interaction.kind === "confirm" ? "pending" : "completed",
    presentation: {
      title: chapter.title,
      detail: [
        chapter.narration,
        {
          k: chapter.interaction.kind === "confirm" ? "确认后" : "完成后",
          v: chapter.result,
        },
      ],
      status: chapter.interaction.kind === "confirm" ? "waiting" : "ok",
      ...(index === 0 ? { panelBase } : {}),
      panel: chapterPanelPatches(chapter, index, total),
    },
  });
  blocks.push(stepTextBlock(chapter, index, index === total - 1));

  return {
    caption: chapter.title,
    blocks,
    ...(chapter.interaction.kind === "confirm"
      ? {
          approval: {
            title: chapter.title,
            description: "这一步会改变业务系统，必须由有权人明确确认后才能继续。",
            facts: chapter.surface.items.map((item) => ({ label: item.label, value: item.value })),
            approveLabel: chapter.interaction.label,
            rejectLabel: "退回修改",
            approvedBlocks: approvedBlocks(chapter, index),
          },
        }
      : {}),
  };
}

export function presentationToReplayScript(scenario: CatalogScenarioPublic): ReplayScript | null {
  const presentation = scenario.presentation;
  if (!presentation) return null;

  const panelBase = makePanelBase();
  const steps = presentation.chapters.map((chapter, index) => (
    buildStep(scenario, chapter, index, presentation.chapters.length, panelBase)
  ));

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    mode: "hero",
    steps,
    sources: presentation.chapters.map((chapter, index) => ({
      blockRef: `step${index + 1}.tool.${TOOL_BY_SURFACE[chapter.surface.kind]}`,
      producer: PRODUCER_BY_SURFACE[chapter.surface.kind],
      state: "needs-change",
      gap: `当前为 Workflow V3 合成演示投影；真实会话需由${PRODUCER_BY_SURFACE[chapter.surface.kind]}产出同结构摘要、业务回执与面板变化。`,
    })),
  };
}
