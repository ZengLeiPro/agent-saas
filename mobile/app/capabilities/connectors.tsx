/**
 * 能力中心 · 连接器 —— 对齐 Web `CapabilityCenter/index.tsx` 的连接器页：
 * 开放个人通用 Agent 时 = 内置 7 张卡 + 自定义 MCP 服务器；
 * 未开放时只保留内置卡 + 「由组织统一配置」提示——内置协同办公连接跟随用户
 * workspace，企业专家会话同样使用，因此入口必须保留。
 */
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { BuiltInConnectorList } from '../../src/components/capabilities/BuiltInConnectorList';
import { CapabilityTabBar } from '../../src/components/capabilities/CapabilityTabBar';
import { ManagedCapabilityNotice } from '../../src/components/capabilities/ManagedCapabilityNotice';
import { McpConnectorList } from '../../src/components/capabilities/McpConnectorList';
import { useCapabilityContext } from '../../src/hooks/useCapabilityContext';
import { capabilityTabContent } from '../../src/lib/capabilities/capabilityTabs';
import { spacing, useColors } from '../../src/theme';

export default function CapabilityConnectorsScreen() {
  const colors = useColors();
  const { personalAgentEnabled } = useCapabilityContext();
  const content = capabilityTabContent('connectors', personalAgentEnabled);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        root: { flex: 1, backgroundColor: colors.background },
        content: { padding: spacing.lg, gap: spacing.xl },
      }),
    [colors],
  );

  return (
    <View style={styles.root}>
      <CapabilityTabBar active="connectors" personalAgentEnabled={personalAgentEnabled} />
      <ScrollView contentContainerStyle={styles.content}>
        <BuiltInConnectorList />
        {content === 'catalog' ? <McpConnectorList /> : <ManagedCapabilityNotice kind="连接器" />}
      </ScrollView>
    </View>
  );
}
