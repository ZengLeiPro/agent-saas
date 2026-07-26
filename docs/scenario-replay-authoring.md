# 场景演示剧本写作规范

> 2026-07-26 立。依据是把产品里的演示与三家客户单页 demo（强力巨彩 / 三钢 / 瑞芯微，共 100 张实机截图）逐屏对照后的结论。
> 目标读者：给场景库里剩下的 20 多个场景写演示剧本的人。
> 参照实现：`web/src/components/scenarios/replay/complianceGateScript.ts`（照这个骨架抄）。

---

## 0. 一句话

**自动投影只保底，说服力靠手写。**

`presentationToReplayScript` 会把任何带 `presentation` 的场景机械投影成回放：每章固定「一个工具块 + 一句正文」，7 步长得一模一样。它的价值是让没人写剧本的场景也有东西可看，**不是**拿去给客户演。真正要演的场景必须手写剧本，登记进 `replay/registry.ts` 的 `SCRIPTS`。

判断标准很简单：**这个场景会不会被销售拿去讲？** 会，就手写。

---

## 1. 四要素（缺一不可）

三家客户 demo 里最有说服力的画面，没有一个是"AI 做对了"。逐屏统计后收敛成四条，每个剧本必须四条齐全：

| 要素 | 它证明什么 | 客户 demo 里的原型 |
|---|---|---|
| **① 主动拒绝 / 拦截** | AI 知道自己的边界，不会乱翻数据、不会越权写系统 | 瑞芯微场景 3：红色「已拦截」+「这条我不能查，也不会绕」+ 权限矩阵打叉 + 合规替代路径 |
| **② 视角切换** | 结果是真的送到对方手上了，不是 AI 自称做完了 | 瑞芯微场景 1 第 7 步：右栏整块变成德国客户此刻打开的英文下载页 |
| **③ 跨系统一致性核对** | 几个系统的说法对得上，不是单点写入 | 三家的终态卡；我们用 markdown 表格 + 右侧 summary 视图 |
| **④ 可下载产物** | 客户能把东西带走，演示不是幻灯片 | 各家的产物卡；我们走 `artifacts` + `[FILE]` 标记，已验证可预览可下载 |

实现位置：
- ① 工具块 `presentation.status: "blocked"`（渲染成红色「已拦截」）+ 正文写清替代路径 + 面板补一个权限/规则视图
- ② 用 `artifacts` 放一份"对方视角"的 HTML（报关行看到的页面、客户收到的邮件、供应商打开的对账单），正文里用 `[FILE]` 标记引出来；客户点开右侧就是对方的屏幕
- ③ 终态正文用 markdown 表格（`| 系统 | 终态 | 依据 |`），右侧同步一个 table 视图
- ④ `artifacts` + `[FILE]{"filePath":"...","fileName":"...","fileSize":N}[/FILE]`，`fileSize` 用 `new TextEncoder().encode(HTML).length` 算真值

### 三个加分项（强烈建议）

- **人改掉 AI 的结论并被记账**（三钢 demo8 最强一屏）：审批步的 `approvedBlocks` 里先放一个 `kind: "prompt"` 写人的原话，再跟一个 Approval 工具块，detail 写「采纳 N 项 · 修改 M 项 · 自动执行 0 项」
- **跨场景交叉引用**（三钢 demo3 引 demo1 决议③）：产出物带稳定编号，另一个剧本引用它。一屏论证"企业记忆"，成本几乎为零
- **主动示弱块**：「这两项我不替你判断」「缺少 X，已阻断」。客户对这类块的信任度高于任何成功画面

---

## 2. 骨架

```
web/src/components/scenarios/replay/
  types.ts                     契约（别改，除非确实缺表达力）
  registry.ts                  注册表：手写剧本写进 SCRIPTS
  presentationReplayScript.ts  自动投影（保底，不要往里塞特例）
  complianceGateScript.ts      ← 参照实现
  <yourScenario>Script.ts      你的新剧本
```

新剧本三步：
1. 新建 `xxxScript.ts`，导出 `xxxScript: ReplayScript`
2. `registry.ts` 里 import 并加进 `SCRIPTS`
3. `scenarioId` 必须精确等于场景库里的 catalog id（`server/src/data/scenarios/workflow-library-v3.json` 的 `catalogScenarios[].id`），否则卡片上不会出现「看它如何完成」

---

## 3. 契约速查

### 一步 = 一次按键

```ts
{ caption: "回放条上显示的这一步在做什么", blocks: [...], approval?: {...} }
```

`blocks` 是**真实的** `ApiTranscriptBlock`，回放时走 `mapSessionDetailToMessages → MessageList → MessageItem → ToolBlock`，与真实会话同一条渲染管线，且强制 `debugModeOverride={false}`。

**这是物理约束，不是风格建议**：演示能表达的形态 = 真实会话能表达的形态。想让演示更好看，只能去改真实渲染器——不许为演示单开视图。

常用 block kind：`prompt`（人说话）/ `tool_use`（Agent 动手）/ `tool_result`（原始返回，客户看不到，debug 才看）/ `text`（Agent 说话）。

### 工具摘要 `presentation`

```ts
{
  title: "业务语言的一句话",          // 客户看到的就是它，不是工具名
  detail: [...],                     // 展开后的明细
  status: "ok" | "warn" | "blocked" | "waiting",
  receipt: { id, system, readBack },  // 写操作回执，渲染成「回执 · 回读校验通过」
  panelBase: {...},                   // 只有第一条生效
  panel: [...],                       // 本步对右侧面板的增量
}
```

`detail` 五种行，混着用才有节奏：

