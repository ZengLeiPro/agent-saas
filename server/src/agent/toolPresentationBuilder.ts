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
  /**
   * 摘要在哪一层产出。缺省 `server-metadata`＝本模块按 provider 的截断前
   * metadata 产出。`mapping` 是例外：该工具的关键数字在服务端写 tool_use 行
   * 时尚未产生（如子 Agent 的耗时/token 要等子 run 结束聚合），只能在
   * shared 的映射层组装——这类工具不受本模块规则表约束。
   */
  producedIn?: 'server-metadata' | 'mapping';
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

  Read: (input, metadata) => {
    const filePath = str(metadata.path) ?? str(input.file_path) ?? str(input.path);
    if (!filePath) return null;
    const linesRead = num(metadata.linesRead);
    const fileBytes = num(metadata.fileBytes);
    const truncated = metadata.truncated === true;

    const detail: PresentationDetailLine[] = [{ k: '路径', v: filePath }];
    // 请求范围与实读行数分开写：两者不一致本身就是重要信息
    if (metadata.ranged === true) {
      const offset = num(input.offset) ?? 1;
      const limit = num(input.limit);
      detail.push({
        tree: '├',
        k: '请求范围',
        v: limit !== undefined ? `第 ${offset}–${offset + limit} 行` : `自第 ${offset} 行`,
      });
    }
    if (linesRead !== undefined) detail.push({ tree: '├', k: '实读', v: `${linesRead.toLocaleString('zh-CN')} 行` });
    if (fileBytes !== undefined) detail.push({ tree: '└', k: '文件大小', v: formatBytes(fileBytes) });
    if (truncated) {
      const shown = num(metadata.shownBytes);
      detail.push({ indent: 0, text: shown !== undefined ? `⚠ 超出单次读取上限，仅返回前 ${formatBytes(shown)}` : '⚠ 内容已截断' });
    }

    return {
      title: `读取 ${basename(filePath)}`,
      detail,
      status: truncated ? 'warn' : 'ok',
    };
  },

  WebSearch: (input, metadata) => {
    const query = str(metadata.query) ?? str(input.query);
    if (!query) return null;
    const detail: PresentationDetailLine[] = [{ k: '检索词', v: query }];
    const provider = str(metadata.provider);
    if (provider) detail.push({ tree: '├', k: '来源', v: provider });
    const count = num(metadata.resultCount);
    if (count !== undefined) detail.push({ tree: '└', k: '命中', v: `${count} 条` });
    if (metadata.truncated === true) detail.push({ indent: 0, text: '⚠ 结果过多，已截断' });
    return { title: '联网检索', detail, status: 'ok' };
  },

  WebFetch: (input, metadata) => {
    const url = str(metadata.finalUrl) ?? str(metadata.url) ?? str(input.url);
    if (!url) return null;
    const detail: PresentationDetailLine[] = [{ k: '来源', v: url }];
    // 发生跳转时把原始地址也写出来——落到哪个域名是安全相关的事实
    const original = str(metadata.url);
    const finalUrl = str(metadata.finalUrl);
    if (original && finalUrl && original !== finalUrl) {
      detail.push({ tree: '├', k: '原始地址', v: original });
    }
    const status = num(metadata.status);
    if (status !== undefined) detail.push({ tree: '├', k: 'HTTP', v: String(status) });
    const returned = num(metadata.returnedLength);
    const raw = num(metadata.rawLength);
    if (returned !== undefined) {
      const ratio = raw !== undefined && raw > returned ? `（原文 ${raw.toLocaleString('zh-CN')} 字）` : '';
      detail.push({ tree: '├', k: '正文', v: `${returned.toLocaleString('zh-CN')} 字${ratio}` });
    }
    const tookMs = num(metadata.tookMs);
    if (tookMs !== undefined) detail.push({ tree: '└', k: '耗时', v: formatDuration(tookMs) });
    if (metadata.truncated === true) detail.push({ indent: 0, text: '⚠ 正文超出上限，已截断' });
    return { title: '读取网页', detail, status: metadata.truncated === true ? 'warn' : 'ok' };
  },

  GenerateImage: (input, metadata) => {
    const engine = str(metadata.engine);
    const detail: PresentationDetailLine[] = [];
    const prompt = str(input.prompt);
    if (prompt) detail.push({ k: '画面', v: prompt });
    if (engine) detail.push({ tree: '├', k: '引擎', v: engine });
    const size = str(metadata.size);
    if (size) detail.push({ tree: '├', k: '尺寸', v: size });
    const count = num(metadata.count);
    if (count !== undefined) detail.push({ tree: '├', k: '数量', v: `${count} 张` });
    // 扣费是客户最该看见的一行，缺省时不猜
    const credits = num(metadata.creditsCharged);
    if (credits !== undefined) {
      const note = str(metadata.pricingNote);
      detail.push({ tree: '└', k: '积分', v: note ? `${credits}（${note}）` : String(credits) });
    } else if (str(metadata.billingNote)) {
      detail.push({ tree: '└', k: '计费', v: str(metadata.billingNote)! });
    }
    return detail.length ? { title: '生成图片', detail, status: 'ok' } : null;
  },

  Edit: (input, metadata) => {
    const filePath = str(metadata.path) ?? str(input.file_path);
    if (!filePath) return null;
    const replacements = num(metadata.replacements);
    const occurrences = num(metadata.occurrences);
    const before = num(metadata.bytesBefore);
    const after = num(metadata.bytesAfter);

    const detail: PresentationDetailLine[] = [{ k: '路径', v: filePath }];
    if (replacements !== undefined) {
      // 命中多处但只替换一处时把两个数都写出来——这正是 replace_all 语义最容易看漏的地方
      const hint = occurrences !== undefined && occurrences !== replacements ? `（命中 ${occurrences} 处）` : '';
      detail.push({ tree: '├', k: '替换', v: `${replacements} 处${hint}` });
    }
    if (before !== undefined && after !== undefined) {
      const delta = after - before;
      const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
      detail.push({ tree: '└', k: '体积变化', v: `${sign}${formatBytes(Math.abs(delta))}` });
    }
    return { title: `修改 ${basename(filePath)}`, detail, status: 'ok' };
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
  { tool: 'Read', state: 'covered' },
  { tool: 'Write', state: 'covered' },
  { tool: 'Edit', state: 'covered' },
  {
    tool: 'Shell',
    state: 'covered',
    gap: '成功路径已用截断前 metadata（退出码/字节数/耗时/截断与超时标记）。'
      + '失败路径当前在 toolRuntime 直接 throw，摘要随之丢失——待「失败态进契约」批次一并处理',
  },
  { tool: 'WebSearch', state: 'covered' },
  { tool: 'WebFetch', state: 'covered' },
  {
    tool: 'Agent',
    state: 'covered',
    producedIn: 'mapping',
    gap: '子 run 的耗时/token/轮次在服务端写 tool_use 行时尚未产生，摘要由 shared 的 mapBlock 取聚合值组装',
  },
  { tool: 'GenerateImage', state: 'covered' },
  { tool: 'Skill', state: 'none', gap: '刻意不做：Skill 的 tool_result 是技能正文，摘要价值近乎零；观众关心的是技能内部的 Shell/Read，已被覆盖' },
] as const;

