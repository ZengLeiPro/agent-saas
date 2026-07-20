import { describe, expect, it } from "vitest";

import {
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
