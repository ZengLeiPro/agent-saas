import { describe, expect, it } from "vitest";
import { projectBusinessStepEvents } from "../../lib/extractTodos";
import { mapSessionDetailToMessages } from "../../lib/sessionsApi";
import { foldPanel, type PanelPulse } from "../../lib/systemPanel";
import { type ApiSessionDetail, type ApiTranscriptBlock } from "../../types";
import { buildLegacyReplayBlocks } from "./legacyTaskDemo";
import {
  allReplayScripts,
} from "./registry";
import {
  heroReplayScenarioIds,
  hookReplayScenarioIds,
  loadLazyReplayScript,
} from "./lazyRegistry";
import type { ReplayScript, ReplayStep } from "./types";

function toolBlock(id: string, title: string): ApiTranscriptBlock {
  return {
    id,
    kind: "tool_use",
    title,
    defaultOpen: true,
    toolName: title,
    toolId: id,
    content: "{}",
    executionStatus: "completed",
    presentation: {
      title,
      detail: [{ fields: [{ k: "对象", v: id }, { k: "状态", v: "已核对" }] }],
      status: "ok",
    },
  };
}

function step(index: number): ReplayStep {
  return {
    caption: `业务步骤 ${index + 1}`,
    blocks: [toolBlock(`tool-${index + 1}`, `执行动作 ${index + 1}`)],
  };
}

const script: ReplayScript = {
  scenarioId: "task-ui-demo",
  title: "任务工具样式演示",
  sources: [],
  steps: [step(0), step(1), step(2), step(3)],
};

function todoPayload(block: ApiTranscriptBlock) {
  if (block.kind !== "tool_use" || block.toolName !== "TodoWrite") throw new Error("不是 TodoWrite 块");
  return JSON.parse(block.content) as { todos: Array<Record<string, unknown>> };
}

