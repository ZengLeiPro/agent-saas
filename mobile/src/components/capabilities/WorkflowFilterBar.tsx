/**
 * 工作流目录筛选条 —— 对齐 Web `ScenariosPanel` 的筛选区，
 * 小屏收敛为三行横向 Chip：行业 → 垂直行业 → 岗位。
 *
 * 垂直行业选项跟随当前行业收敛（`verticalOptionsFor`），行业切换后
 * 由父级重置垂直选择，避免出现「选了筛选却零结果」的死态。
 */
import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { IndustryType } from '@agent/shared';
import { Chip } from '../ui';
import { spacing, typography, useColors } from '../../theme';
import {
  FILTER_ALL,
  INDUSTRY_OPTIONS,
  type WorkflowFilterState,
} from '../../lib/capabilities/workflowFilters';

export interface WorkflowFilterBarProps {
  filters: WorkflowFilterState;
  verticalOptions: readonly string[];
  roleOptions: ReadonlyArray<{ id: string; name: string }>;
  onChange: (next: WorkflowFilterState) => void;
}

export function WorkflowFilterBar({
  filters,
  verticalOptions,
  roleOptions,
  onChange,
}: WorkflowFilterBarProps) {
  const colors = useColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { gap: spacing.sm },
        label: { ...typography.meta, color: colors.mutedForeground, paddingLeft: spacing.xs },
        row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
      }),
    [colors],
  );

  return (
    <View style={styles.wrap} testID="workflow-filter-bar">
      <Text style={styles.label}>行业</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.row}>
          <Chip
            label="全部行业"
            selected={filters.industry === FILTER_ALL}
            onPress={() => onChange({ ...filters, industry: FILTER_ALL, vertical: FILTER_ALL })}
            testID="workflow-filter-industry-all"
          />
          {INDUSTRY_OPTIONS.map((option) => (
            <Chip
              key={option.value}
              label={option.label}
              selected={filters.industry === option.value}
              onPress={() =>
                onChange({
                  ...filters,
                  industry: option.value as IndustryType,
                  vertical: FILTER_ALL,
                })
              }
              testID={`workflow-filter-industry-${option.value}`}
            />
          ))}
        </View>
      </ScrollView>

      {verticalOptions.length > 0 ? (
        <>
          <Text style={styles.label}>垂直行业</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.row}>
              <Chip
                label="不限"
                selected={filters.vertical === FILTER_ALL}
                onPress={() => onChange({ ...filters, vertical: FILTER_ALL })}
                testID="workflow-filter-vertical-all"
              />
              {verticalOptions.map((option) => (
                <Chip
                  key={option}
                  label={option}
                  selected={filters.vertical === option}
                  onPress={() => onChange({ ...filters, vertical: option })}
                />
              ))}
            </View>
          </ScrollView>
        </>
      ) : null}

      {roleOptions.length > 0 ? (
        <>
          <Text style={styles.label}>岗位</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.row}>
              <Chip
                label="全部岗位"
                selected={filters.role === FILTER_ALL}
                onPress={() => onChange({ ...filters, role: FILTER_ALL })}
                testID="workflow-filter-role-all"
              />
              {roleOptions.map((role) => (
                <Chip
                  key={role.id}
                  label={role.name}
                  selected={filters.role === role.id}
                  onPress={() => onChange({ ...filters, role: role.id })}
                />
              ))}
            </View>
          </ScrollView>
        </>
      ) : null}
    </View>
  );
}
