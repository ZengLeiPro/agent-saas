import React, { useMemo, type MutableRefObject } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { MessageCircle, Check } from 'lucide-react-native';
import Animated from 'react-native-reanimated';
import type { ChatSessionIndexItem } from '@agent/shared';
import { formatShortDate, getSessionWaitingLabel } from '@agent/shared';
import { SwipeableRow, type SwipeAction, type Swipeable } from './SwipeableRow';
import { AgentAvatar } from './AgentAvatar';
import { StatusIcons, ICON_SIZE, ICON_STROKE } from '../lib/icons';
import { useSpinStyle } from './ui/motion';
import { useColors, spacing, typography, radius } from '../theme';

/** 未读红点直径（pt），对齐 Web `size-1.5`。 */
const UNREAD_DOT_SIZE = 6;

interface SessionRowProps {
  session: ChatSessionIndexItem;
  actions: SwipeAction[];
  openRowRef: MutableRefObject<Swipeable | null>;
  onPress: (id: string) => void;
  /** Allow native back gesture to take priority over row swipe. */
  enableBackGesture?: boolean;
  /** Show session owner username (admin "all users" view). */
  showOwner?: boolean;
  /** Multi-select mode */
  selectMode?: boolean;
  selected?: boolean;
  onSelectToggle?: () => void;
  /** Agent avatar info for this session's owner. */
  agentAvatar?: string;
  agentAvatarVersion?: number;
  agentAvatarUsername?: string;
  /**
   * 是否显示头像列（个人偏好 `showSessionListAvatar`，与 Web 同一份偏好）。
   * 关闭时整列不渲染，得到更紧凑的单行样式；缺省显示（见
   * `app/settings/appearance-layout.tsx` 里关于默认值差异的说明）。
   */
  showAvatar?: boolean;
}

