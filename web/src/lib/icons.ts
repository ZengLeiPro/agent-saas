/**
 * 语义图标注册表 —— 全站图标唯一取用口（2026-07-14 拍板落地，Batch 1）
 *
 * 规范：
 * 1. 概念/导航/实体图标必须从本注册表按语义取用，一个概念永远一个图标；
 *    禁止业务组件为「概念级」图标自行 import lucide-react。
 * 2. 尺寸三档：size-3.5 行内/表格；size-4 按钮/菜单项（默认）；size-5 页面标题/feature。
 * 3. strokeWidth 全局默认 2（不传即默认），仅强调按钮允许 2.5；禁止其他取值。
 * 4. 运行状态四件套全站唯一：running / success / error / cancelled（+ pending）。
 * 5. lucide 统一新命名（CircleAlert / CircleCheck / ChartColumn…），旧别名不再新引入。
 *
 * 接入进度：Batch 1 仅本批改动文件接入；存量散装 import 随后续批次清洗收口，
 * 收口完成后由 ESLint no-restricted-imports 守护（Batch 3）。
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
  Cpu,
  Files,
  Info,
  Library,
  LayoutGrid,
  Loader2,
  Plug,
  Puzzle,
  Recycle,
  ScrollText,
  ServerCog,
  Settings2,
  ShieldCheck,
  SkipForward,
  Undo2,
  UserPlus,
  Users,
  WalletCards,
  Wrench,
} from "lucide-react";

/** 实体 / 导航概念 —— 一个概念永远一个图标 */
export const EntityIcons = {
  /** 组织 / 租户（全站唯一绑定，不得挪作他用） */
  org: Building2,
  /** 专家 / Agent */
  expert: Bot,
  /** 技能 */
  skill: Puzzle,
  /** 连接器 / MCP */
  connector: Plug,
  /** 能力中心 */
  capabilityCenter: Blocks,
  /** 任务模板 */
  taskTemplates: LayoutGrid,
  /** 知识库 */
  knowledgeBase: Library,
  /** 模型 */
  model: Cpu,
  /** 计费（管理菜单） */
  billing: WalletCards,
  /** 积分 / 余额（用户可见的积分语境统一用 Coins，Sparkles 让位给 AI 能力语境） */
  credits: Coins,
  /** 审计日志 */
  audit: ScrollText,
  /** 用量 / 分析（组织分析、平台分析统一图表系） */
  analytics: ChartColumn,
  /** 管理员身份 / 权限 / 安全治理（审批、风控、出站策略等，ShieldCheck 的唯一合法域） */
  admin: ShieldCheck,
  /** 系统 / 通用配置 */
  systemConfig: Settings2,
  /** 工具开关 */
  toolControls: Wrench,
  /** 文件 / 工作区 */
  files: Files,
  /** 回收站 */
  trash: Recycle,
  /** 成员 / 用户 */
  members: Users,
  /** 注册管理 */
  signup: UserPlus,
  /** 执行环境池 */
  runtimePool: ServerCog,
  /** 公司信息 */
  companyInfo: Info,
  /** 定时任务 */
  cron: Clock,
  /** 平台每日记忆轮询 */
  memoryPolling: BrainCircuit,
} as const;

/** 运行状态四件套（+ pending）—— 全站唯一，禁止另起图标 */
export const StatusIcons = {
  /** 运行中（配 animate-spin） */
  running: Loader2,
  /** 成功（= 旧名 CheckCircle2） */
  success: CircleCheck,
  /** 失败 / 错误（= 旧名 AlertCircle） */
  error: CircleAlert,
  /** 已取消 */
  cancelled: CircleSlash2,
  /** 等待中 */
  pending: CircleDashed,
} as const;

/** 高频动作（增量收录，语义冲突时先查此表） */
export const ActionIcons = {
  /** 回退 / 撤销 */
  undo: Undo2,
  /** 手动投影 / 重算 */
  project: Calculator,
  /** 跳过 */
  skip: SkipForward,
} as const;
