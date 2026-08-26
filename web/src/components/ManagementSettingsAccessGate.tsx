import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalContainerProvider } from "@/components/ui/portal-container";
import { cn } from "@/lib/utils";
import type { ManagementSettingsAccess } from "@/hooks/useManagementSettingsAccess";

interface ManagementSettingsAccessGateProps {
  scope: "tenant" | "platform";
  target: "personal" | "tenant" | "platform";
  access: ManagementSettingsAccess;
  onRetry: () => void;
  onReturnPersonal: () => void;
  /** Desktop unified settings may retain a workspace only after the user has visited it. */
  persistAfterVisit?: boolean;
  children: ReactNode;
}

export function ManagementSettingsAccessGate({
  scope, target, access, onRetry, onReturnPersonal, persistAfterVisit = false, children,
}: ManagementSettingsAccessGateProps) {
  const active = target === scope;
  const [visited, setVisited] = useState(active);
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (persistAfterVisit && active) setVisited(true);
  }, [active, persistAfterVisit]);

  const retained = active || (persistAfterVisit && visited);
  if (!retained) return null;

  const label = scope === "tenant" ? "组织管理" : "平台管理";
  const allowed = scope === "tenant" ? access.tenantEntryAllowed : access.platformEntryAllowed;
  const refreshingAllowed = access.status === "refreshing" && allowed;
  const mountedAllowed = allowed && (access.status === "ready" || access.status === "refreshing");
  if (mountedAllowed) {
    return (
      <div
        className={cn("relative h-full min-h-0", !active && "hidden")}
        aria-hidden={!active}
        // @ts-expect-error -- inert is supported by React 19 but missing from the installed React 18 types
        inert={!active}
        data-testid={`management-settings-${scope}-workspace`}
      >
        <div
          className="h-full min-h-0"
          aria-hidden={refreshingAllowed}
          // @ts-expect-error -- inert is supported by React 19 but missing from the installed React 18 types
          inert={refreshingAllowed}
        >
          <div
            ref={setPortalContainer}
            data-testid={`management-settings-${scope}-portal-container`}
          />
          {portalContainer && (
            <PortalContainerProvider
              container={portalContainer}
              blocked={!active || refreshingAllowed}
            >
              {children}
            </PortalContainerProvider>
          )}
        </div>
        {active && refreshingAllowed && (
          <div
            className="absolute inset-0 z-[200] flex items-center justify-center bg-card/85 px-6 backdrop-blur-[1px]"
            data-testid="management-settings-refreshing"
            role="status"
            aria-live="polite"
          >
            <div className="text-center">
              <Loader2 className="mx-auto mb-4 size-7 animate-spin text-muted-foreground" />
              <h2 className="text-lg font-semibold">{label}权限更新中</h2>
              <p className="mt-2 text-sm text-muted-foreground">正在获取最新管理权限，请稍候。</p>
            </div>
          </div>
        )}
      </div>
    );
  }
  if (!active) return null;

  const loading = access.status === "loading" || access.status === "refreshing";
  const error = access.status === "error";
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-6" data-testid={`management-settings-${access.status}`}>
      <div className="max-w-md text-center">
        {loading && <Loader2 className="mx-auto mb-4 size-7 animate-spin text-muted-foreground" />}
        <h2 className="text-lg font-semibold">
          {loading ? `${label}权限加载中` : error ? "无法验证权限" : "当前账号无权访问"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {loading
            ? "正在获取最新管理权限，请稍候。"
            : error ? `暂时无法验证${label}权限，请重试。` : `当前账号没有${label}访问权限。`}
        </p>
        <div className="mt-5 flex justify-center gap-2">
          {error && <Button onClick={onRetry}>重试</Button>}
          <Button variant={error ? "outline" : "default"} onClick={onReturnPersonal}>返回个人设置</Button>
        </div>
      </div>
    </div>
  );
}
