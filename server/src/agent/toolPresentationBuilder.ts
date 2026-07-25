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

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

type Rule = (input: Record<string, unknown>) => ToolPresentation | null;

/**
 * 基于执行元数据的规则。
 *
 * 与入参侧规则的关键区别：metadata 来自**截断之前**的真实执行结果
 * （Shell 的 exitCode/字节数/耗时、Write 的写入字节数），所以可以给出
 * 精确统计而不会错报。有 metadata 规则时优先用它。
 */
type MetadataRule = (
  input: Record<string, unknown>,
  metadata: Record<string, unknown>,
) => ToolPresentation | null;

const METADATA_RULES: Record<string, MetadataRule> = {
  Shell: (input, metadata) => {
    const command = str(input.command);
    if (!command) return null;
    const exitCode = num(metadata.exitCode);
    const signal = str(metadata.signal);
    const stdoutBytes = num(metadata.stdoutBytes);
    const stderrBytes = num(metadata.stderrBytes);
    const durationMs = num(metadata.durationMs);

    const detail: PresentationDetailLine[] = [{ k: '命令', v: briefCommand(command) }];
    if (exitCode !== undefined) detail.push({ tree: '├', k: '退出码', v: String(exitCode) });
    else if (signal) detail.push({ tree: '├', k: '终止信号', v: signal });
    if (stdoutBytes !== undefined) detail.push({ tree: '├', k: '输出', v: formatBytes(stdoutBytes) });
    if (stderrBytes) detail.push({ tree: '├', k: '错误输出', v: formatBytes(stderrBytes) });
    if (durationMs !== undefined) detail.push({ tree: '└', k: '耗时', v: formatDuration(durationMs) });
    if (metadata.outputExceeded === true) detail.push({ indent: 0, text: '⚠ 输出超出捕获上限，已截断' });
    if (metadata.timedOut === true) detail.push({ indent: 0, text: '⚠ 执行超时' });
    if (metadata.aborted === true) detail.push({ indent: 0, text: '⚠ 已被中止' });

    const failed = metadata.timedOut === true
      || metadata.aborted === true
      || (exitCode !== undefined && exitCode !== 0)
      || (exitCode === undefined && !!signal);

    return {
      title: str(input.description) ?? '执行命令',
      detail,
      status: failed ? 'warn' : 'ok',
    };
  },

  Write: (input, metadata) => {
    const filePath = str(metadata.path) ?? str(input.file_path);
    if (!filePath) return null;
    const bytes = num(metadata.bytesWritten);
    const detail: PresentationDetailLine[] = [{ k: '路径', v: filePath }];
    if (bytes !== undefined) detail.push({ tree: '└', k: '写入', v: formatBytes(bytes) });
    return { title: `写入 ${basename(filePath)}`, detail, status: 'ok' };
  },
};

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
  { tool: 'Read', state: 'partial', gap: '缺读取行数/截断提示；Read 的 provider 目前不产出 metadata，需先补' },
  { tool: 'Write', state: 'covered' },
  { tool: 'Edit', state: 'partial', gap: '缺替换处数；Edit 的 provider 目前不产出 metadata，需先补' },
  {
    tool: 'Shell',
    state: 'covered',
    gap: '成功路径已用截断前 metadata（退出码/字节数/耗时/截断与超时标记）。'
      + '失败路径当前在 toolRuntime 直接 throw，摘要随之丢失——待「失败态进契约」批次一并处理',
  },
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
 * 07-25：Shell 与 Write 接上截断前 metadata，9 → 7。
 * 调高它需要 code review 显式批准——这正是 `[CITE]` 当年缺的那道闸门。
 */
export const PRESENTATION_TODO_BUDGET = 7;

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
  metadata?: Record<string, unknown>,
): ToolPresentation | undefined {
  // provider 在截断前自产的摘要信息量严格更高，规则不得覆盖
  if (existing) return existing;
  const input = parseInput(toolInput);
  try {
    // metadata 来自截断前的真实执行结果，优先于只看入参的规则
    const metadataRule = METADATA_RULES[toolName];
    if (metadataRule && metadata) {
      const fromMetadata = metadataRule(input, metadata);
      if (fromMetadata) return fromMetadata;
    }
    const rule = RULES[toolName];
    return rule ? (rule(input) ?? undefined) : undefined;
  } catch {
    // 摘要是锦上添花，任何异常都不得影响工具执行结果本身
    return undefined;
  }
}

/** 供覆盖率测试使用 */
export function listPresentationRuleNames(): string[] {
  return [...new Set([...Object.keys(RULES), ...Object.keys(METADATA_RULES)])];
}

/** 供覆盖率测试使用：哪些工具有基于截断前元数据的精确规则 */
export function listMetadataRuleNames(): string[] {
  return Object.keys(METADATA_RULES);
}
