import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SettingsDirtyBoundary,
  persistSettingsDraft,
  restoreSettingsDraft,
  useSettingsDirtyEntry,
} from "./dirtyRegistry";

// The editor must be a descendant of the provider, matching SettingsModal's wrapper split.
function WrappedDirtyHarness({ onNavigate }: { onNavigate: () => void }) {
  return (
    <SettingsDirtyBoundary>
      {({ requestNavigation }) => <RegisteredEditor requestNavigation={requestNavigation} onNavigate={onNavigate} />}
    </SettingsDirtyBoundary>
  );
}

function RegisteredEditor({ requestNavigation, onNavigate }: { requestNavigation: (next: () => void) => void; onNavigate: () => void }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  useSettingsDirtyEntry({
    id: "test-editor",
    label: "测试编辑器",
    dirty: value !== saved,
    save: () => setSaved(value),
    discard: () => setValue(saved),
    draft: { value },
  });
  return (
    <>
      <input aria-label="草稿" value={value} onChange={(event) => setValue(event.target.value)} />
      <button onClick={() => requestNavigation(onNavigate)}>切页</button>
    </>
  );
}

beforeEach(() => sessionStorage.clear());

describe("个人设置 dirty registry", () => {
  it("切页提供保存、放弃、取消三选一，并注册 beforeunload", async () => {
    const onNavigate = vi.fn();
    render(<WrappedDirtyHarness onNavigate={onNavigate} />);
    await userEvent.type(screen.getByLabelText("草稿"), "未保存");

    const beforeUnload = new Event("beforeunload", { cancelable: true });
    fireEvent(window, beforeUnload);
    expect(beforeUnload.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "切页" }));
    expect(screen.getByRole("button", { name: "保存并继续" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "放弃更改" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "保存并继续" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("非 Secret 草稿可恢复，Secret 永不持久化", () => {
    persistSettingsDraft("normal", { token: "not-a-secret-field" });
    persistSettingsDraft("secret", { password: "never-store" }, { secret: true });

    expect(restoreSettingsDraft("normal")).toEqual({ token: "not-a-secret-field" });
    expect(restoreSettingsDraft("secret", { secret: true })).toBeNull();
    expect([...Array(sessionStorage.length)].map((_, index) => sessionStorage.key(index)).join("\n"))
      .not.toContain("secret");
  });
});

