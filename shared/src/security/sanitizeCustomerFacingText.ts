export interface RedlineReplacement {
  readonly pattern: RegExp;
  readonly replacement: string;
  readonly reason: string;
}

export const redlineReplacements: readonly RedlineReplacement[] = [
  { pattern: /Claude\s*Code/gi, replacement: "AI 编程工具", reason: "AI 编程工具名" },
  { pattern: /Claude/gi, replacement: "AI 大脑", reason: "海外模型名" },
  { pattern: /GPT[-\s]?[0-9.]*/gi, replacement: "AI 大脑", reason: "海外模型名" },
  { pattern: /Gemini/gi, replacement: "AI 大脑", reason: "海外模型名" },
  { pattern: /Codex/gi, replacement: "AI 大脑", reason: "内部模型名" },
  { pattern: /Cursor/gi, replacement: "AI 编程工具", reason: "AI 编程工具名" },
  { pattern: /Copilot/gi, replacement: "AI 编程工具", reason: "AI 编程工具名" },
  { pattern: /AI\s*Coding/gi, replacement: "AI 帮企业改造", reason: "交付方式红线" },
  { pattern: /OpenAI/gi, replacement: "AI 服务方", reason: "厂商名" },
  { pattern: /Anthropic/gi, replacement: "AI 服务方", reason: "厂商名" },
  { pattern: /火山方舟|火山/g, replacement: "国内 AI 服务方", reason: "厂商名" },
  { pattern: /字节(?:跳动)?/g, replacement: "国内 AI 服务方", reason: "厂商名" },
  { pattern: /深度求索/g, replacement: "国内 AI 服务方", reason: "厂商名" },
  { pattern: /通义/g, replacement: "国内 AI 服务方", reason: "厂商名" },
  { pattern: /workspace/gi, replacement: "工作台", reason: "技术抽象" },
  { pattern: /工作空间/g, replacement: "工作台", reason: "技术抽象" },
  { pattern: /(?<![A-Za-z])[Ss]kill(?![A-Za-z])/g, replacement: "公司规范", reason: "内部能力抽象" },
  { pattern: /技能包/g, replacement: "公司规范", reason: "内部能力抽象" },
  { pattern: /RAG/g, replacement: "读了您的资料", reason: "技术抽象" },
  { pattern: /embedding[s]?/gi, replacement: "学过您的资料", reason: "技术抽象" },
  { pattern: /vector\s*(store|db)?/gi, replacement: "资料库", reason: "技术抽象" },
  { pattern: /SaaS\s*架构/gi, replacement: "每家企业一个独立的库", reason: "架构术语" },
  { pattern: /多租户|multi[-\s]?tenant/gi, replacement: "每家企业一个独立的库", reason: "架构术语" },
  { pattern: /(?:私有化)?容器|云原生/g, replacement: "装进您现有的钉钉和 ERP", reason: "架构术语" },
  { pattern: /Memory\s*持久化/gi, replacement: "账号一转新人接着用", reason: "内部机制" },
  { pattern: /(?:autonomous\s+)?agentic/gi, replacement: "AI 同事", reason: "技术抽象" },
  { pattern: /智能体/g, replacement: "AI 同事", reason: "旧表达" },
  { pattern: /AI\s*助手/g, replacement: "AI 同事", reason: "旧表达" },
  { pattern: /AI\s*助理/g, replacement: "AI 同事", reason: "旧表达" },
  { pattern: /AI\s*帮手/g, replacement: "AI 同事", reason: "旧表达" },
  { pattern: /AI\s*小助手|智能小助手/g, replacement: "AI 同事", reason: "旧表达" },
  { pattern: /(?<![A-Za-z])tokens?(?![A-Za-z])/gi, replacement: "积分", reason: "计费术语" },
  { pattern: /7\s*[×x*]\s*24\s*(?:无人工兜底|SLA)?/gi, replacement: "尽最大努力送达 + 异常时降级为当日补送", reason: "SLA 越权承诺" },
  { pattern: /完整商用\s*SLA/gi, replacement: "尽最大努力送达 + 异常时降级为当日补送", reason: "SLA 越权承诺" },
  { pattern: /(?<![A-Za-z])ISV(?![A-Za-z])/g, replacement: "钉钉官方认证服务商", reason: "行业缩写" },
  { pattern: /AI\s*中台|PaaS/gi, replacement: "AI 帮企业落地", reason: "平台术语" },
] as const;

export interface BannedWord {
  readonly pattern: RegExp;
  readonly reason: string;
  readonly suggestion: string;
}

