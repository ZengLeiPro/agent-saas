/**
 * ListRow 在分组卡片中的「首尾圆角 + hairline 分隔」纯规则。
 *
 * 对齐 Web `SettingsModal` 的分组行：整组是一张卡，只有第一行的上圆角与
 * 最后一行的下圆角被切出来，行与行之间用左缩进的 hairline 分隔，最后一行不带分隔线。
 */
import { radius } from '../../theme';

export type ListRowPosition = 'only' | 'first' | 'middle' | 'last';

/** 根据行序号与分组总行数判定位置；越界或空组一律按 'only' 处理。 */
export function resolveListRowPosition(index: number, count: number): ListRowPosition {
  if (count <= 1) return 'only';
  if (index <= 0) return 'first';
  if (index >= count - 1) return 'last';
  return 'middle';
}

export interface ListRowShape {
  borderTopLeftRadius: number;
  borderTopRightRadius: number;
  borderBottomLeftRadius: number;
  borderBottomRightRadius: number;
  /** 是否在该行下方绘制 hairline 分隔线 */
  showSeparator: boolean;
}

export function resolveListRowShape(
  position: ListRowPosition,
  cornerRadius: number = radius.lg,
): ListRowShape {
  const top = position === 'first' || position === 'only' ? cornerRadius : 0;
  const bottom = position === 'last' || position === 'only' ? cornerRadius : 0;
  return {
    borderTopLeftRadius: top,
    borderTopRightRadius: top,
    borderBottomLeftRadius: bottom,
    borderBottomRightRadius: bottom,
    showSeparator: position === 'first' || position === 'middle',
  };
}
