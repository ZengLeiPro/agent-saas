import { derivePanelPulse, foldPanel } from "@agent/shared";
import type {
  ApiTranscriptBlock,
  DetailLine,
  TodoOutcome,
  TodoStatus,
  ToolPresentation,
} from "@agent/shared";
import type { ReplayScript, ReplayStep } from "./types";

type ReplayDecision = "approved" | "rejected";
type DecisionMap = Record<number, ReplayDecision>;

type SemanticDisplay = {
  type: "facts" | "list" | "comparison" | "checklist";
  title: string;
  items: Array<{
    label: string;
    value?: string;
    baseline?: string;
    current?: string;
    delta?: string;
    note?: string;
    status?: "pass" | "fail" | "warn" | "pending";
  }>;
  footer?: string;
};

type DemoTodo = {
  id: string;
  kind: "business";
  content: string;
  status: TodoStatus;
  activeForm?: string;
  outcome?: TodoOutcome;
  detail?: DetailLine[];
  display?: SemanticDisplay[];
  evidenceRefs?: string[];
};

type TerminalSummary = Pick<DemoTodo, "status" | "outcome" | "detail" | "display" | "evidenceRefs">;

const MAX_CONCISE_NARRATIVE_LENGTH = 80;
const FILE_CARD_PATTERN = /\[FILE\][\s\S]*?\[\/FILE\]/g;

/**
 * 结构化结果已经展示表格、状态色与异常提示时，不再重复同义长文。
 * 文件卡必须保留真实 [FILE] 通道；短回复保留必要的人味与过渡。
 */
function compactNarrativeBlocks(
  blocks: ApiTranscriptBlock[],
  hasStructuredResult: boolean,
): ApiTranscriptBlock[] {
  if (!hasStructuredResult) return blocks;

  return blocks.flatMap((block) => {
    if (block.kind !== "text") return [];
    const fileCards = block.content.match(FILE_CARD_PATTERN);
    if (fileCards?.length) {
      return [{ ...block, content: fileCards.join("\n") }];
    }
    const content = block.content.trim();
    return Array.from(content).length <= MAX_CONCISE_NARRATIVE_LENGTH
      ? [{ ...block, content }]
      : [];
  });
}

function todoBlock(id: string, todos: DemoTodo[], runId: string): ApiTranscriptBlock {
  return {
    id,
    kind: "tool_use",
    runId,
    title: "TodoWrite",
    defaultOpen: false,
    toolName: "TodoWrite",
    toolId: id,
    content: JSON.stringify({ todos }),
    executionStatus: "completed",
  };
}

function presentations(blocks: ApiTranscriptBlock[]): ToolPresentation[] {
  return blocks.flatMap((block) => block.presentation ? [block.presentation] : []);
}

function detailFacts(detail: DetailLine[] | undefined): Array<{ label: string; value: string }> {
  if (!detail) return [];
  return detail.flatMap((line): Array<{ label: string; value: string }> => {
    if (typeof line === "string") return [{ label: "说明", value: line }];
    if ("fields" in line) return line.fields.map((field) => ({ label: field.k, value: field.v }));
    if ("k" in line) return [{ label: line.k, value: line.v }];
    if ("verdict" in line) return [{ label: line.text, value: line.note ?? line.verdict }];
    if ("warn" in line) return [{ label: "需注意", value: line.warn }];
    if ("risk" in line) return [{ label: line.risk === "high" ? "高风险" : "中风险", value: line.text }];
    if ("insight" in line) return [{ label: line.label ?? "结论", value: line.insight }];
    if ("quote" in line) return [{ label: line.source ?? "原文", value: line.quote }];
    if ("original" in line) return [{ label: "原文", value: line.translation ?? line.original }];
    if ("text" in line) return [{ label: "动作", value: line.text }];
    return [];
  });
}

