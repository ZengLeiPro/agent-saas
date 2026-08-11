import { useEffect, useState } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { consumeNativeOAuthHandoff } from '../../src/services/nativeOAuthHandoff';

export default function NativeOAuthCallback() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    const code = typeof params.code === 'string' ? params.code : '';
    if (!/^[A-Za-z0-9_-]{48}$/.test(code)) {
      setResult({ ok: false, message: 'OAuth 回跳短码缺失或格式无效。' });
      return;
    }
    void consumeNativeOAuthHandoff(code)
      .then(value => setResult(value.status === 'succeeded'
        ? { ok: true, message: `${value.connectorId} 已完成授权；返回个人设置后会重新校验资源可用性。` }
        : { ok: false, message: `授权未完成：${value.errorCode ?? 'OAUTH_AUTHORIZATION_FAILED'}` }))
      .catch(error => setResult({ ok: false, message: error instanceof Error ? error.message : 'OAuth 安全回跳失败' }));
  }, [params.code]);

  return <View style={styles.container}>
    <Stack.Screen options={{ title: '连接与授权' }} />
    {!result ? <><ActivityIndicator /><Text style={styles.message}>正在校验一次性安全回跳…</Text></> : <>
      <Text style={[styles.title, result.ok ? styles.success : styles.error]}>{result.ok ? '授权已校验' : '授权未完成'}</Text>
      <Text style={styles.message}>{result.message}</Text>
      <Pressable style={styles.button} onPress={() => router.replace('/settings/connections')}><Text style={styles.buttonText}>返回连接与授权</Text></Pressable>
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
