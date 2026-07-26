import type {
  ApiTranscriptBlock,
  CatalogScenarioPublic,
  DetailLine,
  PanelPatch,
  PanelTone,
  PanelView,
  SystemPanelSnapshot,
} from "@agent/shared";
import type { ReplayScript, ReplayStep } from "./types";

/**
 * 把 Workflow V3 已有的分章演示投影到产品原生会话回放。
 *
 * 这里不另造一套 UI：每章仍生成真实 ApiTranscriptBlock，走
 * MessageList → ToolBlock；右侧状态来自同一条 presentation 的 panel patch。
 * 原分章弹窗只作为历史组件保留，不再承担推荐区演示。
 *
 * 07-26 修订（三家客户 demo 实机对比后）：
 * 1. 每章的 `surface.kind` 决定右侧用哪种控件与落在哪个系统视图，
 *    不再把 9 种界面形态压平成同一个 rows 列表；
 * 2. 每步 focus 到该步真正动了的那个系统，而不是永远停在同一个视图；
 * 3. 工具摘要展开后是本步涉及的业务字段，正文只留结果句，同一句话不再出现两次。
 */

type Presentation = NonNullable<CatalogScenarioPublic["presentation"]>;
type Chapter = Presentation["chapters"][number];
type SurfaceKind = Chapter["surface"]["kind"];
type SurfaceItem = Chapter["surface"]["items"][number];
type SurfaceState = SurfaceItem["state"];

/**
 * 面板视图键。
 *
 * 刻意收敛到 5 个业务视图 + 1 个留痕：`normalizeSystemPanel` 的视图上限是 6，
 * 而单个场景最多会用到 6 种 surface.kind。按「被仿真的系统」而不是按
 * 「界面形态」分组，客户读到的才是"我的 CRM / 我的邮箱"，不是一堆抽象标签。
 */
type ViewKey = "source" | "records" | "comms" | "approval" | "summary" | "audit";

const VIEW_ORDER: ViewKey[] = ["source", "records", "comms", "approval", "summary", "audit"];

const VIEW_BY_SURFACE: Record<SurfaceKind, ViewKey> = {
  browser_panel: "source",
  crm_table: "records",
  erp_table: "records",
  finance_ledger: "records",
  task_list: "records",
  mail_panel: "comms",
  im_thread: "comms",
  approval_card: "approval",
  summary: "summary",
};

/** 被仿真的系统名。进 toolbar、进 foot「已连接：…」，也进来源登记表。 */
const SYSTEM_BY_SURFACE: Record<SurfaceKind, string> = {
  crm_table: "CRM",
  erp_table: "ERP",
  finance_ledger: "财务系统",
  task_list: "任务中心",
  mail_panel: "企业邮箱",
  im_thread: "钉钉",
  approval_card: "审批中心",
  browser_panel: "资料来源",
  summary: "跨系统回读",
};

