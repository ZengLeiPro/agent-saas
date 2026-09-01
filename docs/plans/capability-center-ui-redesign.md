# 能力中心改版方案：工作流目录页 + 技能页

> 范围：`/capabilities` 下的「工作流」与「技能」两个页签
> 目标：在不改变信息内容与后端契约的前提下，重建信息层级、降低视觉噪音、补齐交互反馈
> 约束：**不新增任何运行时依赖**（尤其不引入 framer-motion / motion）；沿用现有 design token 与图标规范

---

## 一、灵感来源：4 个站点实际看到了什么

以下结论来自浏览器实地浏览（非二手描述），只摘可迁移到本项目的部分。

### 1. Beautiful UI — https://beautifului.dev

> "Beautiful UI for AI-native interfaces"，Turbo 出品，21 个 AI 场景组件。

实地看到的可迁移点：

| 组件                    | 观察到的做法                                                                                  | 迁移到我们哪里                                    |
| ----------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Filter Table**        | 筛选 chip = `圆点 + 文字 + 计数`，选中态是**浅底 pill**而非实心色块；一排 chip 里几乎没有强色 | 工作流页「我要解决什么」/「岗位」、技能页来源筛选 |
| **Insight Cards**       | 卡片顶部一行 meta，中部主内容，底部一个「下一步」按钮，层级只有 3 层                          | 工作流卡片重构的骨架                              |
| **Recommendation Card** | 建议 + 置信度条 + 双动作按钮，动作永远在同一位置                                              | 工作流卡片 CTA 统一对齐                           |
| **Task Rows**           | 状态用「文字 + 极小圆点」，不用大色块                                                         | 技能页「已启用」态降噪                            |
| **Sidebar Nav**         | hover 时才滑出次级操作（gliding hover states）                                                | 技能卡片 hover 才出「详情 →」                     |

**最关键的一条**：它整站几乎不用实心强色，颜色预算全留给「状态」。我们现在的两个页面正好相反 —— 品牌蓝被撒在筛选 chip 和随机的几个按钮上。

### 2. beUI — https://beui.dev

> 112 个组件，Tailwind 4 + React 19 + Motion，shadcn 分发。技术栈与我们最接近。

- `/components/motion/tabs` 的说明是 **"Pill, segment or underline tabs with a spring layoutId indicator"** —— 三种 tab 形态共用一个滑动指示器。
  我们 `CapabilityTabsList.tsx:43-51` 已经用**纯 CSS `translateX` 实现了同一个效果**（`cubic-bezier(0.22,1,0.36,1)` + `motion-reduce`），说明这条路不需要 Motion 也走得通。
- 组件清单里对我们有用的模式：`Expandable Tabs`、`Morphing Search`、`Multi Select`、`Animated Badge`、`Command Palette`、`Overflow Actions`。
- 结论：**beUI 的效果我们能用 CSS 复刻 90%，不值得为剩下 10% 引入 ~34KB gzip 的 Motion。**

### 3. Rare UI — https://rareui.com

> "17+ rare and unique components"，单文件、零依赖分发。

- 组件页把每个组件做成**视频卡片，hover 才播放** —— 这是"静态克制、交互给信息"的范式。
- `Grid Reveal`、`Proximity Sidebar`、`Gooey nav` 这类强表现力效果**不适合我们的 B 端后台**（会显得轻浮），但它的**列表分组方式**（`New releases [3]` / `Display [5]` 带计数的分区标题）正好解决我们技能页 29 个技能平铺找不到东西的问题。

### 4. Transitions.dev — https://transitions.dev

> Jakub Antalik 出品，40+ 个"最必要的 UI 过渡"，每个都给源码。

抓到的完整清单里，**直接对应我们缺口**的有 8 条：

| Transition                 | 原描述                                | 用在哪                                                |
| -------------------------- | ------------------------------------- | ----------------------------------------------------- |
| Tabs sliding               | Pill indicator follows the active tab | 筛选 chip 选中态（我们现在是硬切换）                  |
| Texts reveal               | Two lines rise with offset stagger    | 卡片网格入场 / 筛选切换后重排                         |
| Skeleton loader and reveal | Pulse to content cross-fade           | 替换现在的 `Loader2` 转圈（`ScenariosPanel.tsx:217`） |
| Spinner to check morph     | Spinner pops into a drawn check       | 技能启用中 → 已启用（现在是 spinner 直接换成 Check）  |
| Input clear with dissolve  | Clear with per-word dissolve          | 技能页搜索框清除                                      |
| Learn more hover           | Chevron shifts and opens on hover     | 卡片 hover 露出「详情 →」                             |
| Card stack hover           | Stack fans out with a spring          | 卡片 hover 抬升的缓动曲线参考                         |
| Accordion                  | Grid-rows height with chevron morph   | 「更多筛选」展开（现在是无过渡的 `display` 切换）     |

