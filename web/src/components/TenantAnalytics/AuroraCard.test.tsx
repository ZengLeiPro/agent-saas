/**
 * 客户面指标卡语气的契约测试。
 *
 * 为什么值得测：改造前是七彩色板，同一个颜色承载两种含义——`emerald` 既用在
 * 「成员数」（纯展示）又用在「完成率达标」（真的是好事），客户看到一片颜色
 * 判断不出哪个需要行动。现在只有四档语义，这层一旦被塞回装饰色就前功尽弃。
 *
 * 另一条必须锁的是 props 透传：不透传会让「指标卡即入口」在客户面变成死的
 * （卡片看着能点，键盘完全到不了）——这是 S3 修过的真 bug。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Users } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { AuroraCard, ToneBadge, type Tone } from "./AuroraCard";

const ALL_TONES: Tone[] = ["good", "warn", "bad", "neutral"];

describe("AuroraCard", () => {
  it("四档语气各自映射到语义 token，不使用调色板值", () => {
    for (const tone of ALL_TONES) {
      const { container, unmount } = render(<AuroraCard tone={tone}>内容</AuroraCard>);
      const cls = (container.firstChild as HTMLElement).className;
      // 不允许出现 tailwind 调色板色名——颜色预算只给语义
      expect(cls).not.toMatch(/indigo|fuchsia|cyan|emerald|amber|rose|violet|pink|sky|teal/);
      unmount();
    }
  });

  it("语气与语义 token 一一对应", () => {
    const expected: Record<Tone, string> = {
      good: "bg-success/25",
      warn: "bg-warning/30",
      bad: "bg-danger/30",
      neutral: "bg-border",
    };
    for (const tone of ALL_TONES) {
      const { container, unmount } = render(<AuroraCard tone={tone}>内容</AuroraCard>);
      expect((container.firstChild as HTMLElement).className).toContain(expected[tone]);
      unmount();
    }
  });

  it("默认语气是 neutral —— 不传语气不代表「好」", () => {
    const { container } = render(<AuroraCard>内容</AuroraCard>);
    expect((container.firstChild as HTMLElement).className).toContain("bg-border");
  });

  it("透传 role / tabIndex / onClick / onKeyDown（否则客户面指标卡键盘不可达）", async () => {
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    render(
      <AuroraCard tone="good" role="button" tabIndex={0} onClick={onClick} onKeyDown={onKeyDown} aria-label="活跃成员">
        内容
      </AuroraCard>,
    );

    const card = screen.getByRole("button", { name: "活跃成员" });
    expect(card.getAttribute("tabindex")).toBe("0");

    await userEvent.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);

    card.focus();
    await userEvent.keyboard("{Enter}");
    expect(onKeyDown).toHaveBeenCalled();
  });

  it("渲染子内容", () => {
    render(<AuroraCard tone="neutral"><span>成员 12 人</span></AuroraCard>);
    expect(screen.getByText("成员 12 人")).toBeTruthy();
  });
});

describe("ToneBadge", () => {
  it("四档语气都走 subtle/ink 语义 token，不写 dark: 两段式", () => {
    const expected: Record<Tone, string> = {
      good: "bg-success-subtle",
      warn: "bg-warning-subtle",
      bad: "bg-danger-subtle",
      neutral: "bg-muted",
    };
    for (const tone of ALL_TONES) {
      const { container, unmount } = render(<ToneBadge tone={tone} icon={Users} />);
      const cls = (container.firstChild as HTMLElement).className;
      expect(cls).toContain(expected[tone]);
      // -ink token 自身覆盖亮暗两套值，不该再出现 dark: 覆盖
      expect(cls).not.toContain("dark:");
      unmount();
    }
  });

  it("默认语气是 neutral", () => {
    const { container } = render(<ToneBadge icon={Users} />);
    expect((container.firstChild as HTMLElement).className).toContain("bg-muted");
  });
});
