import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { AuthShell } from "@/components/AuthShell";
import { LoginPage } from "@/components/LoginPage";
import { SignupPage } from "@/components/SignupPage";
import { apiUrl } from "@/lib/apiBase";
import App from "@/App";

const SessionSharePage = lazy(() => import("@/components/SessionSharePage").then(m => ({ default: m.SessionSharePage })));

/**
 * 注册模式判定：支持 path `/signup` 与 query `?signup`（官网 CTA 两种链接形态都兼容；
 * query 形态不依赖 nginx SPA fallback，path 形态需要 try_files 兜底到 index.html）。
 */
function initialSignupMode(): boolean {
  return (
    window.location.pathname === "/signup" ||
    new URLSearchParams(window.location.search).has("signup")
  );
}

function currentShareToken(): string | null {
  const match = window.location.pathname.match(/^\/share\/([^/?#]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function FullscreenSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * 登录/注册只替换卡片内容：外层 AuthShell 与卡片 DOM 常驻。
 * 高度随内容平滑变化，短促淡入只作用于表单，不重播整张卡片的入场动画。
 */
function AuthContentTransition({
  viewKey,
  children,
}: {
  viewKey: "login" | "signup";
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const syncHeight = () => setHeight(content.getBoundingClientRect().height);
    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(content);
    return () => observer.disconnect();
  }, [viewKey]);

  return (
    <div
      className="overflow-hidden transition-[height] duration-300 [transition-timing-function:cubic-bezier(0.2,0.7,0.3,1)] motion-reduce:transition-none"
      style={height === null ? undefined : { height }}
    >
      <div
        key={viewKey}
        ref={contentRef}
        className="animate-auth-content-enter motion-reduce:animate-none"
      >
        {children}
      </div>
    </div>
  );
}

export function AuthGate() {
  const { isLoading, isAuthenticated, authEnabled } = useAuth();
  const [signupMode, setSignupMode] = useState(initialSignupMode);
  const [signupEnabled, setSignupEnabled] = useState<boolean | null>(null);
  const shareToken = currentShareToken();

  const switchToLogin = () => {
    // 清掉 /signup 路径与 utm 参数，回到干净登录页
    window.history.replaceState(null, "", "/");
    setSignupMode(false);
  };

  useEffect(() => {
    if (isLoading || !authEnabled || isAuthenticated || shareToken) return;

    let cancelled = false;
    fetch(apiUrl("/api/signup/status"))
      .then((res) => res.json())
      .then((data: { enabled?: boolean }) => {
        if (!cancelled) setSignupEnabled(data.enabled === true);
      })
      .catch(() => {
        if (!cancelled) setSignupEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authEnabled, isAuthenticated, isLoading, shareToken]);

  if (shareToken) {
    return (
      <Suspense fallback={<FullscreenSpinner />}>
        <SessionSharePage token={shareToken} />
      </Suspense>
    );
  }

  if (isLoading) {
    return <FullscreenSpinner />;
  }

  // 后端未启用鉴权 -> 直接进入应用
  if (!authEnabled) {
    return <App />;
  }

  if (!isAuthenticated) {
    return (
      <AuthShell>
        <AuthContentTransition viewKey={signupMode ? "signup" : "login"}>
          {signupMode ? (
            <SignupPage
              enabled={signupEnabled}
              onSwitchToLogin={switchToLogin}
            />
          ) : (
            <LoginPage
              signupEnabled={signupEnabled === true}
              onSwitchToSignup={() => setSignupMode(true)}
            />
          )}
        </AuthContentTransition>
      </AuthShell>
    );
  }

  return <App />;
}