它给的缓动惯例：入场 `cubic-bezier(0.22, 1, 0.36, 1)`，弹性 `cubic-bezier(0.34, 1.56, 0.64, 1)`，时长 180–320ms。

---

## 二、现状诊断

### 2.1 工作流页（`ScenariosPanel.tsx` + `ScenarioCard.tsx`）

| #   | 问题                               | 证据                                                                                                                                                                                                | 严重度  |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| P1  | **标题重复到无法区分卡片**         | `ScenarioCard.tsx:233` 用 `scenario.goalTags[0]` 当 `<h3>`，而 goalTag 只有 8 种。截图里同屏出现 3 个「保交付」、3 个「追回款」、2 个「降客诉」。真正区分内容的 `scenario.title` 被降级成灰色副标题 | 🔴 阻断 |
| P2  | **badge 三连挤占黄金位**           | `ScenarioCard.tsx:224-230` 顶部一行永远是「重点工作流 + 持续闭环 + 标准接入」，三个同质圆角 pill，无层级差                                                                                          | 🔴      |
| P3  | **数据字段大量浪费**               | schema 里有 `value`、`shortChain`(3–6 步)、`triggerBadge`、`actionBadge`、`humanApprovalSummary`，卡片一个都没用。卡片实际只有 2 行文字                                                             | 🟠      |
| P4  | **CTA 数量与位置不一致**           | `showPrimaryAction = cta.label !== "接入我的系统"`（`ScenarioCard.tsx:215`）导致有的卡 2 个按钮、有的 1 个，实心蓝按钮在网格里随机散落成色块                                                        | 🟠      |
| P5  | **筛选区吃掉整个首屏**             | 展开「更多筛选」后是 6 排 chip（`ScenariosPanel.tsx:297-367`），卡片被挤出首屏；筛选条不 sticky，滚动后无法改条件                                                                                   | 🟠      |
| P6  | **无骨架 / 空态单薄 / 无入场动效** | `:217` 是居中转圈；`:370` 空态只有一行灰字 + 一个 link 按钮                                                                                                                                         | 🟡      |
| P7  | 卡片高度不齐                       | 无按钮的卡片比有按钮的矮，网格出现锯齿                                                                                                                                                              | 🟡      |

### 2.2 技能页（`SkillSelector/index.tsx`）

| #   | 问题                                         | 证据                                                                                                       | 严重度 |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| S1  | **绿色实心方块炸屏**                         | `:317-333` 启用态是 `size-8 bg-success`（#00B42A 实心）。29 张卡里 16 个绿块，成为页面视觉主体，压过技能名 | 🔴     |
| S2  | **"点击查看详情" 每卡一行废话**              | `:340`，29 行重复文本，占掉本可展示 meta 的位置                                                            | 🟠     |
| S3  | **已启用没有卡片级表达**                     | 只有右上角一个方块，扫视时无法快速圈定"我开了哪些"                                                         | 🟠     |
| S4  | **29 个技能平铺无分组无排序**                | `:288` 一把梭 grid；来源筛选是 chip 但默认「全部」，用户要靠肉眼找                                         | 🟠     |
| S5  | **图标全是同色蓝方块**                       | `CapabilityLogo` 固定 `bg-brand-50 text-brand-700`（`CatalogUi.tsx:69`），29 个一模一样，辨识度为 0        | 🟠     |
| S6  | 搜索无快捷键、无匹配高亮、无清除按钮         | `CatalogToolbar` `:260-272`                                                                                | 🟡     |
| S7  | 描述中英混排 + `line-clamp-3` 后底部留白参差 | 截图第 1 行 archify(中) / browser(英) / case-study(中)                                                     | 🟡     |

### 2.3 两页共同问题

