import { describe, expect, it } from "vitest";

import {
  bannedWordsHardBlock,
  hasRedlineHardBlock,
  redlineReplacements,
  sanitizeCustomerFacingText,
  sanitizeRole,
  sanitizeScenario,
} from "./sanitizeCustomerFacingText";

describe("sanitizeCustomerFacingText · redlineReplacements", () => {
  it("[A1] replaces Claude family names", () => {
    const result = sanitizeCustomerFacingText("用 Claude Code 帮您整理日报");

    expect(result.output).toBe("用 AI 编程工具 帮您整理日报");
    expect(result.hits.map((hit) => hit.matched)).toEqual(["Claude Code"]);
    expect(result.safeToPublish).toBe(true);
  });

  it("[A2] replaces GPT model names", () => {
    const result = sanitizeCustomerFacingText("GPT-5.5 会先读您的材料");

    expect(result.output).toBe("AI 大脑 会先读您的材料");
    expect(result.hits[0]?.reason).toBe("海外模型名");
  });

  it("[A3] replaces Gemini and Codex", () => {
    const result = sanitizeCustomerFacingText("Gemini 和 Codex 都不应出现在客户面");

    expect(result.output).toBe("AI 大脑 和 AI 大脑 都不应出现在客户面");
    expect(result.hits).toHaveLength(2);
  });

  it("[A4] replaces OpenAI and Anthropic", () => {
    const result = sanitizeCustomerFacingText("OpenAI / Anthropic 只是内部实现");

    expect(result.output).toBe("AI 服务方 / AI 服务方 只是内部实现");
  });

  it("[A5] replaces domestic vendor names", () => {
    const result = sanitizeCustomerFacingText("火山方舟、字节、通义都不要直接写");

    expect(result.output).toBe("国内 AI 服务方、国内 AI 服务方、国内 AI 服务方都不要直接写");
    expect(result.hits).toHaveLength(3);
  });

  it("[A6] replaces workspace without touching unrelated Chinese words", () => {
    const result = sanitizeCustomerFacingText("workspace 里的工作空间会自动整理");

    expect(result.output).toBe("工作台 里的工作台会自动整理");
  });

  it("[A7] replaces skill / Skill with word boundaries", () => {
    const result = sanitizeCustomerFacingText("把您的 skill 沉淀成 Skill 库");
    const fieldName = sanitizeCustomerFacingText("skillCandidates 是内部字段名");

    expect(result.output).toBe("把您的 公司规范 沉淀成 公司规范 库");
    expect(fieldName.output).toBe("skillCandidates 是内部字段名");
    expect(fieldName.hits).toHaveLength(0);
  });

  it("[A8] replaces RAG / embedding / vector db", () => {
    const result = sanitizeCustomerFacingText("RAG + embedding + vector db 不应客户面直出");

    expect(result.output).toBe("读了您的资料 + 学过您的资料 + 资料库 不应客户面直出");
  });

  it("[A9] replaces multi-tenant architecture terms", () => {
    const result = sanitizeCustomerFacingText("多租户和 SaaS 架构是内部说法");

    expect(result.output).toBe("每家企业一个独立的库和 每家企业一个独立的库是内部说法");
  });

  it("[A10] replaces AI assistant labels with AI colleague", () => {
    const result = sanitizeCustomerFacingText("AI 助手、AI 助理、智能体都统一成一个表达");

    expect(result.output).toBe("AI 同事、AI 同事、AI 同事都统一成一个表达");
  });

  it("[A11] replaces token billing terms", () => {
    const result = sanitizeCustomerFacingText("本次任务会消耗 120 tokens");

    expect(result.output).toBe("本次任务会消耗 120 积分");
  });

  it("[A12] replaces unsupported 7x24 SLA promises", () => {
    const result = sanitizeCustomerFacingText("承诺 7×24 无人工兜底");

    expect(result.output).toBe("承诺 尽最大努力送达 + 异常时降级为当日补送");
  });

  it("[A13] replaces ISV and platform terms", () => {
    const result = sanitizeCustomerFacingText("ISV + AI 中台不是客户面表达");

    expect(result.output).toBe("钉钉官方认证服务商 + AI 帮企业落地不是客户面表达");
  });
});

