import type { PanelPatch, PanelTone, PanelView, SystemPanelSnapshot } from "../../lib/systemPanel";
import type { DetailLine } from "../../lib/toolPresentation";
import type { ApiTranscriptBlock, CatalogScenarioPublic } from "../../types";
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
 * 章节收尾正文。**只在有增量信息时产出**（demo 口径：同一句话不说两遍）：
 * - 普通章：结论已由行动块的洞察行承载，不再补一段等价散文 → null；
 * - 确认章：审批门禁的性质说明是独有信息，保留；
 * - 末章：终态卡「本次会话改变了什么」是设计好的收尾制品，保留
 *   （行动块侧对应去掉洞察行，见 buildStep）。
 *
 * 不用 `**xx：**` 这种写法——中文全角冒号紧跟右定界符时 CommonMark 不闭合，
 * 客户会直接看到字面的星号（07-26 实机发现）。
 */
function stepTextBlock(chapter: Chapter, index: number, isLast: boolean): ApiTranscriptBlock | null {
  if (isLast) {
    return {
      id: `presentation-step-${index + 1}-text`,
      kind: "text",
      title: "业务进展",
      defaultOpen: true,
      content: [
        "### 本次会话改变了什么",
        "",
        ...chapter.surface.items.map((item) => `- ${item.label}：${item.value}`),
        "",
        `**业务结果**：${chapter.result}`,
      ].join("\n"),
    };
  }
  if (chapter.interaction.kind === "confirm") {
    return {
      id: `presentation-step-${index + 1}-text`,
      kind: "text",
      title: "业务进展",
      defaultOpen: true,
      content: "审批材料已经准备完成。下一步必须由有权人明确确认，不会自动越过。",
    };
  }
  return null;
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
      // 人工批准是流程里最关键的动作痕迹：独立成行并默认展开
      defaultOpen: true,
      toolName: "Approval",
      toolId: `approval-${index + 1}`,
      content: JSON.stringify({ chapterId: chapter.id, decision: "approved" }),
      executionStatus: "completed",
      presentation: {
        title: `${chapter.interaction.label} · 已确认`,
        // 批准块自身已完整承载审批结果与生效范围，
        // 后面不再补一段等价散文（demo 口径：同一句话不说两遍）
        detail: [
          { k: "审批结果", v: "已批准" },
          { k: "生效范围", v: chapter.result },
          { tree: "└", k: "留痕", v: "审批人、依据与业务版本均已记录" },
        ],
        status: "ok",
        receipt: { id: `APR-2026-${String(index + 1).padStart(2, "0")}`, system: "审批中心", readBack: true },
        panel: approvedPanelPatches(chapter, index),
      },
    },
  ];
}

/** 写类系统的回执单号前缀。读类与审批章不产回执，审批回执由批准块携带。 */
const RECEIPT_PREFIX_BY_SURFACE: Partial<Record<SurfaceKind, string>> = {
  crm_table: "CRM",
  erp_table: "ERP",
  mail_panel: "MAIL",
  im_thread: "IM",
  task_list: "TASK",
  finance_ledger: "FIN",
};

/**
 * 单个业务字段 → 摘要行。按 demo 的混排口径：
 * 缺口用警告行（AI 主动交出「我没确认」）、写入项用键值、
 * 已核对项用判定行、待确认项用待定判定——不再把 9 种状态压平成同一种树形键值。
 */
function itemLine(item: SurfaceItem): DetailLine {
  if (item.state === "warning") return { warn: `${item.label} · ${item.value}` };
  if (item.changed) return { k: item.label, v: item.value };
  if (item.state === "success") return { verdict: "pass", text: item.label, note: item.value };
  if (item.state === "pending") return { verdict: "pending", text: item.label, note: item.value };
  return { k: item.label, v: item.value };
}

/** 本章「真正动了/需要人看」的字段：写入项、缺口、待确认。 */
function isActionItem(item: SurfaceItem): boolean {
  return item.changed === true || item.state === "warning" || item.state === "pending";
}

/**
 * 行动块的字段区。写入项 ≥2 个时升格为字段网格（demo B11 的大字段卡形态，
 * 客户应当记住的硬字段配得上大字），单个写入项维持键值行；
 * 缺口/待确认项保持逐行（渲染层会把连续 warn 聚合成橙底色块）。
 */
