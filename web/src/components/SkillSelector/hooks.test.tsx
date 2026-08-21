import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchMySkills: vi.fn(),
  fetchUserSkills: vi.fn(),
  updateMySelections: vi.fn(),
  updateMySkillSelection: vi.fn(),
  updateUserSelections: vi.fn(),
  useAuth: vi.fn(),
}));

vi.mock("@agent/shared", () => ({
  fetchMySkills: mocks.fetchMySkills,
  fetchUserSkills: mocks.fetchUserSkills,
  updateMySelections: mocks.updateMySelections,
  updateMySkillSelection: mocks.updateMySkillSelection,
  updateUserSelections: mocks.updateUserSelections,
  SkillSelectionConflictError: class SkillSelectionConflictError extends Error {},
}));

vi.mock("@/contexts/AuthContext", () => ({ useAuth: mocks.useAuth }));
vi.mock("@/lib/refreshBus", () => ({
  registerRefresh: vi.fn(),
  unregisterRefresh: vi.fn(),
}));

import { useMySkills } from "./hooks";

function response(selected: boolean) {
  return {
    poolSkills: [{
      id: "browser",
      name: "Browser",
      description: "browser",
      selected,
      selectionVersion: selected ? 1 : 0,
      source: "pool" as const,
    }],
    tenantSkills: [],
    customSkills: [],
  };
}

describe("useMySkills 账号缓存隔离", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAuth.mockReturnValue({ user: { id: "user-a", tenantId: "tenant-a" } });
    mocks.fetchMySkills.mockResolvedValue(response(true));
  });

  it("切换账号后不复用上一个账号的 /me 技能状态", async () => {
    const { result, rerender } = renderHook(() => useMySkills());

    await waitFor(() => expect(result.current.data?.poolSkills[0]?.selected).toBe(true));
    expect(mocks.fetchMySkills).toHaveBeenCalledTimes(1);

    mocks.useAuth.mockReturnValue({ user: { id: "user-b", tenantId: "tenant-b" } });
    mocks.fetchMySkills.mockResolvedValue(response(false));
    rerender();

    await waitFor(() => expect(result.current.data?.poolSkills[0]?.selected).toBe(false));
    expect(mocks.fetchMySkills).toHaveBeenCalledTimes(2);
  });
});
