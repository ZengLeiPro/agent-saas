/**
 * 平台技能专属图标 —— 实体级识别图标，按 skill id 精确映射。
 *
 * 定位与连接器的 ConnectorBrandLogo 相同：让每个技能在目录里一眼可辨，
 * 不属于 icons.ts 的概念级注册表（「技能」概念本身仍是 EntityIcons.skill）。
 *
 * 命中顺序：精确 id > id 关键词兜底（不匹配描述，避免误伤）> EntityIcons.skill。
 * 新增平台技能时在 SKILL_ICON_BY_ID 补一行即可；未收录会自动回退，不会报错。
 */
import {
  AudioLines,
  Bird,
  BriefcaseBusiness,
  Cable,
  Captions,
  ChartLine,
  Clapperboard,
  Clock,
  Database,
  Download,
  FileSpreadsheet,
  FileText,
  Fuel,
  Globe,
  Hammer,
  ImagePlus,
  Mail,
  MessageCircle,
  MessagesSquare,
  MonitorPlay,
  NotebookPen,
  PenLine,
  Presentation,
  Video,
  Workflow,
  Youtube,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { EntityIcons } from "@/lib/icons";

export type SkillCategory = "doc" | "comm" | "media" | "data" | "dev";

/** 分类仅控制技能图标色调，不参与筛选，也不表达好坏。 */
export const SKILL_CATEGORY_BY_ID: Record<string, SkillCategory> = {
  docx: "doc",
  xlsx: "doc",
  pptx: "doc",
  "dingtalk-docs": "doc",
  feishu: "doc",
  "dingtalk-msg": "comm",
  dws: "comm",
  gmail: "comm",
  imsg: "comm",
  "image-gen": "media",
  "video-gen": "media",
  hyperframes: "media",
  "audio-transcribe": "media",
  "media-download": "media",
  "video-subtitle": "media",
  "ky-data-query": "data",
  browser: "data",
  cron: "data",
  archify: "dev",
  codex: "dev",
  "skill-creator": "dev",
};

export const SKILL_CATEGORY_CLASS: Record<SkillCategory, string> = {
  doc: "bg-[hsl(var(--chart-1)/0.10)] text-[hsl(var(--chart-1))] ring-[hsl(var(--chart-1)/0.18)]",
  comm: "bg-[hsl(var(--chart-2)/0.10)] text-[hsl(var(--chart-2))] ring-[hsl(var(--chart-2)/0.18)]",
  media: "bg-[hsl(var(--chart-3)/0.10)] text-[hsl(var(--chart-3))] ring-[hsl(var(--chart-3)/0.18)]",
  data: "bg-[hsl(var(--chart-4)/0.10)] text-[hsl(var(--chart-4))] ring-[hsl(var(--chart-4)/0.18)]",
  dev: "bg-[hsl(var(--chart-5)/0.10)] text-[hsl(var(--chart-5))] ring-[hsl(var(--chart-5)/0.18)]",
};

export function skillCategoryClass(skillId: string): string | undefined {
  const category = SKILL_CATEGORY_BY_ID[skillId.trim().toLocaleLowerCase()];
  return category ? SKILL_CATEGORY_CLASS[category] : undefined;
}

const SKILL_ICON_BY_ID: Record<string, LucideIcon> = {
  // —— skills-pool（仓库内置）——
  archify: Workflow, // 架构图 / 流程图 / 时序图
  "audio-transcribe": AudioLines, // 语音转文字
  browser: Globe, // 浏览器自动化
  cron: Clock, // 定时任务（与 EntityIcons.cron 同图形）
  docx: FileText, // Word 文档
  dws: Zap, // 钉钉全家桶（闪电 = 钉钉品牌核心图形）
  hyperframes: Clapperboard, // 代码精确制作视频
  "image-gen": ImagePlus, // AI 生图
  "ky-data-query": Database, // 业务数据库查询
  "media-download": Download, // 视频 / 音频下载
  pptx: Presentation, // 演示文稿
  "skill-creator": Hammer, // 打造新技能
  "skill-demo": MonitorPlay, // 在线业务系统演示沙盘
  "video-gen": Video, // AI 生成视频
  "video-subtitle": Captions, // 视频字幕
  xlsx: FileSpreadsheet, // 电子表格
  "youtube-transcript": Youtube, // YouTube 字幕提取
  // —— 生产 pool 追加（见 _manifest.json roles）——
  bird: Bird, // X / Twitter
  "frpc-tunnel": Cable, // 内网穿透隧道
  gmail: Mail, // Gmail 收发
  imsg: MessageCircle, // iMessage
  "job-req-optimizer": BriefcaseBusiness, // 招聘 JD 优化
  "oil-price": Fuel, // 油价查询
  reddit: MessagesSquare, // Reddit 社区浏览
  "weekly-report": NotebookPen, // 周报
  "xhs-copywriter": PenLine, // 小红书文案
  "xhs-note-analysis": ChartLine, // 小红书笔记分析
};

/** 仅匹配 id 的高置信关键词兜底，按序命中第一条。 */
const SKILL_ICON_BY_KEYWORD: Array<[RegExp, LucideIcon]> = [
  [/subtitle|caption/, Captions],
  [/video/, Video],
  [/audio|voice|asr/, AudioLines],
  [/image|img|photo/, ImagePlus],
  [/xlsx|sheet|excel/, FileSpreadsheet],
  [/report|weekly|daily/, NotebookPen],
  [/mail/, Mail],
  [/data|query|sql/, Database],
];

export function skillIcon(skillId: string): LucideIcon {
  const id = skillId.trim().toLocaleLowerCase();
  const exact = SKILL_ICON_BY_ID[id];
  if (exact) return exact;
  for (const [pattern, icon] of SKILL_ICON_BY_KEYWORD) {
    if (pattern.test(id)) return icon;
  }
  return EntityIcons.skill;
}