describe("sanitizeCustomerFacingText · bannedWordsHardBlock", () => {
  it("[B1] blocks agent-saas / mcp / prompt", () => {
    const result = sanitizeCustomerFacingText("登录 agent-saas 后填写 prompt，走 mcp 协议");

    expect(result.safeToPublish).toBe(false);
    expect(result.blocked.map((block) => block.matched.toLowerCase())).toEqual(
      expect.arrayContaining(["agent-saas", "prompt", "mcp"]),
    );
    for (const block of result.blocked) expect(block.suggestion).not.toBe("");
  });

  it("[B2] blocks platform and source codenames", () => {
    const result = sanitizeCustomerFacingText("pantheon / manus / kaiyan:custom 只能内部留存");

    expect(result.safeToPublish).toBe(false);
    expect(result.blocked).toHaveLength(3);
  });

  it("[B3] blocks invented percentage claims", () => {
    const result = sanitizeCustomerFacingText("可提效 30%，并降低 12.5% 工作量");

    expect(result.safeToPublish).toBe(false);
    expect(result.blocked).toHaveLength(2);
  });

  it("[B4] blocks perfect promises and model codenames", () => {
    const result = sanitizeCustomerFacingText("100% 准确，无需人工，私有化部署，sonnet，LLM");

    expect(result.safeToPublish).toBe(false);
    expect(result.blocked.map((block) => block.reason)).toEqual(
      expect.arrayContaining(["完美承诺", "越权销售承诺", "模型型号名", "技术缩写"]),
    );
  });
});

describe("sanitizeCustomerFacingText · combinations and boundaries", () => {
  it("[C1] can replace terms and still block remaining hard terms", () => {
    const result = sanitizeCustomerFacingText("Claude 可读 RAG，但 prompt 不该出现");

    expect(result.output).toBe("AI 大脑 可读 读了您的资料，但 prompt 不该出现");
    expect(result.hits).toHaveLength(2);
    expect(result.blocked).toHaveLength(1);
    expect(result.safeToPublish).toBe(false);
  });

  it("[C2] reports hit indexes from the current output", () => {
    const result = sanitizeCustomerFacingText("前缀 Claude");

    expect(result.hits[0]).toMatchObject({ matched: "Claude", index: 3 });
  });

  it("[C3] leaves clean text untouched", () => {
    const input = "每天早上 8 点汇总昨日客户跟进，发到销售群";
    const result = sanitizeCustomerFacingText(input);

    expect(result.output).toBe(input);
    expect(result.hits).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
  });

  it("[C4] handles mixed Chinese and English text", () => {
    const result = sanitizeCustomerFacingText("客户说 OpenAI tokens 太抽象，要换成业务话");

    expect(result.output).toBe("客户说 AI 服务方 积分 太抽象，要换成业务话");
  });

  it("[C5] does not mistake substrings for standalone skill/token", () => {
    const result = sanitizeCustomerFacingText("skillCandidates 和 tokenizer 都是字段名");

    expect(result.output).toBe("skillCandidates 和 tokenizer 都是字段名");
    expect(result.hits).toHaveLength(0);
  });
});

describe("sanitizeCustomerFacingText · nullish and long input", () => {
  it("[D1] handles empty string", () => {
    const result = sanitizeCustomerFacingText("");

    expect(result).toEqual({ output: "", hits: [], blocked: [], safeToPublish: true });
  });

  it("[D2] handles null and undefined", () => {
    expect(sanitizeCustomerFacingText(null).output).toBe("");
    expect(sanitizeCustomerFacingText(undefined).output).toBe("");
    expect(hasRedlineHardBlock(undefined)).toBe(false);
  });

  it("[D3] handles long text without truncation", () => {
    const input = `${"业务文字".repeat(3000)} Claude`;
    const result = sanitizeCustomerFacingText(input);

    expect(result.output.endsWith("AI 大脑")).toBe(true);
    expect(result.output.length).toBeGreaterThan(10000);
  });

  it("[D4] hard-block shortcut only reports true for remaining banned terms", () => {
    expect(hasRedlineHardBlock("Claude")).toBe(false);
    expect(hasRedlineHardBlock("prompt")).toBe(true);
  });
});

