import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  BRAND_SEGMENTED_TABS_LIST_CLASS,
  BRAND_SEGMENTED_TAB_TRIGGER_CLASS,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { navigateToHref } from "@/lib/urlSync";
import { TaskBoardView } from "@/components/TaskBoard";
import { CronScheduleView } from "./CronScheduleView";

interface CronManagerProps {
  onJobCountChange?: (enabled: number, total: number) => void;
  /** 桌面端全局 Header 的二级导航区；undefined 时在页内渲染。 */
  headerNavigationTarget?: HTMLElement | null;
  /** 桌面端全局 Header 的操作区；undefined 时由当前二级视图渲染页内 Header。 */
  headerActionsTarget?: HTMLElement | null;
}

type CronView = "schedule" | "board";

function isTenantAdminPath(pathname: string): boolean {
  return pathname === "/tenant-admin" || pathname.startsWith("/tenant-admin/");
}

export function cronViewFromLocation(location: Pick<Location, "pathname" | "search"> = window.location): CronView {
  if (location.pathname !== "/cron" && !isTenantAdminPath(location.pathname)) return "schedule";
  return new URLSearchParams(location.search).get("view") === "board" ? "board" : "schedule";
}

function cronViewHref(view: CronView, location: Pick<Location, "pathname" | "search"> = window.location): string {
  if (!isTenantAdminPath(location.pathname)) {
    return view === "board" ? "/cron?view=board" : "/cron";
  }

  const query = new URLSearchParams(location.search);
  if (view === "board") query.set("view", "board");
  else query.delete("view");
  const search = query.toString();
  return `${location.pathname}${search ? `?${search}` : ""}`;
}

export function CronManager({ onJobCountChange, headerNavigationTarget, headerActionsTarget }: CronManagerProps) {
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
    navigateToHref(cronViewHref(cronView));
  };

  const navigation = (
    <Tabs value={view} onValueChange={changeView} className="min-w-0">
      <TabsList
        className={cn(
          BRAND_SEGMENTED_TABS_LIST_CLASS,
          "relative grid max-w-xl grid-cols-2",
          headerNavigationTarget !== undefined && "w-[30rem] max-w-[min(30rem,calc(100vw-24rem))]",
        )}
        aria-label="任务中心二级导航"
      >
        <span
          aria-hidden="true"
          data-task-center-tab-indicator
          className="pointer-events-none absolute inset-y-1 left-1 w-[calc((100%-0.5rem)/2)] rounded-[7px] bg-background shadow-[0_1px_4px_rgba(15,23,42,0.10)] transition-transform duration-300 [transition-timing-function:cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
          style={{ transform: `translateX(${view === "schedule" ? 0 : 100}%)` }}
        />
        <TabsTrigger
          value="schedule"
          className={cn(BRAND_SEGMENTED_TAB_TRIGGER_CLASS, "relative z-10 px-2 sm:px-3")}
        >
          定时任务
        </TabsTrigger>
        <TabsTrigger
          value="board"
          className={cn(BRAND_SEGMENTED_TAB_TRIGGER_CLASS, "relative z-10 px-2 sm:px-3")}
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
