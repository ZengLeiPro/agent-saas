import { beforeEach, describe, expect, it } from "vitest";
import {
  loadSelectedBoardId,
  saveSelectedBoardId,
  SELECTED_BOARD_STORAGE_KEY,
} from "./boardOrder";

describe("任务看板选择记忆", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("保存并恢复上次显示的看板", () => {
    expect(loadSelectedBoardId()).toBeNull();

    saveSelectedBoardId("board-2");

    expect(window.localStorage.getItem(SELECTED_BOARD_STORAGE_KEY)).toBe("board-2");
    expect(loadSelectedBoardId()).toBe("board-2");
  });
});
