/**
 * 内置连接器目录 —— 对齐 Web `CapabilityCenter/BuiltInConnectors.tsx`
 * 的 7 张卡与顺序：钉钉 / 飞书 / Notion / Google Workspace / 阿里云 / GitHub / X。
 *
 * 授权方式在原生端的分工：
 * - 钉钉 / 飞书 / Notion：服务端授权会话 + 轮询，只需把 authorizationUrl 交给
 *   系统浏览器，不依赖 OAuth 原生回跳，生产包可用；
 * - GitHub / X / 阿里云：粘贴凭据，凭据只经 shared `connectorsApi` 送到服务端，
 *   不落 AsyncStorage、不打日志；
 * - Google Workspace：需要原生 OAuth 回跳。生产 profile 的
 *   `oauthCallback.enabled.production=false`（release-manifest.json），
 *   因此这里**不自行打开生产 OAuth callback**，而是降级为「请在 Web 端完成授权」。
 */
import React, { useCallback } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { ConnectorCard } from './ConnectorCard';
import { showTextPrompt } from '../ui';
import { spacing, typography, useColors } from '../../theme';
import { connectorActionLabel, connectorStatusLabel } from '../../lib/capabilities/connectorStatus';
import { usePollingAuthConnector } from '../../hooks/usePollingAuthConnector';
import {
  useCredentialConnectors,
  type CredentialConnectorId,
} from '../../hooks/useCredentialConnectors';

const OAUTH_DEGRADED_NOTICE =
  '本次发布未开放原生授权回跳，请在 Web 端完成 Google Workspace 授权后回到 App 使用。';