const TOOL_BY_SURFACE: Record<SurfaceKind, string> = {
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

const PRODUCER_BY_SURFACE: Record<SurfaceKind, string> = {
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

interface ViewDef {
  label: string;
  winTitle: string;
  build: () => PanelView["widget"];
}

const VIEW_DEFS: Record<ViewKey, ViewDef> = {
  source: {
    label: "来源资料",
    winTitle: "资料来源 · 本次读取",
    build: () => ({ kind: "rows", rows: [], empty: { title: "尚未读取任何资料" } }),
  },
  records: {
    label: "业务系统",
    winTitle: "业务系统 · 记录明细",
    build: () => ({
      kind: "table",
      cols: [
        { key: "field", label: "字段" },
        { key: "value", label: "当前值" },
        { key: "state", label: "状态", align: "right" },
      ],
      rows: [],
      empty: { title: "业务系统尚未被改动" },
    }),
  },
  comms: {
    label: "沟通",
    winTitle: "对外沟通 · 邮件与消息",
    // 用 cards 而不是 feed：一条对外消息就是一张卡（收件人 / 内容 / 送达状态），
    // feed 的「发送者 + 正文」结构会把同一个字段名说两遍
    build: () => ({ kind: "cards", cards: [], empty: { title: "尚未发生任何对外沟通" } }),
  },
  approval: {
    label: "审批",
    winTitle: "审批中心 · 待确认事项",
    build: () => ({ kind: "rows", rows: [], empty: { title: "当前没有待确认事项" } }),
  },
  summary: {
    label: "终态核对",
    winTitle: "跨系统终态核对",
    build: () => ({
      kind: "table",
      cols: [
        { key: "object", label: "业务对象" },
        { key: "value", label: "终态" },
        { key: "state", label: "核对", align: "right" },
      ],
      rows: [],
      empty: { title: "尚未回读终态" },
    }),
  },
  audit: {
    label: "操作留痕",
    winTitle: "操作留痕 · 本次演示",
    build: () => ({ kind: "feed", items: [], empty: { title: "尚无系统动作" } }),
  },
};

function badgeText(item: SurfaceItem): string {
  if (item.changed) return "刚刚变化";
  if (item.state === "pending") return "待处理";
  if (item.state === "warning") return "需注意";
  return "当前状态";
}

function usedViews(chapters: Chapter[]): ViewKey[] {
  const used = new Set<ViewKey>(chapters.map((chapter) => VIEW_BY_SURFACE[chapter.surface.kind]));
  used.add("audit");
  return VIEW_ORDER.filter((key) => used.has(key));
}

function connectedFoot(chapters: Chapter[]): string {
  const systems: string[] = [];
  for (const chapter of chapters) {
    const system = SYSTEM_BY_SURFACE[chapter.surface.kind];
    if (system !== "跨系统回读" && !systems.includes(system)) systems.push(system);
  }
  return `已连接：${systems.join(" · ")}（演示）`;
}

function makePanelBase(chapters: Chapter[]): SystemPanelSnapshot {
  const keys = usedViews(chapters);
  return {
    title: "企业系统实况",
    live: true,
    activeView: keys[0] ?? "audit",
    foot: connectedFoot(chapters),
    views: keys.map((key) => ({
      key,
      label: VIEW_DEFS[key].label,
      winTitle: VIEW_DEFS[key].winTitle,
      toolbar: { title: VIEW_DEFS[key].winTitle, sub: "等待第一步" },
      widget: VIEW_DEFS[key].build(),
    })),
  };
}

/** 表格行 id 要在整场演示里唯一——同一视图会被多章累积写入。 */
function rowId(chapter: Chapter, slot: number): string {
  return `${chapter.id}-${slot + 1}`;
}

function surfacePatches(chapter: Chapter, index: number, total: number, prevRowIds: string[]): PanelPatch[] {
  const view = VIEW_BY_SURFACE[chapter.surface.kind];
  const system = SYSTEM_BY_SURFACE[chapter.surface.kind];
  const items = chapter.surface.items;
  const patches: PanelPatch[] = [
    { op: "focus", view },
    {
      op: "toolbar",
      view,
      title: `${system} · ${chapter.surface.title}`,
      sub: `第 ${index + 1} / ${total} 步`,
    },
  ];

  switch (view) {
    case "records":
    case "summary": {
      // 上一批行降级为中性，只有本步动到的行保留高亮——「刚刚变化」才有意义
      for (const id of prevRowIds) {
        patches.push({ op: "cellFlag", view, rowId: id, colKey: "state", tone: "pending" });
      }
      items.forEach((item, slot) => {
        patches.push({
          op: "tableRowInsert",
          view,
          row: {
            id: rowId(chapter, slot),
            cells: {
              [view === "summary" ? "object" : "field"]: item.label,
              value: item.value,
              state: badgeText(item),
            },
            ...(item.changed ? { tone: "info" as PanelTone } : {}),
            flags: { state: { tone: TONE_BY_STATE[item.state], flag: badgeText(item) } },
          },
          at: 0,
        });
      });
      break;
    }
    case "comms": {
      items.forEach((item, slot) => {
        patches.push({
          op: "cardInsert",
          view,
          card: {
            id: rowId(chapter, slot),
            title: item.label,
            body: item.value,
            meta: [
              { text: `${system} · 步骤 ${index + 1}` },
              { text: badgeText(item), tone: TONE_BY_STATE[item.state] },
            ],
          },
          at: 0,
        });
      });
      break;
    }
    default: {
      patches.push({
        op: "rowsSet",
        view,
        rows: items.map((item, slot) => ({
          id: rowId(chapter, slot),
          text: item.label,
          sub: item.value,
          state: item.changed ? "hit" : "normal",
          tone: TONE_BY_STATE[item.state],
          badge: { text: badgeText(item), tone: item.changed ? "info" : TONE_BY_STATE[item.state] },
        })),
      });
      break;
    }
  }

  patches.push(
    {
      op: "feedAppend",
      view: "audit",
      item: {
        id: `chapter-${index + 1}`,
        from: "AI 同事",
        time: `步骤 ${index + 1}`,
        text: `${system} · ${chapter.title}：${chapter.result}`,
      },
    },
    { op: "toolbar", view: "audit", title: "本次工作流动作", sub: `${index + 1} 条` },
  );
  return patches;
}

function approvedPanelPatches(chapter: Chapter, index: number): PanelPatch[] {
  const view = VIEW_BY_SURFACE[chapter.surface.kind];
  const patches: PanelPatch[] = [{ op: "focus", view }];

  if (view === "records" || view === "summary") {
    chapter.surface.items.forEach((_item, slot) => {
      patches.push({
        op: "tableRowUpdate",
        view,
        id: rowId(chapter, slot),
        set: { cells: { state: "已确认" }, tone: "pass" },
      });
    });
  } else if (view === "approval" || view === "source") {
    patches.push({
      op: "rowsSet",
      view,
      rows: chapter.surface.items.map((item, slot) => ({
        id: rowId(chapter, slot),
        text: item.label,
        sub: item.value.startsWith("待") ? "已由有权人确认" : item.value,
        state: "hit" as const,
        tone: "pass" as const,
        badge: { text: "已确认", tone: "pass" as const },
      })),
    });
  }

  patches.push({
    op: "feedAppend",
    view: "audit",
    item: {
      id: `approval-${index + 1}`,
      from: "负责人",
      time: `步骤 ${index + 1}`,
      text: `${chapter.interaction.label}：已确认，原审批依据与结果完整留痕。`,
    },
  });
  return patches;
}

/**
 * 终态正文。
 *
 * 不用 `**xx：**` 这种写法——中文全角冒号紧跟右定界符时 CommonMark 不闭合，
 * 客户会直接看到字面的星号（07-26 实机发现）。
 */
function stepTextBlock(chapter: Chapter, index: number, isLast: boolean): ApiTranscriptBlock {
  const content = isLast
    ? [
        "### 本次会话改变了什么",
        "",
        ...chapter.surface.items.map((item) => `- ${item.label}：${item.value}`),
        "",
        `**业务结果**：${chapter.result}`,
      ].join("\n")
    : chapter.interaction.kind === "confirm"
      ? "审批材料已经准备完成。下一步必须由有权人明确确认，不会自动越过。"
      : chapter.result;

  return {
    id: `presentation-step-${index + 1}-text`,
    kind: "text",
    title: "业务进展",
    defaultOpen: true,
    content,
  };
}

/** 退回分支：不写系统、记账、等重新提交。三家客户演示稿这里都是死路。 */
function rejectedBlocks(chapter: Chapter, index: number): ApiTranscriptBlock[] {
  const view = VIEW_BY_SURFACE[chapter.surface.kind];
  return [
    {
      id: `presentation-step-${index + 1}-rejected`,
      kind: "tool_use",
      title: "Approval",
      defaultOpen: false,
      toolName: "Approval",
      toolId: `approval-reject-${index + 1}`,
      content: JSON.stringify({ chapterId: chapter.id, decision: "rejected" }),
      executionStatus: "completed",
      presentation: {
        title: `${chapter.interaction.label} · 已退回`,
        detail: [
          { k: "审批结果", v: "退回修改" },
          { k: "业务系统", v: "未写入任何变更" },
          { tree: "└", k: "留痕", v: "退回时间、退回人与当时材料版本均已记录" },
        ],
        status: "blocked",
        panel: [
          { op: "focus", view },
          {
            op: "feedAppend",
            view: "audit",
            item: {
              id: `approval-reject-${index + 1}`,
              from: "负责人",
              time: `步骤 ${index + 1}`,
              text: `${chapter.interaction.label}：已退回修改，未写入业务系统。`,
            },
          },
        ],
      },
    },
    {
      id: `presentation-step-${index + 1}-rejected-text`,
      kind: "text",
      title: "退回说明",
      defaultOpen: true,
      content: "已停在审核点：业务系统没有任何写入，退回记录已留痕。重新提交后仍需再次明确批准。",
    },
  ];
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

/** 工具摘要展开后给的是本步真正涉及的业务字段，不是把 result 再说一遍。 */
function surfaceDetail(chapter: Chapter): DetailLine[] {
  const items = chapter.surface.items.slice(0, 4);
  return [
    chapter.narration,
    ...items.map((item, slot) => (
      slot === items.length - 1
        ? { tree: "└" as const, k: item.label, v: item.value }
        : { tree: "├" as const, k: item.label, v: item.value }
    )),
  ];
}

function buildStep(
  scenario: CatalogScenarioPublic,
  chapter: Chapter,
  index: number,
  total: number,
  panelBase: SystemPanelSnapshot,
  prevRowIds: string[],
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
      detail: surfaceDetail(chapter),
      status: chapter.interaction.kind === "confirm" ? "waiting" : "ok",
      ...(index === 0 ? { panelBase } : {}),
      panel: surfacePatches(chapter, index, total, prevRowIds),
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
            rejectedBlocks: rejectedBlocks(chapter, index),
          },
        }
      : {}),
  };
}

