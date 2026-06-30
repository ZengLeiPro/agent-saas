import { useEffect } from "react";
import { reportActivity } from "@agent/shared";

/**
 * 监听页面可见性变化，上报 app_foreground / app_background 事件。
 */
export function useActivityReporter() {
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === "visible") {
        reportActivity("app_foreground");
      } else {
        reportActivity("app_background");
      }
    };
    document.addEventListener("visibilitychange", handler);
    // 初次进入上报
    reportActivity("app_foreground");
    return () => document.removeEventListener("visibilitychange", handler);
  }, []);
}