export function BuiltInConnectorList() {
  const colors = useColors();
  const dws = usePollingAuthConnector('dws');
  const feishu = usePollingAuthConnector('feishu');
  const credentials = useCredentialConnectors();

  const openUrl = useCallback(async (url: string | null, failure: string) => {
    if (!url) {
      Alert.alert('授权未启动', failure);
      return;
    }
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      Alert.alert('授权未启动', '授权地址必须使用 HTTPS');
      return;
    }
    await Linking.openURL(parsed.toString());
  }, []);

  const promptSecret = useCallback(
    (options: { title: string; message: string; onConfirm: (value: string) => void }) => {
      showTextPrompt({
        title: options.title,
        message: options.message,
        placeholder: '粘贴凭据',
        secureTextEntry: true,
        autoCapitalize: 'none',
        confirmText: '连接',
        onConfirm: options.onConfirm,
      });
    },
    [],
  );

  const credentialCard = (
    id: CredentialConnectorId,
    name: string,
    onConnect: () => void,
    notice?: string | null,
    disabled?: boolean,
  ) => {
    const state = credentials.states[id];
    const connected = state.status === 'connected' || state.status === 'paused';
    return (
      <ConnectorCard
        key={id}
        name={name}
        description={state.detail}
        status={state.status}
        statusLabel={state.statusLabel}
        actionLabel={connected ? '断开连接' : connectorActionLabel(state.status)}
        busy={credentials.busyId === id}
        disabled={disabled || state.status === 'unavailable'}
        onPress={() => (connected ? void credentials.disconnect(id) : onConnect())}
        notice={notice ?? null}
        testID={`connector-card-${id}`}
      />
    );
  };

  const styles = StyleSheet.create({
    wrap: { gap: spacing.md },
    heading: { ...typography.heading, color: colors.foreground },
    description: { ...typography.caption, color: colors.mutedForeground },
    error: { ...typography.caption, color: colors.destructive },
  });

  const dwsConnected = dws.connections.find((item) => item.status === 'connected');
  const feishuConnected = feishu.connections.some((item) => item.status === 'connected');

  return (
    <View style={styles.wrap}>
      <Text style={styles.heading}>连接器</Text>
      <Text style={styles.description}>
        连接你的账号后，支持的 CLI、Shell 和 SDK 会在当前用户的独立运行环境中直接可用。
      </Text>
      {dws.error ? <Text style={styles.error}>{dws.error}</Text> : null}
      {feishu.error ? <Text style={styles.error}>{feishu.error}</Text> : null}
      {credentials.error ? <Text style={styles.error}>{credentials.error}</Text> : null}

      <ConnectorCard
        name="钉钉"
        description="钉钉工作台、文档、审批与消息能力（一个账号可连接多个组织）"
        status={dws.status}
        statusLabel={dws.statusLabel}
        actionLabel={connectorActionLabel(dws.status, {
          multiProfile: true,
          hasAnyConnection: dws.connections.length > 0,
          connectLabel: '连接钉钉',
        })}
        busy={dws.connecting || dws.busy}
        disabled={dws.status === 'unavailable'}
        onPress={() => {
          if (dws.status === 'authorizing') void dws.cancelAuthorization();
          else void dws.startConnection();
        }}
        secondaryLabel={dwsConnected ? '断开' : undefined}
        onSecondaryPress={
          dwsConnected ? () => void dws.disconnect(dwsConnected.profileId) : undefined
        }
        testID="connector-card-dws"
      />

      <ConnectorCard
        name="飞书"
        description="飞书文档、日历、审批与消息能力"
        status={feishu.status}
        statusLabel={feishu.statusLabel}
        actionLabel={connectorActionLabel(feishu.status, { connectLabel: '连接飞书' })}
        busy={feishu.connecting || feishu.busy}
        disabled={feishu.status === 'unavailable'}
        onPress={() => {
          if (feishu.status === 'authorizing') void feishu.cancelAuthorization();
          else if (feishuConnected) void feishu.disconnect();
          else void feishu.startConnection();
        }}
        testID="connector-card-feishu"
      />

      {credentialCard('notion', 'Notion', () => {
        void credentials.startNotion().then((url) => openUrl(url, 'Notion 授权地址不可用'));
      })}

      {credentialCard(
        'google-workspace',
        'Google Workspace',
        () => Alert.alert('请在 Web 端完成授权', OAUTH_DEGRADED_NOTICE),
        credentials.oauthRedirectAvailable ? null : OAUTH_DEGRADED_NOTICE,
        !credentials.oauthRedirectAvailable &&
          credentials.states['google-workspace'].status === 'disconnected',
      )}

      {credentialCard('aliyun', '阿里云', () => {
        showTextPrompt({
          title: '连接阿里云',
          message:
            '依次输入 AccessKey ID、AccessKey Secret 与地域 ID（如 cn-hangzhou），用换行分隔。',
          multiline: true,
          autoCapitalize: 'none',
          confirmText: '连接',
          onConfirm: (value) => {
            const [accessKeyId = '', accessKeySecret = '', regionId = ''] = value
              .split('\n')
              .map((line) => line.trim());
            void credentials.connectAliyunKeys({ accessKeyId, accessKeySecret, regionId });
          },
        });
      })}

      {credentialCard('github', 'GitHub', () => {
        promptSecret({
          title: '连接 GitHub',
          message: '粘贴 GitHub Personal Access Token（ghp_ / github_pat_ 开头）。',
          onConfirm: (token) => void credentials.connectGithubToken(token),
        });
      })}

      {credentialCard('x', 'X', () => {
        showTextPrompt({
          title: '连接 X',
          message: '依次输入 auth_token 与 ct0，用换行分隔。',
          multiline: true,
          autoCapitalize: 'none',
          confirmText: '连接',
          onConfirm: (value) => {
            const [authToken = '', ct0 = ''] = value.split('\n').map((line) => line.trim());
            void credentials.connectXCookies({ authToken, ct0 });
          },
        });
      })}
    </View>
  );
}

/** 供上层显示「未连接」占位文案时复用，避免各处自造状态字串。 */
export const connectorFallbackStatusLabel = connectorStatusLabel;
