import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { navigateToHref } from "@/lib/urlSync";
import {
  rememberTaskCenterView,
  taskCenterPath,
  taskCenterViewFromPath,
  type TaskCenterView,
} from "@/lib/taskCenterRoute";
import { TaskBoardView } from "@/components/TaskBoard";
import { CronScheduleView } from "./CronScheduleView";

interface CronManagerProps {
  /** mount-once 容器当前是否为用户可见的顶层页面。 */
  active?: boolean;
  onJobCountChange?: (enabled: number, total: number) => void;
  /** 桌面端全局 Header 的二级导航区；undefined 时在页内渲染。 */
  headerNavigationTarget?: HTMLElement | null;
  /** 桌面端全局 Header 的操作区；undefined 时由当前二级视图渲染页内 Header。 */
  headerActionsTarget?: HTMLElement | null;
  /** 桌面端与主内容同级的任务详情停靠区。 */
  detailPanelTarget?: HTMLElement | null;
  onTaskDetailOpenChange?: (open: boolean) => void;
}

function isTenantAdminPath(pathname: string): boolean {
  return pathname === "/tenant-admin" || pathname.startsWith("/tenant-admin/");
}

export function cronViewFromLocation(location: Pick<Location, "pathname" | "search"> = window.location): TaskCenterView {
  if (!isTenantAdminPath(location.pathname)) {
    if (location.pathname === "/cron" && new URLSearchParams(location.search).get("view") === "board") return "board";
    return taskCenterViewFromPath(location.pathname) ?? "schedule";
  }
  return new URLSearchParams(location.search).get("view") === "board" ? "board" : "schedule";
}

function cronViewHref(
  view: TaskCenterView,
  location: Pick<Location, "pathname" | "search"> = window.location,
): string {
  if (!isTenantAdminPath(location.pathname)) return taskCenterPath(view);

  const query = new URLSearchParams(location.search);
  if (view === "board") query.set("view", "board");
  else query.delete("view");
  const search = query.toString();
  return `${location.pathname}${search ? `?${search}` : ""}`;
}

export function CronManager({
  active = true,
  onJobCountChange,
  headerNavigationTarget,
  headerActionsTarget,
  detailPanelTarget,
  onTaskDetailOpenChange,
}: CronManagerProps) {
  const [view, setView] = useState<TaskCenterView>(() => cronViewFromLocation());
  const [mountedViews, setMountedViews] = useState<Record<TaskCenterView, boolean>>(() => ({
    schedule: cronViewFromLocation() === "schedule",
    board: cronViewFromLocation() === "board",
  }));

  useEffect(() => {
    rememberTaskCenterView(view);
  }, [view]);

  useEffect(() => {
    const syncFromUrl = () => {
      const next = cronViewFromLocation();
      setMountedViews((current) => ({ ...current, [next]: true }));
      setView(next);
    };
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  const changeView = (next: string) => {
    const cronView: TaskCenterView = next === "board" ? "board" : "schedule";
    if (cronView === view) return;
    setMountedViews((current) => ({ ...current, [cronView]: true }));
    navigateToHref(cronViewHref(cronView));
  };

  const navigation = (
    <Tabs value={view} onValueChange={changeView} className="min-w-0">
      <TabsList
        variant="secondary"
        className={cn(headerNavigationTarget !== undefined && "md:min-w-60")}
        aria-label="任务中心二级导航"
      >
        <TabsTrigger
          value="schedule"
        >
          定时任务
        </TabsTrigger>
        <TabsTrigger
          value="board"
        >
          任务看板
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {headerNavigationTarget === undefined ? (
        <div className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-6">
          {navigation}
        </div>
      ) : headerNavigationTarget ? createPortal(navigation, headerNavigationTarget) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {mountedViews.schedule ? (
          <div className="h-full min-h-0" hidden={view !== "schedule"}>
            <CronScheduleView
              active={active && view === "schedule"}
              onJobCountChange={onJobCountChange}
              headerActionsTarget={view === "schedule" ? headerActionsTarget : null}
            />
          </div>
        ) : null}
        {mountedViews.board ? (
          <div className="h-full min-h-0" hidden={view !== "board"}>
            <TaskBoardView
              active={active && view === "board"}
              headerActionsTarget={view === "board" ? headerActionsTarget : null}
              detailPanelTarget={detailPanelTarget}
              onDetailOpenChange={onTaskDetailOpenChange}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
