import { describe, expect, it } from "vitest";

import { classifyFailureReason, classifyLoadError } from "./errorText";

describe("platform admin friendly errors", () => {
  it("translates common technical failures and keeps the original detail", () => {
    const result = classifyFailureReason("upstream request timed out after 30000ms");
    expect(result.summary).toBe("请求超时");
    expect(result.suggestion).toContain("刷新重试");
    expect(result.technicalDetail).toContain("30000ms");
  });

  it("uses a safe business-facing fallback for unknown load errors", () => {
    const result = classifyLoadError(new Error("Runtime projection backend exploded"));
    expect(result.summary).toBe("暂时无法加载数据");
    expect(result.technicalDetail).toBe("Runtime projection backend exploded");
  });

  it("recognizes missing records without exposing the raw message as the headline", () => {
    const result = classifyLoadError("/api/admin/runs → HTTP 404 Not Found");
    expect(result.summary).toBe("没有找到对应记录");
    expect(result.technicalDetail).toContain("404");
  });
});
