export type TaskCenterView = "schedule" | "board";

export const TASK_CENTER_VIEW_STORAGE_KEY = "task-center:last-view";

export function taskCenterViewFromPath(pathname: string): TaskCenterView | null {
  if (pathname === "/cron") return "schedule";
  if (pathname === "/taskboard") return "board";
  return null;
}

export function readLastTaskCenterView(): TaskCenterView {
  try {
    return window.localStorage.getItem(TASK_CENTER_VIEW_STORAGE_KEY) === "board" ? "board" : "schedule";
  } catch {
    return "schedule";
  }
}

export function rememberTaskCenterView(view: TaskCenterView): void {
  try {
    window.localStorage.setItem(TASK_CENTER_VIEW_STORAGE_KEY, view);
  } catch {
    // localStorage 不可用时仍保留当前页面行为。
  }
}

export function taskCenterPath(view: TaskCenterView): string {
  return view === "board" ? "/taskboard" : "/cron";
}

export function preferredTaskCenterPath(pathname = window.location.pathname): string {
  const currentView = taskCenterViewFromPath(pathname);
  return taskCenterPath(currentView ?? readLastTaskCenterView());
}
