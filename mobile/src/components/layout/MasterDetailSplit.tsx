/**
 * Generic list|detail split for md+ shells (chat / files / cron).
 * Phone callers keep their existing stack; this is only the wide layout chrome.
 */
import React, { useMemo } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useColors, fontScale, spacing } from '../../theme';
import { MASTER_LIST_WIDTH } from '../../lib/layoutDensity';

export type MasterDetailSplitProps = {
  master: React.ReactNode;
  detail: React.ReactNode | null;
  emptyLabel?: string;
  masterWidth?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function MasterDetailSplit({
  master,
  detail,
  emptyLabel = '请选择',
  masterWidth = MASTER_LIST_WIDTH,
  testID = 'master-detail-split',
  style,
}: MasterDetailSplitProps) {
  const colors = useColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        split: { flex: 1, flexDirection: 'row' },
        master: {
          width: masterWidth,
          maxWidth: '42%',
          borderRightWidth: StyleSheet.hairlineWidth,
          borderRightColor: colors.border,
          backgroundColor: colors.card,
        },
        detail: { flex: 1, backgroundColor: colors.background },
        empty: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
          backgroundColor: colors.background,
        },
        emptyText: { ...fontScale.base, color: colors.mutedForeground },
      }),
    [colors, masterWidth],
  );

  return (
    <View style={[styles.split, style]} testID={testID}>
      <View style={styles.master}>{master}</View>
      <View style={styles.detail}>
        {detail ?? (
          <View style={styles.empty} testID={`${testID}-empty`}>
            <Text style={styles.emptyText}>{emptyLabel}</Text>
          </View>
        )}
      </View>
    </View>
  );
}
