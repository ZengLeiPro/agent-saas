import React, { useState, useRef, useCallback } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, ChevronDown } from 'lucide-react-native';
import { useColors } from '../../theme';
import { hapticLight } from '../../lib/haptics';
import { DropdownMenu, type DropdownSection } from '../overlays/DropdownMenu';
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
}

export function FormPickerRow({
  label,
  value,
  options,
  onChange,
  disabled,
  emptyLabel = '未选择',
  required,
}: FormPickerRowProps) {
  const colors = useColors();
  const current = options.find((o) => o.value === value);
  const displayLabel = current?.label ?? emptyLabel;

  const [menuVisible, setMenuVisible] = useState(false);
  const [anchorTop, setAnchorTop] = useState(0);
  const triggerRef = useRef<View>(null);

  const sections: DropdownSection[] = [{
    id: 'options',
    actions: options.map((o) => ({
      id: o.value,
      label: o.label,
      checked: o.value === value,
    })),
  }];

  const handleOpen = useCallback(() => {
    if (disabled) return;
    hapticLight();
    triggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setAnchorTop(y + h);
      setMenuVisible(true);
    });
  }, [disabled]);

  const handleSelect = useCallback((actionId: string) => {
    if (disabled) return;
    onChange(actionId);
  }, [disabled, onChange]);

  const content = (
    <View style={styles.row}>
      <Text style={[styles.value, { color: colors.mutedForeground }]} numberOfLines={1}>
        {displayLabel}
      </Text>
      {Platform.OS === 'ios' ? (
        <ChevronRight size={16} color={colors.mutedForeground} strokeWidth={2} style={styles.chevron} />
      ) : (
        <ChevronDown size={16} color={colors.mutedForeground} strokeWidth={2} style={styles.chevron} />
      )}
    </View>
  );

  return (
    <>
      <Pressable ref={triggerRef} onPress={handleOpen}>
        <FormRow label={label} disabled={disabled} required={required}>
          {content}
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
  },
  value: {
    fontSize: 16,
    flexShrink: 1,
    textAlign: 'right',
  },
  chevron: {
    marginLeft: 6,
  },
});
