/**
 * 语义图标注册表 —— 与 Web `web/src/lib/icons.ts` 一比一对齐。
 *
 * 规范：
 * 1. 概念/导航/实体图标必须从本注册表按语义取用，一个概念永远一个图标；
 *    禁止业务组件为「概念级」图标自行 import lucide-react-native。
 * 2. 尺寸三档：14 行内/表格；16 按钮/菜单项（默认）；20 页面标题/feature。
 * 3. strokeWidth 全局默认 2，仅强调按钮允许 2.5。
 * 4. 运行状态四件套全站唯一：running / success / error / cancelled（+ pending）。
 */
import {
  Blocks,
  Bot,
  BrainCircuit,
  Building2,
  Calculator,
  ChartColumn,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash2,
  Clock,
  Coins,
  Columns3,
  Cpu,
  Files,
  Fingerprint,
  Info,
  Library,
  LayoutGrid,
  Loader2,
  MessageSquareText,
  Plug,
  Puzzle,
  Recycle,
  ScrollText,
  ServerCog,
  Settings2,
  ShieldCheck,
  SkipForward,
  Speech,
  Undo2,
  UserPlus,
  Users,
  WalletCards,
  Waypoints,
  Workflow,
  Wrench,
} from 'lucide-react-native';

export const ICON_SIZE = { inline: 14, action: 16, feature: 20 } as const;
export const ICON_STROKE = { default: 2, emphasis: 2.5 } as const;

/** 实体 / 导航概念 —— 一个概念永远一个图标 */
export const EntityIcons = {
  org: Building2,
  expert: Bot,
  skill: Puzzle,
  connector: Plug,
  capabilityCenter: Blocks,
  taskTemplates: LayoutGrid,
  knowledgeBase: Library,
  model: Cpu,
  billing: WalletCards,
  credits: Coins,
  audit: ScrollText,
  analytics: ChartColumn,
  admin: ShieldCheck,
  systemConfig: Settings2,
  toolControls: Wrench,
  files: Files,
  trash: Recycle,
  members: Users,
  signup: UserPlus,
  runtimePool: ServerCog,
  companyInfo: Info,
  tenantInstructions: Speech,
  cron: Clock,
  taskboard: Columns3,
  memoryPolling: BrainCircuit,
  egress: Waypoints,
  systemPrompts: MessageSquareText,
  workflow: Workflow,
  configStatus: Fingerprint,
} as const;

/** 运行状态四件套（+ pending）—— 全站唯一，禁止另起图标 */
export const StatusIcons = {
  running: Loader2,
  success: CircleCheck,
  error: CircleAlert,
  cancelled: CircleSlash2,
  pending: CircleDashed,
} as const;

/** 高频动作 */
export const ActionIcons = {
  undo: Undo2,
  project: Calculator,
  skip: SkipForward,
} as const;
