import { describe, expect, it } from "vitest";

import {
  failureQueryKeyword,
  isRunFailureStatus,
  resolveRunCancellationReason,
  resolveRunFailureReason,
} from "./runStatus";

describe("run status notices", () => {
  it("does not treat a completed status reason as a failure", () => {
    expect(isRunFailureStatus("completed")).toBe(false);
    expect(resolveRunFailureReason("completed", "success", undefined)).toBeNull();
  });

  it("keeps real failure and orphan reasons visible", () => {
    expect(resolveRunFailureReason("failed", "model error", undefined)).toBe("model error");
    expect(resolveRunFailureReason("orphaned", null, "worker lost")).toBe("worker lost");
  });

  it("separates cancellation details from failure details", () => {
    expect(resolveRunFailureReason("cancelled", "web_abort", undefined)).toBeNull();
    expect(resolveRunCancellationReason("cancelled", "web_abort")).toBe("web_abort");
    expect(resolveRunCancellationReason("completed", "success")).toBeNull();
  });
});

/**
 * 「查看同类失败」的检索关键词（S5-B）。
 *
 * 关键词要拿去做 `status_reason ILIKE '%关键词%'`，所以判定标准只有一条：
 * **它必须是其他同类失败里也会原样出现的片段**。带上每次都不同的毫秒数 / run id，
 * 点进去只会看到自己那一条——那比没有这个按钮更糟（会让人以为是个例）。
 */
describe("failureQueryKeyword", () => {
  it("稳定短语原样保留", () => {
    expect(failureQueryKeyword("model error")).toBe("model error");
    expect(failureQueryKeyword("  quota exceeded  ")).toBe("quota exceeded");
  });

  it("截掉每次都不同的毫秒数与长数字", () => {
    expect(failureQueryKeyword("run timed out after 300000ms")).toBe("run timed out after");
    expect(failureQueryKeyword("upstream connect failed port 18080")).toBe("upstream connect failed port");
  });

  it("截掉 run / trace id 这类长十六进制串", () => {
    expect(failureQueryKeyword("hand provisioning failed for 9f2c1a4b7e5d")).toBe("hand provisioning failed for");
  });

  it("三位状态码是有效特征，必须留下", () => {
    expect(failureQueryKeyword("HTTP 500: upstream unavailable")).toBe("HTTP 500");
  });

  it("只取第一段：冒号 / 括号 / 换行之后通常是本次特有的上下文", () => {
    expect(failureQueryKeyword("tool execution failed（Bash: exit 127）")).toBe("tool execution failed");
    expect(failureQueryKeyword("approval denied\nby admin@kaiyan")).toBe("approval denied");
  });

  it("提炼结果过短时退回原文，不用一两个字符去扫全库", () => {
    expect(failureQueryKeyword("a: 12345678 detail")).toBe("a: 12345678 detail");
  });

  it("空值 → null（调用点据此不渲染按钮）", () => {
    expect(failureQueryKeyword(null)).toBeNull();
    expect(failureQueryKeyword(undefined)).toBeNull();
    expect(failureQueryKeyword("   ")).toBeNull();
  });

  it("超长原因截到 60 字符（后端上限 200，这里更保守）", () => {
    const keyword = failureQueryKeyword("x".repeat(200));
    expect(keyword).not.toBeNull();
    expect(keyword?.length).toBe(60);
  });
});
