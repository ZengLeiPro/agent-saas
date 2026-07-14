import { lazy, Suspense, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import App from "@/App";

const LoginPage = lazy(() => import("@/components/LoginPage").then(m => ({ default: m.LoginPage })));
const SignupPage = lazy(() => import("@/components/SignupPage").then(m => ({ default: m.SignupPage })));
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

export function AuthGate() {
  const { isLoading, isAuthenticated, authEnabled } = useAuth();
  const [signupMode, setSignupMode] = useState(initialSignupMode);
  const shareToken = currentShareToken();

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
      <Suspense fallback={<FullscreenSpinner />}>
        {signupMode ? (
          <SignupPage
            onSwitchToLogin={() => {
              // 清掉 /signup 路径与 utm 参数，回到干净登录页
              window.history.replaceState(null, "", "/");
              setSignupMode(false);
            }}
          />
        ) : (
          <LoginPage onSwitchToSignup={() => setSignupMode(true)} />
        )}
      </Suspense>
    );
  }

  return <App />;
}
