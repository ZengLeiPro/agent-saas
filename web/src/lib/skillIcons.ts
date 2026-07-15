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
