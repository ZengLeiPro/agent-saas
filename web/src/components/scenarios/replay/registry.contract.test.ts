import { describe, expect, it } from "vitest";
import { HANDWRITTEN_REPLAY_SCENARIO_IDS, HOOK_REPLAY_SCENARIO_IDS } from "./availability";
import { allReplayScripts, hookReplayScenarioIds, loadHookReplayScript } from "./registry";
import type { ReplayScript, ReplayStep } from "./types";

/**
 * 手写剧本的契约闸门。
 *
 * `docs/scenario-replay-authoring.md` 里的规范如果只写在文档里，第 5 个剧本
 * 就会开始跑偏。这里把其中可机检的部分变成会失败的测试——新增剧本注册进
 * registry 的同时必须过这些断言。
 *
 * 不可机检的部分（业务是否可信、文案是否像人话）仍然要人看。
 */

const scripts = allReplayScripts();
// 钩子剧本懒加载：契约门禁必须覆盖到它们，测试里全部装载
const hookScripts = await Promise.all(
  hookReplayScenarioIds().map((scenarioId) => loadHookReplayScript(scenarioId)!),
);
const gatedScripts = [...scripts, ...hookScripts];

function toolBlocks(step: ReplayStep) {
  return step.blocks.filter((block) => block.kind === "tool_use");
}

function allBlocks(script: ReplayScript) {
  return script.steps.flatMap((step) => [
    ...step.blocks,
    ...(step.approval?.approvedBlocks ?? []),
    ...(step.approval?.rejectedBlocks ?? []),
  ]);
}

function allText(script: ReplayScript): string {
  return allBlocks(script)
    .map((block) => block.content ?? "")
    .join("\n");
}

describe("剧本注册表", () => {
  it("至少有 4 个手写剧本，且 scenarioId 不重复并与轻量可用性索引一致", () => {
    expect(scripts.length).toBeGreaterThanOrEqual(4);
    const ids = scripts.map((script) => script.scenarioId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(HANDWRITTEN_REPLAY_SCENARIO_IDS));
  });

  it("钩子剧本懒加载表与轻量可用性索引一致，scenarioId 与装载键一一对应", () => {
    expect(new Set(hookReplayScenarioIds())).toEqual(new Set(HOOK_REPLAY_SCENARIO_IDS));
    const ids = hookScripts.map((script) => script.scenarioId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(HOOK_REPLAY_SCENARIO_IDS));
  });
});

describe.each(gatedScripts.map((script) => [script.title, script] as const))("剧本《%s》", (_title, script) => {
  it("步数在 5~10 之间——少于 5 步撑不起闭环，多于 10 步销售讲不完", () => {
    expect(script.steps.length).toBeGreaterThanOrEqual(5);
    expect(script.steps.length).toBeLessThanOrEqual(10);
  });

  it("第一步就让右侧面板有内容（带 panelBase 的工具块）", () => {
    const first = script.steps[0];
    expect(toolBlocks(first).some((block) => block.presentation?.panelBase)).toBe(true);
  });

  it("每个工具块都在 sources 里有登记，且非 exists 必须写 gap", () => {
    const registered = new Set(script.sources.map((source) => source.blockRef));
    expect(script.sources.length).toBeGreaterThanOrEqual(script.steps.length);
    for (const source of script.sources) {
      expect(source.producer.trim().length).toBeGreaterThan(0);
      if (source.state !== "exists") expect(source.gap?.trim().length ?? 0).toBeGreaterThan(0);
    }
    // blockRef 用 stepN.tool.X / stepN.artifact.X 约定，至少覆盖到每一个有工具的步骤
    const stepsWithTools = script.steps.filter((step) => toolBlocks(step).length > 0).length;
    const referencedSteps = new Set([...registered].map((ref) => ref.split(".")[0]));
    expect(referencedSteps.size).toBeGreaterThanOrEqual(Math.min(stepsWithTools, script.steps.length - 1));
  });

  it("有产物，且产物被正文的 [FILE] 标记引出来（否则客户看不到也带不走）", () => {
    const paths = Object.keys(script.artifacts ?? {});
    expect(paths.length).toBeGreaterThanOrEqual(1);
    const text = allText(script);
    for (const path of paths) {
      expect(text.includes(`[FILE]{"filePath":"${path}"`), `产物 ${path} 没有被 [FILE] 引用`).toBe(true);
    }
  });

  it("至少有一处主动停下：拦截（blocked）或等待人确认（waiting）", () => {
    const statuses = allBlocks(script)
      .map((block) => block.presentation?.status)
      .filter(Boolean);
    expect(statuses.some((status) => status === "blocked" || status === "waiting")).toBe(true);
  });

  it("终态说清「没有做什么」——边界比成果更值钱", () => {
    const last = script.steps.at(-1);
    const text = (last?.blocks ?? []).map((block) => block.content ?? "").join("\n");
    expect(/没有做什么|没有做的事|未做什么/.test(text), "终态缺少「没有做什么」段").toBe(true);
  });

  it("文案红线：加粗片段不以中文标点结尾（CommonMark 定界符不闭合，会露出字面星号）", () => {
    const text = allText(script);
    // `**这条我不能查。**成本…` 与 `**业务结果：**` 是同一个坑：右定界符前是中文
    // 标点、后面紧跟汉字时不闭合。写法应为 `**这条我不能查**。成本…`
    // 起点排除中文标点，否则「两对加粗之间的普通文本」会被当成一对误报
    const bad = text.match(/\*\*(?![，。：；！？、])[^*\n]{0,120}?[，。：；！？、]\*\*(?=[^\s])/g);
    expect(bad, `出现了会渲染成字面星号的加粗：${bad?.join(" / ")}`).toBeNull();
  });

  it("文案红线：正文不复述工具摘要的同一句话", () => {
    expect(allText(script).includes("这一步完成后")).toBe(false);
  });

  it("面板视图不超过 6 个（超出会被 normalizeSystemPanel 截断）", () => {
    const base = script.steps
      .flatMap((step) => toolBlocks(step))
      .map((block) => block.presentation?.panelBase)
      .find(Boolean);
    expect(base!.views.length).toBeLessThanOrEqual(6);
    expect(base!.foot ?? "").toContain("已连接：");
  });
});

describe.each(
  [
    // hero 剧本与钩子剧本执行同一档质量要求：有 Gate、退回有下文、终态可核对
    ...scripts.filter((script) => script.mode === "hero"),
    ...hookScripts,
  ].map((script) => [script.title, script] as const),
)("完整业务闭环剧本《%s》额外要求", (_title, script) => {
  it("至少一个人工审批门禁", () => {
    expect(script.steps.some((step) => step.approval)).toBe(true);
  });

  it("退回不是死路：每个审批都写了退回后的下文", () => {
    for (const step of script.steps) {
      if (!step.approval) continue;
      expect((step.approval.rejectedBlocks ?? []).length, `${step.caption} 缺 rejectedBlocks`).toBeGreaterThan(0);
    }
  });

  it("终态给出跨系统核对表（markdown 表格）", () => {
    const last = script.steps.at(-1);
    const text = (last?.blocks ?? []).map((block) => block.content ?? "").join("\n");
    expect(/\|\s*---/.test(text), "终态缺少跨系统核对表").toBe(true);
  });
});
