/**
 * Generic list|detail split for md+ shells (chat / files / cron).
 * Phone callers keep their existing stack; this is the wide layout chrome:
 * master list ~320–380 + floating main card (web DesktopLayout inset).
 * P4: `masterHidden` drops the list column so primary can stay ≥640.
 */
import React, { useMemo } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useColors, radius, shadows, spacing } from '../../theme';
import { FLOATING_MAIN_INSET, MASTER_LIST_WIDTH } from '../../lib/layoutDensity';
import { EmptyState } from '../ui';

export type MasterDetailSplitProps = {
  master: React.ReactNode;
  detail: React.ReactNode | null;
  emptyLabel?: string;
  emptyDescription?: string;
  masterWidth?: number;
  /** When true, omit the master column (protection / user collapse). */
  masterHidden?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

export function MasterDetailSplit({
  master,
  detail,
  emptyLabel = '请选择',
  emptyDescription,
  masterWidth = MASTER_LIST_WIDTH,
  masterHidden = false,
  testID = 'master-detail-split',
  style,
}: MasterDetailSplitProps) {
  const colors = useColors();
  const styles = useMemo(
    () =>
      StyleSheet.create({
        split: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
        master: {
          width: masterWidth,
          maxWidth: '42%',
          borderRightWidth: StyleSheet.hairlineWidth,
          borderRightColor: colors.border,
          backgroundColor: colors.card,
        },
        detailHost: {
          flex: 1,
          paddingVertical: FLOATING_MAIN_INSET,
          paddingRight: FLOATING_MAIN_INSET,
          paddingLeft: masterHidden ? FLOATING_MAIN_INSET : 0,
          backgroundColor: colors.background,
        },
        detailCard: {
          flex: 1,
          borderRadius: radius.xl,
          overflow: 'hidden',
          backgroundColor: colors.card,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: colors.border,
          ...shadows.card,
        },
        empty: {
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: spacing.lg,
        },
      }),
    [colors, masterWidth, masterHidden],
  );

  return (
    <View style={[styles.split, style]} testID={testID}>
      {masterHidden ? null : <View style={styles.master}>{master}</View>}
      <View style={styles.detailHost}>
        <View style={styles.detailCard}>
          {detail ?? (
            <View style={styles.empty} testID={`${testID}-empty`}>
              <EmptyState title={emptyLabel} description={emptyDescription} />
            </View>
          )}
        </View>
      </View>
    </View>
  );
}
