import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import {
  SANDBOX_PROFILE_OPTIONS,
  isSandboxProfileLocked,
  resolveSessionSandboxProfile,
  sandboxProfileLabel,
  type SandboxProfile,
} from '@agent/shared';
import { useColors, spacing, radius, fontScale, fontWeight } from '../../theme';
import { ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { ActionSheet } from '../ui';
import {
  resetDraftSandboxProfile,
  setDraftSandboxProfile,
  useDraftSandboxProfile,
} from '../../lib/sandboxProfileStore';

export interface SandboxProfileToggleProps {
  /** 已落地会话 id；为空表示新会话草稿态，此时才允许改档。 */
  sessionId?: string | null;
  /** 已落地会话的服务端档位（`ApiSessionListItem.sandboxProfile`），仅用于展示。 */
  sessionProfile?: SandboxProfile;
  loading?: boolean;
  disabled?: boolean;
}

/**
 * 运行环境（沙箱档位）切换（对齐 `web/src/components/ChatInput.tsx` 的 `profileLabel` 弹层）。
 *
 * - 新会话：显示并可改草稿档位，发送时由 `sendChatViaWs` 塞进 `target.sandboxProfile`；
 * - 已落地会话：档位已被服务端固化，只读展示，点击给出「当前会话使用 X 环境」提示。
 */
export function SandboxProfileToggle({
  sessionId,
  sessionProfile,
  loading,
  disabled,
}: SandboxProfileToggleProps) {
  const colors = useColors();
  const draftProfile = useDraftSandboxProfile();
  const [sheetOpen, setSheetOpen] = useState(false);
  const previousSessionIdRef = useRef<string | null | undefined>(sessionId);

  // 从已落地会话回到新会话草稿时，档位回到默认（Web `startNewSandboxProfile`）。
  useEffect(() => {
    if (previousSessionIdRef.current && !sessionId) resetDraftSandboxProfile();
    previousSessionIdRef.current = sessionId;
  }, [sessionId]);

  const locked = isSandboxProfileLocked({ sessionId, loading, disabled });
  const profile: SandboxProfile = sessionId
    ? resolveSessionSandboxProfile(sessionProfile)
    : draftProfile;
  const label = sandboxProfileLabel(profile);

  const actions = useMemo(
    () =>
      SANDBOX_PROFILE_OPTIONS.map((option) => ({
        label: option.value === profile ? `${option.label} ✓` : option.label,
        onPress: () => setDraftSandboxProfile(option.value),
      })),
    [profile],
  );

  const handlePress = useCallback(() => {
    if (locked) return;
    setSheetOpen(true);
  }, [locked]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        trigger: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.xs / 2,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
          borderRadius: radius.md,
        },
        locked: { opacity: 0.6 },
        label: {
          ...fontScale.xs,
          fontWeight: fontWeight.medium,
          color: colors.mutedForeground,
        },
      }),
    [colors],
  );

  return (
    <View>
      <Pressable
        testID="sandbox-profile-toggle"
        accessibilityRole="button"
        accessibilityState={{ disabled: locked }}
        accessibilityLabel={locked ? `当前会话使用${label}环境` : `运行环境：${label}`}
        disabled={locked}
        hitSlop={spacing.sm}
        onPress={handlePress}
        style={({ pressed }) => [
          styles.trigger,
          locked ? styles.locked : null,
          pressed && !locked ? { backgroundColor: colors.accent } : null,
        ]}
      >
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <ChevronDown
          size={ICON_SIZE.inline}
          color={colors.mutedForeground}
          strokeWidth={ICON_STROKE.default}
        />
      </Pressable>
      <ActionSheet
        testID="sandbox-profile-sheet"
        visible={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="运行环境"
        message="日常环境更轻更快；编程环境提供更强的工程工具链。会话建立后不可更改。"
        actions={actions}
      />
    </View>
  );
}
