export interface ThemeColors {
  background: string;
  foreground: string;
  card: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  borderStrong: string;
  ring: string;
  success: string;
  warning: string;
  link: string;
  userBubble: string;
  warm200: string;
  codeBlockBg: string;
  successBg: string;
  errorBg: string;
  // Overlay & shadow (identical in light/dark — physical colors)
  overlay: string; // modal/action-sheet backdrop
  overlayHeavy: string; // lightbox/full-screen preview
  onOverlay: string; // icons/text on dark overlays
  shadow: string; // iOS shadowColor
  actions: {
    organize: string; // 组织/整理类动作：分组、移出
    edit: string; // 编辑类动作：重命名
    destructive: string; // 危险动作：删除
    onAction: string; // 动作按钮前景色
  };
  statusIcon: {
    success: string;
    warning: string;
    info: string;
    purple: string;
    cyan: string;
  };
}

// Agent SaaS light theme (based on WeUI neutral surfaces + custom monochrome brand)
export const lightColors: ThemeColors = {
  background: "#EDEDED",
  foreground: "rgba(0,0,0,0.9)",
  card: "#FFFFFF",
  primary: "#1F1F1F",
  primaryForeground: "#FFFFFF",
  secondary: "#F7F7F7",
  secondaryForeground: "rgba(0,0,0,0.9)",
  muted: "#ECECEC",
  mutedForeground: "rgba(0,0,0,0.5)",
  accent: "#ECECEC",
  accentForeground: "rgba(0,0,0,0.9)",
  destructive: "#FA5151",
  destructiveForeground: "#FFFFFF",
  border: "rgba(0,0,0,0.1)",
  borderStrong: "rgba(0,0,0,0.15)",
  ring: "#1F1F1F",
  success: "#07C160",
  warning: "#FFC300",
  link: "#576B95",
  userBubble: "#D4E2FC",
  warm200: "#D5D5DA",
  codeBlockBg: "#F7F7F7",
  successBg: "#B4ECCE",
  errorBg: "#FDCACA",
  overlay: "rgba(0,0,0,0.5)",
  overlayHeavy: "rgba(0,0,0,0.9)",
  onOverlay: "#FFFFFF",
  shadow: "#000000",
  // Swipe / quick actions：遵循《微信色彩标准参考》，但独立于 primary/secondary
  // 以避免页面结构色和动作语义色混用。
  actions: {
    organize: "#FA9D3B",
    edit: "#1485EE",
    destructive: "#FA5151",
    onAction: "#FFFFFF",
  },
  statusIcon: {
    success: "#07C160",
    warning: "#FFC300",
    info: "#10AEFF",
    purple: "#6467F0",
    cyan: "#10AEFF",
  },
};

// Agent SaaS dark theme
export const darkColors: ThemeColors = {
  background: "#191919",
  foreground: "rgba(255,255,255,0.8)",
  card: "#1E1E1E",
  primary: "#F5F5F5",
  primaryForeground: "#111111",
  secondary: "#2C2C2C",
  secondaryForeground: "rgba(255,255,255,0.8)",
  muted: "#3A3A3A",
  mutedForeground: "rgba(255,255,255,0.45)",
  accent: "#3A3A3A",
  accentForeground: "rgba(255,255,255,0.8)",
  destructive: "#FA5151",
  destructiveForeground: "#FFFFFF",
  border: "rgba(255,255,255,0.1)",
  borderStrong: "rgba(255,255,255,0.18)",
  ring: "#F5F5F5",
  success: "#07C160",
  warning: "#FFC300",
  link: "#7D90A9",
  userBubble: "#202A3C",
  warm200: "#2C2C2C",
  codeBlockBg: "#1E1E1E",
  successBg: "rgba(7,193,96,0.15)",
  errorBg: "rgba(250,81,81,0.15)",
  overlay: "rgba(0,0,0,0.5)",
  overlayHeavy: "rgba(0,0,0,0.9)",
  onOverlay: "#FFFFFF",
  shadow: "#000000",
  // Swipe / quick actions：遵循《微信色彩标准参考》，但独立于 primary/secondary
  // 以避免页面结构色和动作语义色混用。
  actions: {
    organize: "#FA9D3B",
    edit: "#1485EE",
    destructive: "#FA5151",
    onAction: "#FFFFFF",
  },
  statusIcon: {
    success: "#38CD7F",
    warning: "#FFCF33",
    info: "#3FBEFF",
    purple: "#8385F3",
    cyan: "#3FBEFF",
  },
};

// 向后兼容：未迁移的文件继续 import { colors }
export const colors = lightColors;
