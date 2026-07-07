import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MessageItem } from "@agent/shared";

import { TodoPanel } from "./TodoPanel";

function todoMessage(): MessageItem {
  return {
    id: "todo-1",
    type: "tool_use",
    toolName: "TodoWrite",
    toolId: "tool-1",
    toolInput: JSON.stringify({
      todos: [
        { content: "读取代码", status: "in_progress", activeForm: "正在读取代码" },
        { content: "修改展示", status: "pending" },
      ],
    }),
  };
}

describe("TodoPanel", () => {
  it("shows an active spinner while the run is active", () => {
    const { container } = render(<TodoPanel messages={[todoMessage()]} runActive />);

    expect(screen.getByText("正在读取代码")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });

  it("keeps the latest todo snapshot static after the run stops", () => {
    const { container } = render(<TodoPanel messages={[todoMessage()]} runActive={false} />);

    expect(screen.getByText("停留在：读取代码")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });
});
