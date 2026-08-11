import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { fetchEffectiveResources } from "@agent/shared/lib/governanceApi";
import type { EffectiveResourceView } from "@agent/shared/types/governance";

import { radius, spacing, typography, useColors } from "../../src/theme";

export default function MyPermissionsScreen() {
  const colors = useColors();
  const [resources, setResources] = useState<EffectiveResourceView[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const styles = useMemo(() => StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.lg },
    card: { padding: spacing.lg, gap: spacing.sm, backgroundColor: colors.card, borderRadius: radius.lg },
    title: { ...typography.body, color: colors.foreground, fontWeight: "600" },
    result: { ...typography.body, color: colors.foreground },
    label: { ...typography.caption, color: colors.mutedForeground },
    error: { ...typography.body, color: colors.destructive, textAlign: "center" },
    retry: { alignSelf: "center", paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, backgroundColor: colors.primary, borderRadius: radius.md },
    retryText: { ...typography.body, color: colors.primaryForeground, fontWeight: "600" },
  }), [colors]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setResources(await fetchEffectiveResources());
    } catch (err) {
      setResources([]);
      setError(err instanceof Error ? err.message : "权威权限视图加载失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (loading && !resources.length) return <View style={[styles.content, { flex: 1, justifyContent: "center" }]}><ActivityIndicator /></View>;
  if (error) return <View style={[styles.content, { flex: 1, justifyContent: "center" }]}><Text style={styles.error}>{error}</Text><TouchableOpacity style={styles.retry} onPress={() => void load()}><Text style={styles.retryText}>重试</Text></TouchableOpacity></View>;

  return (
    <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}>
      {resources.map(item => (
        <View key={`${item.resource.type}:${item.resource.id}`} style={styles.card}>
          <Text style={styles.title}>{item.resource.displayName}</Text>
          <Text style={styles.result}>{item.primaryResult.label}</Text>
          <Text style={styles.label}>决定因素：{item.decisiveFactor.label}</Text>
          <Text style={styles.label}>访问判定：{item.access.reason}</Text>
          <Text style={styles.label}>执行就绪：{item.readiness ? item.readiness.ready ? "已就绪" : item.readiness.blockers[0]?.message ?? "不可执行" : "权威数据不可用"}</Text>
        </View>
      ))}
      {!resources.length ? <View style={styles.card}><Text style={styles.title}>暂无可用资源</Text><Text style={styles.label}>当前没有权威资源结果；客户端不会自行推导权限。</Text></View> : null}
    </ScrollView>
  );
}