- **筛选 chip 选中态是实心品牌蓝**（`CatalogUi.tsx:206`），与 `index.css` 里写死的原则冲突：
  > "后台工具页不铺品牌色：颜色预算全部留给这四族状态语义，品牌蓝只保留在主 CTA、链接与选中导航。"
  > 筛选 chip 不是导航，不该吃品牌蓝。
- **交互反馈只有 hover 抬升**（`CAPABILITY_SURFACE_HOVER`），没有入场、切换、加载、成功四类反馈。

---

## 三、设计原则（本次改版的判据）

1. **颜色预算**：一屏内最多出现 1 处品牌蓝实心（当前聚焦的主 CTA）。分类靠图标，状态靠 `success/warning/danger/info` 的**浅底 + ink 文字**，绝不用实心。
2. **层级三段式**：`标识行（弱） → 主标题（强） → 支撑信息（中） → 动作（右下固定位）`。每张卡片严格四段，不多不少。
3. **静态克制，交互给信息**：次级操作 hover / focus 才出现；但状态（已启用、重点）必须常驻可见。
4. **零新增依赖**：动效全部走 CSS + `tailwindcss-animate`（已装）。
5. **可访问性不降级**：hover 才出现的操作必须同时响应 `:focus-within`；所有动效受 `prefers-reduced-motion` 保护。

---

## 四、工作流页改版

### 4.1 卡片重构（核心改动）

**改前**（`ScenarioCard.tsx:216-270`）：

```
[重点工作流][持续闭环][标准接入]
保交付                       ← goalTags[0]，8 选 1，大量重复
交付窗口里的风险，解除或改期都有交代   ← scenario.title，真正的区分信息
                    [接入我的系统][看演示]
```

**改后**：

```
┌────────────────────────────────────────┐
│ ▌ 🚚 保交付                    标准接入 │  ← ▌=featured 竖条；图标+结果标签；就绪度极轻右上
│                                          │
│ 交付窗口里的风险，解除或改期都有交代      │  ← scenario.title 升为 h3（16px/600）
│ 提前 3 天预警，改期同步到客户与生产        │  ← scenario.value（新增，2 行截断）
│                                          │
│ 订单变更 › 算交付窗口 › 通知客户          │  ← shortChain 前 3 步（新增，11px）
│ ─────────────────────────────────────── │
│ 需您确认后发送            [演示] [接入]   │  ← humanApprovalSummary + 固定位 CTA
└────────────────────────────────────────┘
```

改动清单：

| 项          | 改前                                          | 改后                                                                                                      |
| ----------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `<h3>` 内容 | `scenario.goalTags[0]`                        | `scenario.title`                                                                                          |
| 结果标签    | 无（被当标题用了）                            | 顶部 `图标 + goalTags[0]`，`text-xs text-muted-foreground`，图标 `h-3.5 w-3.5`                            |
| featured    | `<Badge>重点工作流</Badge>` 占一个 pill 位    | 卡片左侧 `before:` 伪元素 2px 竖条（`bg-gradient-to-b from-brand-500 to-brand-600`）+ `ring-brand-200/70` |
| primaryType | `<Badge variant="secondary">持续闭环</Badge>` | 移入底部 meta 行，纯文字 `text-[11px]`                                                                    |
| readiness   | `<Badge variant="outline">标准接入</Badge>`   | 右上角纯文字 `text-[11px] text-muted-foreground`，`title` 属性给完整解释                                  |
| 副标题      | `scenario.title`（灰）                        | `scenario.value`（灰，`line-clamp-2`）                                                                    |
| 新增        | —                                             | `shortChain.slice(0,3)` 用 `ChevronRight h-3 w-3` 分隔                                                    |
| 新增        | —                                             | 底部 `humanApprovalSummary`（`line-clamp-1`）                                                             |
| CTA         | 数量不定，右对齐                              | **永远 1–2 个、永远在底部右侧**；`showPrimaryAction` 判断删除，「接入我的系统」也渲染成主按钮             |
| CTA 配色    | 主按钮常驻实心蓝                              | 主按钮默认 `outline`，**卡片 hover/focus-within 时才填充 brand-600**（featured 卡片常驻实心）             |
| 高度        | 不齐                                          | `min-h-[13.5rem]` + `flex-col`，meta 行 `mt-auto`                                                         |

