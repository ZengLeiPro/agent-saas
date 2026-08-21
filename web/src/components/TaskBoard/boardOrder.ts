import type { TaskBoard } from "@agent/shared";

export const BOARD_ORDER_STORAGE_KEY = "taskboard:board-order";

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
  next.splice(next.indexOf(targetId), 0, sourceId);
  return next;
}
