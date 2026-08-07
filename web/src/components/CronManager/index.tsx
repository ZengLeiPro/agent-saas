import { useEffect, useState } from "react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { navigateToHref } from "@/lib/urlSync";
import { TaskBoardView } from "@/components/TaskBoard";
import { CronScheduleView } from "./CronScheduleView";

interface CronManagerProps {
  onJobCountChange?: (enabled: number, total: number) => void;
  /** 桌面端全局 Header 的操作区；undefined 时由当前二级视图渲染页内 Header。 */
  headerActionsTarget?: HTMLElement | null;
}

type CronView = "schedule" | "board";

export function cronViewFromLocation(location: Pick<Location, "pathname" | "search"> = window.location): CronView {
  if (location.pathname !== "/cron") return "schedule";
  return new URLSearchParams(location.search).get("view") === "board" ? "board" : "schedule";
}

export function CronManager({ onJobCountChange, headerActionsTarget }: CronManagerProps) {
  const [view, setView] = useState<CronView>(() => cronViewFromLocation());
  const [mountedViews, setMountedViews] = useState<Record<CronView, boolean>>(() => ({
    schedule: cronViewFromLocation() === "schedule",
    board: cronViewFromLocation() === "board",
  }));

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
    const cronView = next as CronView;
    if (cronView === view) return;
    setMountedViews((current) => ({ ...current, [cronView]: true }));
    navigateToHref(cronView === "board" ? "/cron?view=board" : "/cron");
  };

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="shrink-0 border-b border-border/60 px-4 pt-3 sm:px-6 sm:pt-4">
        <Tabs value={view} onValueChange={changeView}>
          <TabsList className="h-9" aria-label="定时任务二级导航">
            <TabsTrigger value="schedule">任务调度</TabsTrigger>
            <TabsTrigger value="board">任务看板</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {mountedViews.schedule ? (
          <div className="h-full min-h-0" hidden={view !== "schedule"}>
            <CronScheduleView
              active={view === "schedule"}
              onJobCountChange={onJobCountChange}
              headerActionsTarget={view === "schedule" ? headerActionsTarget : null}
            />
          </div>
        ) : null}
        {mountedViews.board ? (
          <div className="h-full min-h-0" hidden={view !== "board"}>
            <TaskBoardView
              active={view === "board"}
              headerActionsTarget={view === "board" ? headerActionsTarget : null}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
