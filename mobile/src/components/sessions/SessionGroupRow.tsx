/**
 * 会话分组折叠行 —— 对齐 Web `MobileSessionList` 的 `renderGroupRow`。
 *
 * 行内元信息：分组类型图标 + 名称 + 聚合未读红点 + （等待人工文案 / 运行中转圈 /
 * 最近更新时间）+ 会话数徽标；行滑动动作集为「重命名 / 删除」。
 */
import React, { useMemo, type MutableRefObject } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Folder, Timer } from 'lucide-react-native';
import type { SessionGroup } from '@agent/shared';
import { formatShortDate, getSessionWaitingLabel } from '@agent/shared';
import { SwipeableRow, type SwipeAction, type Swipeable } from '../SwipeableRow';
import { StatusIcons, ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { useSpinStyle } from '../ui/motion';
import { useColors, spacing, typography } from '../../theme';

/** 与 SessionRow 一致的行高与头像尺寸，保证两类行在列表中对齐 */
const ROW_MIN_HEIGHT = 62;
const AVATAR_SIZE = 42;
const UNREAD_DOT_SIZE = 6;

export interface SessionGroupRowProps {
  group: SessionGroup;
  /** 分组内是否有未读 AI 回复（聚合红点） */
  unread?: boolean;
  /** 管理员「全部用户」视图下展示会话归属人 */
  showOwner?: boolean;
  /** 只读分组（管理员全部用户视图）时不挂滑动动作 */
  readOnly?: boolean;
  openRowRef: MutableRefObject<Swipeable | null>;
  onPress: (group: SessionGroup) => void;
  onRename: (group: SessionGroup) => void;
  onDelete: (group: SessionGroup) => void;
}

export function SessionGroupRow({
  group,
  unread = false,
  showOwner = false,
  readOnly = false,
  openRowRef,
  onPress,
  onRename,
  onDelete,
}: SessionGroupRowProps) {
  const colors = useColors();
  const waitingLabel = getSessionWaitingLabel(group.runtimeStatus);
  const isRunning = group.isRunning === true && !waitingLabel;
  const spinStyle = useSpinStyle(isRunning);
  const latestChild = group.children[0];

  const styles = useMemo(
    () =>
      StyleSheet.create({
        swipeContainer: { overflow: 'hidden' },
        row: {
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: ROW_MIN_HEIGHT,
          paddingHorizontal: spacing.md,
          paddingVertical: 10,
          backgroundColor: colors.card,
        },
        rowPressed: { backgroundColor: colors.secondary },
        avatar: {
          width: AVATAR_SIZE,
          height: AVATAR_SIZE,
          borderRadius: AVATAR_SIZE / 2,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: spacing.md,
          backgroundColor: group.kind === 'cron' ? colors.warning : colors.statusIcon.info,
        },
        content: { flex: 1 },
        titleRow: { flexDirection: 'row', alignItems: 'center' },
        unreadDot: {
          width: UNREAD_DOT_SIZE,
          height: UNREAD_DOT_SIZE,
          borderRadius: UNREAD_DOT_SIZE / 2,
          backgroundColor: colors.destructive,
          marginRight: spacing.xs,
        },
        name: {
          ...typography.body,
          color: colors.foreground,
          fontWeight: '500',
          flex: 1,
          marginRight: spacing.sm,
        },
        time: { ...typography.caption, color: colors.mutedForeground },
        waiting: { ...typography.caption, color: colors.warning, fontWeight: '500' },
        previewRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
        owner: {
          ...typography.caption,
          color: colors.primary,
          fontWeight: '500',
          marginRight: spacing.sm,
        },
        preview: {
          ...typography.caption,
          color: colors.mutedForeground,
          flex: 1,
          marginRight: spacing.sm,
        },
        countBadge: {
          minWidth: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: colors.muted,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: spacing.xs,
        },
        countText: { ...typography.meta, color: colors.mutedForeground, fontWeight: '600' },
        separator: {
          position: 'absolute',
          bottom: 0,
          left: spacing.sm + AVATAR_SIZE + spacing.md,
          right: 0,
          height: StyleSheet.hairlineWidth,
          backgroundColor: colors.border,
        },
      }),
    [colors, group.kind],
  );

  const actions = useMemo<SwipeAction[]>(
    () => [
      {
        key: 'rename',
        label: '重命名',
        backgroundColor: colors.actions.edit,
        color: colors.actions.onAction,
        onPress: () => onRename(group),
      },
      {
        key: 'delete',
        label: '删除',
        backgroundColor: colors.actions.destructive,
        color: colors.actions.onAction,
        onPress: () => onDelete(group),
      },
    ],
    [colors, group, onRename, onDelete],
  );

  const rowContent = (
    <Pressable
      testID={`group-${group.groupKey}`}
      accessibilityRole="button"
      accessibilityLabel={`分组：${group.name}`}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={() => onPress(group)}
    >
      <View style={styles.avatar}>
        {group.kind === 'cron' ? (
          <Timer size={20} color={colors.primaryForeground} strokeWidth={2} />
        ) : (
          <Folder size={20} color={colors.primaryForeground} strokeWidth={2} />
        )}
      </View>
      <View style={styles.content}>
        <View style={styles.titleRow}>
          {unread && <View style={styles.unreadDot} accessibilityLabel="分组内有未读回复" />}
          <Text style={styles.name} numberOfLines={1}>
            {group.name}
          </Text>
          {waitingLabel ? (
            <Text style={styles.waiting}>{waitingLabel}</Text>
          ) : isRunning ? (
            <Animated.View style={spinStyle} accessibilityLabel="分组内有运行中的会话">
              <StatusIcons.running
                size={ICON_SIZE.inline}
                color={colors.mutedForeground}
                strokeWidth={ICON_STROKE.default}
              />
            </Animated.View>
          ) : (
            <Text style={styles.time}>{formatShortDate(group.latestUpdatedAt)}</Text>
          )}
        </View>
        <View style={styles.previewRow}>
          {showOwner && latestChild?.owner && (
            <Text style={styles.owner} numberOfLines={1}>
              {latestChild.owner.realName || latestChild.owner.username}
            </Text>
          )}
          <Text style={styles.preview} numberOfLines={1}>
            {latestChild?.preview || latestChild?.title || ''}
          </Text>
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{group.count}</Text>
          </View>
        </View>
      </View>
      <View style={styles.separator} />
    </Pressable>
  );

  if (readOnly) return <View style={styles.swipeContainer}>{rowContent}</View>;

  return (
    <SwipeableRow actions={actions} openRowRef={openRowRef} containerStyle={styles.swipeContainer}>
      {rowContent}
    </SwipeableRow>
  );
}
