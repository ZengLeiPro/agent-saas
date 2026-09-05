/**
 * 会话列表顶部 pill 行 —— 对齐 Web `MobileSessionList` 抽屉里的
 * 「能力中心 / 任务中心 / 文件 / 回收站」四枚 pill。
 *
 * P3-3a 起「能力中心」已解锁（`/capabilities`，在 V1 生产 allowlist 内）；
 * 「任务中心 / 文件」仍是禁用态占位，不接 DEFERRED 路由，
 * 避免把未上线能力伪装成可点入口。
 */
import React, { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Chip } from '../ui';
import { EntityIcons } from '../../lib/icons';
import { spacing } from '../../theme';

export interface SessionPillRowProps {
  /** 回收站视图是否展开（选中态） */
  trashOpen: boolean;
  onToggleTrash: () => void;
}

/** 仍待解锁：任务中心 / 文件两枚 pill 先占位（对应路由仍为 DEFERRED）。 */
const DEFERRED_PILLS = [
  { key: 'cron', label: '任务中心', icon: EntityIcons.cron },
  { key: 'files', label: '文件', icon: EntityIcons.files },
] as const;

export function SessionPillRow({ trashOpen, onToggleTrash }: SessionPillRowProps) {
  const router = useRouter();
  const openCapabilities = useCallback(() => {
    router.push('/capabilities');
  }, [router]);
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
          <Chip
            label="能力中心"
            icon={EntityIcons.capabilityCenter}
            onPress={openCapabilities}
            testID="session-pill-capabilities"
          />
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
