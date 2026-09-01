import {
  Boxes,
  Gauge,
  HeartHandshake,
  ShieldAlert,
  TrendingUp,
  Truck,
  UserPlus,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { OutcomeFilterValue } from './workflowUi';

/** 业务结果图标只用于快速辨识，不用颜色表达状态好坏。 */
export const OUTCOME_ICON: Record<Exclude<OutcomeFilterValue, 'all'>, LucideIcon> = {
  找客户: UserPlus,
  推进成交: TrendingUp,
  追回款: Wallet,
  保交付: Truck,
  控库存: Boxes,
  降客诉: HeartHandshake,
  提人效: Gauge,
  控风险: ShieldAlert,
};
