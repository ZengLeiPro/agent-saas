# 案例 HTML 模板指南

本文件包含案例 PDF 的完整 CSS 样式系统、HTML 组件库和 print 媒体查询。生成 HTML 时必须参考此文件。

## 目录

1. [CSS 变量与基础样式](#css-变量与基础样式)
2. [页面结构](#页面结构)
3. [Hero 区域](#hero-区域)
4. [Stats 数据条](#stats-数据条)
5. [Section 区域](#section-区域)
6. [模拟界面：看板 Kanban](#模拟界面看板-kanban)
7. [模拟界面：数据表格](#模拟界面数据表格)
8. [模拟界面：数据看板（图表）](#模拟界面数据看板图表)
9. [模拟界面：审批流程](#模拟界面审批流程)
10. [Feature 功能卡片](#feature-功能卡片)
11. [九宫格场景卡片](#九宫格场景卡片)
12. [Highlight Box](#highlight-box)
13. [Footer](#footer)
14. [Print 媒体查询](#print-媒体查询)

---

## CSS 变量与基础样式

```css
* { margin: 0; padding: 0; box-sizing: border-box; }

:root {
  --blue: #2E56E1;
  --blue-light: #EBF5FF;
  --gray-bg: #F5F5F7;
  --gray-100: #FBFBFD;
  --gray-200: #F2F2F7;
  --gray-300: #E5E5EA;
  --gray-400: #D1D1D6;
  --gray-500: #8E8E93;
  --gray-600: #636366;
  --gray-700: #48484A;
  --gray-800: #3A3A3C;
  --gray-900: #1D1D1F;
  --green: #34C759;
  --orange: #FF9500;
  --red: #FF3B30;
  --purple: #AF52DE;
  --radius: 16px;
  --radius-sm: 10px;
  --radius-xs: 6px;
}

body {
  font-family: "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  background: #fff;
  color: var(--gray-900);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
```

---

## 页面结构

```html
<div class="page">
  <!-- Hero -->
  <!-- Stats -->
  <!-- Section: 核心场景（含模拟界面 + feature 卡片）-->
  <div class="divider"></div>
  <!-- Section: 补充场景 1 -->
  <div class="divider"></div>
  <!-- Section: 补充场景 2 -->
  <div class="divider"></div>
  <!-- Section: 更多场景九宫格（加 class="section-last"）-->
  <!-- Highlight Box -->
  <!-- Footer -->
</div>
```

```css
.page {
  max-width: 900px;
  margin: 0 auto;
  padding: 0 40px;
}

.divider {
  width: 40px;
  height: 3px;
  background: var(--blue);
  border-radius: 2px;
  margin: 48px auto;
}
```

---

## Hero 区域

```html
<div class="hero">
  <div class="tag">行业场景</div>
  <h1>从投标混乱到全流程掌控</h1>
  <p class="subtitle">一家消防制造企业如何用钉钉实现投标管理数字化，并带动全业务线效率提升</p>
</div>
```

```css
.hero {
  text-align: center;
  padding: 80px 0 50px;
}
.hero .tag {
  display: inline-block;
  background: var(--blue-light);
  color: var(--blue);
  font-size: 13px;
  font-weight: 600;
  padding: 6px 16px;
  border-radius: 20px;
  margin-bottom: 20px;
  letter-spacing: 0.5px;
}
.hero h1 {
  font-size: 44px;
  font-weight: 700;
  letter-spacing: -0.5px;
  line-height: 1.15;
  margin-bottom: 16px;
  background: linear-gradient(135deg, var(--gray-900) 0%, var(--gray-700) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.hero .subtitle {
  font-size: 19px;
  color: var(--gray-600);
  max-width: 560px;
  margin: 0 auto;
  line-height: 1.5;
}
```

---

## Stats 数据条

4个关键指标，水平排列。

```html
<div class="stats-bar">
  <div class="stat">
    <div class="number">66%</div>
    <div class="label">中标率提升</div>
  </div>
  <div class="stat">
    <div class="number">3天</div>
    <div class="label">标书准备周期缩短</div>
  </div>
  <\!-- 再加2个 -->
</div>
```

```css
.stats-bar {
  display: flex;
  justify-content: center;
  gap: 48px;
  padding: 36px 0;
  margin: 10px 0 50px;
  border-top: 1px solid var(--gray-300);
  border-bottom: 1px solid var(--gray-300);
}
.stat { text-align: center; }
.stat .number {
  font-size: 36px;
  font-weight: 700;
  color: var(--blue);
  letter-spacing: -1px;
}
.stat .label {
  font-size: 13px;
  color: var(--gray-500);
  margin-top: 4px;
  font-weight: 500;
}
```

---

## Section 区域

每个内容区块用 section 包裹。

```html
<div class="section">
  <div class="section-header">
    <div class="section-number">核心场景</div>
    <h2 class="section-title">投标项目全流程看板</h2>
    <p class="section-desc">描述文字...</p>
  </div>
  <\!-- 模拟界面 -->
  <\!-- feature 卡片（可选）-->
</div>
```

```css
.section { margin-bottom: 64px; }
.section-header { margin-bottom: 32px; }
.section-number {
  font-size: 13px;
  font-weight: 700;
  color: var(--blue);
  text-transform: uppercase;
  letter-spacing: 1.5px;
  margin-bottom: 8px;
}
.section-title {
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.3px;
  margin-bottom: 10px;
}
.section-desc {
  font-size: 16px;
  color: var(--gray-600);
  max-width: 640px;
  line-height: 1.6;
}
```

---

## 模拟界面：看板 Kanban

适用于投标管理、项目进度、订单跟踪等多阶段流转场景。

```html
<div class="mock-device">
  <div class="mock-toolbar">
    <div class="mock-toolbar-title">投标管理看板</div>
    <div class="mock-toolbar-actions">
      <div class="mock-btn">筛选</div>
      <div class="mock-btn">按截止日期排序</div>
      <div class="mock-btn primary">+ 新建投标</div>
    </div>
  </div>
  <div class="kanban">
    <div class="kanban-col">
      <div class="kanban-col-header">
        <div class="kanban-col-dot" style="background:var(--blue)"></div>
        <div class="kanban-col-name">信息收集</div>
        <div class="kanban-col-count">3</div>
      </div>
      <div class="kanban-card">
        <div class="kanban-card-title">福州某商业综合体消防改造</div>
        <div class="kanban-card-meta">
          <span>预算 ¥280 万</span>
          <span class="kanban-card-tag tag-urgent">4/20 截止</span>
        </div>
      </div>
      <\!-- 更多卡片 -->
    </div>
    <\!-- 更多列 -->
  </div>
</div>
```

看板通常4列，每列2-3张卡片。列的颜色建议：蓝→橙→紫→绿（对应阶段递进）。

标签类：`tag-urgent`（红）、`tag-normal`（橙）、`tag-done`（绿）、`tag-purple`（紫）。

```css
.mock-device {
  background: var(--gray-200);
  border-radius: var(--radius);
  padding: 24px;
  margin: 28px 0;
  position: relative;
  overflow: hidden;
}
.mock-device::before {
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent);
}
.mock-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--gray-300);
}
.mock-toolbar-title { font-size: 15px; font-weight: 600; color: var(--gray-800); }
.mock-toolbar-actions { display: flex; gap: 8px; }
.mock-btn {
  font-size: 12px; padding: 5px 12px; border-radius: var(--radius-xs);
  border: 1px solid var(--gray-300); background: #fff; color: var(--gray-700); font-weight: 500;
}
.mock-btn.primary { background: var(--blue); color: #fff; border-color: var(--blue); }

.kanban { display: flex; gap: 12px; overflow: hidden; }
.kanban-col { flex: 1; min-width: 0; }
.kanban-col-header { display: flex; align-items: center; gap: 6px; margin-bottom: 10px; padding: 0 4px; }
.kanban-col-dot { width: 8px; height: 8px; border-radius: 50%; }
.kanban-col-name { font-size: 12px; font-weight: 600; color: var(--gray-700); }
.kanban-col-count { font-size: 11px; color: var(--gray-500); margin-left: auto; }

.kanban-card {
  background: #fff; border-radius: var(--radius-sm); padding: 12px;
  margin-bottom: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.kanban-card-title { font-size: 13px; font-weight: 600; color: var(--gray-800); margin-bottom: 6px; line-height: 1.3; }
.kanban-card-meta { font-size: 11px; color: var(--gray-500); display: flex; gap: 8px; flex-wrap: wrap; }
.kanban-card-tag { font-size: 10px; padding: 2px 6px; border-radius: 4px; font-weight: 500; }
.tag-urgent { background: #FFF0F0; color: var(--red); }
.tag-normal { background: #FFF8EC; color: var(--orange); }
.tag-done { background: #F0FFF4; color: var(--green); }
.tag-purple { background: #F8F0FF; color: var(--purple); }
```

---

## 模拟界面：数据表格

适用于资质证照管理、合同台账、供应商列表等。

```html
<div class="mock-device">
  <div class="mock-toolbar">
    <div class="mock-toolbar-title">资质证照管理</div>
    <div class="mock-toolbar-actions">
      <div class="mock-btn">全部证照</div>
      <div class="mock-btn" style="color:var(--red);">即将到期 2</div>
    </div>
  </div>
  <table class="cert-table">
    <thead>
      <tr>
        <th>证照名称</th>
        <th>证照编号</th>
        <th>到期日期</th>
        <th>状态</th>
        <th>负责人</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>消防产品 3C 认证</td>
        <td>2024-CCCF-0892</td>
        <td>2026-04-28</td>
        <td><span class="status-badge status-danger">15天后到期</span></td>
        <td>张工</td>
      </tr>
      <\!-- 更多行 -->
    </tbody>
  </table>
</div>
```

状态标签：`status-ok`（绿）、`status-warn`（橙）、`status-danger`（红）。

```css
.cert-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
.cert-table th {
  background: var(--gray-200); padding: 10px 14px; text-align: left;
  font-weight: 600; color: var(--gray-700); font-size: 12px;
}
.cert-table th:first-child { border-radius: 8px 0 0 0; }
.cert-table th:last-child { border-radius: 0 8px 0 0; }
.cert-table td { padding: 10px 14px; border-bottom: 1px solid var(--gray-200); color: var(--gray-700); }
.cert-table tr:last-child td { border-bottom: none; }
.status-badge { font-size: 11px; padding: 3px 8px; border-radius: 4px; font-weight: 600; }
.status-ok { background: #F0FFF4; color: var(--green); }
.status-warn { background: #FFF8EC; color: var(--orange); }
.status-danger { background: #FFF0F0; color: var(--red); }
```

---

## 模拟界面：数据看板（图表）

适用于经营分析、投标数据、回款统计等。包含环形图、柱状图和数值卡片。

```html
<div class="mock-device">
  <div class="chart-container">
    <\!-- 环形图卡片 -->
    <div class="chart-card">
      <div class="chart-title">本季度中标率</div>
      <div class="donut-wrap">
        <div class="donut"></div>
        <div class="donut-legend">
          <div><span class="donut-legend-dot" style="background:var(--blue)"></span>中标 8 个</div>
          <div><span class="donut-legend-dot" style="background:var(--gray-300)"></span>未中标 4 个</div>
          <div style="margin-top:8px;font-weight:600;color:var(--gray-800)">较上季度 <span style="color:var(--green)">+12%</span></div>
        </div>
      </div>
    </div>
    <\!-- 柱状图卡片 -->
    <div class="chart-card">
      <div class="chart-title">月度投标金额（万元）</div>
      <div class="chart-value">1,260<span class="unit"> 万</span><span class="change">+18%</span></div>
      <div class="bar-chart" style="padding-bottom:20px;">
        <div class="bar" style="height:45%;background:var(--gray-300);"><span class="bar-label">1月</span></div>
        <div class="bar" style="height:62%;background:var(--gray-300);"><span class="bar-label">2月</span></div>
        <div class="bar" style="height:78%;background:var(--blue);opacity:0.7;"><span class="bar-label">3月</span></div>
        <div class="bar" style="height:100%;background:var(--blue);"><span class="bar-label">4月</span></div>
      </div>
    </div>
    <\!-- 数值卡片 -->
    <div class="chart-card">
      <div class="chart-title">保证金余额</div>
      <div class="chart-value">47.5<span class="unit"> 万</span></div>
      <div style="font-size:12px;color:var(--gray-600);line-height:2;">
        <div>在投项目冻结: <b style="color:var(--gray-800)">¥32.0 万</b></div>
        <div>待退还: <b style="color:var(--orange)">¥15.5 万</b></div>
        <div>本月已退: <b style="color:var(--green)">¥8.0 万</b></div>
      </div>
    </div>
  </div>
</div>
```

环形图通过 `conic-gradient` 实现。调整比例时修改角度值（360° × 百分比）和 `::after` 中的百分比文字。

```css
.chart-container { display: flex; gap: 20px; }
.chart-card {
  flex: 1; background: #fff; border-radius: var(--radius-sm);
  padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.chart-title { font-size: 12px; color: var(--gray-500); font-weight: 500; margin-bottom: 4px; }
.chart-value { font-size: 28px; font-weight: 700; color: var(--gray-900); margin-bottom: 12px; }
.chart-value .unit { font-size: 14px; color: var(--gray-500); font-weight: 500; }
.chart-value .change { font-size: 13px; color: var(--green); font-weight: 600; margin-left: 6px; }
.chart-value .change.down { color: var(--red); }

.bar-chart { display: flex; align-items: flex-end; gap: 6px; height: 80px; }
.bar { flex: 1; border-radius: 4px 4px 0 0; position: relative; }
.bar-label {
  position: absolute; bottom: -18px; left: 50%; transform: translateX(-50%);
  font-size: 9px; color: var(--gray-500); white-space: nowrap;
}

.donut-wrap { display: flex; align-items: center; gap: 16px; }
.donut {
  width: 80px; height: 80px; border-radius: 50%; position: relative;
  background: conic-gradient(var(--blue) 0deg 237.6deg, var(--gray-300) 237.6deg 360deg);
}
.donut::after {
  content: '66%'; position: absolute; inset: 14px; background: #fff; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; font-weight: 700; color: var(--gray-800);
}
.donut-legend { font-size: 12px; color: var(--gray-600); line-height: 2; }
.donut-legend-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px;
}
```

---

## 模拟界面：审批流程

适用于 OA 审批、采购审批等场景。

```html
<div class="mock-device">
  <div class="approval-detail">
    <div class="approval-detail-header">
      <h3>采购申请审批</h3>
      <span>申请人：王明 · 2026-04-10</span>
    </div>
    <div class="approval-detail-body">
      <div class="approval-field">
        <div class="approval-field-label">采购物资</div>
        <div class="approval-field-value">消防管件 DN100</div>
      </div>
      <div class="approval-field">
        <div class="approval-field-label">金额</div>
        <div class="approval-field-value">¥45,800</div>
      </div>
      <div class="approval-field">
        <div class="approval-field-label">供应商</div>
        <div class="approval-field-value">泉州鑫达管业</div>
      </div>
      <div class="approval-field">
        <div class="approval-field-label">审批状态</div>
        <div class="approval-field-value"><span class="status-badge status-ok">已通过</span></div>
      </div>
    </div>
  </div>
</div>
```

```css
.approval-detail {
  background: #fff; border-radius: var(--radius-sm); overflow: hidden;
  box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.approval-detail-header {
  padding: 16px 20px; background: linear-gradient(135deg, #1E6FD9 0%, #2E56E1 100%); color: #fff;
}
.approval-detail-header h3 { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.approval-detail-header span { font-size: 12px; opacity: 0.8; }
.approval-detail-body { padding: 16px 20px; }
.approval-field {
  display: flex; padding: 8px 0; border-bottom: 1px solid var(--gray-200); font-size: 13px;
}
.approval-field:last-child { border-bottom: none; }
.approval-field-label { width: 100px; color: var(--gray-500); font-weight: 500; flex-shrink: 0; }
.approval-field-value { color: var(--gray-800); }
```

---

## Feature 功能卡片

2x2 网格，放在核心场景的模拟界面下方。

```html
<div class="features">
  <div class="feature-card">
    <div class="feature-icon" style="background:#FFF0F0;">&#128276;</div>
    <h4>资质到期三级预警</h4>
    <p>3C 认证、检验报告到期前 60/30/7 天自动提醒，杜绝废标风险</p>
  </div>
  <\!-- 3 more cards -->
</div>
```

图标使用 HTML 实体（emoji），背景色用对应的淡色：
- 红色系：`background:#FFF0F0;`
- 绿色系：`background:#F0FFF4;`
- 蓝色系：`background:#F0F7FF;`
- 紫色系：`background:#F8F0FF;`

```css
.features { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 24px 0; }
.feature-card {
  background: var(--gray-100); border-radius: var(--radius-sm); padding: 24px;
  border: 1px solid var(--gray-200);
}
.feature-icon {
  width: 36px; height: 36px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; margin-bottom: 14px;
}
.feature-card h4 { font-size: 15px; font-weight: 600; margin-bottom: 6px; color: var(--gray-800); }
.feature-card p { font-size: 13px; color: var(--gray-600); line-height: 1.5; }
```

---

## 九宫格场景卡片

3x3 网格。注意加 `class="section-last"` 到包裹的 section 上，用于 print 分页控制。

```html
<div class="section section-last">
  <div class="section-header">
    <div class="section-number">更多场景</div>
    <h2 class="section-title">投标之外，还能做更多</h2>
    <p class="section-desc">在考勤的基础上，逐步延伸到更多业务场景。</p>
  </div>
  <div class="scene-grid">
    <div class="scene-card">
      <div class="scene-icon">&#128176;</div>
      <h4>工程项目盈亏分析</h4>
      <p>每个项目赚了多少、亏了多少<br>材料费、人工、外协一笔笔算清<br><b style="color:var(--gray-700)">不等结项才发现超支</b></p>
    </div>
    <\!-- 8 more cards -->
  </div>
</div>
```

```css
.scene-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin: 24px 0; }
.scene-card {
  background: var(--gray-100); border-radius: var(--radius-sm); padding: 28px 22px;
  border: 1px solid var(--gray-200); text-align: center;
}
.scene-card .scene-icon { font-size: 32px; margin-bottom: 14px; }
.scene-card h4 { font-size: 15px; font-weight: 600; margin-bottom: 8px; color: var(--gray-800); }
.scene-card p { font-size: 12px; color: var(--gray-600); line-height: 1.5; }
```

---

## Highlight Box

```html
<div class="highlight-box">
  <h3>基于钉钉平台，分步实施、按需推进</h3>
  <ul class="highlight-list">
    <li>已有考勤基础，无需重新部署，直接在现有环境上扩展</li>
    <li>优先上线投标管理，快速见效，再逐步覆盖其他业务线</li>
    <li>手机端随时操作，两个厂区、外出工地都能用</li>
    <li>泉州本地服务团队，上门调研、面对面培训、持续运维</li>
  </ul>
</div>
```

```css
.highlight-box {
  background: linear-gradient(135deg, #F0F7FF 0%, #E8F4FD 100%);
  border-radius: var(--radius); padding: 32px; margin: 32px 0;
  border: 1px solid #D0E6F7;
}
.highlight-box h3 { font-size: 18px; font-weight: 700; color: var(--gray-900); margin-bottom: 14px; }
.highlight-list { list-style: none; }
.highlight-list li {
  font-size: 14px; color: var(--gray-700); padding: 6px 0; padding-left: 20px; position: relative;
}
.highlight-list li::before {
  content: ''; position: absolute; left: 0; top: 12px;
  width: 8px; height: 8px; border-radius: 50%; background: var(--blue);
}
```

---

## Footer

```html
<div class="footer">
  <div class="footer-logo">开沿科技</div>
  <div class="footer-desc">钉钉官方授权服务商 · 泉州本地化服务</div>
  <div class="footer-contact">
    服务顾问：<span>{服务顾问姓名}</span>
  </div>
</div>
```

```css
.footer {
  text-align: center; padding: 48px 0 60px; margin-top: 40px;
  border-top: 1px solid var(--gray-300);
}
.footer-logo { font-size: 20px; font-weight: 700; color: var(--gray-900); margin-bottom: 8px; }
.footer-desc { font-size: 13px; color: var(--gray-500); margin-bottom: 20px; }
.footer-contact { font-size: 14px; color: var(--gray-700); }
.footer-contact span { color: var(--blue); font-weight: 600; }
```

---

## Print 媒体查询

这段 CSS 必须包含在每个生成的 HTML 中。它解决了 PDF 输出时的间距、分页和字体大小问题。

```css
@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { max-width: none; padding: 0 24px; }

  /* 压缩首屏间距 */
  .hero { padding: 36px 0 20px; }
  .hero h1 { font-size: 36px; }
  .hero .subtitle { font-size: 16px; }
  .hero .tag { margin-bottom: 12px; }
  .stats-bar { padding: 20px 0; margin: 6px 0 24px; gap: 36px; }
  .stat .number { font-size: 28px; }

  /* 全局间距压缩 */
  .section { margin-bottom: 28px; }
  .section-header { margin-bottom: 16px; }
  .section-title { font-size: 24px; }
  .section-desc { font-size: 14px; }
  .divider { margin: 20px auto; }
  .mock-device { padding: 16px; margin: 16px 0; }
  .features { gap: 10px; margin: 14px 0; }
  .feature-card { padding: 16px; }
  .feature-card h4 { font-size: 13px; }
  .feature-card p { font-size: 11px; }
  .feature-icon { width: 28px; height: 28px; font-size: 14px; margin-bottom: 8px; }

  /* 看板卡片压缩 */
  .kanban-card { padding: 8px 10px; margin-bottom: 6px; }
  .kanban-card-title { font-size: 11px; margin-bottom: 4px; }
  .kanban-card-meta { font-size: 10px; }
  .kanban-col-name { font-size: 11px; }

  /* 表格压缩 */
  .cert-table th, .cert-table td { padding: 6px 10px; font-size: 11px; }

  /* 图表压缩 */
  .chart-container { gap: 12px; }
  .chart-card { padding: 14px; }
  .chart-title { font-size: 11px; }
  .chart-value { font-size: 22px; margin-bottom: 8px; }

  /* 更多场景 - 独立成页 */
  .section-last { page-break-before: always; padding-top: 12px; margin-bottom: 12px; }
  .section-last .section-header { margin-bottom: 16px; }
  .section-last .section-title { font-size: 24px; }
  .scene-grid { gap: 10px; margin: 14px 0; }
  .scene-card { padding: 14px 12px; }
  .scene-card .scene-icon { font-size: 22px; margin-bottom: 6px; }
  .scene-card h4 { font-size: 12px; margin-bottom: 4px; }
  .scene-card p { font-size: 10px; line-height: 1.4; }

  /* highlight box */
  .highlight-box { padding: 20px 24px; margin: 20px 0 12px; }
  .highlight-box h3 { font-size: 15px; margin-bottom: 10px; }
  .highlight-list li { font-size: 12px; padding: 3px 0 3px 18px; }

  /* footer 紧跟 highlight，不分页 */
  .footer { padding: 16px 0 0; margin-top: 8px; border-top: none; }
  .footer-logo { font-size: 16px; }
  .footer-desc { font-size: 11px; margin-bottom: 8px; }
  .footer-contact { font-size: 12px; }

  /* 分页控制 */
  .mock-device { page-break-inside: avoid; }
  .features { page-break-inside: avoid; }
  .scene-grid { page-break-inside: avoid; }
  .chart-container { page-break-inside: avoid; }
  .highlight-box { page-break-inside: avoid; page-break-after: avoid; }
  .footer { page-break-inside: avoid; page-break-before: avoid; }
}
```

如果生成 PDF 后发现分页问题，优先调整 print 媒体查询中的间距值，而不是修改网页版样式。
