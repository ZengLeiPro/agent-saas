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

  it("renders structured context breakdown and cumulative usage separately", async () => {
    render(
      <TokenUsageDisplay
        allowDetails
        tokenUsage={null}
        contextUsage={{
          totalTokens: 64_000,
          maxTokens: 128_000,
          percentage: 0.5,
          categories: [],
          breakdown: {
            method: 'utf8_bytes_v1',
            estimatedTokens: 60_000,
            providerInputTokens: 60_000,
            providerContextTokens: 64_000,
            unattributedTokens: 4_000,
            categories: [
              {
                key: 'system_prompt',
                name: '系统提示语',
                tokens: 20_000,
                color: '#8B5CF6',
                accuracy: 'estimated',
                children: [{
                  key: 'system:platform',
                  name: '平台基础规则',
                  tokens: 20_000,
                  color: '#8B5CF6',
                  accuracy: 'estimated',
                }],
              },
              {
                key: 'unattributed',
                name: '协议及未归因开销',
                tokens: 4_000,
                color: '#94A3B8',
                accuracy: 'derived',
              },
            ],
          },
          usageTotals: {
            inputTokens: 100_000,
            uncachedInputTokens: 60_000,
            cacheReadTokens: 40_000,
            cacheCreationTokens: 0,
            outputTokens: 5_000,
            reasoningTokens: 2_000,
          },
          memoryFiles: [],
          mcpTools: [],
        }}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /上下文 64\.0k/ }));
    expect(screen.getByText("上下文构成")).toBeTruthy();
    expect(screen.getByText("系统提示语")).toBeTruthy();
    expect(screen.getByText("平台基础规则")).toBeTruthy();
    expect(screen.getByText("协议及未归因开销")).toBeTruthy();
    expect(screen.getByText("累计模型用量")).toBeTruthy();
    expect(screen.getByText("思考 Token")).toBeTruthy();
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