/**
 * 未覆盖（state !== 'covered'）工具数的上限，**只减不增**。
 *
 * 每让一个工具真正做到 covered，就把这个数字减一并在 PR 里说明。
 * 07-25：Shell/Write 接截断前 metadata（9→7）；Read/Edit 补 provider metadata（7→5）；
 * WebSearch/WebFetch/GenerateImage/Agent 接各自真实结果（5→1）。仅剩 Skill，刻意不做。
 * 调高它需要 code review 显式批准——这正是 `[CITE]` 当年缺的那道闸门。
 */
export const PRESENTATION_TODO_BUDGET = 1;

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

/**
 * 携带摘要的工具执行错误。
 *
 * 工具失败时链路是 `throw` → 上层 catch → 构造错误 tool_result，摘要在这一跳
 * 会丢。但失败恰恰是最该说清楚的时刻：客户看到「读取 差旅.md · 有异常 · 文件
 * 不存在」远好过看到一行「已执行，有异常」。
 */
export class ToolExecutionError extends Error {
  constructor(message: string, readonly presentation?: ToolPresentation) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

/**
 * 失败时的摘要。
 *
 * 优先用错误自带的（那是 provider 在截断前按真实 metadata 产出的）；
 * 否则退回入参侧规则，并强制标记为 warn——**失败的执行绝不允许显示为 ok**。
 * 入参侧规则本身不产出 status，所以这里必须显式兜底。
 */
export function buildFailurePresentation(
  toolName: string,
  toolInput: unknown,
  error: unknown,
): ToolPresentation | undefined {
  if (error instanceof ToolExecutionError && error.presentation) {
    return { ...error.presentation, status: error.presentation.status ?? 'warn' };
  }
  const base = buildToolPresentation(toolName, toolInput);
  return base ? { ...base, status: 'warn' } : undefined;
}

/** 供覆盖率测试使用 */
export function listPresentationRuleNames(): string[] {
  return [...new Set([...Object.keys(RULES), ...Object.keys(METADATA_RULES)])];
}

/** 供覆盖率测试使用：哪些工具有基于截断前元数据的精确规则 */
export function listMetadataRuleNames(): string[] {
  return Object.keys(METADATA_RULES);
}