**8 个结果标签的图标映射**（新建 `web/src/components/scenarios/outcomeIcons.ts`）：

```ts
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

/** 8 个业务结果的识别图标。只做辨识，不引入 8 种颜色——颜色预算留给状态语义。 */
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
```

> 符合 `CLAUDE.md` 图标规范：来源 lucide-react、尺寸 `h-3.5 w-3.5`（行内档）、不写 `strokeWidth`。

### 4.2 筛选区重构

**改前**：`结果 chips`（1 排）+ `岗位 chips`（1 排）+ 展开后 4 排 = 最多 6 排，全部占据文档流。

**改后**：一条 **sticky 工具条** + 一个 Popover：

```
┌─────────────────────────────────────────────────────────────┐
│ [🎯全部结果 22][👤找客户 3][📈推进成交 4]…      🧑‍💼岗位 ▾  ⚙筛选 ②  ↺│  ← sticky top-0
└─────────────────────────────────────────────────────────────┘
```

- **结果 chips 保留横滑**，但加 `count`（`CapabilityFilterTabs` 已支持 `option.count`，只是没传）+ 图标。
- **岗位从 chips 改为 `Select`**（9 个岗位，横滑体验差，且移动端易误触）。
- **「更多筛选」从内联展开改为 `Popover`**：内含业务入口 / 垂直行业 / 经营模式 / 数字化基础 4 组，按钮上带激活数量角标。省下 4 排高度。
- 工具条 `sticky top-0 z-10 -mx-4 px-4 sm:-mx-6 sm:px-6 bg-card/80 backdrop-blur-sm border-b border-border/50`，滚动时仍可改条件。
- 首屏因此能看到 **2 排完整卡片**（改前 0–1 排）。

**chip 新样式**（改 `CatalogUi.tsx:203-208`，两页共用）：

```diff
- "shrink-0 rounded-full border border-transparent px-3 py-1.5 text-sm transition-colors",
- selected
-   ? "bg-primary text-primary-foreground"
-   : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground",
+ "group/chip relative shrink-0 rounded-full border px-3 py-1.5 text-sm",
+ "transition-[color,background-color,border-color,box-shadow] duration-200",
+ "[transition-timing-function:cubic-bezier(0.22,1,0.36,1)]",
+ "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
+ selected
+   ? "border-brand-200 bg-brand-50 font-medium text-brand-700 shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:border-brand-800 dark:bg-brand-900/40 dark:text-brand-200"
+   : "border-transparent bg-muted/50 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground",
```

计数样式同步改为 `ml-1.5 text-xs tabular-nums opacity-60`（`tabular-nums` 防止数字跳动时宽度抖）。

> 效果：一排 chip 从「1 个实心蓝 + 8 个灰」变成「1 个淡蓝描边 + 8 个近乎透明」，噪音降一个数量级。

### 4.3 状态页面

- **加载**：12 张骨架卡替代 `Loader2`（`ScenariosPanel.tsx:216-218`）。骨架尺寸与真卡一致，避免内容到位时布局跳动。
- **空态**：`CAPABILITY_EMPTY_SURFACE` 内改为
  `图标 → "没有同时满足这些条件的工作流" → 当前生效条件的可点掉 chips → [重置全部筛选]`。
  让用户知道是哪一条把结果筛没了，而不是只给一个重置按钮。
- **错误态**：保留，补一行 `result.error` 的原因文案与「重试」按钮的 loading 态。

---

## 五、技能页改版

### 5.1 启用态降噪（S1/S3，最高优先级）

```diff
  className={cn(
-   "flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors",
+   "flex size-7 shrink-0 items-center justify-center rounded-full border transition-all duration-200",
+   "[transition-timing-function:cubic-bezier(0.34,1.56,0.64,1)] active:scale-95",
    selected
-     ? "border-transparent bg-success text-success-foreground hover:bg-success/85"
-     : "bg-muted/40 text-muted-foreground hover:border-success/40 hover:bg-success/10 hover:text-success",
+     ? "border-success/25 bg-success/12 text-success-ink hover:bg-success/20"
+     : "border-border/70 bg-transparent text-muted-foreground hover:border-success/40 hover:bg-success/8 hover:text-success-ink",
  )}
```

同时给**卡片级**启用表达（扫视时一眼圈定）：

