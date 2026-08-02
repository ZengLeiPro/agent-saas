import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

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
          usageTotals: {
            inputTokens: 352451,
            uncachedInputTokens: 179907,
            cacheReadTokens: 172544,
            cacheCreationTokens: 0,
            outputTokens: 37719,
            reasoningTokens: 0,
          },
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

    await userEvent.click(screen.getByRole("button", { name: /^217\.6k$/ }));

    const cumulativeHeading = screen.getByText("累计模型用量");
    const parentHeading = screen.getByText("主 Agent");
    const childHeading = screen.getByText("子 Agent（7 个 · 297 次调用）");
    const contextHeading = screen.getByText("当前上下文");
    // 新信息架构：当前上下文（hero 卡）在最前，其后依次为累计模型用量 → 主 Agent → 子 Agent
    expect(contextHeading.compareDocumentPosition(cumulativeHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cumulativeHeading.compareDocumentPosition(parentHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(parentHeading.compareDocumentPosition(childHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    expect(parentHeading).toBeTruthy();
    expect(screen.getByText("子 Agent（7 个 · 297 次调用）")).toBeTruthy();
    expect(screen.getByText("33.1M")).toBeTruthy();
    expect(screen.getByText("11,024,944")).toBeTruthy();
    expect(screen.getByText("21,776,384")).toBeTruthy();
    expect(screen.getByText("66.4%")).toBeTruthy();
    expect(screen.getByText("任务总消耗")).toBeTruthy();
    // 33.5M 出现两处：hero 卡「累计消耗 · 含子 Agent」+ 子 Agent 节「任务总消耗」
    expect(screen.getByText("累计消耗 · 含子 Agent")).toBeTruthy();
    expect(screen.getAllByText("33.5M").length).toBe(2);
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

    await userEvent.click(screen.getByRole("button", { name: /^64\.0k · 50%$/ }));
    expect(screen.getByText("总量为 provider 实际值 · 构成按估算占比校准")).toBeTruthy();
    expect(screen.getByText("原始估算 60.0k / 校准总量 64.0k")).toBeTruthy();
    expect(screen.getByText("上下文构成")).toBeTruthy();
    expect(screen.getByText("系统提示语")).toBeTruthy();
    expect(screen.getAllByText("校准估算").length).toBeGreaterThan(0);
    expect(screen.getByText("平台基础规则")).toBeTruthy();
    expect(screen.getByText("协议及未归因开销")).toBeTruthy();
    expect(screen.getByText("累计模型用量")).toBeTruthy();
    expect(screen.getByText("思考")).toBeTruthy();
  });

  it("renders per-child resource entries and opens child session", async () => {
    const onOpenChildSession = vi.fn();
    render(
      <TokenUsageDisplay
        allowDetails
        tokenUsage={{
          contextTokens: 10_000,
          totalInputTokens: 8_000,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          totalOutputTokens: 2_000,
          subagentTotalTokens: 12_000,
          subagentUsage: {
            childCount: 1,
            requestCount: 2,
            inputTokens: 10_000,
            uncachedInputTokens: 10_000,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 2_000,
            totalTokens: 12_000,
            cacheHitDenominatorTokens: 10_000,
            cacheHitRatio: 0,
          },
        }}
        messages={[{
          id: 'sub-1',
          type: 'subagent',
          toolId: 'tool-sub-1',
          agentType: 'explore',
          status: 'completed',
          childSessionId: 'child-session',
          model: 'gpt-5.6',
          durationMs: 2_000,
          totalTokens: 12_000,
        }]}
        onOpenChildSession={onOpenChildSession}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /累计 22\.0k/ }));
    expect(screen.getByText('子任务资源')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /explore/ }));
    expect(onOpenChildSession).toHaveBeenCalledWith('child-session');
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

    expect(screen.getByText("1.2k")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
