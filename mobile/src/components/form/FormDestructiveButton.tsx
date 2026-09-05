import React from 'react';
import { StyleSheet } from 'react-native';
import { spacing } from '../../theme';
import { Card } from '../ui/Card';
import { ListRow } from '../ui/ListRow';

interface FormDestructiveButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

/** 表单末尾的危险动作行：卡片底 + 红字，度量与其它表单行一致。 */
export function FormDestructiveButton({ label, onPress, disabled }: FormDestructiveButtonProps) {
  return (
    <Card flush style={styles.card}>
      <ListRow
        title={label}
        destructive
        disabled={disabled}
        showChevron={false}
        onPress={onPress}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing['2xl'],
  },
});
