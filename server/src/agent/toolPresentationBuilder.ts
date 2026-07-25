/**
 * 工具执行摘要（给人看）的服务端产出规则。
 *
 * 背景：前端渲染器与契约已上线，但服务端一度对 presentation 零产出——
 * 与 `[CITE]` 引用溯源卡（shared/src/lib/markers.ts）同一个失败模式：
 * 解析器、组件、测试俱全，无人产出，四个月零使用。本模块是那条通道的产出端。
 *
 * ## 两条硬规则
 *
 * 1. **只写确定为真的信息。** 本模块运行在 `PlatformToolRuntime.invoke` 的
 *    收口点，此处拿到的 `content` 已被各 provider 截断（Shell/Read ≤64KB），
 *    在截断后的文本上数行数、数命中数会**静默错报**。因此规则一律只用
 *    **入参侧**数据；需要精确统计的字段必须由对应 provider 在截断前自产，
 *    并通过 `ToolResult.presentation` 直接带上来（本模块见到已有值即不覆盖）。
 *
 * 2. **宁可没有，不可编造。** 没有规则的工具优雅退化为无 presentation，
 *    渲染与本模块引入前逐像素一致。摘要里的数字会被渲染成对齐键值表，
 *    排版的精确感会放大读者对数字的信任——错报的代价高于不报。
 */

/**
 * 摘要行。**与 shared 的 `DetailLine` 结构等价**。
 *
 * server 不依赖 shared 包（两端是结构性契约而非共享类型：server 直通
 * `TranscriptBlock[]`，前端按 `ApiTranscriptBlock` 解读），故此处本地定义。
 * 权威校验器是前端的 `normalizeToolPresentation`——它对任何脏数据返回 null
 * 并回退原始 payload，所以两边结构漂移不会导致崩溃，只会导致摘要不显示。
 * 修改本类型时必须同步 `shared/src/lib/toolPresentation.ts`。
 */
export type PresentationDetailLine =
  | string
  | { k: string; v: string }
  | { tree: '├' | '└'; k: string; v: string }
  | { no: number; text: string }
  | { indent: number; text: string };

/** 与 shared 的 `ToolPresentation` 结构等价，见上方说明 */
export interface ToolPresentation {
  title: string;
  detail?: PresentationDetailLine[];
  status?: 'ok' | 'warn' | 'blocked' | 'waiting';
  receipt?: { id: string; system: string; readBack?: boolean };
}

/** 规则覆盖状态。用于覆盖率断言，见 toolPresentationCoverage.test.ts */
export type PresentationSourceState =
  /** 已有规则，且规则只用确定为真的数据 */
  | 'covered'
  /** 有规则但只覆盖入参侧；结果侧统计待对应 provider 在截断前自产 */
  | 'partial'
  /** 尚无规则，退化为无摘要 */
  | 'none';

export interface PresentationSourceEntry {
  tool: string;
  state: PresentationSourceState;
  /** state !== 'covered' 时必填：还缺什么 */
  gap?: string;
}

