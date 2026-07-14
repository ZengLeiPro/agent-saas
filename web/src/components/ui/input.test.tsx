import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Input } from "./input";
import { Textarea } from "./textarea";

describe("输入控件自动填充策略", () => {
  it("普通输入默认关闭浏览器与常见密码管理器的自动填充", () => {
    render(
      <>
        <Input aria-label="普通输入" />
        <Textarea aria-label="多行输入" />
      </>,
    );

    for (const control of [screen.getByLabelText("普通输入"), screen.getByLabelText("多行输入")]) {
      expect(control.getAttribute("autocomplete")).toBe("off");
      expect(control.getAttribute("data-1p-ignore")).toBe("true");
      expect(control.getAttribute("data-bwignore")).toBe("true");
      expect(control.getAttribute("data-lpignore")).toBe("true");
    }
  });

  it("登录等明确语义的字段保留浏览器自动填充能力", () => {
    render(<Input aria-label="登录密码" type="password" autoComplete="current-password" />);

    const input = screen.getByLabelText("登录密码");
    expect(input.getAttribute("autocomplete")).toBe("current-password");
    expect(input.hasAttribute("data-1p-ignore")).toBe(false);
    expect(input.hasAttribute("data-bwignore")).toBe(false);
    expect(input.hasAttribute("data-lpignore")).toBe(false);
  });

  it("API Key 等非登录密钥可以保留密码型控件并拒绝密码管理器", () => {
    render(
      <Input
        aria-label="API Key"
        type="password"
        autoComplete="new-password"
        passwordManager="ignore"
      />,
    );

    const input = screen.getByLabelText("API Key");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    expect(input.getAttribute("data-1p-ignore")).toBe("true");
    expect(input.getAttribute("data-bwignore")).toBe("true");
    expect(input.getAttribute("data-lpignore")).toBe("true");
  });
});
