import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import App from "@/App";

const LoginPage = lazy(() => import("@/components/LoginPage").then(m => ({ default: m.LoginPage })));

export function AuthGate() {
  const { isLoading, isAuthenticated, authEnabled } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // 后端未启用鉴权 -> 直接进入应用
  if (!authEnabled) {
    return <App />;
  }

  if (!isAuthenticated) {
    return (
      <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>}>
        <LoginPage />
      </Suspense>
    );
  }

  return <App />;
}
