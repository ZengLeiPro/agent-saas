import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { UserAggregate } from "./types";
import { UserRankTable } from "./index";

vi.mock("./api", () => ({
  usageApi: {
    byModel: vi.fn(() => new Promise(() => {})),
  },
}));

const USERS: UserAggregate[] = [
  {
    username: "alice@example.com",
    realName: "Alice",
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheReadTokens: 25,
    totalCacheCreationTokens: 10,
    totalTokens: 185,
    totalCostUsd: 0.25,
    totalTurns: 3,
    cacheHitRatio: 0.2,
    lastActiveDate: "2026-08-13",
  },
];

function renderTable() {
  return render(
    <UserRankTable
      users={USERS}
      dateArgs={{ range: "30d" }}
      onSelectUser={vi.fn()}
      isPlatformAdmin
    />,
  );
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("UserRankTable accessibility", () => {
  it("reports the active sort direction and marks inactive sortable headers as none", () => {
    renderTable();

    expect(screen.getByRole("columnheader", { name: /总 Token/ }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("columnheader", { name: /用户/ }).getAttribute("aria-sort")).toBe("none");

    fireEvent.click(screen.getByRole("button", { name: /用户/ }));

    expect(screen.getByRole("columnheader", { name: /用户/ }).getAttribute("aria-sort")).toBe("ascending");
    expect(screen.getByRole("columnheader", { name: /总 Token/ }).getAttribute("aria-sort")).toBe("none");
  });

  it("links each expand button to the controlled details row", () => {
    renderTable();
    const expandButton = screen.getByRole("button", { name: "展开模型分布" });
    const detailsId = expandButton.getAttribute("aria-controls");

    expect(expandButton.getAttribute("aria-expanded")).toBe("false");
    expect(detailsId).toBeTruthy();
    expect(document.getElementById(detailsId!)).toBeNull();

    fireEvent.click(expandButton);

    expect(expandButton.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(detailsId!)).toBeTruthy();
  });
});
