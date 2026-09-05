import React, { useState, useRef, useCallback } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, ChevronDown } from 'lucide-react-native';
import { useColors, spacing, fontScale } from '../../theme';
import { ICON_SIZE, ICON_STROKE } from '../../lib/icons';
import { hapticLight } from '../../lib/haptics';
import { DropdownMenu, type DropdownSection } from '../overlays/DropdownMenu';
import type { ListRowPosition } from '../ui/listRowStyles';
import { FormRow } from './FormRow';

export interface PickerOption {
  value: string;
  label: string;
}

interface FormPickerRowProps {
  label: string;
  value: string;
  options: PickerOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  emptyLabel?: string;
  required?: boolean;
  position?: ListRowPosition;
}

/** 单选行：点开锚定在行下方的 DropdownMenu，选中项打勾。 */
export function FormPickerRow({
  label,
  value,
  options,
  onChange,
  disabled,
  emptyLabel = '未选择',
  required,
  position,
}: FormPickerRowProps) {
  const colors = useColors();
  const current = options.find((o) => o.value === value);
  const displayLabel = current?.label ?? emptyLabel;

  const [menuVisible, setMenuVisible] = useState(false);
  const [anchorTop, setAnchorTop] = useState(0);
  const triggerRef = useRef<View>(null);

  const sections: DropdownSection[] = [
    {
      id: 'options',
      actions: options.map((o) => ({ id: o.value, label: o.label, checked: o.value === value })),
    },
  ];

  const handleOpen = useCallback(() => {
    if (disabled) return;
    hapticLight();
    triggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setAnchorTop(y + h);
      setMenuVisible(true);
    });
  }, [disabled]);

  const handleSelect = useCallback(
    (actionId: string) => {
      if (disabled) return;
      onChange(actionId);
    },
    [disabled, onChange],
  );

  const Chevron = Platform.OS === 'ios' ? ChevronRight : ChevronDown;

  return (
    <>
      <Pressable ref={triggerRef} onPress={handleOpen}>
        <FormRow label={label} disabled={disabled} required={required} position={position}>
          <View style={styles.row}>
            <Text style={[styles.value, { color: colors.mutedForeground }]} numberOfLines={1}>
              {displayLabel}
            </Text>
            <Chevron
              size={ICON_SIZE.action}
              color={colors.mutedForeground}
              strokeWidth={ICON_STROKE.default}
            />
          </View>
        </FormRow>
      </Pressable>
      <DropdownMenu
        visible={menuVisible}
        onClose={() => setMenuVisible(false)}
        sections={sections}
        onSelect={handleSelect}
        anchorTop={anchorTop}
      />
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    justifyContent: 'flex-end',
    gap: spacing.xs,
  },
  value: {
    ...fontScale.base,
    flexShrink: 1,
    textAlign: 'right',
  },
});
