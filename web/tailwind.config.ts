import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";
import typography from "@tailwindcss/typography";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      colors: {
        // 开沿科技品牌色板（跨项目对齐：brand-50…900 + accent / accent-soft / accent-ink）
        brand: {
          50:  "#EEF2FF",
          100: "#DDE5FF",
          200: "#BDCCFF",
          300: "#93A9FF",
          400: "#6480F6",
          500: "#3A61EE", // Logo 蓝（仅品牌资产，不做 UI 主色）
          600: "#2E56E1", // UI 主色：按钮/链接/选中
          700: "#2444C0", // hover / 深文字
          800: "#1F399B",
          900: "#1B327B",
        },
        // 强调色仅在「人文/温度/故事」语境使用，不与品牌蓝混用
        "brand-accent": {
          DEFAULT: "#E8843A",
          soft:    "#FDF2E8",
          ink:     "#B65E16",
        },
        // 辅助青绿色：用于连接、协作、洞察等非主 CTA / 非成功态语义
        teal: {
          50:  "#EAFBFA",
          100: "#CCF3F0",
          200: "#99E7E1",
          300: "#5DD3CB",
          400: "#2ABBB3",
          500: "#159E98",
          600: "#0F817D",
          700: "#0F6664",
        },
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        link: "hsl(var(--link))",
        "user-bubble": "hsl(var(--user-bubble))",
        "code-block-bg": "hsl(var(--code-block-bg))",
        interrupted: "hsl(var(--interrupted))",
      },
      boxShadow: {
        // 主品牌阴影：brand-600 @ 28% 投影，Hero / 悬浮卡片 / 模态使用
        brand: "var(--shadow-brand)",
      },
      typography: {
        DEFAULT: {
          css: {
            '--tw-prose-links': 'hsl(var(--link))',
          },
        },
        invert: {
          css: {
            '--tw-prose-invert-links': 'hsl(var(--link))',
          },
        },
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        soundbar: {
          "0%, 100%": { height: "4px" },
          "50%": { height: "12px" },
        },
        "voice-wave": {
          "0%": { height: "4px" },
          "25%": { height: "16px" },
          "50%": { height: "8px" },
          "75%": { height: "20px" },
          "100%": { height: "4px" },
        },
        // 登录/注册门面（AuthShell）：卡片入场 + 背景光晕漂移
        "login-rise": {
          from: { opacity: "0", transform: "translateY(16px)" },
          to: { opacity: "1", transform: "none" },
        },
        "auth-content-enter": {
          from: { opacity: "0.45", transform: "translateY(5px)" },
          to: { opacity: "1", transform: "none" },
        },
        "glow-drift-a": {
          to: { transform: "translate(70px, 50px) scale(1.08)" },
        },
        "glow-drift-b": {
          to: { transform: "translate(-60px, -40px) scale(1.05)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
        soundbar: "soundbar 0.6s ease-in-out infinite",
        "voice-wave": "voice-wave 1.2s ease-in-out infinite",
        "login-rise": "login-rise 0.55s cubic-bezier(0.2, 0.7, 0.3, 1) both",
        "auth-content-enter": "auth-content-enter 0.18s ease-out both",
        "glow-drift-a": "glow-drift-a 22s ease-in-out infinite alternate",
        "glow-drift-b": "glow-drift-b 26s ease-in-out infinite alternate",
      },
    },
  },
  plugins: [animate, typography],
} satisfies Config;
