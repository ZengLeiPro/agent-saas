import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioLibraryResponse, UserPreferences } from "@agent/shared";

import { RoleSwitcher } from "./RoleSwitcher";
import { authFetch } from "@/lib/authFetch";

const mocked = vi.hoisted(() => ({
  library: {
    roles: [
      { id: "boss", name: "老板/总经理", sort: 1 },
      { id: "sales", name: "销售", sort: 2 },
      { id: "finance", name: "财务", sort: 3 },
    ],
    scenarios: [],
  } satisfies ScenarioLibraryResponse,
  updatePreferences: vi.fn<(preferences: UserPreferences) => void>(),
}));

vi.mock("./useScenarioLibrary", () => ({
  useScenarioLibrary: () => ({
    library: mocked.library,
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { preferences: { activeRoleId: "boss" } },
    updatePreferences: mocked.updatePreferences,
  }),
}));

vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

describe("RoleSwitcher", () => {
  it("loads available roles and switches the active role", async () => {
    const authFetchMock = vi.mocked(authFetch);
    authFetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ availableRoleIds: ["boss", "sales"], activeRoleId: "boss" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            activeRoleId: "sales",
            welcomeMessage: "销售岗已切换",
            preferences: { activeRoleId: "sales" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(<RoleSwitcher onOpenRoleDetail={vi.fn()} />);

    await screen.findByText("老板/总经理");
    fireEvent.click(screen.getByRole("button", { name: /老板\/总经理/ }));

    expect(screen.getByText("已开通")).toBeTruthy();
    expect(screen.getByText("未开通")).toBeTruthy();
    expect(screen.getByText("财务")).toBeTruthy();

    fireEvent.click(screen.getByText("销售"));

    await waitFor(() => {
      expect(authFetchMock).toHaveBeenCalledWith(
        "/api/user/switch-role",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ roleId: "sales" }),
        }),
      );
    });
    expect(mocked.updatePreferences).toHaveBeenCalledWith({ activeRoleId: "sales" });
  });
});
