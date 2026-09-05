/**
 * 自定义 MCP 服务器目录 —— 由 `app/settings/connections.tsx` 迁入
 * （旧路由已删除并在 V1 清单记墓碑），对齐 Web `McpManager` embedded 模式里
 * 「我的连接器」那一段：列出带 OAuth 的 MCP server，按 Grant 权威显示连接态，
 * 连接走 `startMyMcpOAuth`，撤销走 governance 的影响预览 + 撤销两步。
 *
 * 安全边界保持不变：
 * - 授权前先过 `hydrateMobileCapability` 能力闸；
 * - `beginNativeOAuthTransaction` 依赖本构建的可信 callback allowlist，
 *   生产 profile 为空（release-manifest `oauthCallback.enabled.production=false`），
 *   此时不发起授权，直接提示到 Web 端完成；
 * - 撤销必须先取权威影响预览，有 blocker 一律阻止。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { fetchMyMcp, startMyMcpOAuth, type McpServerSummary } from '@agent/shared';
import { governanceAccessApi, type OAuthGrantResponse } from '@agent/shared/lib/governanceApi';
import { ConnectorCard } from './ConnectorCard';
import { EmptyState } from '../ui';
import { EntityIcons } from '../../lib/icons';
import { spacing, typography, useColors } from '../../theme';
import { resolveCredentialConnectorStatus } from '../../lib/capabilities/connectorStatus';
import { connectorStatusLabel } from '../../lib/capabilities/connectorStatus';
import { nativeOAuthRedirectAvailable } from '../../hooks/useCredentialConnectors';
import {
  beginNativeOAuthTransaction,
  cancelNativeOAuthTransaction,
} from '../../services/nativeOAuthHandoff';
import { hydrateMobileCapability } from '../../services/authConnectionCapabilityAdapter';
import { useAuth } from '../../contexts/AuthContext';

const OAUTH_DEGRADED_NOTICE = '本次发布未开放原生授权回跳，请在 Web 端完成该连接器授权。';
/** 授权成功后的回跳落地页：与本页路由一致，用户完成授权后回到同一处。 */
const RETURN_PATH = '/capabilities/connectors';

function assertHttps(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('OAuth authorization URL 必须使用 HTTPS');
  return parsed.toString();
}