describe("sanitizeScenario · scenario batch", () => {
  it("[E1] sanitizes scenario customer-facing fields", () => {
    const dirty = {
      id: "sales-x",
      role: "sales",
      mode: "recurring",
      title: "用 Claude 跟进客户",
      pitch: "每天节省时间，但不要写 OpenAI",
      story: "RAG 会变成业务话",
      promptTemplate: "请基于 workspace 总结",
      welcomeMessage: "AI 助手先帮你开场",
      cannotPromise: ["7x24 无人工兜底"],
      slots: [{ key: "customer", label: "token 用量", example: "GPT-5.5" }],
      skillCandidates: [
        {
          name: "沉淀 skill",
          level: "tenant",
          firstSampleGate: "用 embedding 看资料",
          freshnessMechanism: "Memory 持久化",
          roiVisibility: "ISV 可见",
        },
      ],
      activationFallback: {
        withoutData: "没有 RAG 时先问",
        degradedContent: "没有 vector db 时降级",
      },
      signalAdaptation: { emptyContentFallback: "无 token 也输出" },
      day1PathSteps: [
        {
          stage: "aha",
          userAction: "输入 Claude",
          aiAction: "用 GPT 草拟",
          userSees: "AI 助理结果",
        },
      ],
    };

    const report = sanitizeScenario(dirty);
    const scenario = report.scenario as typeof dirty;

    expect(scenario.title).toBe("用 AI 大脑 跟进客户");
    expect(scenario.promptTemplate).toBe("请基于 工作台 总结");
    expect(scenario.slots[0]?.example).toBe("AI 大脑");
    expect(scenario.skillCandidates[0]?.firstSampleGate).toContain("学过您的资料");
    expect(scenario.day1PathSteps[0]?.userSees).toContain("AI 同事");
    expect(report.safeToPublish).toBe(true);
    expect(report.hits.length).toBeGreaterThanOrEqual(12);
  });

  it("[E2] does not mutate internal source/enabled/salesPitch fields", () => {
    const dirty = {
      id: "boss-x",
      role: "boss",
      mode: "recurring",
      enabled: true,
      source: "manus:120205",
      salesPitch: {
        oralScript: "对老板说 Claude 是我们的核心",
        demoSteps: ["mcp"],
        bossQnA: [{ q: "prompt?", a: "agent-saas" }],
      },
      title: "干净标题",
    };

    const report = sanitizeScenario(dirty);
    const scenario = report.scenario as typeof dirty;

    expect(scenario.source).toBe("manus:120205");
    expect(scenario.enabled).toBe(true);
    expect(scenario.salesPitch.oralScript).toContain("Claude");
    expect(report.safeToPublish).toBe(true);
  });

  it("[E3] deep-clones and leaves the original object untouched", () => {
    const dirty = {
      title: "Claude 标题",
      slots: [{ key: "x", label: "GPT 标签", example: "OpenAI 示例" }],
    };

    const report = sanitizeScenario(dirty);

    expect(report.scenario).not.toBe(dirty);
    expect((report.scenario as typeof dirty).slots).not.toBe(dirty.slots);
    expect(dirty.title).toBe("Claude 标题");
    expect(dirty.slots[0]?.label).toBe("GPT 标签");
  });

  it("[E4] sanitizes exampleResult.body while keeping markdown structure intact", () => {
    const body = [
      "## 示例结论",
      "",
      "| 客户 | 应收余额 | 状态 |",
      "| --- | ---: | --- |",
      "| 华跃鞋材 | 128,600.00 | 已逾期 |",
      "| Claude 贸易 | 56,000.00 | 正常 |",
      "",
      "### 疑点清单",
      "",
      "- 第 3 张发票与第 7 张同号",
      "- `INV-2026-0612` 日期倒挂",
      "",
      "## AI 做了什么",
      "",
      "1. 逐张提取发票字段",
      "2. 用 workspace 汇总台账",
    ].join("\n");
    const dirty = {
      id: "fin-x",
      title: "干净标题",
      exampleResult: { body, dataLabel: "synthetic" },
    };

    const report = sanitizeScenario(dirty);
    const scenario = report.scenario as typeof dirty;
    const output = scenario.exampleResult.body;

    // 红线词已替换
    expect(output).not.toContain("Claude");
    expect(output).not.toContain("workspace");
    expect(output).toContain("AI 大脑 贸易");
    expect(output).toContain("用 工作台 汇总台账");
    // markdown 结构完好：标题、表格（表头/分隔行/数据行）、列表、行内代码、行数不变
    expect(output).toContain("## 示例结论");
    expect(output).toContain("### 疑点清单");
    expect(output).toContain("| 客户 | 应收余额 | 状态 |");
    expect(output).toContain("| --- | ---: | --- |");
    expect(output).toContain("| 华跃鞋材 | 128,600.00 | 已逾期 |");
    expect(output).toContain("- 第 3 张发票与第 7 张同号");
    expect(output).toContain("`INV-2026-0612` 日期倒挂");
    expect(output.split("\n").length).toBe(body.split("\n").length);
    // dataLabel 是受控枚举，原样保留
    expect(scenario.exampleResult.dataLabel).toBe("synthetic");
    expect(report.safeToPublish).toBe(true);
    expect(report.hits.some((hit) => hit.path === "exampleResult.body")).toBe(true);
  });
});

