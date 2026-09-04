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
      /*
       * Type scale（全站唯一合法字号阶梯）
       * ------------------------------------------------------------------
       * 规则：新代码不允许再写 `text-[10px]` 这类 arbitrary 字号。
       * 需要比 `text-xs` 更小的密集元信息（表格内徽章、时间线 meta、口径标注）
       * 一律用 `text-2xs`。低于 11px 在 CJK 下已不可读，不再提供更小档位。
       *
       * `xs` 及以上刻意与 Tailwind 默认值保持一致（此处是显式固化而非改值），
       * 目的是把"允许的档位"集中写在一个可检索的位置，同时保证既有 UI 零视觉变化。
       */
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }], // 11px / 16px 密集元信息（新增档位）
        xs: ["0.75rem", { lineHeight: "1rem" }], //      12px / 16px 表格与后台正文
        sm: ["0.875rem", { lineHeight: "1.25rem" }], //  14px / 20px 卡片标题、表单
        base: ["1rem", { lineHeight: "1.5rem" }], //     16px / 24px 聊天正文
        lg: ["1.125rem", { lineHeight: "1.75rem" }], //  18px / 28px 区块标题
        xl: ["1.25rem", { lineHeight: "1.75rem" }], //   20px / 28px
        "2xl": ["1.5rem", { lineHeight: "2rem" }], //    24px / 32px 指标卡数值、页标题
      },
      fontFamily: {
        /*
         * 等宽栈：ID / token 数 / 耗时 / 代码片段。
         * 末尾挂 CJK 字体，避免中英混排时中文回退到系统默认无衬线字体导致
         * 基线与字重跳变（Windows 上 Consolas + YaHei 的经典错位）。
         */
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "SF Mono",
          "JetBrains Mono",
          "Menlo",
          "Monaco",
          "Consolas",
          "Liberation Mono",
          "Courier New",
          "PingFang SC",
          "HarmonyOS Sans SC",
          "Microsoft YaHei",
          "monospace",
        ],
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
          ink:     "#A0500E", // 橙色文字：brand-guidelines 指定，比官网 accent-ink 更深以保证小字对比度
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
        /*
         * 状态语义色板（定义见 src/index.css）。后台界面的颜色一律从这里取，
         * 禁止再写 bg-emerald-500/15 这类硬编码调色板值——它们不随暗色切换，
         * 也不承载"这是什么状态"的信息。
         *   DEFAULT     实心块 / 圆点 / 进度条
         *   -foreground 实心底上的文字
         *   -subtle     不透明浅底（横幅）
         *   -ink        浅底上的文字（一个 token 覆盖亮/暗两套）
         */
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
          subtle: "hsl(var(--success-subtle))",
          ink: "hsl(var(--success-ink))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
          subtle: "hsl(var(--warning-subtle))",
          ink: "hsl(var(--warning-ink))",
        },
        danger: {
          DEFAULT: "hsl(var(--danger))",
          foreground: "hsl(var(--danger-foreground))",
          subtle: "hsl(var(--danger-subtle))",
          ink: "hsl(var(--danger-ink))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
          subtle: "hsl(var(--info-subtle))",
          ink: "hsl(var(--info-ink))",
        },
        /*
         * 分类色板（categorical）。多系列图表、Token 构成、事件类别用它，
         * 不要用状态语义色——绿/琥珀/红出现在图表里必须真的表示好坏。
         */
        "chart-1": "hsl(var(--chart-1))",
        "chart-2": "hsl(var(--chart-2))",
        "chart-3": "hsl(var(--chart-3))",
        "chart-4": "hsl(var(--chart-4))",
        "chart-5": "hsl(var(--chart-5))",
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