describe("legacy task demo", () => {
  it("首屏保持原始入口，不提前泄露业务计划", () => {
    const promptScript: ReplayScript = {
      ...script,
      steps: [{
        ...script.steps[0],
        blocks: [{
          id: "prompt",
          kind: "prompt",
          title: "用户消息",
          defaultOpen: true,
          content: "请开始演示",
        }, ...script.steps[0].blocks],
      }, ...script.steps.slice(1)],
    };
    expect(buildLegacyReplayBlocks(promptScript, 0, {})).toEqual([promptScript.steps[0].blocks[0]]);

    const eventScript: ReplayScript = {
      ...promptScript,
      steps: [{
        ...promptScript.steps[0],
        blocks: [{
          id: "event",
          kind: "text",
          title: "业务事件",
          defaultOpen: true,
          content: "系统出现待处理事件",
          replayInstant: true,
        }, ...script.steps[0].blocks],
      }, ...promptScript.steps.slice(1)],
    };
    expect(buildLegacyReplayBlocks(eventScript, 1, {})[0].id).toBe("event");
  });

  it("每一步都生成开始与终态全量快照，并轮换四种结构化展示", () => {
    const blocks = buildLegacyReplayBlocks(script, 4, {});
    const snapshots = blocks.filter((block) => block.kind === "tool_use" && block.toolName === "TodoWrite");
    expect(snapshots).toHaveLength(8);

    const terminalSnapshots = snapshots.filter((_, index) => index % 2 === 1);
    const displayTypes = terminalSnapshots.map((block, index) => {
      const todo = todoPayload(block).todos[index];
      return (todo.display as Array<{ type: string }>)[0].type;
    });
    expect(displayTypes).toEqual(["facts", "list", "comparison", "checklist"]);

    const lastTodos = todoPayload(terminalSnapshots.at(-1)!).todos;
    expect(lastTodos.every((todo) => todo.status === "completed")).toBe(true);
    expect(lastTodos.every((todo) => typeof (todo.outcome as { text?: string }).text === "string")).toBe(true);
  });

  it("全部 hook legacy 演示在审批回复和后续 prompt 后仍只有一个计划实例", async () => {
    for (const scenarioId of hookReplayScenarioIds()) {
      const loaded = loadLazyReplayScript(scenarioId);
      if (!loaded) throw new Error(`未注册 legacy 剧本：${scenarioId}`);
      const replay = await loaded;
      const decisions = Object.fromEntries(
        replay.steps.flatMap((item, index) => item.approval ? [[index, "approved" as const]] : []),
      );
      const blocks = buildLegacyReplayBlocks(replay, replay.steps.length, decisions);
      const detail: ApiSessionDetail = {
        sessionId: `legacy-${scenarioId}`,
        stats: { lines: blocks.length, parsedLines: blocks.length, parseErrors: 0 },
        blocks,
      };
      const projection = projectBusinessStepEvents(mapSessionDetailToMessages(detail), false);
      expect(
        projection.events.filter((event) => event.kind === "plan"),
        `${scenarioId} 生成了重复计划`,
      ).toHaveLength(1);
    }
  });

  it("全部正式剧本的每组业务面板写入都能自动形成当前可见 delta", async () => {
    const heroScripts = await Promise.all(heroReplayScenarioIds().map(async (scenarioId) => {
      const loaded = loadLazyReplayScript(scenarioId);
      if (!loaded) throw new Error(`未注册 Hero 剧本：${scenarioId}`);
      return loaded;
    }));
    const hookScripts = await Promise.all(hookReplayScenarioIds().map(async (scenarioId) => {
      const loaded = loadLazyReplayScript(scenarioId);
      if (!loaded) throw new Error(`未注册 legacy 剧本：${scenarioId}`);
      return loaded;
    }));
    const scripts = [...allReplayScripts(), ...heroScripts, ...hookScripts];
    const businessOps = new Set([
      "rowInsert", "rowsSet", "rowUpdate", "rowsUpdate", "cardInsert", "cardUpdate",
      "tableRowInsert", "tableRowUpdate", "cellFlag", "statsSet", "feedAppend",
    ]);
    const coveredScripts = new Set<string>();
    let coveredSteps = 0;
    let coveredGroups = 0;

    for (const replay of scripts) {
      let snapshot = null as ReturnType<typeof foldPanel> | null;
      const decisions = Object.fromEntries(
        replay.steps.flatMap((step, index) => step.approval ? [[index, "approved" as const]] : []),
      );
      const enrichedById = new Map(
        buildLegacyReplayBlocks(replay, replay.steps.length, decisions).map((block) => [block.id, block]),
      );
      for (const step of replay.steps) {
        let stepHasDelta = false;
        const blocks = [...step.blocks, ...(step.approval?.approvedBlocks ?? [])];
        for (const block of blocks) {
          const presentation = enrichedById.get(block.id)?.presentation;
          if (!presentation) continue;
          if (!snapshot && presentation.panelBase) snapshot = presentation.panelBase;
          if (presentation.panel === undefined) continue;
          if (snapshot) snapshot = foldPanel(snapshot, presentation.panel);
          if (!presentation.panel.some((patch) => businessOps.has(patch.op))) continue;

          const pulse = presentation.panel.filter((patch): patch is PanelPulse => patch.op === "pulse").at(-1);
          expect(pulse, `${replay.scenarioId}/${step.caption} 未投影 pulse`).toBeDefined();
          expect(pulse?.ids.length, `${replay.scenarioId}/${step.caption} delta 无对象`).toBeGreaterThan(0);
          if (snapshot) expect(pulse?.view).toBe(snapshot.activeView);
          coveredGroups += 1;
          stepHasDelta = true;
        }
        if (stepHasDelta) {
          coveredScripts.add(replay.scenarioId);
          coveredSteps += 1;
        }
      }
    }

    expect(scripts).toHaveLength(
      allReplayScripts().length + heroReplayScenarioIds().length + hookReplayScenarioIds().length,
    );
    expect(coveredScripts.size).toBe(scripts.length);
    expect(coveredSteps).toBeGreaterThanOrEqual(scripts.length);
    expect(coveredGroups).toBeGreaterThanOrEqual(coveredSteps);
  });

  it("结构化结果后只保留短回复和文件卡，省略重复长文", () => {
    const narrativeScript: ReplayScript = {
      ...script,
      steps: [{
        caption: "展示结果",
        blocks: [
          toolBlock("tool-result", "结构化结果"),
          {
            id: "short-text",
            kind: "text",
            title: "业务进展",
            defaultOpen: true,
            content: "已核对，结果见表格。",
          },
          {
            id: "long-text",
            kind: "text",
            title: "业务进展",
            defaultOpen: true,
            content: "这是一段会重复结构化结果的长篇说明。".repeat(12),
          },
          {
            id: "file-text",
            kind: "text",
            title: "业务进展",
            defaultOpen: true,
            content: "前后说明都应删掉。\n\n[FILE]{\"filePath\":\"assets/demo/结果.html\"}[/FILE]\n\n更多重复说明。",
          },
        ],
      }],
    };

    const blocks = buildLegacyReplayBlocks(narrativeScript, 1, {});
    expect(blocks.find((block) => block.id === "short-text")?.content).toBe("已核对，结果见表格。");
    expect(blocks.some((block) => block.id === "long-text")).toBe(false);
    expect(blocks.find((block) => block.id === "file-text")?.content).toBe(
      '[FILE]{"filePath":"assets/demo/结果.html"}[/FILE]',
    );
  });

  it("审批等待与退回分别使用 waiting 和 blocked，不伪装成完成", () => {
    const approvalScript: ReplayScript = {
      ...script,
      steps: [{
        ...script.steps[0],
        approval: {
          title: "确认执行",
          description: "批准后继续",
          facts: [{ label: "范围", value: "演示" }],
          approveLabel: "批准",
          approvedBlocks: [],
          rejectedBlocks: [],
        },
      }],
    };

    const waiting = buildLegacyReplayBlocks(approvalScript, 1, {}).at(-1)!;
    const rejected = buildLegacyReplayBlocks(approvalScript, 1, { 0: "rejected" }).at(-1)!;
    expect(todoPayload(waiting).todos[0].status).toBe("waiting");
    expect(todoPayload(rejected).todos[0].status).toBe("blocked");
    expect((todoPayload(rejected).todos[0].outcome as { tone: string }).tone).toBe("warn");
  });
});
