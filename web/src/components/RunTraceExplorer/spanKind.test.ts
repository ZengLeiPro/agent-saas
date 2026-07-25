/**
 * spanKind 色板契约。
 *
 * 最重要的一条不是「哪类是什么颜色」，而是**类型色永不占用 success / danger**：
 * 绿和红在本项目里只表示结果好坏。如果哪天有人把「工具调用」改成绿色，
 * 运维就会把「这步是工具」读成「这步成功了」。这条用一个断言全局锁死。
 */
import { describe, expect, it } from "vitest";

import { SPAN_KIND_ORDER, SPAN_KIND_STYLES, spanKindOf, spanKindStyle, type SpanKind } from "./spanKind";

describe("spanKindOf", () => {
  it("显式映射：用户 / 记忆 / 思考 / 输出 / 工具调用", () => {
    expect(spanKindOf("user_message")).toBe("user");
    expect(spanKindOf("memory_context")).toBe("memory");
    expect(spanKindOf("memory_recall")).toBe("memory");
    expect(spanKindOf("assistant_thinking")).toBe("reasoning");
    expect(spanKindOf("assistant_message")).toBe("model");
    expect(spanKindOf("assistant_stream_event")).toBe("model");
    expect(spanKindOf("assistant_tool_calls")).toBe("tool");
  });

  it("前缀兜底：tool_* / approval_* / run_* / hand_* / subagent*", () => {
    expect(spanKindOf("tool_result")).toBe("tool");
    expect(spanKindOf("tool_audit")).toBe("tool");
    expect(spanKindOf("tool_output_delta")).toBe("tool");
    expect(spanKindOf("approval_requested")).toBe("approval");
    expect(spanKindOf("approval_resolved")).toBe("approval");
    expect(spanKindOf("run_finished")).toBe("lifecycle");
    expect(spanKindOf("run_state_changed")).toBe("lifecycle");
    expect(spanKindOf("hand_provisioned")).toBe("lifecycle");
    expect(spanKindOf("hand_failure")).toBe("lifecycle");
    expect(spanKindOf("subagent_started")).toBe("subagent");
    expect(spanKindOf("subagent_finished")).toBe("subagent");
  });

  it("未知 / 空 type 落中性 lifecycle，不会误导成某一类", () => {
    expect(spanKindOf("brand_new_event")).toBe("lifecycle");
    expect(spanKindOf(null)).toBe("lifecycle");
    expect(spanKindOf(undefined)).toBe("lifecycle");
    expect(spanKindOf("")).toBe("lifecycle");
  });

  it("assistant_tool_calls 归工具而不是模型输出（显式映射优先于 assistant 前缀）", () => {
    expect(spanKindOf("assistant_tool_calls")).toBe("tool");
    expect(spanKindOf("assistant")).toBe("model");
  });
});

describe("SPAN_KIND_STYLES", () => {
  const kinds = Object.keys(SPAN_KIND_STYLES) as SpanKind[];

  it("类型色不占用 success / danger —— 绿和红只表示结果好坏", () => {
    for (const kind of kinds) {
      const style = SPAN_KIND_STYLES[kind];
      const all = [style.dot, style.ink, style.surface, style.border, style.bar].join(" ");
      expect(all).not.toMatch(/success|destructive|danger/);
    }
  });

  it("每一类的 dot 颜色互不重复（8 类 8 种视觉）", () => {
    const dots = kinds.map((kind) => SPAN_KIND_STYLES[kind].dot);
    expect(new Set(dots).size).toBe(dots.length);
  });

  it("每一类都有中文 label（可直接做图例与 aria-label）", () => {
    for (const kind of kinds) {
      expect(SPAN_KIND_STYLES[kind].label.length).toBeGreaterThan(0);
      expect(SPAN_KIND_STYLES[kind].kind).toBe(kind);
    }
  });

  it("approval 例外地用 warning —— 它是「真的在等人」的状态语义", () => {
    expect(SPAN_KIND_STYLES.approval.dot).toContain("warning");
  });

  it("图例顺序覆盖全部 kind 且无重复", () => {
    expect([...SPAN_KIND_ORDER].sort()).toEqual([...kinds].sort());
    expect(new Set(SPAN_KIND_ORDER).size).toBe(SPAN_KIND_ORDER.length);
  });

  it("颜色全部来自 token（chart-* / info / warning / muted），无硬编码调色板", () => {
    for (const kind of kinds) {
      const style = SPAN_KIND_STYLES[kind];
      const all = [style.dot, style.ink, style.surface, style.border, style.bar].join(" ");
      expect(all).not.toMatch(/emerald|amber|rose|indigo|violet|sky|cyan|fuchsia|slate-\d/);
    }
  });

  it("spanKindStyle 是 spanKindOf + 查表的组合", () => {
    expect(spanKindStyle("tool_result")).toBe(SPAN_KIND_STYLES.tool);
    expect(spanKindStyle("nope")).toBe(SPAN_KIND_STYLES.lifecycle);
  });
});
