/**
 * 场景回放剧本 —— 移动端注册表与构建器。
 *
 * 与 Web `web/src/components/scenarios/replay/` 的关系（本批的取舍）：
 * Web 侧 24 个手写剧本直接内联 `ApiTranscriptBlock`，体量数千行且驻留在 web 包内，
 * 本任务不允许改 `web/`，因此无法把它们下沉到 shared 复用。移动端改走
 * **纯数据驱动**的同一条底：目录接口 `GET /api/scenarios/v3` 已经在
 * `CatalogScenarioPublic.presentation` 上带了 6~9 章的合成演示数据
 * （schema: `shared/src/schemas/workflowScenario.ts`），Web 的
 * `presentationToReplayScript()` / `getWorkflowCardReplayScript()` 也是以它为准
 * 生成剧本。这里复刻同一套章节合成规则（含 Web 的 6 章兜底），
 * 好处是：不需要按需 lazy import 任何剧本文件，任一目录场景都有可看的演示，
 * 且演示内容与服务端目录同源、不会漂移。
 *
 * 纯函数：不引入 React / RN，可在 node 环境 vitest 直接跑。
 */
import type { CatalogScenarioPublic, DetailLine, MessageItem } from '@agent/shared';

type Presentation = NonNullable<CatalogScenarioPublic['presentation']>;
export type ScenarioReplayChapter = Presentation['chapters'][number];
export type ScenarioReplaySurfaceItem = ScenarioReplayChapter['surface']['items'][number];

export interface ScenarioReplayScript {
  scenarioId: string;
  title: string;
  /** 恒为「合成场景演示」，回放头部必须常驻展示，避免被当成真实执行 */
  dataLabel: string;
  limitation: string;
  /** hero=目录自带演示数据；quick=按公开业务定义合成的兜底演示 */
  mode: 'hero' | 'quick';
  chapters: ScenarioReplayChapter[];
}

const SYNTHETIC_LIMITATION =
  '本演示只使用公开定义中的示例业务数据，不会连接或写入你的真实业务系统。';
const MAX_SYNTHETIC_ITEMS = 6;

/** 目录里的每个场景都必须有可看的演示：要么自带 presentation，要么可合成。 */
export function hasScenarioReplay(scenario: CatalogScenarioPublic): boolean {
  return Boolean(scenario.presentation) || scenario.detail.reads.length > 0;
}

/** 按公开业务定义合成 6 章演示；章节结构与 Web `getWorkflowCardReplayScript` 一致。 */
function syntheticChapters(scenario: CatalogScenarioPublic): ScenarioReplayChapter[] {
  const reads = scenario.detail.reads.slice(0, MAX_SYNTHETIC_ITEMS);
  const acts = scenario.detail.acts.slice(0, MAX_SYNTHETIC_ITEMS);
  return [
    {
      id: 'quick-event',
      title: '接收业务事件',
      narration: '先确认这次要处理的业务对象和触发原因。',
      result: '业务事件已登记，开始读取处理所需信息。',
      interaction: { kind: 'next', label: '读取业务信息' },
      surface: {
        kind: 'browser_panel',
        title: '示例业务事件',
        items: [
          {
            label: '触发内容',
            value: scenario.launch.entry.content,
            state: 'active',
            changed: true,
          },
        ],
      },
    },
    {
      id: 'quick-read',
      title: '读取业务事实',
      narration: '只依据已列明的信息来源整理事实，不补造缺失数据。',
      result: '处理所需的业务事实已汇总。',
      interaction: { kind: 'next', label: '开始判断' },
      surface: {
        kind: 'browser_panel',
        title: '需要读取的信息',
        items: reads.map((value, index) => ({
          label: `信息 ${index + 1}`,
          value,
          state: 'success' as const,
        })),
      },
    },
    {
      id: 'quick-decide',
      title: '判断风险与缺口',
      narration: scenario.detail.decides,
      result: '判断依据和仍需确认的边界已经列明。',
      interaction: { kind: 'next', label: '查看确认项' },
      surface: {
        kind: 'summary',
        title: '判断结果',
        items: [
          { label: '判断与边界', value: scenario.detail.decides, state: 'active', changed: true },
        ],
      },
    },
    {
      id: 'quick-approve',
      title: '确认关键动作',
      narration: '涉及关键业务动作时，先把依据和影响范围交给有权人确认。',
      result: '关键动作已经获得示例确认，可以继续执行。',
      interaction: { kind: 'confirm', label: '确认并继续' },
      surface: {
        kind: 'approval_card',
        title: '人工确认',
        items: [
          { label: '确认边界', value: scenario.detail.approval, state: 'pending', changed: true },
        ],
      },
    },
    {
      id: 'quick-act',
      title: '执行获批动作',
      narration: '只执行已经确认的动作，并逐项保留处理结果。',
      result: '获批动作已经执行并留下示例记录。',
      interaction: { kind: 'next', label: '核验处理结果' },
      surface: {
        kind: 'task_list',
        title: '执行记录',
        items: acts.map((value, index) => ({
          label: `动作 ${index + 1}`,
          value,
          state: 'success' as const,
          changed: true,
        })),
      },
    },
    {
      id: 'quick-verify',
      title: '回读业务终态',
      narration: '执行后重新读取业务状态，用可核对的结果证明工作已完成。',
      result: scenario.detail.beforeAfter,
      interaction: { kind: 'next', label: '演示完成' },
      surface: {
        kind: 'summary',
        title: '完成核验',
        items: [
          {
            label: '业务终态',
            value: scenario.detail.beforeAfter,
            state: 'success',
            changed: true,
          },
          { label: '完成证明', value: scenario.detail.valueProof, state: 'success' },
        ],
      },
    },
  ];
}

