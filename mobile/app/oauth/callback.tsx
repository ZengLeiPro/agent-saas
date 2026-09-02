import { useEffect, useMemo, useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { useAuth } from '../../src/contexts/AuthContext';
import { consumeNativeOAuthCallback } from '../../src/services/nativeOAuthHandoff';

export default function NativeOAuthCallback() {
  const router = useRouter();
  const { identity } = useAuth();
  const params = useLocalSearchParams<{ code?: string; error?: string; state?: string; provider?: string; redirect?: string; generation?: string }>();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const rawUrl = useMemo(() => {
    if (!params.redirect) return '';
    const query = new URLSearchParams();
    for (const key of ['code', 'error', 'state', 'provider', 'redirect', 'generation'] as const) {
      const value = params[key];
      if (typeof value === 'string') query.set(key, value);
    }
    return `${params.redirect}?${query.toString()}`;
  }, [params.code, params.error, params.generation, params.provider, params.redirect, params.state]);

  useEffect(() => {
    if (!identity) {
      setResult({ ok: false, message: '登录账号已变化；已拒绝此前账号发起的 OAuth callback。' });
      return;
    }
    void consumeNativeOAuthCallback(rawUrl, identity)
      .then(value => setResult(value.status === 'succeeded'
        ? { ok: true, message: `${value.connectorId} 已完成授权；返回个人设置后会重新校验资源可用性。` }
        : { ok: false, message: `授权未完成：${value.errorCode ?? 'OAUTH_AUTHORIZATION_FAILED'}；可以重新发起授权。` }))
      .catch(error => setResult({ ok: false, message: `${error instanceof Error ? error.message : 'OAuth 安全回跳失败'}；可以重新发起授权。` }));
  }, [identity, rawUrl]);

  return <View style={styles.container}>
    <Stack.Screen options={{ title: '连接与授权' }} />
    {!result ? <><ActivityIndicator /><Text style={styles.message}>正在校验一次性安全回跳…</Text></> : <>
      <Text style={[styles.title, result.ok ? styles.success : styles.error]}>{result.ok ? '授权已校验' : '授权未完成'}</Text>
      <Text style={styles.message}>{result.message}</Text>
      <Pressable style={styles.button} onPress={() => router.replace('/(tabs)/settings')}><Text style={styles.buttonText}>返回设置</Text></Pressable>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 28, backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: '700' }, success: { color: '#047857' }, error: { color: '#b91c1c' },
  message: { textAlign: 'center', color: '#475569', lineHeight: 22 },
  button: { marginTop: 8, borderRadius: 10, backgroundColor: '#111827', paddingHorizontal: 18, paddingVertical: 12 },
  buttonText: { color: '#fff', fontWeight: '600' },
});