export function McpConnectorList() {
  const colors = useColors();
  const { identity } = useAuth();
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [grants, setGrants] = useState<OAuthGrantResponse['grants']>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const redirectAvailable = nativeOAuthRedirectAvailable();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { gap: spacing.md },
        heading: { ...typography.heading, color: colors.foreground },
        description: { ...typography.caption, color: colors.mutedForeground },
        error: { ...typography.caption, color: colors.destructive },
        center: { paddingVertical: spacing['2xl'], alignItems: 'center' },
      }),
    [colors],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [mcp, grantResult] = await Promise.all([
        fetchMyMcp(),
        governanceAccessApi.listOAuthGrants(),
      ]);
      setServers(mcp.servers.filter((server) => server.oauth));
      setGrants(grantResult.grants);
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接器列表加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = useCallback(
    async (server: McpServerSummary) => {
      if (!redirectAvailable) {
        Alert.alert('请在 Web 端完成授权', OAUTH_DEGRADED_NOTICE);
        return;
      }
      setBusyId(server.id);
      try {
        if (!identity) throw new Error('必须先登录才能发起 OAuth');
        const hydrated = await hydrateMobileCapability({
          userId: identity.userId,
          tenantId: identity.tenantId,
          provider: server.id,
          channel: 'mobile',
          operation: 'connection',
        });
        if (hydrated.status.mode !== 'normal') {
          throw new Error(`${hydrated.presentation.title}：${hydrated.presentation.detail}`);
        }
        const binding = await beginNativeOAuthTransaction(server.id, identity);
        const started = await startMyMcpOAuth(server.id, RETURN_PATH, binding);
        if (started.status === 'connected') {
          await cancelNativeOAuthTransaction();
          await load();
          return;
        }
        if (
          !started.authorizationUrl ||
          !started.requestedScopes?.length ||
          !started.purpose ||
          !started.dataDestination ||
          !started.revokeMethod
        ) {
          throw new Error('OAuth scope 预览或 authorization URL 不可用');
        }
        const authorizationUrl = assertHttps(started.authorizationUrl);
        Alert.alert(
          '确认授权范围',
          `${started.purpose}\n\n风险：高影响长期授权\n数据去向：${started.dataDestination}\n撤销：${started.revokeMethod}\n\n申请范围：\n${started.requestedScopes.join('\n')}`,
          [
            {
              text: '取消',
              style: 'cancel',
              onPress: () => {
                void cancelNativeOAuthTransaction();
              },
            },
            {
              text: '前往授权',
              onPress: () => {
                void Linking.openURL(authorizationUrl);
              },
            },
          ],
        );
      } catch (err) {
        await cancelNativeOAuthTransaction();
        Alert.alert('授权未启动', err instanceof Error ? err.message : '连接器授权启动失败');
      } finally {
        setBusyId(null);
      }
    },
    [identity, load, redirectAvailable],
  );

  const revoke = useCallback(
    async (grantId: string, label: string) => {
      setBusyId(grantId);
      try {
        const preview = await governanceAccessApi.previewOAuthGrantRevocation(
          grantId,
          'native_user_request',
        );
        if (preview.impact.blockers.length) {
          Alert.alert('当前不能撤销', preview.impact.blockers.join('\n'));
          return;
        }
        const details = [
          `${label} 将立即不可用于新 Run。`,
          preview.impact.affectedAgents.length
            ? `受影响 Agent：${preview.impact.affectedAgents.length}`
            : '',
          preview.impact.affectedAutomations.length
            ? `受影响自动化：${preview.impact.affectedAutomations.length}`
            : '',
          ...preview.impact.warnings,
        ]
          .filter(Boolean)
          .join('\n');
        Alert.alert('确认撤销授权', details, [
          { text: '取消', style: 'cancel' },
          {
            text: '撤销',
            style: 'destructive',
            onPress: async () => {
              setBusyId(grantId);
              try {
                await governanceAccessApi.revokeOAuthGrant(grantId, {
                  reason: 'native_user_request',
                  previewId: preview.previewId,
                  baselineDigest: preview.baselineDigest,
                  expiresAt: preview.expiresAt,
                  expectedVersion: preview.impact.currentVersion,
                });
                await load();
              } catch (err) {
                Alert.alert('撤销失败', err instanceof Error ? err.message : '授权撤销失败');
              } finally {
                setBusyId(null);
              }
            },
          },
        ]);
      } catch (err) {
        Alert.alert(
          '影响预览失败',
          err instanceof Error ? err.message : '无法获取权威影响，已阻止撤销',
        );
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>自定义 MCP 服务器</Text>
      <Text style={styles.description}>
        组织为你开放的 MCP 连接器；授权与撤销都以服务端 OAuth Grant 为权威记录。
      </Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {loading && servers.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : servers.length === 0 ? (
        <EmptyState icon={EntityIcons.connector} title="暂无可用的自定义 MCP 服务器" />
      ) : (
        servers.map((server) => {
          const grant = grants.find(
            (item) => item.connectorId === server.id && item.status !== 'revoked',
          );
          const connected = grant?.status === 'active';
          const legacyWithoutGrant = server.oauth?.status === 'connected' && !grant;
          const status = resolveCredentialConnectorStatus({
            loading: false,
            status: connected ? 'connected' : 'disconnected',
            runtimeEnabled: true,
            available: server.oauth?.platformConfigured !== false,
          });
          const notice = !server.oauth?.platformConfigured
            ? '平台尚未配置该连接器 OAuth'
            : legacyWithoutGrant
              ? 'OAuth Grant 权威记录不可用，已阻止客户端自行操作'
              : !connected && !redirectAvailable
                ? OAUTH_DEGRADED_NOTICE
                : null;
          return (
            <ConnectorCard
              key={server.id}
              name={server.name}
              description={server.oauth?.provider ?? 'MCP 连接器'}
              status={status}
              statusLabel={connectorStatusLabel(status)}
              actionLabel={connected ? '撤销' : grant ? '重新连接' : '连接'}
              busy={busyId === server.id || busyId === grant?.grantId}
              disabled={
                !server.oauth?.platformConfigured ||
                legacyWithoutGrant ||
                (!connected && !redirectAvailable)
              }
              notice={notice}
              onPress={() =>
                connected && grant ? void revoke(grant.grantId, server.name) : void connect(server)
              }
              testID={`connector-card-mcp-${server.id}`}
            />
          );
        })
      )}
    </View>
  );
}