describe("sanitizeRole · role batch", () => {
  it("[F1] sanitizes role-level customer-facing fields", () => {
    const dirty = {
      id: "boss",
      name: "老板 Claude 版",
      roleWelcomeMessage: {
        default: "OpenAI 不是卖点",
        internal: "workspace 每天看",
        export: "AI 助手导出",
      },
      roleTopPains: ["GPT 太抽象", "tokens 听不懂"],
      roleP0DataSources: [
        {
          name: "RAG 资料库",
          afterConnected: "embedding 后可用",
          customerAction: "上传到 workspace",
        },
      ],
      retentionPath7Day: [
        {
          day: 1,
          mainlineAiAction: "Claude 先发",
          backupCsmAction: "ISV 人工补",
        },
      ],
    };

    const report = sanitizeRole(dirty);
    const role = report.scenario as typeof dirty;

    expect(role.name).toBe("老板 AI 大脑 版");
    expect(role.roleWelcomeMessage.default).toContain("AI 服务方");
    expect(role.roleTopPains[1]).toContain("积分");
    expect(role.roleP0DataSources[0]?.afterConnected).toContain("学过您的资料");
    expect(role.retentionPath7Day[0]?.backupCsmAction).toContain("钉钉官方认证服务商");
    expect(report.safeToPublish).toBe(true);
  });
});

describe("sanitize rules · meta constraints", () => {
  it("[G1] keeps enough replacement and hard-block rules", () => {
    expect(redlineReplacements.length).toBeGreaterThanOrEqual(25);
    expect(bannedWordsHardBlock.length).toBeGreaterThanOrEqual(10);
  });

  it("[G2] keeps replacement rules well formed", () => {
    for (const rule of redlineReplacements) {
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(rule.replacement).not.toBe("");
      expect(rule.reason).not.toBe("");
    }
  });

  it("[G3] keeps hard-block rules actionable", () => {
    for (const rule of bannedWordsHardBlock) {
      expect(rule.pattern).toBeInstanceOf(RegExp);
      expect(rule.reason).not.toBe("");
      expect(rule.suggestion).not.toBe("");
    }
  });
});