export const bannedWordsHardBlock: readonly BannedWord[] = [
  { pattern: /agent[-\s]?saas/gi, reason: "产品内部代号泄漏", suggestion: "改用「开沿科技」或「AI 员工搭子」" },
  { pattern: /(?<![A-Za-z])mcp(?![A-Za-z])/gi, reason: "内部协议名", suggestion: "改成具体业务动作" },
  { pattern: /(?<![A-Za-z])prompt(?![A-Za-z])/gi, reason: "技术抽象术语", suggestion: "改用「起手指令」或「提问」" },
  { pattern: /pantheon/gi, reason: "平台 admin 租户内部代号", suggestion: "删除该词" },
  { pattern: /manus/gi, reason: "内部溯源标记", suggestion: "仅保留在内部 source 字段" },
  { pattern: /kaiyan:custom|kaiyan:internal/gi, reason: "内部溯源命名空间", suggestion: "仅保留在内部 source 字段" },
  { pattern: /sonnet|opus|haiku/gi, reason: "模型型号名", suggestion: "改用「AI 大脑」" },
  { pattern: /境内模型|海外模型/g, reason: "厂商合规话题不作客户面表述", suggestion: "改用「AI 服务方」或删除" },
  { pattern: /Anthropic\s*(Inc\.?|,\s*Inc\.?)?/gi, reason: "厂商法人名", suggestion: "改用「AI 服务方」" },
  { pattern: /私有化部署/g, reason: "越权销售承诺", suggestion: "改用「装进您现有的钉钉和 ERP」" },
  {
    pattern: /提效\s*\d+(\.\d+)?\s*%|节省\s*\d+(\.\d+)?\s*%|降低\s*\d+(\.\d+)?\s*%/g,
    reason: "自造量化数字",
    suggestion: "删除，或只用已审核白名单数字",
  },
  { pattern: /100\s*%\s*(?:准确|无误|无需人工)/g, reason: "完美承诺", suggestion: "改用「AI 起草，人工确认」" },
  { pattern: /(?<![A-Za-z])RBAC(?![A-Za-z])/g, reason: "权限模型技术术语", suggestion: "改用「谁看得到哪些」" },
  { pattern: /LLM(?![A-Za-z])/g, reason: "技术缩写", suggestion: "改用「AI 大脑」" },
] as const;

export interface SanitizeHit {
  readonly matched: string;
  readonly replacedWith?: string;
  readonly reason: string;
  readonly index: number;
}

export interface SanitizeBlock {
  readonly matched: string;
  readonly reason: string;
  readonly suggestion: string;
  readonly index: number;
}

export interface SanitizeResult {
  readonly output: string;
  readonly hits: readonly SanitizeHit[];
  readonly blocked: readonly SanitizeBlock[];
  readonly safeToPublish: boolean;
}

const globalPatternCache = new WeakMap<RegExp, RegExp>();

function ensureGlobal(pattern: RegExp): RegExp {
  if (pattern.flags.includes("g")) return pattern;
  const cached = globalPatternCache.get(pattern);
  if (cached) return cached;
  const next = new RegExp(pattern.source, pattern.flags + "g");
  globalPatternCache.set(pattern, next);
  return next;
}

export function sanitizeCustomerFacingText(input: string | null | undefined): SanitizeResult {
  if (input == null || input === "") {
    return { output: input ?? "", hits: [], blocked: [], safeToPublish: true };
  }

  const hits: SanitizeHit[] = [];
  let output = input;

  for (const rule of redlineReplacements) {
    const pattern = ensureGlobal(rule.pattern);
    const matches = [...output.matchAll(pattern)];
    if (matches.length === 0) continue;
    for (const match of matches) {
      hits.push({
        matched: match[0],
        replacedWith: rule.replacement,
        reason: rule.reason,
        index: match.index ?? 0,
      });
    }
    output = output.replace(pattern, rule.replacement);
  }

  const blocked: SanitizeBlock[] = [];
  for (const rule of bannedWordsHardBlock) {
    const pattern = ensureGlobal(rule.pattern);
    const matches = [...output.matchAll(pattern)];
    for (const match of matches) {
      blocked.push({
        matched: match[0],
        reason: rule.reason,
        suggestion: rule.suggestion,
        index: match.index ?? 0,
      });
    }
  }

  return { output, hits, blocked, safeToPublish: blocked.length === 0 };
}

export function hasRedlineHardBlock(input: string | null | undefined): boolean {
  if (input == null || input === "") return false;
  const sanitized = sanitizeCustomerFacingText(input);
  return sanitized.blocked.length > 0;
}

export interface ScenarioSanitizeReport {
  readonly scenario: unknown;
  readonly hits: ReadonlyArray<SanitizeHit & { readonly path: string }>;
  readonly blocked: ReadonlyArray<SanitizeBlock & { readonly path: string }>;
  readonly safeToPublish: boolean;
}

function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function sanitizeStringAt(
  path: string,
  value: unknown,
  hits: Array<SanitizeHit & { path: string }>,
  blocked: Array<SanitizeBlock & { path: string }>,
): unknown {
  if (typeof value !== "string") return value;
  const result = sanitizeCustomerFacingText(value);
  for (const hit of result.hits) hits.push({ ...hit, path });
  for (const block of result.blocked) blocked.push({ ...block, path });
  return result.output;
}

