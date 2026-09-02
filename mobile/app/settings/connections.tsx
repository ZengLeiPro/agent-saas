import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import {
  fetchMyMcp,
  startGoogleWorkspaceOAuth,
  startMyMcpOAuth,
  type McpServerSummary,
} from "@agent/shared";
import { governanceAccessApi, type OAuthGrantResponse } from "@agent/shared/lib/governanceApi";

import { beginNativeOAuthTransaction, cancelNativeOAuthTransaction } from "../../src/services/nativeOAuthHandoff";
import { hydrateMobileCapability } from "../../src/services/authConnectionCapabilityAdapter";
import { useAuth } from "../../src/contexts/AuthContext";
import { radius, spacing, typography, useColors } from "../../src/theme";

function assertHttps(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("OAuth authorization URL 必须使用 HTTPS");
  return parsed.toString();
}

export default function ConnectionsScreen() {
  const colors = useColors();
  const { identity } = useAuth();
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [grants, setGrants] = useState<OAuthGrantResponse['grants']>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const styles = useMemo(() => StyleSheet.create({
    content: { padding: spacing.lg, gap: spacing.lg },
    card: { padding: spacing.lg, gap: spacing.md, backgroundColor: colors.card, borderRadius: radius.lg },
    title: { ...typography.body, color: colors.foreground, fontWeight: "600" },
    text: { ...typography.body, color: colors.foreground },
    muted: { ...typography.caption, color: colors.mutedForeground },
    error: { ...typography.body, color: colors.destructive },
    row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
    action: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.primary },
    actionText: { ...typography.caption, color: colors.primaryForeground, fontWeight: "600" },
    disconnect: { backgroundColor: colors.destructive },
  }), [colors]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [result, grantResult] = await Promise.all([fetchMyMcp(), governanceAccessApi.listOAuthGrants()]);
      setServers(result.servers.filter(server => server.oauth));
      setGrants(grantResult.grants);
    } catch (err) {
      setError(err instanceof Error ? err.message : "连接器列表加载失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const requireConnectionCapability = async (provider: string) => {
    if (!identity) throw new Error("必须先登录才能发起 OAuth");
    const hydrated = await hydrateMobileCapability({
      userId: identity.userId, tenantId: identity.tenantId, provider,
      channel: "mobile", operation: "connection",
    });
    if (hydrated.status.mode !== "normal") throw new Error(`${hydrated.presentation.title}：${hydrated.presentation.detail}`);
  };

  const connectGoogle = async () => {
    setBusyId("google-workspace");
    try {
      if (!identity) throw new Error("必须先登录才能发起 OAuth");
      await requireConnectionCapability("google-workspace");
      const binding = await beginNativeOAuthTransaction("google-workspace", identity);
      const started = await startGoogleWorkspaceOAuth(binding);
      const authorizationUrl = assertHttps(started.authorizationUrl);
      if (!started.requestedScopes.length || !started.purpose || !started.dataDestination || !started.revokeMethod) {
        throw new Error("OAuth scope 预览权威不可用");
      }
      Alert.alert("确认 Google Workspace 授权范围", `${started.purpose}\n\n风险：高影响长期授权\n数据去向：${started.dataDestination}\n撤销：${started.revokeMethod}\n\n${started.requestedScopes.join("\n")}`, [
        { text: "取消", style: "cancel", onPress: () => { void cancelNativeOAuthTransaction(); } },
        { text: "前往授权", onPress: () => { void Linking.openURL(authorizationUrl); } },
      ]);
    } catch (err) {
      await cancelNativeOAuthTransaction();
      Alert.alert("授权未启动", err instanceof Error ? err.message : "Google Workspace 授权启动失败");
    } finally {
      setBusyId(null);
    }
  };

  const connectMcp = async (server: McpServerSummary) => {
    setBusyId(server.id);
    try {
      if (!identity) throw new Error("必须先登录才能发起 OAuth");
      await requireConnectionCapability(server.id);
      const binding = await beginNativeOAuthTransaction(server.id, identity);
      const started = await startMyMcpOAuth(server.id, "/settings/connections", binding);
      if (started.status === "connected") { await cancelNativeOAuthTransaction(); await load(); }
      else if (started.authorizationUrl && started.requestedScopes?.length
        && started.purpose && started.dataDestination && started.revokeMethod) {
        const authorizationUrl = assertHttps(started.authorizationUrl);
        Alert.alert("确认授权范围", `${started.purpose}\n\n风险：高影响长期授权\n数据去向：${started.dataDestination}\n撤销：${started.revokeMethod}\n\n申请范围：\n${started.requestedScopes.join("\n")}`, [
          { text: "取消", style: "cancel", onPress: () => { void cancelNativeOAuthTransaction(); } },
          { text: "前往授权", onPress: () => { void Linking.openURL(authorizationUrl); } },
        ]);
      } else throw new Error("OAuth scope 预览或 authorization URL 不可用");
    } catch (err) {
      await cancelNativeOAuthTransaction();
      Alert.alert("授权未启动", err instanceof Error ? err.message : "连接器授权启动失败");
    } finally {
      setBusyId(null);
    }
  };

  const revokeGrant = async (grantId: string, label: string) => {
    setBusyId(grantId);
    try {
      const preview = await governanceAccessApi.previewOAuthGrantRevocation(grantId, "native_user_request");
      const details = [
        `${label} 将立即不可用于新 Run。`,
        preview.impact.affectedAgents.length ? `受影响 Agent：${preview.impact.affectedAgents.length}` : "",
        preview.impact.affectedAutomations.length ? `受影响自动化：${preview.impact.affectedAutomations.length}` : "",
        ...preview.impact.warnings,
      ].filter(Boolean).join("\n");
      if (preview.impact.blockers.length) {
        Alert.alert("当前不能撤销", preview.impact.blockers.join("\n"));
        return;
      }
      Alert.alert("确认撤销授权", details, [
        { text: "取消", style: "cancel" },
        { text: "撤销", style: "destructive", onPress: async () => {
          setBusyId(grantId);
          try {
            await governanceAccessApi.revokeOAuthGrant(grantId, {
              reason: "native_user_request",
              previewId: preview.previewId,
              baselineDigest: preview.baselineDigest,
              expiresAt: preview.expiresAt,
              expectedVersion: preview.impact.currentVersion,
            });
            await load();
          } catch (err) {
            Alert.alert("撤销失败", err instanceof Error ? err.message : "授权撤销失败");
          } finally {
            setBusyId(null);
          }
        } },
      ]);
    } catch (err) {
      Alert.alert("影响预览失败", err instanceof Error ? err.message : "无法获取权威影响，已阻止撤销");
    } finally {
      setBusyId(null);
    }
  };

  const googleGrant = grants.find(grant => grant.connectorId === "google-workspace" && grant.status !== "revoked");
  const googleConnected = googleGrant?.status === "active";

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <View style={styles.row}>
          <View style={{ flex: 1 }}><Text style={styles.title}>Google Workspace</Text><Text style={styles.muted}>{googleGrant?.status ?? "disconnected"} · 原生安全回跳绑定当前设备</Text></View>
          <TouchableOpacity
            style={[styles.action, googleConnected && styles.disconnect]}
            disabled={busyId !== null}
            onPress={() => googleConnected && googleGrant ? void revokeGrant(googleGrant.grantId, "Google Workspace") : void connectGoogle()}
          >
            <Text style={styles.actionText}>{busyId === googleGrant?.grantId || busyId === "google-workspace" ? "处理中…" : googleConnected ? "撤销" : googleGrant ? "重新连接" : "连接"}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {loading && !servers.length ? <ActivityIndicator /> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {servers.map(server => {
        const grant = grants.find(item => item.connectorId === server.id && item.status !== "revoked");
        const connected = grant?.status === "active";
        const legacyWithoutGrant = server.oauth?.status === "connected" && !grant;
        return (
          <View key={server.id} style={styles.card}>
            <View style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={styles.title}>{server.name}</Text>
                <Text style={styles.muted}>{server.oauth?.status ?? "disconnected"} · {server.oauth?.provider}</Text>
              </View>
              <TouchableOpacity
                style={[styles.action, connected && styles.disconnect]}
                disabled={busyId !== null || !server.oauth?.platformConfigured || legacyWithoutGrant}
                onPress={() => connected && grant ? void revokeGrant(grant.grantId, server.name) : void connectMcp(server)}
              >
                <Text style={styles.actionText}>{busyId === server.id || busyId === grant?.grantId ? "处理中…" : connected ? "撤销" : grant ? "重新连接" : "连接"}</Text>
              </TouchableOpacity>
            </View>
            {!server.oauth?.platformConfigured ? <Text style={styles.error}>平台尚未配置该连接器 OAuth</Text> : null}
            {legacyWithoutGrant ? <Text style={styles.error}>OAuth Grant 权威记录不可用，已阻止客户端自行操作</Text> : null}
          </View>
        );
      })}
    </ScrollView>
  );
}
