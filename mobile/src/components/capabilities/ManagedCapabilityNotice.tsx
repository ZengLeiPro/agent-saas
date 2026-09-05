/**
 * 「由组织统一配置」提示 —— 对齐 Web `CapabilityCenter/index.tsx` 的
 * `ManagedCapabilityNotice`：租户未开放个人通用 Agent 时，技能/连接器目录
 * 不给成员自助开关，只解释企业专家所需能力已由管理员配置。
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import { EmptyState } from '../ui';
import { EntityIcons } from '../../lib/icons';
import { spacing } from '../../theme';

export interface ManagedCapabilityNoticeProps {
  kind: '技能' | '连接器';
}

export function ManagedCapabilityNotice({ kind }: ManagedCapabilityNoticeProps) {
  return (
    <View style={styles.wrap} testID={`managed-capability-notice-${kind}`}>
      <EmptyState
        icon={kind === '技能' ? EntityIcons.skill : EntityIcons.connector}
        title={`${kind} 由组织统一配置`}
        description={`当前组织未开放个人通用 Agent。企业专家所需的 ${kind} 已由管理员配置，成员无需重复启用。`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.lg, paddingVertical: spacing['2xl'] },
});