```tsx
<Card className={cn(
  "group relative cursor-pointer overflow-hidden border-0 shadow-none",
  CAPABILITY_SURFACE, CAPABILITY_SURFACE_HOVER,
  selected && "ring-success/30 before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-success/60",
)}>
```

图标底色随启用态走：`selected ? "bg-success/10 text-success-ink ring-success/20" : 分类色`。

> 视觉重量对比：实心 `#00B42A` 32×32 方块 → 12% 透明度 28px 圆 + 3px 竖条。绿色总面积下降约 75%，"哪些开了"反而更清楚（因为整卡有信号）。

### 5.2 图标分类着色（S5）

复用 `index.css` 已定义的 `--chart-1…5` 分类色板（原文注释：_"只需要区分、不需要判断好坏"_），正好是这个场景：

```ts
// web/src/lib/skillIcons.ts 追加
export type SkillCategory = 'doc' | 'comm' | 'media' | 'data' | 'dev';

/** 分类只用于图标着色的辨识度，不参与筛选，也不表示好坏。 */
export const SKILL_CATEGORY_BY_ID: Record<string, SkillCategory> = {
  docx: 'doc',
  xlsx: 'doc',
  pptx: 'doc',
  'dingtalk-docs': 'doc',
  feishu: 'doc',
  'dingtalk-msg': 'comm',
  dws: 'comm',
  gmail: 'comm',
  'image-gen': 'media',
  'video-gen': 'media',
  hyperframes: 'media',
  'audio-transcribe': 'media',
  'media-download': 'media',
  'video-subtitle': 'media',
  'ky-data-query': 'data',
  browser: 'data',
  cron: 'data',
  archify: 'dev',
  codex: 'dev',
  'skill-creator': 'dev',
};

export const SKILL_CATEGORY_CLASS: Record<SkillCategory, string> = {
  doc: 'bg-[hsl(var(--chart-1)/0.10)] text-[hsl(var(--chart-1))] ring-[hsl(var(--chart-1)/0.18)]',
  comm: 'bg-[hsl(var(--chart-2)/0.10)] text-[hsl(var(--chart-2))] ring-[hsl(var(--chart-2)/0.18)]',
  media: 'bg-[hsl(var(--chart-3)/0.10)] text-[hsl(var(--chart-3))] ring-[hsl(var(--chart-3)/0.18)]',
  data: 'bg-[hsl(var(--chart-4)/0.10)] text-[hsl(var(--chart-4))] ring-[hsl(var(--chart-4)/0.18)]',
  dev: 'bg-[hsl(var(--chart-5)/0.10)] text-[hsl(var(--chart-5))] ring-[hsl(var(--chart-5)/0.18)]',
};
```

未收录的技能回落到现有 `bg-brand-50`，不报错、不需要一次补全。

### 5.3 卡片信息重排（S2/S7）

```diff
- <div className="mt-auto pt-3 text-xs text-muted-foreground">点击查看详情</div>
+ <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-[11px] text-muted-foreground">
+   <span className="truncate">
+     {skill.governance?.version ? `v${skill.governance.version}` : "平台内置"}
+     {selected ? " · 已启用" : ""}
+   </span>
+   <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-200
+                    group-hover:opacity-100 group-focus-within:opacity-100">
+     详情<ChevronRight className="h-3 w-3 transition-transform duration-200 group-hover:translate-x-0.5" />
+   </span>
+ </div>
```

- 来源 badge 从标题下方移到图标右下角的小角标，或保留但缩为 `text-[10px]`（29 张卡都有「平台提供」，重复度高）。
- 描述统一 `line-clamp-2` + `min-h-[2.5rem]`，卡片 `min-h-40` → `min-h-[9.5rem]`，高度整齐。

### 5.4 分组与排序（S4）

默认排序改为：**已启用 → 平台 → 组织 → 个人**，并在「全部」筛选下插入分区标题（Rare UI 的 `New releases [3]` 模式）：

```tsx
// 分区标题：sticky，带计数
<div
  className="sticky top-[3.25rem] z-[5] -mx-1 mb-2 mt-6 flex items-center gap-2
                bg-card/85 px-1 py-1.5 backdrop-blur-sm first:mt-0"
>
  <span className="text-xs font-medium text-foreground">已启用</span>
  <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">
    {n}
  </span>
</div>
```

