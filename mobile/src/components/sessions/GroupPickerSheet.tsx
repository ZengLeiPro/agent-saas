/**
 * 「添加到分组」底部面板 —— 对齐 Web `AddToGroupDialog`
 * （标题「添加到分组」，描述「选择一个分组或创建新分组」）。
 *
 * 用 `ui/BottomSheet` + `ui/ListRow` 呈现分组列表；「新建分组」由调用方用
 * `ui/TextPrompt` 的命令式入口接管（待归类会话要跨输入框保留）。
 */
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { FolderClosed, FolderPlus } from 'lucide-react-native';
import type { SessionGroup } from '@agent/shared';
import { BottomSheet, ListRow, ListRowGroup } from '../ui';
import { useColors, spacing, typography } from '../../theme';

export interface GroupPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  /** 已排序的全部分组（cron + manual） */
  groups: readonly SessionGroup[];
  onSelectGroup: (groupKey: string) => void;
  /** 点「新建分组」：由调用方弹输入框并保留待归类会话 */
  onCreateGroupRequested: () => void;
}

export function GroupPickerSheet({
  visible,
  onClose,
  groups,
  onSelectGroup,
  onCreateGroupRequested,
}: GroupPickerSheetProps) {
  const colors = useColors();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        description: {
          ...typography.caption,
          color: colors.mutedForeground,
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.sm,
        },
        body: { maxHeight: 360 },
        empty: {
          ...typography.bodySmall,
          color: colors.mutedForeground,
          textAlign: 'center',
          paddingVertical: spacing.lg,
        },
      }),
    [colors],
  );

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="添加到分组"
      snap="auto"
      testID="group-picker-sheet"
    >
      <Text style={styles.description}>选择一个分组或创建新分组</Text>
      <ScrollView style={styles.body}>
        <ListRowGroup>
          <ListRow
            title="新建分组"
            icon={FolderPlus}
            showChevron
            onPress={onCreateGroupRequested}
          />
          {groups.map((group) => (
            <ListRow
              key={group.groupKey}
              title={group.name}
              icon={FolderClosed}
              value={String(group.count)}
              subtitle={group.kind === 'cron' ? '定时任务分组' : undefined}
              onPress={() => onSelectGroup(group.groupKey)}
            />
          ))}
        </ListRowGroup>
        {groups.length === 0 && (
          <View>
            <Text style={styles.empty}>还没有分组，先新建一个吧</Text>
          </View>
        )}
      </ScrollView>
    </BottomSheet>
  );
}