function actionDetailLines(items: SurfaceItem[]): DetailLine[] {
  const changed = items.filter((item) => item.changed === true);
  const rest = items.filter((item) => item.changed !== true);
  const changedLines: DetailLine[] = changed.length >= 2
    ? [{ fields: changed.map((item) => ({ k: item.label, v: item.value })) }]
    : changed.map(itemLine);
  return [...changedLines, ...rest.map(itemLine)];
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
  const system = SYSTEM_BY_SURFACE[chapter.surface.kind];
  const isConfirm = chapter.interaction.kind === "confirm";
  const isLast = index === total - 1;
  const blocks: ApiTranscriptBlock[] = [];

  if (index === 0) {
    const entry = scenario.launch.entry;
    const entryTitle = entry.kind === "scheduled_trigger"
      ? "定时任务触发"
      : entry.kind === "business_event"
        ? "业务事件"
        : "用户消息";
    blocks.push({
      id: "presentation-entry",
      kind: entry.kind === "user_request" ? "prompt" : "text",
      title: entryTitle,
      defaultOpen: true,
      content: entry.content,
      replayInstant: entry.kind !== "user_request",
    });
  }

  // 一章拆成「感知 → 行动」两条执行行（demo 的工作过程口径），
  // 仅当两侧都有内容时才拆——不为拆而拆。
  const actionItems = chapter.surface.items.filter(isActionItem);
  const contextItems = chapter.surface.items.filter((item) => !isActionItem(item));
  const split = actionItems.length > 0 && contextItems.length > 0;

  if (split) {
    blocks.push({
      id: `presentation-step-${index + 1}-read`,
      kind: "tool_use",
      title: toolName,
      defaultOpen: false,
      toolName,
      toolId: `presentation-${index + 1}-read`,
      content: JSON.stringify({ scenarioId: scenario.id, chapterId: chapter.id, phase: "inspect" }),
      executionStatus: "completed",
      presentation: {
        title: `核对 ${system} 当前状态`,
        detail: [
          chapter.narration,
          ...contextItems.map(itemLine),
        ],
        status: "ok",
      },
    });
  }

  const receiptPrefix = RECEIPT_PREFIX_BY_SURFACE[chapter.surface.kind];

  blocks.push({
    id: `presentation-step-${index + 1}-tool`,
    kind: "tool_use",
    title: toolName,
    // 主行动块是「AI 在动系统」的关键痕迹：独立成行并默认展开
    defaultOpen: true,
    toolName,
    toolId: `presentation-${index + 1}`,
    content: JSON.stringify({ scenarioId: scenario.id, chapterId: chapter.id }),
    executionStatus: isConfirm ? "pending" : "completed",
    presentation: {
      // 标题保持章节的业务语言（demo 口径）；「动了哪个系统」由折叠行的回执徽标承载
      title: chapter.title,
      detail: [
        ...(split ? [] : [chapter.narration]),
        ...actionDetailLines(split ? actionItems : chapter.surface.items),
        // 行动块以本章硬结论收尾——demo 的洞察行口径；
        // 末章除外：同一句业务结果由紧随其后的终态卡承载，不说两遍
        ...(isConfirm || isLast ? [] : [{ insight: chapter.result, label: "结论" } satisfies DetailLine]),
      ],
      status: isConfirm ? "waiting" : "ok",
      // 写类系统给出可回读的合成回执；审批章的回执由批准块携带
      ...(receiptPrefix && !isConfirm
        ? { receipt: { id: `${receiptPrefix}-2026-${String(index + 1).padStart(2, "0")}`, system, readBack: true } }
        : {}),
      ...(index === 0 ? { panelBase } : {}),
      panel: surfacePatches(chapter, index, total, prevRowIds),
    },
  });
  const textBlock = stepTextBlock(chapter, index, isLast);
  if (textBlock) blocks.push(textBlock);

  return {
    caption: chapter.title,
    blocks,
    ...(isConfirm
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
    // 逐块登记：一章可能投影为「感知 + 行动」两条执行行，且审批分支块同样登记——
    // 来源表随块走而不是随章走，治理条款「每个 presentation 都有 producer」才闭合
    sources: steps.flatMap((step, index) => [
      ...step.blocks,
      ...(step.approval?.approvedBlocks ?? []),
      ...(step.approval?.rejectedBlocks ?? []),
    ]
      .filter((block) => block.kind === "tool_use" && block.presentation)
      .map((block) => ({
        blockRef: `step${index + 1}.${block.id}`,
        producer: block.toolName === "Approval"
          ? "业务审批执行器"
          : PRODUCER_BY_SURFACE[chapters[index].surface.kind],
        state: "needs-change" as const,
        gap: `当前为 Workflow V3 合成演示投影；真实会话需由${PRODUCER_BY_SURFACE[chapters[index].surface.kind]}产出同结构摘要、业务回执与面板变化。`,
      }))),
  };
}