function uniqueFacts(items: Array<{ label: string; value: string }>) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.label}\u0000${item.value}`;
    if (!item.label.trim() || !item.value.trim() || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function presentationStatus(presentation: ToolPresentation): "pass" | "fail" | "warn" | "pending" {
  if (presentation.status === "blocked") return "fail";
  if (presentation.status === "warn") return "warn";
  if (presentation.status === "waiting") return "pending";
  return "pass";
}

function buildDisplay(
  step: ReplayStep,
  index: number,
  blocks: ApiTranscriptBlock[],
  terminalStatus: TodoStatus,
): SemanticDisplay[] {
  const summaries = presentations(blocks);
  const toolBlocks = blocks.filter((block) => block.kind === "tool_use" && block.toolName !== "TodoWrite");
  const facts = uniqueFacts(summaries.flatMap((summary) => detailFacts(summary.detail)));
  const fallbackFacts = [
    { label: "业务步骤", value: step.caption },
    { label: "系统动作", value: `${toolBlocks.length} 项` },
    { label: "执行状态", value: terminalStatus === "completed" ? "已完成" : terminalStatus === "waiting" ? "等待中" : terminalStatus === "blocked" ? "已阻断" : "执行失败" },
  ];
  const usableFacts = uniqueFacts([...facts, ...fallbackFacts]).slice(0, 6);
  const style = index % 4;

  if (style === 0) {
    return [{ type: "facts", title: "本步关键结果", items: usableFacts }];
  }
  if (style === 1) {
    const items = (summaries.length ? summaries : [{ title: step.caption } as ToolPresentation])
      .slice(0, 6)
      .map((summary, summaryIndex) => ({
        label: summary.title,
        value: summary.status === "blocked" ? "已阻断" : summary.status === "waiting" ? "等待中" : "已处理",
        note: detailFacts(summary.detail)[0]?.value ?? `执行记录 ${summaryIndex + 1}`,
      }));
    return [{ type: "list", title: "本步执行记录", items }];
  }
  if (style === 2) {
    return [{
      type: "comparison",
      title: "本步业务对照",
      items: usableFacts.slice(0, 6).map((item) => ({
        label: item.label,
        baseline: "会话开始时待处理",
        current: item.value,
        delta: "本步已形成结果",
        status: terminalStatus === "completed" ? "pass" : terminalStatus === "failed" || terminalStatus === "blocked" ? "fail" : "pending",
        note: "来自本步执行结果",
      })),
    }];
  }

  const checklistItems = (summaries.length ? summaries : [{ title: step.caption } as ToolPresentation])
    .slice(0, 6)
    .map((summary) => ({
      label: summary.title,
      status: presentationStatus(summary),
      value: detailFacts(summary.detail)[0]?.value ?? "已形成业务结果",
    }));
  return [{ type: "checklist", title: "本步核对结果", items: checklistItems }];
}

function terminalSummary(step: ReplayStep, index: number, decision?: ReplayDecision): TerminalSummary {
  const decisionBlocks = decision === "approved"
    ? step.approval?.approvedBlocks ?? []
    : decision === "rejected"
      ? step.approval?.rejectedBlocks ?? []
      : [];
  const blocks = [...step.blocks, ...decisionBlocks];
  const summaries = presentations(blocks);
  const failed = blocks.some((block) => block.kind === "tool_use" && block.executionStatus === "failed");
  const blocked = summaries.some((summary) => summary.status === "blocked");
  const waiting = summaries.some((summary) => summary.status === "waiting");
  const warned = summaries.some((summary) => summary.status === "warn");
  const receipts = summaries.flatMap((summary) => summary.receipt ? [`simulation:${summary.receipt.id}`] : []);
  const toolCount = blocks.filter((block) => block.kind === "tool_use").length;
  const issueCount = summaries.filter((summary) => summary.status === "blocked" || summary.status === "warn").length;

  let status: TodoStatus = "completed";
  let text = `${step.caption}已完成并形成可回读结果`;
  let tone: TodoOutcome["tone"] = "ok";
  let detail: DetailLine[] | undefined;

  if (decision === "rejected") {
    status = "blocked";
    text = `${step.caption}已退回，业务系统未继续写入`;
    tone = "warn";
    detail = [{ verdict: "fail", text: "审批未通过", note: "重新提交后仍需再次明确确认" }];
  } else if (step.approval && decision !== "approved") {
    status = "waiting";
    text = `${step.caption}材料已就绪，正在等待有权人确认`;
    tone = "warn";
    detail = [{ verdict: "pending", text: "等待人工确认", note: "确认前不执行后续写入" }];
  } else if (failed) {
    status = "failed";
    text = `${step.caption}执行失败，未形成可信终态`;
    tone = "fail";
    detail = [{ verdict: "fail", text: "执行失败", note: "需先处理失败原因再继续" }];
  } else if (blocked) {
    status = "blocked";
    text = `${step.caption}被业务规则阻断，未越过限制`;
    tone = "fail";
    detail = [{ verdict: "fail", text: "业务规则阻断", note: "未把技术成功误报为业务完成" }];
  } else if (waiting) {
    status = "waiting";
    text = `${step.caption}已推进，正在等待外部反馈`;
    tone = "warn";
    detail = [{ verdict: "pending", text: "等待外部反馈", note: "反馈到达后从原步骤继续" }];
  } else if (warned) {
    text = `${step.caption}已完成，但仍有需关注项`;
    tone = "warn";
    detail = [{ warn: "本步已形成结果，但保留了需要业务人员关注的例外。" }];
  }

  const stats = [
    ...(toolCount ? [{ label: "动作", value: `${toolCount} 项` }] : []),
    ...(receipts.length ? [{ label: "回执", value: `${receipts.length} 个` }] : []),
    ...(issueCount ? [{ label: "例外", value: `${issueCount} 项` }] : []),
  ];

  return {
    status,
    outcome: { text, tone, ...(stats.length ? { stat: stats } : {}) },
    ...(detail ? { detail } : {}),
    display: buildDisplay(step, index, blocks, status),
    ...(receipts.length ? { evidenceRefs: [...new Set(receipts)] } : {}),
  };
}

function snapshotTodos(script: ReplayScript, currentIndex: number, phase: "start" | "terminal", decisions: DecisionMap): DemoTodo[] {
  return script.steps.map((step, index) => {
    const base: DemoTodo = {
      id: `demo-step-${index + 1}`,
      kind: "business",
      content: step.caption,
      status: "pending",
      activeForm: `正在处理：${step.caption}`,
    };
    if (index < currentIndex) return { ...base, ...terminalSummary(step, index, decisions[index]) };
    if (index > currentIndex) return base;
    if (phase === "start") return { ...base, status: "in_progress" };
    return { ...base, ...terminalSummary(step, index, decisions[index]) };
  });
}

function withDerivedPanelDeltas(blocks: ApiTranscriptBlock[]): ApiTranscriptBlock[] {
  let snapshot: ReturnType<typeof foldPanel> | null = null;
  return blocks.map((block) => {
    const presentation = block.presentation;
    if (!presentation) return block;
    if (!snapshot && presentation.panelBase) snapshot = presentation.panelBase;
    if (presentation.panel === undefined) return block;
    if (snapshot) snapshot = foldPanel(snapshot, presentation.panel);

    const pulse = derivePanelPulse(presentation.panel, snapshot?.activeView);
    if (!pulse) return block;
    const hasExplicitPulse = presentation.panel.some((patch) => patch.op === "pulse");
    const needsFocus = !!snapshot && snapshot.activeView !== pulse.view;
    if (!needsFocus && hasExplicitPulse) return block;

    const panel = [...presentation.panel];
    if (needsFocus) {
      panel.push({ op: "focus", view: pulse.view });
      snapshot = { ...snapshot!, activeView: pulse.view };
    }
    if (!hasExplicitPulse) panel.push(pulse);
    return { ...block, presentation: { ...presentation, panel } };
  });
}

/**
 * 给旧版回放剧本补上真实 TodoWrite 快照。
 *
 * 快照仍走 mapSessionDetailToMessages → projectBusinessStepEvents → BusinessStepFlow，
 * 所以这里不会生成任何演示专用 UI。四种 display 语义按步骤轮换，确保能力中心的
 * 各类 demo 能稳定展示 facts / list / comparison / checklist，而不是只露出一种卡片。
 */
export function buildLegacyReplayBlocks(
  script: ReplayScript,
  visibleStepCount: number,
  decisions: DecisionMap,
): ApiTranscriptBlock[] {
  if (visibleStepCount === 0) return script.steps[0]?.blocks.slice(0, 1) ?? [];

  const visible: ApiTranscriptBlock[] = [];
  const runId = `scenario-replay:${script.scenarioId}`;
  for (const [index, step] of script.steps.slice(0, visibleStepCount).entries()) {
    const leadingPrompts: ApiTranscriptBlock[] = [];
    const processBlocks = [...step.blocks];
    while (processBlocks[0]?.kind === "prompt" || processBlocks[0]?.replayInstant) {
      leadingPrompts.push(processBlocks.shift()!);
    }
    visible.push(...leadingPrompts);
    visible.push(todoBlock(
      `demo-task-${index + 1}-start`,
      snapshotTodos(script, index, "start", decisions),
      runId,
    ));

    // 工具过程收进步骤节；必要的短回复与产物卡留在终态快照之后，和真实 Agent
    // 「先收口业务步骤，再给最终回复」的顺序一致，也避免折叠步骤吞掉产物卡。
    const narrativeBlocks = processBlocks.filter((block) => block.kind === "text");
    visible.push(...processBlocks.filter((block) => block.kind !== "text"));

    const decision = decisions[index];
    const decisionBlocks = decision === "approved"
      ? step.approval?.approvedBlocks ?? []
      : decision === "rejected"
        ? step.approval?.rejectedBlocks ?? []
        : [];
    visible.push(...decisionBlocks.filter((block) => block.kind !== "text"));
    visible.push(todoBlock(
      `demo-task-${index + 1}-terminal-${decision ?? "default"}`,
      snapshotTodos(script, index, "terminal", decisions),
      runId,
    ));
    const decisionNarrativeBlocks = decisionBlocks.filter((block) => block.kind === "text");
    const hasStructuredResult = [...processBlocks, ...decisionBlocks].some((block) => block.presentation);
    visible.push(...compactNarrativeBlocks(
      [...narrativeBlocks, ...decisionNarrativeBlocks],
      hasStructuredResult,
    ));
  }
  return withDerivedPanelDeltas(visible);
}
