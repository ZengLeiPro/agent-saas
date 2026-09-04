import type { TaskBoard } from "@agent/shared";

export const BOARD_ORDER_STORAGE_KEY = "taskboard:board-order";
export const SELECTED_BOARD_STORAGE_KEY = "taskboard:selected-board";

export function loadBoardOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(BOARD_ORDER_STORAGE_KEY) ?? "null");
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((value): value is string => typeof value === "string"))];
  } catch {
    return [];
  }
}

export function loadSelectedBoardId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(SELECTED_BOARD_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveSelectedBoardId(boardId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SELECTED_BOARD_STORAGE_KEY, boardId);
  } catch {
    // 本地存储不可用时仍允许当前页面内切换看板。
  }
}

export function saveBoardOrder(order: string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BOARD_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // 本地存储不可用时仍允许当前页面内排序。
  }
}

export function orderBoards(boards: TaskBoard[], savedOrder: string[]): TaskBoard[] {
  const boardsById = new Map(boards.map((board) => [board.id, board]));
  const ordered: TaskBoard[] = [];
  const added = new Set<string>();

  for (const boardId of savedOrder) {
    const board = boardsById.get(boardId);
    if (!board || added.has(boardId)) continue;
    ordered.push(board);
    added.add(boardId);
  }

  return ordered.concat(boards.filter((board) => !added.has(board.id)));
}

export function reorderBoardIds(boardIds: string[], sourceId: string, targetId: string): string[] {
  if (sourceId === targetId) return boardIds;
  const sourceIndex = boardIds.indexOf(sourceId);
  const targetIndex = boardIds.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return boardIds;

  const next = boardIds.filter((boardId) => boardId !== sourceId);
  const targetIndexAfterRemoval = next.indexOf(targetId);
  const insertionIndex = sourceIndex < targetIndex
    ? targetIndexAfterRemoval + 1
    : targetIndexAfterRemoval;
  next.splice(insertionIndex, 0, sourceId);
  return next;
}
