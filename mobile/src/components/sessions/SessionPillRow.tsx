/**
 * 会话列表顶部 pill 行 —— 对齐 Web `MobileSessionList` 抽屉里的
 * 「能力中心 / 任务中心 / 文件 / 回收站」四枚 pill。
 *
 * P3-3a 起「能力中心」已解锁；P3-3b 起「任务中心」解锁到 `/cron`；
 * P3-3c 起「文件」解锁到 `/files`（Stack 路由，不恢复第三个 Tab）。
 * 任务中心 / 文件的可见性口径与 Web 完全一致：
 *   任务中心 = `getSidebarNavItems`（personalAgentOnly）∩ `tenantFeatures.cronEnabled`
 *              ∩ V1 生产 allowlist；
 *   文件     = `tenantFeatures.filesEnabled` ∩ V1 生产 allowlist；
 * 任一不满足就整枚不渲染，而不是给一个点不动的入口。
 */
import React, { useCallback, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { DEFAULT_TENANT_SETTINGS } from '@agent/shared';
import { Chip } from '../ui';
import { EntityIcons } from '../../lib/icons';
import { spacing } from '../../theme';
import { useAuth } from '../../contexts/AuthContext';
import { useCapabilityContext } from '../../hooks/useCapabilityContext';
import { isCronEntryVisible } from '../../lib/cronEntry';
import { isFilesEntryVisible } from '../../lib/filesEntry';
import { isV1RouteAllowed } from '../../v1/v1Capabilities';
import { getV1BuildProfile } from '../../v1/v1Runtime';

export interface SessionPillRowProps {
  /** 回收站视图是否展开（选中态） */
  trashOpen: boolean;
  onToggleTrash: () => void;
}

export function SessionPillRow({ trashOpen, onToggleTrash }: SessionPillRowProps) {
  const router = useRouter();
  const { user } = useAuth();
  const { personalAgentEnabled } = useCapabilityContext();

  const openCapabilities = useCallback(() => {
    router.push('/capabilities');
  }, [router]);
  const openCron = useCallback(() => {
    router.push('/cron');
  }, [router]);
  const openFiles = useCallback(() => {
    router.push('/files');
  }, [router]);

  const cronVisible = useMemo(
    () =>
      isCronEntryVisible({
        isAdmin: user?.role === 'admin',
        personalAgentEnabled,
        cronEnabled: (user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features).cronEnabled,
        routeAllowed: isV1RouteAllowed('cron', getV1BuildProfile()),
      }),
    [user?.tenantFeatures, user?.role, personalAgentEnabled],
  );

  const filesVisible = useMemo(
    () =>
      isFilesEntryVisible({
        filesEnabled: (user?.tenantFeatures ?? DEFAULT_TENANT_SETTINGS.features).filesEnabled,
        routeAllowed: isV1RouteAllowed('files', getV1BuildProfile()),
      }),
    [user?.tenantFeatures],
  );

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
          {cronVisible ? (
            <Chip
              label="任务中心"
              icon={EntityIcons.cron}
              onPress={openCron}
              testID="session-pill-cron"
            />
          ) : null}
          {filesVisible ? (
            <Chip
              label="文件"
              icon={EntityIcons.files}
              onPress={openFiles}
              testID="session-pill-files"
            />
          ) : null}
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