| 写法 | 渲染 | 用在哪 |
|---|---|---|
| `"整句话"` | 纯文本行 | 一句话说明，通常放第一行 |
| `{ k, v }` | 键值对齐 | 关键字段 |
| `{ tree: "├" \| "└", k, v }` | 树形键值 | 同一组字段的后续行，最后一行用 `└` |
| `{ no: 1, text }` | `① 文本` | 逐条判定结论 |
| `{ indent: 0, text }` | 缩进文本 | 警告行（`⚠ …`） |

**禁止**把 `JSON.stringify` 的东西塞进 detail。观众是业务负责人。

### 右侧面板

- 视图上限 **6**，按「被仿真的系统」命名（证据台账 / 权限矩阵 / 分发与回执 / 操作留痕），不要按界面形态命名
- widget 选择：

| 数据长什么样 | 用 | 备注 |
|---|---|---|
| 多字段多记录、要对齐比较 | `table` | 有表头、右对齐、sticky；配 `cellFlag` 做状态标记 |
| 名单/清单，每条一两行 | `rows` | 配 `badge` 与 `state: "hit"` 做高亮 |
| 消息、邮件、群通知 | `feed` | `item.card` 可以承载一张卡片 |
| 几个大数字 | `stats` | 2~4 列 |
| 独立卡片 | `cards` | |

- 每一步必须 `{ op: "focus", view }` 到**这一步真正动了的那个系统**。客户 demo 每步自动切 tab，这是"系统状态被真实改变"最强的视觉证据
- 变化标记只给这一步动到的行。上一批要降级（`cellFlag` 改 tone），否则满屏「刚刚变化」等于没标
- `foot` 写「已连接：A · B · C（演示）」

### 审批门禁

```ts
approval: {
  title, description, facts: [{label, value}],
  approveLabel: "确认放行",
  rejectLabel: "退回修改",
  approvedBlocks: [...],   // 批准后追加，人的原话放这里
  rejectedBlocks: [...],   // 退回后追加 —— 别让退回变成死路
}
```

未批准时「下一步」变灰、空格与方向键都推不动。**三家客户 demo 的「退回修改」都是只弹 toast 的死按钮，我们的退回是真状态机，这是我们比它们强的地方，别丢。**

---

## 4. 文案红线

1. **第一句提问必须是自然业务语言。** 「下周要发一批货去德国，客户催合规文件」✅；「请启动『xx 工作流』。先说明当前可直接完成的范围…」❌（这是给 Agent 的指令模板，客户读着像念咒）
2. **同一句话不许在一屏里出现两次。** 工具摘要写了「完成后 X」，正文就别再写一遍「这一步完成后：X」
3. **`**加粗**` 后面不要紧跟中文全角冒号。** `**业务结果：**` 会渲染成字面星号（CommonMark 定界符不闭合），必须写 `**业务结果**：`
4. **不写技术归因。** 客户面不出现「上游」「超时」「500」这类词；失败就说业务话
5. **不加"这是演示"的说明文案。** 底部回放条本身就是标识（曾磊 07-25 拍板）
6. **数据全部虚构但要具体**：有编号、有日期、有金额、有时限。「XX 公司」这种占位一眼假
7. **不出现真实客户名**（强力巨彩/三钢/瑞芯微/唯恩等一律不写进产品）

---

## 5. 治理条款：`sources`

每个 `tool_use` 块都要在 `sources` 里有一条：

```ts
{ blockRef: "step3.tool.FinanceQuery", producer: "独立范围门禁", state: "needs-change", gap: "…还缺什么" }
```

`state` 三选一：
- `exists`：今天的真实会话已经能产出
- `needs-change`：产出方存在，但要改造才会输出这份摘要
- `missing`：产出方根本不存在

**诚实第一。** 产品里没有的连接器就写 `missing`，不许美化。这张表加起来就是"演示到真实"的距离，也是报价与排期的依据。

历史教训：`[CITE]` 引用溯源卡有解析器、有组件、有 30 处测试，因为没有任何产出方，零使用四个月。缺的不是代码，是这张表。

---

## 6. 发布前自检

- [ ] `scenarioId` 与场景库 catalog id 精确一致，卡片上出现了「看它如何完成」
- [ ] 第 1 步在 `prompt` 之后**立刻**有带 `panelBase` 的 `tool_use`（否则首屏右侧一片空白）
- [ ] 四要素齐：拒绝 / 视角切换 / 跨系统核对 / 可下载产物
- [ ] 至少一个审批步，且 `rejectedBlocks` 写了退回后的下文
- [ ] 每步 `focus` 到该步动的系统，视图 ≤ 6
- [ ] 变化标记只在本步的行上，上一批已降级
- [ ] 终态两栏：「改变了什么」+「没有做什么」
- [ ] 没有重复文案、没有 `**xx：**`、没有技术归因、没有真实客户名
- [ ] 每个工具块都有 `sources` 条目，非 exists 都写了 gap
- [ ] `cd web && npx tsc --noEmit` 干净；`NODE_ENV=test npx vitest run src/components/scenarios` 全绿

---

## 7. 批量转 20+ 场景的建议顺序

1. **先按销售价值排序，不按场景库顺序。** 优先写销售这个月真的会讲的 3~5 个
2. **同一行业的场景共用一套虚构主数据**（同一家虚构公司、同一批订单号），这样多个剧本之间能互相引用，「企业记忆」自然成立
3. **一个剧本 7~8 步**。少于 6 步撑不起闭环，多于 10 步销售讲不完
4. **产物 HTML 可以复用模板**：把 `complianceGateScript.ts` 里那份的 CSS 抄走，换内容即可（必须单文件自包含，沙箱 CSP 禁外链）
5. 写完一个就注册一个、跑一次 tsc 与测试，不要攒一批再合