export function sanitizeScenario<T extends Record<string, unknown>>(scenario: T): ScenarioSanitizeReport {
  const clone = deepClone(scenario) as Record<string, unknown>;
  const hits: Array<SanitizeHit & { path: string }> = [];
  const blocked: Array<SanitizeBlock & { path: string }> = [];
  const applyAt = (path: string, value: unknown) => sanitizeStringAt(path, value, hits, blocked);

  for (const key of ["title", "pitch", "story", "promptTemplate", "welcomeMessage"]) {
    if (typeof clone[key] === "string") clone[key] = applyAt(key, clone[key]);
  }
  if (Array.isArray(clone.cannotPromise)) {
    clone.cannotPromise = clone.cannotPromise.map((v, i) => applyAt(`cannotPromise[${i}]`, v));
  }
  if (Array.isArray(clone.slots)) {
    clone.slots = (clone.slots as Array<Record<string, unknown>>).map((slot, i) => ({
      ...slot,
      label: applyAt(`slots[${i}].label`, slot.label),
      example: applyAt(`slots[${i}].example`, slot.example),
    }));
  }
  if (Array.isArray(clone.skillCandidates)) {
    clone.skillCandidates = (clone.skillCandidates as Array<Record<string, unknown>>).map((item, i) => ({
      ...item,
      name: applyAt(`skillCandidates[${i}].name`, item.name),
      firstSampleGate: applyAt(`skillCandidates[${i}].firstSampleGate`, item.firstSampleGate),
      freshnessMechanism: applyAt(`skillCandidates[${i}].freshnessMechanism`, item.freshnessMechanism),
      roiVisibility: applyAt(`skillCandidates[${i}].roiVisibility`, item.roiVisibility),
    }));
  }
  if (clone.activationFallback && typeof clone.activationFallback === "object") {
    const activationFallback = clone.activationFallback as Record<string, unknown>;
    clone.activationFallback = {
      ...activationFallback,
      withoutData: applyAt("activationFallback.withoutData", activationFallback.withoutData),
      degradedContent: applyAt("activationFallback.degradedContent", activationFallback.degradedContent),
    };
  }
  if (clone.signalAdaptation && typeof clone.signalAdaptation === "object") {
    const signalAdaptation = clone.signalAdaptation as Record<string, unknown>;
    clone.signalAdaptation = {
      ...signalAdaptation,
      emptyContentFallback: applyAt("signalAdaptation.emptyContentFallback", signalAdaptation.emptyContentFallback),
    };
  }
  if (Array.isArray(clone.day1PathSteps)) {
    clone.day1PathSteps = (clone.day1PathSteps as Array<Record<string, unknown>>).map((step, i) => ({
      ...step,
      userAction: applyAt(`day1PathSteps[${i}].userAction`, step.userAction),
      aiAction: applyAt(`day1PathSteps[${i}].aiAction`, step.aiAction),
      userSees: applyAt(`day1PathSteps[${i}].userSees`, step.userSees),
    }));
  }

  return { scenario: clone, hits, blocked, safeToPublish: blocked.length === 0 };
}

export function sanitizeRole<T extends Record<string, unknown>>(role: T): ScenarioSanitizeReport {
  const clone = deepClone(role) as Record<string, unknown>;
  const hits: Array<SanitizeHit & { path: string }> = [];
  const blocked: Array<SanitizeBlock & { path: string }> = [];
  const applyAt = (path: string, value: unknown) => sanitizeStringAt(path, value, hits, blocked);

  if (typeof clone.name === "string") clone.name = applyAt("name", clone.name);
  if (typeof clone.roleWelcomeMessage === "string") {
    clone.roleWelcomeMessage = applyAt("roleWelcomeMessage", clone.roleWelcomeMessage);
  } else if (clone.roleWelcomeMessage && typeof clone.roleWelcomeMessage === "object") {
    const message = clone.roleWelcomeMessage as Record<string, unknown>;
    clone.roleWelcomeMessage = {
      ...message,
      default: applyAt("roleWelcomeMessage.default", message.default),
      internal: applyAt("roleWelcomeMessage.internal", message.internal),
      export: applyAt("roleWelcomeMessage.export", message.export),
    };
  }
  if (Array.isArray(clone.roleTopPains)) {
    clone.roleTopPains = clone.roleTopPains.map((v, i) => applyAt(`roleTopPains[${i}]`, v));
  }
  if (Array.isArray(clone.roleP0DataSources)) {
    clone.roleP0DataSources = (clone.roleP0DataSources as Array<Record<string, unknown>>).map((source, i) => ({
      ...source,
      name: applyAt(`roleP0DataSources[${i}].name`, source.name),
      afterConnected: applyAt(`roleP0DataSources[${i}].afterConnected`, source.afterConnected),
      customerAction: applyAt(`roleP0DataSources[${i}].customerAction`, source.customerAction),
    }));
  }
  if (Array.isArray(clone.retentionPath7Day)) {
    clone.retentionPath7Day = (clone.retentionPath7Day as Array<Record<string, unknown>>).map((item, i) => ({
      ...item,
      mainlineAiAction: applyAt(`retentionPath7Day[${i}].mainlineAiAction`, item.mainlineAiAction),
      backupCsmAction: applyAt(`retentionPath7Day[${i}].backupCsmAction`, item.backupCsmAction),
    }));
  }

  return { scenario: clone, hits, blocked, safeToPublish: blocked.length === 0 };
}
