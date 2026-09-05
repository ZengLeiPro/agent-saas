import React, { Children, cloneElement, isValidElement, useCallback } from 'react';
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { useColors, spacing, fontScale, fontWeight } from '../../theme';
import { ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { hapticLight } from '../../lib/haptics';
import type { ButtonIcon } from './Button';
import { Card } from './Card';
import { resolveListRowPosition, resolveListRowShape, type ListRowPosition } from './listRowStyles';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  /** 副标题最多显示的行数（默认 2；多行明细如权限解释可放宽） */
  subtitleLines?: number;
  /** 左侧语义图标（取自 `src/lib/icons.ts`） */
  icon?: ButtonIcon;
  /** 左侧自定义节点（头像等），优先于 icon */
  leading?: React.ReactNode;
  /** 打在标题 Text 上的 testID（E2E 需要按 id + 文本断言时使用） */
  titleTestID?: string;
  /** 右侧值文字（accessory / switch 未提供时生效） */
  value?: string;
  /** 右侧自定义控件（徽章、状态点等）；可与开关并存 */
  accessory?: React.ReactNode;
  /** 提供后右侧渲染开关；此时不显示 chevron */
  switchValue?: boolean;
  onSwitchChange?: (next: boolean) => void;
  switchDisabled?: boolean;
  /** 默认：可点击且非开关行时显示 */
  showChevron?: boolean;
  onPress?: () => void;
  /** 危险行：标题与图标转红 */
  destructive?: boolean;
  disabled?: boolean;
  /** 在分组中的位置，决定首尾圆角与分隔线 */
  position?: ListRowPosition;
  cornerRadius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

export function ListRow({
  title,
  subtitle,
  subtitleLines = 2,
  icon: Icon,
  leading,
  value,
  accessory,
  switchValue,
  onSwitchChange,
  switchDisabled,
  showChevron,
  titleTestID,
  onPress,
  destructive = false,
  disabled = false,
  position = 'only',
  cornerRadius,
  style,
  testID,
  accessibilityLabel,
}: ListRowProps) {
  const colors = useColors();
  const shape = resolveListRowShape(position, cornerRadius);
  const hasSwitch = switchValue !== undefined;
  const chevron = showChevron ?? (!!onPress && !hasSwitch);
  const titleColor = destructive ? colors.destructive : colors.foreground;

  const handlePress = useCallback(() => {
    hapticLight();
    onPress?.();
  }, [onPress]);

  const content = (
    <View style={[styles.row, disabled ? styles.disabled : null]}>
      {leading ??
        (Icon ? (
          <Icon
            size={ICON_SIZE.feature}
            color={destructive ? colors.destructive : colors.mutedForeground}
            strokeWidth={ICON_STROKE.default}
          />
        ) : null)}
      <View style={styles.labels}>
        <Text testID={titleTestID} style={[styles.title, { color: titleColor }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text
            style={[styles.subtitle, { color: colors.mutedForeground }]}
            numberOfLines={subtitleLines}
          >
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={styles.right}>
        {/* accessory 与开关可以并存（如「状态徽章 + 启停开关」）；value 只在两者都没有时兜底 */}
        {accessory}
        {hasSwitch ? (
          <Switch
            value={switchValue}
            disabled={switchDisabled || disabled}
            onValueChange={onSwitchChange}
            trackColor={{ false: colors.muted, true: colors.success }}
            thumbColor={colors.card}
            ios_backgroundColor={colors.muted}
          />
        ) : null}
        {!accessory && !hasSwitch && value ? (
          <Text style={[styles.value, { color: colors.mutedForeground }]} numberOfLines={1}>
            {value}
          </Text>
        ) : null}
        {chevron ? (
          <ChevronRight
            size={ICON_SIZE.action}
            color={colors.mutedForeground}
            strokeWidth={ICON_STROKE.default}
          />
        ) : null}
      </View>
    </View>
  );

  return (
    <View
      style={[
        {
          backgroundColor: colors.card,
          borderTopLeftRadius: shape.borderTopLeftRadius,
          borderTopRightRadius: shape.borderTopRightRadius,
          borderBottomLeftRadius: shape.borderBottomLeftRadius,
          borderBottomRightRadius: shape.borderBottomRightRadius,
        },
        style,
      ]}
    >
      {onPress ? (
        <Pressable
          testID={testID}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? title}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={handlePress}
          style={({ pressed }) => (pressed ? { backgroundColor: colors.accent } : null)}
        >
          {content}
        </Pressable>
      ) : (
        <View testID={testID} accessibilityLabel={accessibilityLabel}>
          {content}
        </View>
      )}
      {shape.showSeparator ? (
        <View style={[styles.separator, { backgroundColor: colors.border }]} />
      ) : null}
    </View>
  );
}

/** 右侧值文字的最大宽度，超出后截断而不是把标题挤走 */
const VALUE_MAX_WIDTH = 180;

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  disabled: {
    opacity: 0.5,
  },
  labels: {
    flex: 1,
    gap: 2,
  },
  title: {
    ...fontScale.base,
    fontWeight: fontWeight.regular,
  },
  subtitle: {
    ...fontScale.xs,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 1,
  },
  value: {
    ...fontScale.sm,
    flexShrink: 1,
    maxWidth: VALUE_MAX_WIDTH,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: spacing.lg,
  },
});

export interface ListRowGroupProps {
  children?: React.ReactNode;
  testID?: string;
}

/**
 * 行分组：把若干 ListRow 包成一张卡，并按序号自动下发 position
 * （首尾圆角 + 行间 hairline），调用点不必手工标注每一行的位置。
 */
export function ListRowGroup({ children, testID }: ListRowGroupProps) {
  const items = Children.toArray(children).filter(
    isValidElement,
  ) as React.ReactElement<ListRowProps>[];
  return (
    <Card flush testID={testID}>
      {items.map((child, index) =>
        cloneElement(child, {
          key: child.key ?? index,
          position: resolveListRowPosition(index, items.length),
        }),
      )}
    </Card>
  );
}
