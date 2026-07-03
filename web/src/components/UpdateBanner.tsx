import { useSyncExternalStore } from "react";
import { subscribeUpdateReady, isUpdateReady, applyUpdateNow } from "@/lib/swUpdate";

/**
 * 新版本提示条：SW 检测到更新且未被 update-on-navigation 消化时显示。
 * 用户点击立即更新；不点也会在下一次导航时自动应用（见 swUpdate.ts）。
 */
export function UpdateBanner() {
  const ready = useSyncExternalStore(subscribeUpdateReady, isUpdateReady, isUpdateReady);
  if (!ready) return null;
  return (
    <div className="fixed left-1/2 top-3 z-[100] -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-full bg-foreground/90 py-1.5 pl-4 pr-1.5 text-sm text-background shadow-lg backdrop-blur">
        <span>新版本可用</span>
        <button
          type="button"
          onClick={applyUpdateNow}
          className="rounded-full bg-background px-3 py-1 text-xs font-medium text-foreground transition-opacity hover:opacity-80"
        >
          立即更新
        </button>
      </div>
    </div>
  );
}