function parseInput(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function basename(filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  return parts[parts.length - 1] || filePath;
}

/** 命令行超长时保留头部，避免摘要行被一条长命令撑爆 */
function briefCommand(command: string): string {
  const singleLine = command.replace(/\s+/g, ' ').trim();
  return singleLine.length > 120 ? `${singleLine.slice(0, 120)}…` : singleLine;
}

type Rule = (input: Record<string, unknown>) => ToolPresentation | null;

const RULES: Record<string, Rule> = {
  Read: (input) => {
    const filePath = str(input.file_path);
    if (!filePath) return null;
    const detail: ToolPresentation['detail'] = [{ k: '路径', v: filePath }];
    const offset = input.offset;
    const limit = input.limit;
    if (typeof offset === 'number' || typeof limit === 'number') {
      const from = typeof offset === 'number' ? offset : 0;
      const span = typeof limit === 'number' ? `${from}–${from + limit}` : `自第 ${from} 行`;
      detail.push({ tree: '└', k: '范围', v: `第 ${span} 行` });
    }
    return { title: `读取 ${basename(filePath)}`, detail };
  },

  Write: (input) => {
    const filePath = str(input.file_path);
    if (!filePath) return null;
    return { title: `写入 ${basename(filePath)}`, detail: [{ k: '路径', v: filePath }] };
  },

  Edit: (input) => {
    const filePath = str(input.file_path);
    if (!filePath) return null;
    const detail: ToolPresentation['detail'] = [{ k: '路径', v: filePath }];
    if (input.replace_all === true) detail.push({ tree: '└', k: '模式', v: '全部替换' });
    return { title: `修改 ${basename(filePath)}`, detail };
  },

  Shell: (input) => {
    const command = str(input.command);
    if (!command) return null;
    // description 是模型对本次执行的意图说明，比命令本身更接近业务语言
    const description = str(input.description);
    const detail: ToolPresentation['detail'] = [{ k: '命令', v: briefCommand(command) }];
    return { title: description ?? '执行命令', detail };
  },

  WebSearch: (input) => {
    const query = str(input.query);
    if (!query) return null;
    return { title: '联网检索', detail: [{ k: '检索词', v: query }] };
  },

  WebFetch: (input) => {
    const url = str(input.url);
    if (!url) return null;
    const detail: ToolPresentation['detail'] = [{ k: '来源', v: url }];
    const prompt = str(input.prompt);
    if (prompt) detail.push({ tree: '└', k: '提取目标', v: prompt });
    return { title: '读取网页', detail };
  },

  Agent: (input) => {
    const description = str(input.description);
    if (!description) return null;
    const detail: ToolPresentation['detail'] = [];
    const agentType = str(input.subagent_type);
    if (agentType) detail.push({ k: '子 Agent', v: agentType });
    const model = str(input.model);
    if (model) detail.push({ tree: '└', k: '模型', v: model });
    return detail.length ? { title: description, detail } : { title: description };
  },
};

/**
 * 产出方登记表（治理条款）。
 *
 * 每个在真实会话里高频出现的工具都必须在此登记；state 非 covered 时必须写明
 * gap。`toolPresentationCoverage.test.ts` 断言这张表与 RULES 一致，并对
 * 未覆盖数量设只减不增的上限——这是防止「数据后补」再次无限期拖下去的闸门。
 */
export const PRESENTATION_SOURCES: readonly PresentationSourceEntry[] = [
  { tool: 'Read', state: 'partial', gap: '缺读取行数/截断提示；需 Read provider 在 64KB 截断前自产' },
  { tool: 'Write', state: 'partial', gap: '缺写入字节数；需 Write provider 在返回前自产' },
  { tool: 'Edit', state: 'partial', gap: '缺替换处数；需 Edit provider 在返回前自产' },
  { tool: 'Shell', state: 'partial', gap: '缺退出码/输出行数/是否被截断；需 Shell provider 在截断前用原始 stdout 自产' },
  { tool: 'WebSearch', state: 'partial', gap: '缺命中条数与来源域名' },
  { tool: 'WebFetch', state: 'partial', gap: '缺响应状态与正文长度' },
  { tool: 'Agent', state: 'partial', gap: '缺子 Agent 的耗时/token/工具次数（事件里已有，未接进摘要）' },
  { tool: 'GenerateImage', state: 'none', gap: '尚无规则；应展示引擎、尺寸与积分扣费' },
  { tool: 'Skill', state: 'none', gap: '刻意不做：Skill 的 tool_result 是技能正文，摘要价值近乎零；观众关心的是技能内部的 Shell/Read，已被覆盖' },
] as const;

/**
 * 未覆盖（state !== 'covered'）工具数的上限，**只减不增**。
 *
 * 每让一个工具真正做到 covered，就把这个数字减一并在 PR 里说明。
 * 调高它需要 code review 显式批准——这正是 `[CITE]` 当年缺的那道闸门。
 */
export const PRESENTATION_TODO_BUDGET = 9;

/**
 * 在工具执行结果上补一份「给人看」摘要。
 *
 * @param toolName 工具名（`ToolDescriptor.name`，非 id）
 * @param toolInput 原始入参（JSON 字符串或对象）
 * @param existing provider 已自产的 presentation；有值时原样返回，不覆盖
 */
export function buildToolPresentation(
  toolName: string,
  toolInput: unknown,
  existing?: ToolPresentation,
): ToolPresentation | undefined {
  // provider 在截断前自产的摘要信息量严格更高，规则不得覆盖
  if (existing) return existing;
  const rule = RULES[toolName];
  if (!rule) return undefined;
  try {
    return rule(parseInput(toolInput)) ?? undefined;
  } catch {
    // 摘要是锦上添花，任何异常都不得影响工具执行结果本身
    return undefined;
  }
}

/** 供覆盖率测试使用 */
export function listPresentationRuleNames(): string[] {
  return Object.keys(RULES);
}
