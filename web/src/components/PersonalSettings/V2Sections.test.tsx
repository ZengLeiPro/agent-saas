import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const retry = vi.fn();
const governanceError = Object.assign(new Error("private backend detail"), { status: 503 });

vi.mock("@/hooks/useEffectiveResources", () => ({
  useEffectiveResources: () => ({ data: null, loading: false, error: governanceError, retry }),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: null, updatePreferences: vi.fn() }),
}));

import { MyPermissionsSection } from "./V2Sections";

describe("我的权限 fail-closed", () => {
  it("503 时复用权威资源列表的不可用态，不泄露后端详情或本地推导允许", () => {
    render(<MyPermissionsSection />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("不会降级为允许");
    expect(alert.textContent).toContain("服务状态：503");
    expect(alert.textContent).not.toContain("private backend detail");
  });
});
