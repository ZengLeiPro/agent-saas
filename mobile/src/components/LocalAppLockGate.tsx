import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useLocalAppLock } from '../contexts/LocalAppLockContext';
import { useColors } from '../theme';

export function LocalAppLockGate({ children }: { children: React.ReactNode }) {
  const lock = useLocalAppLock();
  const colors = useColors();
  return (
    <View style={styles.root}>
      {children}
      {lock.offlineShell ? (
        <View style={[styles.banner, { backgroundColor: colors.muted }]}>
          <Text style={{ color: colors.foreground }}>离线只读：已暂停发送、凭据刷新和实时连接；联网后需重新验证登录。</Text>
        </View>
      ) : null}
      {lock.locked ? (
        <View style={[styles.overlay, { backgroundColor: colors.background }]} accessibilityViewIsModal>
          <Text style={[styles.title, { color: colors.foreground }]}>Agent SaaS 已锁定</Text>
          <Text style={[styles.body, { color: colors.mutedForeground }]}>本地验证只解锁应用界面，不替代服务端登录。</Text>
          {lock.failure ? (
            <Text style={[styles.error, { color: colors.destructive }]}>验证未完成。可使用设备密码重试，或重新登录。</Text>
          ) : null}
          <TouchableOpacity
            style={[styles.primary, { backgroundColor: colors.primary }]}
            disabled={lock.promptInFlight}
            onPress={() => { void lock.unlock(); }}
          >
            {lock.promptInFlight ? <ActivityIndicator color={colors.primaryForeground} /> : (
              <Text style={{ color: colors.primaryForeground, fontWeight: '600' }}>使用生物识别或设备密码解锁</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondary} onPress={() => { void lock.reauthenticate(); }}>
            <Text style={{ color: colors.primary }}>重新登录</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  banner: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 50, paddingHorizontal: 16, paddingVertical: 10 },
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 100, alignItems: 'center', justifyContent: 'center', padding: 32 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 12 },
  body: { textAlign: 'center', lineHeight: 21, marginBottom: 24 },
  error: { textAlign: 'center', marginBottom: 16 },
  primary: { minHeight: 48, borderRadius: 12, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', width: '100%' },
  secondary: { padding: 16 },
});
