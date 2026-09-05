/**
 * 会话列表顶部 pill 行 —— 对齐 Web `MobileSessionList` 抽屉里的
 * 「能力中心 / 任务中心 / 文件 / 回收站」四枚 pill。
 *
 * 本批只解锁「回收站」；另外三枚渲染为禁用态占位（P3 解锁），
 * 不接 DEFERRED 路由，避免把未上线能力伪装成可点入口。
 */
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Chip } from '../ui';
import { EntityIcons } from '../../lib/icons';
import { spacing } from '../../theme';

export interface SessionPillRowProps {
  /** 回收站视图是否展开（选中态） */
  trashOpen: boolean;
  onToggleTrash: () => void;
}

/** P3 解锁：能力中心 / 任务中心 / 文件三枚 pill 先占位。 */
const DEFERRED_PILLS = [
  { key: 'capabilities', label: '能力中心', icon: EntityIcons.capabilityCenter },
  { key: 'cron', label: '任务中心', icon: EntityIcons.cron },
  { key: 'files', label: '文件', icon: EntityIcons.files },
] as const;

export function SessionPillRow({ trashOpen, onToggleTrash }: SessionPillRowProps) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: {
          paddingHorizontal: spacing.md,
          paddingBottom: spacing.sm,
        },
        content: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
        },
      }),
    [],
  );

  return (
    <View style={styles.wrap} testID="session-pill-row">
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.content}>
          {DEFERRED_PILLS.map((pill) => (
            <Chip
              key={pill.key}
              label={pill.label}
              icon={pill.icon}
              disabled
              testID={`session-pill-${pill.key}`}
              accessibilityLabel={`${pill.label}（暂未开放）`}
            />
          ))}
          <Chip
            label="回收站"
            icon={EntityIcons.trash}
            selected={trashOpen}
            onPress={onToggleTrash}
            testID="session-pill-trash"
          />
        </View>
      </ScrollView>
    </View>
  );
}
