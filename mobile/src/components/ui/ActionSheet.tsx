import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';
import { ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { hapticLight } from '../../lib/haptics';
import {
  registerActionMenuHandler,
  type ActionMenuItem,
  type ActionMenuOptions,
} from '../../lib/prompt';
import { BottomSheet } from './BottomSheet';

export type { ActionMenuItem, ActionMenuOptions };

export interface ActionSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  message?: string;
  actions: ActionMenuItem[];
  cancelText?: string;
  testID?: string;
}

/** 受控动作面板：底部滑出的动作列表，危险动作红字。 */
export function ActionSheet({
  visible,
  onClose,
  title,
  message,
  actions,
  cancelText = '取消',
  testID,
}: ActionSheetProps) {
  const colors = useColors();

  const run = useCallback(
    (action: ActionMenuItem) => {
      hapticLight();
      onClose();
      action.onPress();
    },
    [onClose],
  );

  return (
    <BottomSheet visible={visible} onClose={onClose} title={title} testID={testID}>
      <View style={styles.body}>
        {message ? (
          <Text style={[styles.message, { color: colors.mutedForeground }]}>{message}</Text>
        ) : null}
        {actions.map((action, index) => {
          const Icon = action.icon;
          const tint = action.destructive ? colors.destructive : colors.foreground;
          return (
            <Pressable
              key={`${action.label}-${index}`}
              testID={testID ? `${testID}-action-${index}` : undefined}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              disabled={action.disabled}
              onPress={() => run(action)}
              style={({ pressed }) => [
                styles.item,
                { backgroundColor: pressed ? colors.accent : colors.secondary },
                action.disabled ? styles.disabled : null,
              ]}
            >
              {Icon ? (
                <Icon size={ICON_SIZE.action} color={tint} strokeWidth={ICON_STROKE.default} />
              ) : null}
              <Text style={[styles.itemLabel, { color: tint }]} numberOfLines={1}>
                {action.label}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          testID={testID ? `${testID}-cancel` : undefined}
          accessibilityRole="button"
          accessibilityLabel={cancelText}
          onPress={onClose}
          style={({ pressed }) => [
            styles.item,
            styles.cancel,
            { backgroundColor: pressed ? colors.accent : colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.itemLabel, { color: colors.foreground }]}>{cancelText}</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

/**
 * 命令式宿主：由 `PromptHost` 挂载一次，接收 `showActionMenu(...)` 调用。
 * 复用 lib/prompt 的 handler 注册机制，不再另起一套 overlay 容器。
 */
export function ActionSheetHost() {
  const [opts, setOpts] = useState<ActionMenuOptions | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    registerActionMenuHandler((next) => {
      setOpts(next);
      setVisible(true);
    });
    return () => registerActionMenuHandler(null);
  }, []);

  const handleClose = useCallback(() => {
    setVisible(false);
    opts?.onCancel?.();
  }, [opts]);

  if (!opts) return null;

  return (
    <ActionSheet
      testID="action-sheet"
      visible={visible}
      onClose={handleClose}
      title={opts.title}
      message={opts.message}
      actions={opts.actions}
      cancelText={opts.cancelText}
    />
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    gap: spacing.sm,
  },
  message: {
    ...fontScale.sm,
    paddingBottom: spacing.xs,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    gap: spacing.sm,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg,
  },
  cancel: {
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.xs,
  },
  itemLabel: {
    ...fontScale.base,
    fontWeight: fontWeight.medium,
  },
  disabled: {
    opacity: 0.5,
  },
});
