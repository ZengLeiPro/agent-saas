import { lazy, Suspense, useLayoutEffect, useState } from 'react';
const ClaimPage = lazy(() =>
  import('./KyAppCredentialClaimPage').then((module) => ({
    default: module.KyAppCredentialClaimPage,
  })),
);

/** 先移除 fragment，再加载领取页面；票据仅保留在本次路由的内存。 */
export function KyAppCredentialClaimEntry({ installationId }: { installationId: string }) {
  const [ticket, setTicket] = useState<string | null>(null);
  useLayoutEffect(() => {
    const captured = new URLSearchParams(window.location.hash.slice(1)).get('ticket');
    if (captured) window.history.replaceState(window.history.state, '', window.location.pathname);
    setTicket((previous) => captured ?? previous ?? '');
  }, []);
  return ticket === null ? null : (
    <Suspense fallback={<p role="status">正在加载凭据领取页…</p>}>
      <ClaimPage installationId={installationId} initialTicket={ticket} />
    </Suspense>
  );
}