选中具体来源筛选时不分组（此时组只有一个，标题是冗余）。

### 5.5 搜索增强（S6）

- `/` 或 `⌘K` 聚焦（`useEffect` 里挂 `keydown`，输入框已聚焦时不拦截）。
- 有内容时右侧出 `X` 清除按钮，清除时列表走一次 `fade-up` 重入场（对应 Transitions.dev 的 _Input clear with dissolve_）。
- 匹配文本高亮：`<mark className="bg-brand-100/70 text-inherit rounded px-0.5">`。
- 空结果提示带搜索词：`没有匹配「xxx」的技能`，并给「清空搜索」与「切到全部来源」两个出口。

---

## 六、共享动效层（零依赖实现）

新增 `web/src/styles/motion.css`，由 `index.css` 引入。**不装任何 npm 包。**

```css
@layer base {
  :root {
    /* 入场 / 位移：Transitions.dev 与我们 CapabilityTabsList 已在用的曲线 */
    --ease-out-expo: cubic-bezier(0.22, 1, 0.36, 1);
    /* 弹性：勾选、开关、按下回弹 */
    --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
    --dur-fast: 160ms;
    --dur-base: 220ms;
    --dur-slow: 320ms;
  }
}

@layer components {
  /* 网格入场 + 筛选切换重排：两行错峰升起（Texts reveal） */
  .cap-grid-item {
    animation: cap-rise var(--dur-base) var(--ease-out-expo) backwards;
    animation-delay: calc(var(--i, 0) * 24ms);
  }
  @keyframes cap-rise {
    from {
      opacity: 0;
      transform: translateY(8px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  /* 骨架微光（Skeleton loader and reveal） */
  .cap-skeleton {
    background: linear-gradient(
      90deg,
      hsl(var(--muted)) 25%,
      hsl(var(--muted) / 0.55) 37%,
      hsl(var(--muted)) 63%
    );
    background-size: 400% 100%;
    animation: cap-shimmer 1.4s ease-in-out infinite;
  }
  @keyframes cap-shimmer {
    from {
      background-position: 100% 50%;
    }
    to {
      background-position: 0 50%;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .cap-grid-item,
  .cap-skeleton {
    animation: none !important;
  }
  .cap-grid-item {
    opacity: 1;
    transform: none;
  }
}
```

**用法**（stagger 上限 12 个，之后归零，避免长列表末尾延迟过久）：

```tsx
{scenarios.map((s, i) => (
  <WorkflowScenarioCard
    key={s.id}
    style={{ "--i": Math.min(i, 12) } as CSSProperties}
    className="cap-grid-item"
    …
  />
))}
```

筛选切换时给网格容器一个随筛选值变化的 `key`，让 React 重挂载触发重入场：

```tsx
<div key={`${activeOutcome}-${activeRole}`} className="grid …">
```

**卡片 hover 曲线微调**（`CatalogUi.tsx:24-25`）：

```diff
  export const CAPABILITY_SURFACE_HOVER =
-   "transition-all hover:-translate-y-0.5 hover:ring-brand-200 hover:shadow-[0_6px_18px_-8px_rgba(15,23,42,0.18)]";
+   "transition-[transform,box-shadow,--tw-ring-color] duration-[var(--dur-base)] [transition-timing-function:var(--ease-out-expo)] " +
+   "hover:-translate-y-0.5 hover:ring-brand-200 hover:shadow-[0_8px_24px_-10px_rgba(15,23,42,0.20)] " +
+   "active:translate-y-0 active:duration-75 motion-reduce:transform-none motion-reduce:transition-none";
```

（把 `transition-all` 收窄到具体属性，避免 hover 时连 `color` 一起过渡导致文字发虚。）

**技能启用成功反馈**（Spinner → check morph 的 CSS 版）：

```tsx
{
  pending ? (
    <Loader2 className="h-4 w-4 animate-spin" />
  ) : selected ? (
    <Check className="h-4 w-4 animate-in zoom-in-50 duration-200" strokeWidth={2.5} />
  ) : (
    <Plus className="h-4 w-4" />
  );
}
```

`animate-in zoom-in-50` 来自已装的 `tailwindcss-animate`，无需新依赖。

**「更多筛选」如仍保留内联展开**，用 grid-rows 过渡（Transitions.dev 的 Accordion 做法）：

