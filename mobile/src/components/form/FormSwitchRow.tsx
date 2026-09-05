import React from 'react';
import { ListRow } from '../ui/ListRow';
import type { ListRowPosition } from '../ui/listRowStyles';

interface FormSwitchRowProps {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  /** 行下方的补充说明 */
  description?: string;
  position?: ListRowPosition;
}

/**
 * 开关行 —— 直接复用 `ui/ListRow` 的开关形态，
 * 表单里的开关与设置页的开关从此是同一个组件、同一套度量。
 */
export function FormSwitchRow({
  label,
  value,
  onValueChange,
  disabled,
  description,
  position = 'only',
}: FormSwitchRowProps) {
  return (
    <ListRow
      title={label}
      subtitle={description}
      switchValue={value}
      onSwitchChange={onValueChange}
      switchDisabled={disabled}
      disabled={disabled}
      position={position}
    />
  );
}
