import React, { useMemo, type MutableRefObject } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ChatSessionIndexItem } from '@agent/shared';
import { formatShortDate } from '@agent/shared';
import { SwipeableRow, type SwipeAction, type Swipeable } from './SwipeableRow';
import { AgentAvatar } from './AgentAvatar';
import { useColors, spacing, typography, radius } from '../theme';

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
}

export const SessionRow = React.memo(function SessionRow({ session, actions, openRowRef, onPress, enableBackGesture, showOwner, selectMode, selected, onSelectToggle, agentAvatar, agentAvatarVersion, agentAvatarUsername }: SessionRowProps) {
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
    subtitleRow: {
      flexDirection: 'row' as const,
      alignItems: 'center' as const,
      marginTop: 2,
    },
    sessionTime: {
      ...typography.caption,
      color: colors.mutedForeground,
    },
  }), [colors]);

  const hasAgentAvatar = agentAvatar !== undefined;
  const separatorLeft = spacing.sm + (selectMode ? 24 + spacing.sm : 0) + 42 + spacing.md;

  const avatarElement = hasAgentAvatar ? (
    <View style={styles.avatarWrap}>
      <AgentAvatar avatar={agentAvatar} username={agentAvatarUsername} size={42} version={agentAvatarVersion} />
    </View>
  ) : (
    <View style={styles.avatarCircle}>
      <Ionicons name="chatbubble" size={20} color={colors.primaryForeground} />
    </View>
  );

  const rowContent = (
    <Pressable
      style={({ pressed }) => [styles.sessionRow, pressed && styles.sessionRowPressed]}
      onPress={selectMode ? onSelectToggle : () => onPress(session.id)}
    >
      {selectMode && (
        <View style={[styles.checkbox, selected && styles.checkboxSelected]}>
          {selected && <Ionicons name="checkmark" size={16} color={colors.primaryForeground} />}
        </View>
      )}
      {avatarElement}
      <View style={styles.sessionContent}>
        <View style={styles.titleRow}>
          <Text style={styles.sessionTitle} numberOfLines={1}>
            {session.title || '新会话'}
          </Text>
          <Text style={styles.sessionTime}>
            {formatShortDate(session.updatedAt)}
          </Text>
        </View>
        {(session.preview || (showOwner && session.owner)) && (
          <View style={styles.subtitleRow}>
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
        )}
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