```tsx
<div
  className={cn(
    'grid transition-[grid-template-rows] duration-[var(--dur-slow)]',
    '[transition-timing-function:var(--ease-out-expo)]',
    open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
  )}
>
  <div className="overflow-hidden">{/* 内容 */}</div>
</div>
```

### 关于是否引入 Motion（framer-motion）

**结论：本次不引入。**

- 现状：`web/package.json` 只有 `tailwindcss-animate`，无任何 JS 动画库。
- beUI 那个"spring layoutId indicator"我们在 `CapabilityTabsList.tsx:43-51` 已用纯 CSS 实现且效果一致。
- 本方案全部效果（stagger、shimmer、morph 勾、accordion、hover）CSS 可覆盖。
- 唯一需要 Motion 的是"卡片 → 详情抽屉"的 shared-element morph。**可用 View Transitions API 渐进增强**（Chrome 111+/Safari 18+，不支持的浏览器自动退化为现有直切）：

```ts
const open = (s: CatalogScenarioPublic) => {
  if (!document.startViewTransition) return setDetail({ scenario: s });
  document.startViewTransition(() => flushSync(() => setDetail({ scenario: s })));
};
```

若后续确实要做复杂编排，再单独评估引入 `motion`（~34KB gzip）。

---

## 七、落地批次

### P0 — 信息架构与降噪（约 1 天，视觉收益最大）

