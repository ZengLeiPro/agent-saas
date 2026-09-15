import { lazy, Suspense, useLayoutEffect, useState } from 'react';
const ClaimPage = lazy(() =>
  import('./KyAppCredentialClaimPage').then((module) => ({
    default: module.KyAppCredentialClaimPage,
  })),
);

/** 先移除 fragment，再加载领取页面；票据仅保留在本次路由的内存。 */
export function KyAppCredentialClaimEntry({ installationId }: { installationId: string }) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    if (window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
    setReady(true);
  }, []);
  return !ready ? null : (
    <Suspense fallback={<p role="status">正在加载凭据领取页…</p>}>
      <ClaimPage installationId={installationId} />
    </Suspense>
  );
}
