import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { TokenUsageDisplay } from "./TokenUsageDisplay";

describe("TokenUsageDisplay", () => {
  it("separates parent context from durable subagent usage", async () => {
    render(
      <TokenUsageDisplay
        allowDetails
        contextUsage={{
          totalTokens: 217626,
          model: "gpt-5.6-sol",
          categories: [],
          memoryFiles: [],
          mcpTools: [],
        }}
        tokenUsage={{
          contextTokens: 217626,
          totalInputTokens: 352451,
          totalCacheReadTokens: 172544,
          totalCacheCreationTokens: 0,
          totalOutputTokens: 37719,
          subagentTotalTokens: 33065054,
          totalTokens: 33455224,
          cacheHitDenominatorTokens: 352451,
          cacheHitRatio: 172544 / 352451,
          subagentUsage: {
            childCount: 7,
            requestCount: 297,
            inputTokens: 32801328,
            uncachedInputTokens: 11024944,
            cacheReadTokens: 21776384,
            cacheCreationTokens: 0,
            outputTokens: 263726,
            totalTokens: 33065054,
            cacheHitDenominatorTokens: 32801328,
            cacheHitRatio: 21776384 / 32801328,
          },
        }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /上下文 217\.6k/ }));

    expect(screen.getByText("父 Agent")).toBeTruthy();
    expect(screen.getByText("子 Agent（7 个 · 297 次调用）")).toBeTruthy();
    expect(screen.getByText("33.1M")).toBeTruthy();
    expect(screen.getByText("11,024,944")).toBeTruthy();
    expect(screen.getByText("21,776,384")).toBeTruthy();
    expect(screen.getByText("66.4%")).toBeTruthy();
    expect(screen.getByText("任务总消耗")).toBeTruthy();
    expect(screen.getByText("33.5M")).toBeTruthy();
    expect(screen.getByText("缓存写入为 provider 上报值；0 不代表一定未创建缓存。")).toBeTruthy();
  });

  it("renders a non-interactive value when tenant policy disables details", () => {
    render(
      <TokenUsageDisplay
        allowDetails={false}
        contextUsage={{
          totalTokens: 1234,
          categories: [],
          memoryFiles: [],
          mcpTools: [],
        }}
        tokenUsage={null}
      />,
    );

    expect(screen.getByText("上下文 1.2k")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