| 文件                                                | 改动                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/src/components/scenarios/outcomeIcons.ts`      | **新建**：8 个结果标签图标映射                                                                                                                                        |
| `web/src/components/scenarios/ScenarioCard.tsx`     | `WorkflowScenarioCard` 重构：标题换 `title`、结果标签带图标、featured 转竖条、启用 `value`/`shortChain`/`humanApprovalSummary`、CTA 固定位与 hover 填充、`min-h` 统一 |
| `web/src/components/CapabilityCenter/CatalogUi.tsx` | `CapabilityFilterTabs` chip 新样式；`CAPABILITY_SURFACE_HOVER` 曲线收窄；`CapabilityLogo` 支持 `tone` 入参                                                            |
| `web/src/components/SkillSelector/index.tsx`        | 启用态按钮降重、卡片级 success 表达、删「点击查看详情」改 meta 行、描述 `line-clamp-2`                                                                                |
| `web/src/lib/skillIcons.ts`                         | 追加 `SKILL_CATEGORY_BY_ID` / `SKILL_CATEGORY_CLASS`                                                                                                                  |

**验收**：同屏卡片标题不再重复；一屏内品牌蓝实心 ≤1 处；绿色面积下降 ≥70%；卡片等高。

### P1 — 筛选与状态页（约 1 天）

| 文件                                                       | 改动                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `web/src/components/scenarios/ScenariosPanel.tsx`          | 工具条 sticky 化；岗位 chips → `Select`；4 组次级筛选移入 `Popover`（带激活角标）；结果 chip 传 `count` |
| `web/src/components/scenarios/WorkflowCatalogSkeleton.tsx` | **新建**：12 张骨架卡                                                                                   |
| `web/src/components/scenarios/ScenariosPanel.tsx`          | 空态升级：生效条件 chips 可单独点掉                                                                     |
| `web/src/components/SkillSelector/index.tsx`               | 分区标题（sticky + 计数）、默认排序「已启用 → 平台 → 组织 → 个人」                                      |

**验收**：1440×900 首屏可见 ≥2 排完整卡片；滚动到底部仍可改筛选条件；加载态无布局跳动（CLS ≈ 0）。

### P2 — 动效与搜索（约 0.5 天）

| 文件                                                | 改动                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `web/src/styles/motion.css`                         | **新建**：token + `cap-grid-item` + `cap-skeleton` + reduced-motion |
| `web/src/index.css`                                 | `@import "./styles/motion.css";`                                    |
| 两页网格                                            | 挂 `.cap-grid-item` + `--i`；容器 `key` 绑筛选值                    |
| `web/src/components/CapabilityCenter/CatalogUi.tsx` | `CatalogToolbar`：`/`、`⌘K` 聚焦 + 清除按钮                         |
| `web/src/components/SkillSelector/index.tsx`        | 匹配高亮、空结果带搜索词、启用成功 `zoom-in`                        |

**验收**：`prefers-reduced-motion: reduce` 下所有动画停用；筛选切换 stagger 总时长 ≤ 500ms。

### P3 — 可选增强（视排期）

- 技能页多选 + 底部浮起批量操作条（Beautiful UI 的 _Selection Actions_）。
- 卡片 → 详情抽屉的 View Transitions morph。
- 工作流卡片 hover 时 `shortChain` 逐步高亮（示意执行顺序）。

---

## 八、测试与风险

### 受影响的既有测试（改动前需先读，改完同步更新）

| 测试文件                               | 受影响原因                                     |
| -------------------------------------- | ---------------------------------------------- |
| `scenarios/ScenarioCard.test.tsx`      | 卡片 DOM 结构与文案位置全变（标题断言会失败）  |
| `scenarios/ScenariosPanel.v3.test.tsx` | 筛选区从 chips 改 Select/Popover，查询方式变化 |
| `scenarios/ScenariosPanel.test.tsx`    | 同上                                           |
| `CapabilityCenter/CatalogUi.test.tsx`  | chip 类名断言                                  |
| `SkillSelector/index.test.tsx`         | 「点击查看详情」文案删除、启用按钮类名变化     |
| `scenarios/workflowUi.test.ts`         | 若删 `showPrimaryAction` 分支需同步            |

> 建议顺序：每个 P 批次内先改组件 → 跑 `pnpm --filter web test` → 再补测试断言，避免一次性大改后测试全红难定位。

### 风险与取舍

| 风险                                                      | 应对                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 岗位从 chips 改 Select 后，"一眼看到有哪些岗位"的能力下降 | Select 触发器显示当前岗位名 + 总数；`ScenariosPanel` 已有的"按用户 position 自动选中岗位"逻辑（`:106-112`）保留不变 |
| 次级筛选移入 Popover 后可发现性下降                       | 按钮带激活数量角标（`②`）；有激活项时按钮变 `brand-50` 底色，与现有 `secondaryFiltersActive` 逻辑对齐               |
| `scenario.value` / `shortChain` 在某些数据里可能过长      | 均加 `line-clamp`；`shortChain` 只取前 3 步且每步 `truncate`                                                        |
| 分类着色可能被理解成"好坏"                                | 用 `--chart-*` 而非状态色，且 `index.css` 原注释已明确该色板"不承载好坏"；分类不进筛选条件                          |
| stagger 在低端机上掉帧                                    | 只动 `opacity` / `transform`（合成层属性），上限 12 个，且 reduced-motion 直接关闭                                  |

### 不做的事（明确排除）

- 不改后端 schema、不改 `workflow-library` 数据文件。
- 不引入新的 npm 依赖。
- 不动移动端 `MobileLayout` 的布局分支（两页在移动端沿用同组件，改动天然继承；仅需回归验证 `767px` 断点）。
- 不改 `CapabilityTabsList` 的顶部四页签（现状已经是好的滑动指示器实现）。

---

## 九、改前 / 改后对照速查

| 维度             | 改前                          | 改后                                                                                |
| ---------------- | ----------------------------- | ----------------------------------------------------------------------------------- |
| 工作流卡片标题   | 8 选 1 的结果词，同屏大量重复 | 场景全名，张张不同                                                                  |
| 工作流卡片信息量 | 2 行文字                      | 结果标签 + 标题 + 价值 + 3 步链路 + 人审说明                                        |
| 顶部 badge       | 3 个同质 pill                 | 0 个（转竖条 / 右上文字 / 底部 meta）                                               |
| 一屏品牌蓝实心   | 5–6 处（随机散落的按钮）      | ≤1 处（hover 聚焦的那张卡）                                                         |
| 技能页绿色面积   | 16 × 32px 实心方块            | 16 × 28px 12% 浅底圆 + 3px 竖条                                                     |
| 技能图标         | 29 个同色蓝方块               | 5 类分类色                                                                          |
| 首屏可见卡片     | 0–1 排                        | ≥2 排                                                                               |
| 加载反馈         | 居中转圈                      | 骨架卡（零布局跳动）                                                                |
| 交互反馈类型     | 1 种（hover 抬升）            | 5 种（入场 stagger / hover 抬升+CTA 填充 / 按下回弹 / 成功 zoom / 骨架 cross-fade） |
| 新增依赖         | —                             | 0                                                                                   |
