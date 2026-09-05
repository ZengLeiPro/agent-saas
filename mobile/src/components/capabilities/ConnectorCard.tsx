/**
 * 连接器目录卡 —— 对齐 Web `CapabilityCenter/CatalogUi.tsx` 的 `ConnectorCatalogCard`：
 * 名称 + 状态徽标 + 一行说明 + 右侧主动作。
 *
 * 状态与按钮文案全部来自 `lib/capabilities/connectorStatus.ts`（纯函数，有单测），
 * 卡片本身不做任何状态推断。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Badge, Button } from '../ui';
import { radius, spacing, typography, useColors } from '../../theme';
import { connectorStatusTone, type ConnectorStatus } from '../../lib/capabilities/connectorStatus';

export interface ConnectorCardProps {
  name: string;
  description: string;
  status: ConnectorStatus;
  statusLabel: string;
  actionLabel: string;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
  /** 次要动作（如已连接时的「断开」） */
  secondaryLabel?: string;
  onSecondaryPress?: () => void;
  /** 错误 / 降级说明；有值时以危险色呈现在卡底 */
  notice?: string | null;
  testID?: string;
}

const TONE_VARIANT = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  muted: 'secondary',
} as const;

export function ConnectorCard({
  name,
  description,
  status,
  statusLabel,
  actionLabel,
  busy = false,
  disabled = false,
  onPress,
  secondaryLabel,
  onSecondaryPress,
  notice,
  testID,
}: ConnectorCardProps) {
  const colors = useColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        card: {
          backgroundColor: colors.card,
          borderRadius: radius.xl,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          padding: spacing.lg,
          gap: spacing.sm,
        },
        row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
        name: { ...typography.subtitle, color: colors.foreground, flex: 1 },
        description: { ...typography.caption, color: colors.mutedForeground },
        notice: { ...typography.caption, color: colors.destructive },
        actions: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'flex-end' },
      }),
    [colors],
  );

  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.row}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Badge label={statusLabel} size="sm" variant={TONE_VARIANT[connectorStatusTone(status)]} />
      </View>
      <Text style={styles.description}>{description}</Text>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <View style={styles.actions}>
        {secondaryLabel && onSecondaryPress ? (
          <Button
            label={secondaryLabel}
            variant="outline"
            size="sm"
            disabled={busy}
            onPress={onSecondaryPress}
            testID={testID ? `${testID}-secondary` : undefined}
          />
        ) : null}
        <Button
          label={actionLabel}
          variant="primary"
          size="sm"
          loading={busy}
          disabled={disabled}
          onPress={onPress}
          testID={testID ? `${testID}-action` : undefined}
        />
      </View>
    </View>
  );
}