export const SessionRow = React.memo(function SessionRow({ session, actions, openRowRef, onPress, enableBackGesture, showOwner, selectMode, selected, onSelectToggle, agentAvatar, agentAvatarVersion, agentAvatarUsername, showAvatar = true }: SessionRowProps) {
  const colors = useColors();

  const styles = useMemo(() => StyleSheet.create({
    swipeContainer: {
      overflow: 'hidden',
    },
    sessionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: 62,
      paddingLeft: spacing.md,
      paddingRight: spacing.md,
      paddingVertical: 10,
      backgroundColor: colors.card,
    },
    sessionRowPressed: {
      backgroundColor: colors.accent,
    },
    selectContainer: {
      overflow: 'hidden',
    },
    separator: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
    },
    checkbox: {
      width: 24,
      height: 24,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: colors.mutedForeground,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: spacing.sm,
    },
    checkboxSelected: {
      backgroundColor: colors.primary,
      borderColor: colors.primary,
    },
    avatarCircle: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: spacing.md,
    },
    avatarWrap: {
      marginRight: spacing.md,
    },
    sessionContent: {
      flex: 1,
      paddingRight: spacing.sm,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    sessionTitle: {
      ...typography.body,
      color: colors.foreground,
      fontWeight: '500',
      flex: 1,
      marginRight: spacing.sm,
    },

    sessionPreview: {
      ...typography.caption,
      color: colors.mutedForeground,
      marginTop: 2,
      flex: 1,
    },
    ownerName: {
      ...typography.caption,
      color: colors.primary,
      fontWeight: '500',
      marginTop: 2,
      marginRight: spacing.sm,
    },
    targetName: {
      ...typography.caption,
      color: colors.primary,
      fontWeight: '600',
      marginRight: spacing.sm,
    },
    subtitleRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      marginTop: 2,
    },
    sessionTime: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
    waitingLabel: {
      ...typography.caption,
      color: colors.warning,
      fontWeight: '500',
    },
    unreadDot: {
      width: UNREAD_DOT_SIZE,
      height: UNREAD_DOT_SIZE,
      borderRadius: UNREAD_DOT_SIZE / 2,
      backgroundColor: colors.destructive,
      marginRight: spacing.xs,
    },
  }), [colors]);

  const waitingLabel = getSessionWaitingLabel(session.runtimeStatus);
  const isRunning = session.isRunning === true && !waitingLabel;
  const spinStyle = useSpinStyle(isRunning);

  const hasAgentAvatar = agentAvatar !== undefined;
  const targetLabel = session.agentTargetSnapshot?.name ?? '绑定不可验证';
  const separatorLeft =
    spacing.sm + (selectMode ? 24 + spacing.sm : 0) + (showAvatar ? 42 + spacing.md : 0);

  const avatarElement = !showAvatar ? null : hasAgentAvatar ? (
    <View style={styles.avatarWrap}>
      <AgentAvatar avatar={agentAvatar} username={agentAvatarUsername} size={42} version={agentAvatarVersion} />
    </View>
  ) : (
    <View style={styles.avatarCircle}>
      <MessageCircle size={20} color={colors.primaryForeground} strokeWidth={2} />
    </View>
  );

  const rowContent = (
    <Pressable
      testID={session.id}
      accessibilityLabel={`会话：${session.title || '新会话'}`}
      accessibilityRole="button"
      style={({ pressed }) => [styles.sessionRow, pressed && styles.sessionRowPressed]}
      onPress={selectMode ? onSelectToggle : () => onPress(session.id)}
    >
      {selectMode && (
        <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
          {selected && <Check size={16} color={colors.primaryForeground} strokeWidth={2} />}
        </View>
      )}
      {avatarElement}
      <View style={styles.sessionContent}>
        <View style={styles.titleRow}>
          {session.hasUnreadAiReply === true && (
            <View style={styles.unreadDot} accessibilityLabel="有未读回复" />
          )}
          <Text style={styles.sessionTitle} numberOfLines={1} testID={`${session.id}-title`}>
            {session.title || '新会话'}
          </Text>
          {waitingLabel ? (
            <Text style={styles.waitingLabel} accessibilityLabel={`会话${waitingLabel}`}>
              {waitingLabel}
            </Text>
          ) : isRunning ? (
            <Animated.View style={spinStyle} accessibilityLabel="会话运行中">
              <StatusIcons.running
                size={ICON_SIZE.inline}
                color={colors.statusIcon.info}
                strokeWidth={ICON_STROKE.default}
              />
            </Animated.View>
          ) : (
            <Text style={styles.sessionTime}>
              {formatShortDate(session.updatedAt)}
            </Text>
          )}
        </View>
        <View style={styles.subtitleRow}>
            <Text style={styles.targetName} numberOfLines={1}>{targetLabel}</Text>
            {showOwner && session.owner && (
              <Text style={styles.ownerName} numberOfLines={1}>
                {session.owner.realName || session.owner.username}
              </Text>
            )}
            {session.preview && (
              <Text style={styles.sessionPreview} numberOfLines={1}>
                {session.preview}
              </Text>
            )}
          </View>
      </View>
      <View style={[styles.separator, { left: separatorLeft }]} />
    </Pressable>
  );

  if (selectMode) {
    return <View style={styles.selectContainer}>{rowContent}</View>;
  }

  return (
    <SwipeableRow
      actions={actions}
      openRowRef={openRowRef}
      containerStyle={styles.swipeContainer}
      enableBackGesture={enableBackGesture}
    >
      {rowContent}
    </SwipeableRow>
  );
}, (prev, next) => {
  return (
    prev.session.id === next.session.id &&
    prev.session.title === next.session.title &&
    prev.session.preview === next.session.preview &&
    prev.session.updatedAt === next.session.updatedAt &&
    prev.session.hasUnreadAiReply === next.session.hasUnreadAiReply &&
    prev.session.isRunning === next.session.isRunning &&
    prev.session.runtimeStatus === next.session.runtimeStatus &&
    prev.session.owner?.username === next.session.owner?.username &&
    prev.onPress === next.onPress &&
    prev.enableBackGesture === next.enableBackGesture &&
    prev.showOwner === next.showOwner &&
    prev.selectMode === next.selectMode &&
    prev.selected === next.selected &&
    prev.agentAvatar === next.agentAvatar &&
    prev.agentAvatarVersion === next.agentAvatarVersion
  );
});