export function presentationToReplayScript(scenario: CatalogScenarioPublic): ReplayScript | null {
  const presentation = scenario.presentation;
  if (!presentation) return null;

  const chapters = presentation.chapters;
  const panelBase = makePanelBase(chapters);
  // 表格类视图逐章累积，需要知道上一次写进同一视图的行 id 才能把旧高亮降级
  const lastRowIdsByView = new Map<ViewKey, string[]>();
  const steps = chapters.map((chapter, index) => {
    const view = VIEW_BY_SURFACE[chapter.surface.kind];
    const prevRowIds = lastRowIdsByView.get(view) ?? [];
    const step = buildStep(scenario, chapter, index, chapters.length, panelBase, prevRowIds);
    lastRowIdsByView.set(view, chapter.surface.items.map((_item, slot) => rowId(chapter, slot)));
    return step;
  });

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    mode: "hero",
    steps,
    sources: chapters.map((chapter, index) => ({
      blockRef: `step${index + 1}.tool.${TOOL_BY_SURFACE[chapter.surface.kind]}`,
      producer: PRODUCER_BY_SURFACE[chapter.surface.kind],
      state: "needs-change",
      gap: `当前为 Workflow V3 合成演示投影；真实会话需由${PRODUCER_BY_SURFACE[chapter.surface.kind]}产出同结构摘要、业务回执与面板变化。`,
    })),
  };
}
