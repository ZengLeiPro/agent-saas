/**
 * Agent 目标选择（对齐 `web/src/components/OrgAgentPickerDialog.tsx`）。
 *
 * 与 Web 一样只列「可用」目标；目标来自 shared `AgentTargetCatalog`，
 * 不在客户端二次推断可用性。入口在会话页顶栏标题（testID `agent-target-picker`）。
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Check } from 'lucide-react-native';
import type { AgentTarget, AgentTargetCatalog, OrgAgentSummary } from '@agent/shared';
import { sameAgentTarget } from '@agent/shared';
import { BottomSheet, ListRow, ListRowGroup } from '../ui';
import { EntityIcons, ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { useColors, spacing, fontScale } from '../../theme';
import { listAgentTargetChoices } from '../../lib/agentTargetPresentation';

export interface OrgAgentPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  catalog: AgentTargetCatalog<OrgAgentSummary> | null;
  activeTarget: AgentTarget | null;
  onSelect: (target: AgentTarget) => void;
}

export function OrgAgentPickerSheet({
  visible,
  onClose,
  catalog,
  activeTarget,
  onSelect,
}: OrgAgentPickerSheetProps) {
  const colors = useColors();
  const choices = useMemo(() => listAgentTargetChoices(catalog), [catalog]);

  return (
    <BottomSheet
      testID="org-agent-picker-sheet"
      visible={visible}
      onClose={onClose}
      title="选择 Agent"
    >
      <View style={styles.body}>
        {choices.length === 0 ? (
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            暂无可用的 Agent，请联系组织管理员。
          </Text>
        ) : (
          <ListRowGroup>
            {choices.map((choice) => {
              const active = !!activeTarget && sameAgentTarget(activeTarget, choice.target);
              return (
                <ListRow
                  key={choice.actionId}
                  testID={choice.testID}
                  title={choice.label}
                  subtitle={choice.description}
                  icon={EntityIcons.expert}
                  showChevron={false}
                  accessory={
                    active ? (
                      <Check
                        size={ICON_SIZE.action}
                        color={colors.primary}
                        strokeWidth={ICON_STROKE.default}
                      />
                    ) : undefined
                  }
                  onPress={() => {
                    onClose();
                    if (!active) onSelect(choice.target);
                  }}
                />
              );
            })}
          </ListRowGroup>
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
  },
  empty: {
    ...fontScale.sm,
    paddingVertical: spacing.lg,
    textAlign: 'center',
  },
});