export function buildScenarioReplayScript(scenario: CatalogScenarioPublic): ScenarioReplayScript {
  const presentation = scenario.presentation;
  if (presentation) {
    return {
      scenarioId: scenario.id,
      title: scenario.title,
      dataLabel: presentation.dataLabel,
      limitation: presentation.limitation,
      mode: 'hero',
      chapters: [...presentation.chapters],
    };
  }
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    dataLabel: '合成场景演示',
    limitation: SYNTHETIC_LIMITATION,
    mode: 'quick',
    chapters: syntheticChapters(scenario),
  };
}

/** 章节 surface 的一行 → `ToolPresentation.detail` 的一行（复用真实会话的摘要行变体）。 */
function detailLineFor(item: ScenarioReplaySurfaceItem): DetailLine {
  if (item.state === 'warning') return { warn: `${item.label}：${item.value}` };
  if (item.state === 'pending') {
    return { verdict: 'pending', text: `${item.label}：${item.value}` };
  }
  return { k: item.label, v: item.value };
}

/**
 * 把已推进到 `stepIndex`（含）的章节投影成真实会话的 `MessageItem[]`，
 * 交给 `chat/MessageList` 渲染——回放与真实会话共用同一条渲染路径，
 * 演示能表达的形态 = 真实会话能表达的形态。
 */
export function replayMessagesUpTo(
  script: ScenarioReplayScript,
  stepIndex: number,
  options?: { entryContent?: string },
): MessageItem[] {
  const messages: MessageItem[] = [];
  if (options?.entryContent) {
    messages.push({
      id: `${script.scenarioId}-entry`,
      type: 'user',
      content: options.entryContent,
    });
  }
  const visible = script.chapters.slice(0, Math.max(0, stepIndex + 1));
  for (const chapter of visible) {
    messages.push({
      id: `${script.scenarioId}-${chapter.id}-narration`,
      type: 'text',
      content: chapter.narration,
    });
    messages.push({
      id: `${script.scenarioId}-${chapter.id}-surface`,
      type: 'tool_use',
      toolName: chapter.surface.kind,
      toolInput: '',
      toolId: `${script.scenarioId}-${chapter.id}`,
      executionStatus: 'completed',
      resultReady: true,
      presentation: {
        title: chapter.surface.title,
        status: chapter.surface.items.some((item) => item.state === 'warning')
          ? 'warn'
          : chapter.surface.items.some((item) => item.state === 'pending')
            ? 'waiting'
            : 'ok',
        detail: chapter.surface.items.map(detailLineFor),
      },
    });
    messages.push({
      id: `${script.scenarioId}-${chapter.id}-result`,
      type: 'text',
      content: chapter.result,
      finalOutput: true,
    });
  }
  return messages;
}

/** 当前步是否需要人工确认才能继续（Web 回放器的 approval 阻断语义）。 */
export function replayStepRequiresApproval(
  script: ScenarioReplayScript,
  stepIndex: number,
): boolean {
  return script.chapters[stepIndex]?.interaction.kind === 'confirm';
}
