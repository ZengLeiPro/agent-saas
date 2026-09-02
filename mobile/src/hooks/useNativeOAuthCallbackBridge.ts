import { useEffect } from 'react';
import { Linking } from 'react-native';
import { useRouter } from 'expo-router';
import { parseOAuthCallbackUrl } from '@agent/shared';
import { getNativeOAuthCallbackAllowlist } from '../platform/nativeOAuthCallbackPolicy';

/** Thin native bridge for both cold-start initialURL and warm Linking events. */
export function useNativeOAuthCallbackBridge(): void {
  const router = useRouter();
  useEffect(() => {
    let active = true;
    const route = (url: string | null) => {
      if (!active || !url) return;
      const payload = parseOAuthCallbackUrl(url, getNativeOAuthCallbackAllowlist());
      if (!payload) return; // unknown host/route/shape fails closed
      router.replace({
        pathname: '/oauth/callback',
        params: {
          state: payload.state,
          ...(payload.code ? { code: payload.code } : {}),
          ...(payload.error ? { error: payload.error } : {}),
          provider: payload.provider,
          redirect: payload.redirectUri,
          generation: String(payload.generation),
        },
      });
    };
    void Linking.getInitialURL().then(route);
    const subscription = Linking.addEventListener('url', event => route(event.url));
    return () => { active = false; subscription.remove(); };
  }, [router]);
}
