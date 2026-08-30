# 小红书聚光完整数据查询与分析手册

本手册面向 `azeroth xiaohongshu` 动态数据集能力。目标不是“能拿到几张日报”，而是把 **目录发现 → 参数理解 → 单页探测 → 全量分页导出 → 覆盖核对 → 分层分析** 做成可复核闭环。

## 1. 能力边界

- 数据由 ky-azeroth 服务端 registry 统一登记；CLI 不保存固定数据集清单。registry 后续新增数据集时，Agent 通过 `datasets` 自动发现。
- 目录包含本地同步日报（`source=local_report`）与聚光官方 API（`source=official_api`）。两者可能描述同一事实层，不能相加。
- `queryable=false` 表示当前身份/连接下不能安全查询，常见原因包括缺 scope、白名单、额外授权、账户角色、必需上下文或待验证契约。它不等于“业务数据为 0”。
- CLI 和服务端使用当前会话用户的 PAT/RBAC；不得切换账号、绕过权限或直连数据库。
- 所有查询都是只读。目录中即使出现带“校验、推荐、映射”含义的接口，也只允许通过 registry 已声明的只读查询入口调用。

## 2. 目录与单项契约

### 2.1 发现连接、广告主和目录

```bash
azeroth xiaohongshu connection
azeroth xiaohongshu advertisers
azeroth xiaohongshu datasets --advertiser-id <advertiserId>
```

`--advertiser-id` 很重要：同一租户可能有多条连接，必须按目标广告主所属连接解析真实 scopes，不能借用另一条连接的权限。

目录关键字段：

| 字段                      | 含义                               | Agent 用法                                                 |
| ------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `id`                      | 稳定数据集标识                     | 传给 `describe-dataset/query-dataset`，不要自行拼 endpoint |
| `label/group/description` | 业务语义                           | 用于覆盖矩阵与数据集选择                                   |
| `source`                  | `official_api` / `local_report`    | 判断来源与潜在重叠                                         |
| `queryable`               | 当前连接下是否可查询               | 只对 true 项发查询；false 项记录边界                       |
| `availability`            | 可用性分类                         | 区分缺 scope、白名单、角色、上下文等原因                   |
| `availabilityReason`      | 具体限制                           | 原样写入覆盖报告，不要改写成“无数据”                       |
| `requiredScope`           | 所需 OAuth scope                   | 与目录顶层 `scopes` 对照                                   |
| `method/endpoint`         | 服务端已批准的官方调用契约         | 仅用于诊断，不绕过 ky-azeroth 直调                         |
| `parameters`              | 参数名、来源、类型、必填性、枚举   | 构造 query JSON 的第一信源                                 |
| `allowsAdditionalParams`  | 是否允许 `params` 透传官方扩展参数 | 额外参数仍需来自官方契约/错误反馈，不能猜                  |
| `pagination`              | 官方分页形态                       | CLI/服务端负责适配，Agent 统一用 `page/pageSize`           |
| `supportsDateRange`       | 是否接受日期范围                   | true 时分析任务应显式给日期                                |
| `supportsDataCaliber`     | 是否接受数据口径                   | true 时显式选择并在报告标注 0/1                            |
| `defaults`                | registry 安全默认值                | 不要在 `params` 中无意覆盖                                 |
| `coreFields`              | 预期核心字段                       | 与实际响应 `fields` 交叉核对                               |

### 2.2 单项描述

```bash
azeroth xiaohongshu describe-dataset <datasetId> --advertiser-id <advertiserId>
```

在写查询 JSON 前必须读描述，尤其检查：

1. `queryable` 是否为 true；
2. `parameters` 中所有 `required=true` 项；
3. 参数应放在请求顶层（`source=request`）还是 `params` 内（`source=params`）；
4. 日期、口径与分页支持；
5. `defaults/coreFields`。

数据集 ID 只接受小写点分/连字符格式；路径、斜杠、大写或自行拼接的 ID 会在 CLI 发 HTTP 前被拒绝。

## 3. 查询 JSON 契约

通用结构：

```json
{
  "advertiserId": "广告主ID",
  "startDate": "2026-08-01",
  "endDate": "2026-08-29",
  "dataCaliber": 0,
  "page": 1,
  "pageSize": 100,
  "params": {}
}
```

规则：

- `advertiserId` 必填，必须来自 `advertisers` 返回值。
- `startDate/endDate` 格式为 `YYYY-MM-DD`，必须成对且正序；只有描述声明 `supportsDateRange=true` 时才允许传入，否则服务端拒绝。
- `dataCaliber`：`0` 为计费/点击时间口径，`1` 为转化时间口径。不要把两种口径的数值直接合并。
- `page` 从 1 开始；`pageSize` 为 1—100。`--all` 要求 JSON 中 `page=1`，失败续传改用 `--resume-from-page`。
- 数据集专属参数放在 `params`。服务端会强制覆盖广告主、分页、日期和口径，防止嵌套参数伪造这些控制字段。
- 未知顶层字段会被拒绝；必填 `params` 值不能是空字符串、空数组或空对象，并严格按 `parameters[].valueType` 校验类型；`local_report` 不接受无意义的 `params`。
- 不知道参数含义时停止并查描述/官方契约；不要用看似合理的字符串或 ID 试撞。

带上下文参数示例（以实际描述为准）：

```json
{
  "advertiserId": "广告主ID",
  "page": 1,
  "pageSize": 100,
  "params": {
    "note_ids": ["真实笔记ID"]
  }
}
```

## 4. 单页探测与全量导出

### 4.1 先探一页

```bash
azeroth xiaohongshu query-dataset <datasetId> --json <query.json> > <datasetId>.probe.json
```

单页响应关键字段：

- `dataset`：查询时刻的数据集契约与可用性；
- `fields`：本页实际字段的 key、中文标签、业务组、值类型、是否核心；
- `items`：规范化后的行数据，保留官方未知字段；
- `total/totalMode`：精确总数或保守估算；`estimated` 不能冒充精确值；
- `hasMore/page/pageSize/totalPages`：分页状态；判停以 `hasMore` 为第一信源；
- `aggregation`：官方汇总数据，不能丢；
- `metadata`：兼容性提示、统计口径、分页附加信息等；
- `requestId`：官方请求追踪标识，异常排查必须保留；
- `fetchedAt`：服务端取数时刻。

先用 probe 核对字段、单位、空值、官方兼容性提示和聚合口径。probe 不是全量数据，不得直接用于“完整分析”。

### 4.2 全量 NDJSON + metadata sidecar

```bash
azeroth xiaohongshu query-dataset <datasetId> \
  --json <query.json> \
  --all --page-size 100 \
  --output <datasetId>.ndjson \
  --metadata-output <datasetId>.metadata.json
```

全量模式要求 `--json` 指向可重新读取的文件（不接受 `-`/stdin），且必须提供文件型 `--output`；失败续传才能独立执行。若省略 `--metadata-output`，默认写 `<output>.metadata.json`，两者不得是同一路径。

- NDJSON 每行只包含一个 `item`，便于 DuckDB 直接读取。
- sidecar 顶层 `dataset.coreFields` 保存预期核心字段，顶层 `fields` 保存实际响应字段并集；每页的汇总、附加元数据与追踪标识分别位于 `pages[].aggregation`、`pages[].metadata`、`pages[].requestId`。
- sidecar 的 `ndjson` 保存 SHA-256、字节数和行数；`pages[]` 保存连续页检查点、每页行数、总数模式、`hasMore` 与取数时间。
- `status=running` 表示尚未结束；`failed` 表示半成品；只有 `complete` 才能作为全量分析输入。
- 无分页接口由服务端明确返回 `hasMore=false`，即使一次恰好返回 100 行也不会误拉下一页。
- 官方未返回精确总数时，CLI 仍按 `hasMore` 拉到底；sidecar 中保留 `totalMode=estimated`，不要把中间页估算值写成官方总量。CLI 同时校验响应页码/页大小并设置最大页保护，防止上游忽略分页导致无界拉取。

### 4.3 失败续传

失败时 CLI 会：

1. 保留已写入的 NDJSON；
2. 把 sidecar 标记为 `failed`；
3. 在 stderr 输出完整 `Resume with:` 命令。

原样执行该命令。续传会校验 sidecar schema、完整查询契约（含日期、口径、分页大小和 `params`）、输出路径、连续页记录、预期下一页，以及 NDJSON 已提交前缀的 SHA-256/字节数/行数。崩溃后若文件尾部存在未提交行，会先安全截断到最后检查点，再从失败页 append，避免重复或跳页。

不要手工改成“从下一页开始”：失败页不属于已提交检查点。也不要修改 NDJSON/sidecar 或删除 sidecar 后盲目 append；校验失败时应重新导出。

## 5. “完整分析”的覆盖矩阵

在分析前建立一份 manifest，至少包含：

| datasetId | label | source | queryable | exported | rows | startDate | endDate | dataCaliber | status/reason |
| --------- | ----- | ------ | --------: | -------: | ---: | --------- | ------- | ----------: | ------------- |

判断规则：

- `queryable=false`：`exported=false`，reason 原样记录 `availability/availabilityReason`；
- `queryable=true` 但需要 `params` 上下文：先标记 `waiting_context`，从基础数据集取得真实 ID 后再查询；
- 已导出但 sidecar 非 `complete`：标记 `partial_failed`，不进入全量汇总；
- `complete` 且 0 行：才能标记为真实空结果，但仍需保留查询日期与口径；
- 目录自身也要保存为快照，便于解释为何某些维度缺失。

不要机械并发轰炸所有数据集。推荐分层：

1. **连接与基础对象**：账户、计划、单元、创意、笔记、广告组等；
2. **事实报表**：账户/计划/单元/创意/笔记/关键词/搜索词等离线或实时表现；
3. **依赖上下文的数据集**：从前两层取得 `campaign_group_ids`、`note_id(s)`、`unit_id`、`taxonomy_id` 等真实值后查询；
4. **受限数据集**：只登记限制，不通过猜参数、换账号或直调官方 endpoint 绕过。

如果用户只问一个具体问题，只查询能回答该问题的最小相关数据集；“完整”是覆盖可解释，不是请求数量越多越好。

## 6. 聚光分析框架

### 6.1 先定唯一事实层

账户、计划、单元、创意/笔记、关键词/搜索词通常是同一份消费与转化的不同切片。总消耗、总曝光、总点击、总转化只在一个明确事实层计算；其它层用于解释贡献和定位问题。跨层相加会重复计算。

本地日报与官方离线报表也可能重叠：

- 本地日报适合与既有看板/历史同步口径对齐；
- 官方报表适合取完整原始字段与即时查询范围；
- 两者用于核对差异，不相加，也不按日、账户或其它键做 `COALESCE`/“官方优先、本地补缺”的混合事实表；同步延迟、归因窗口和补数机制不同会让这种拼接制造不可解释的混合口径。
- 总量必须对整个查询范围选择一个 `complete` 来源作为唯一事实层。首选来源不完整时，可以把另一个完整来源整体替换为事实层并明确降级理由；若没有任何单一完整来源，就只能报告覆盖缺口，不能产出号称完整的拼接总量。

### 6.2 建议分析顺序

1. **投放总览**：消费、曝光、点击、互动、咨询/线索/表单/下单等核心转化；
2. **时间趋势**：按天观察预算消耗、流量、转化与成本变化，标记异常日；
3. **层级归因**：计划 → 单元 → 创意/笔记，找贡献集中度、低效消耗和断层；
4. **搜索意图**：关键词与真实搜索词对照，发现高转化词、浪费词和否词机会；
5. **内容诊断**：笔记/创意的曝光—点击—互动—咨询漏斗，结合审核/状态/素材属性；
6. **配置核对**：预算、出价、状态、定向、落地页与实际表现是否一致；
7. **覆盖与风险**：说明不可查询维度、缺失字段、估算总数、兼容性提示及 requestId。

### 6.3 指标计算纪律

只在 sidecar/字段说明确认字段与单位后计算。常见公式（字段存在时）：

- CTR = 点击 / 曝光；
- CPC = 消耗 / 点击；
- CPM = 消耗 / 曝光 × 1000；
- 咨询转化率 = 咨询 / 点击；
- 咨询成本 = 消耗 / 咨询；
- 线索/表单/下单成本同理。

分母为 0 时返回 NULL/“不可计算”，不要伪造 0%。消费金额的单位、归因窗口和转化定义以官方响应 metadata/字段说明为准，不凭经验猜。

### 6.4 DuckDB 读取

```sql
CREATE OR REPLACE VIEW xhs_keyword AS
SELECT *
FROM read_json_auto(
  '.cache/azq/<session>/xiaohongshu/report.keyword.offline.ndjson',
  format='newline_delimited'
);
```

字段动态且可能稀疏：先读 sidecar 的 `fields`，再写 SQL；遇到类型推断冲突时改用 `read_json(..., columns={...})` 显式声明。SQL 仍遵循 skill 的 print-then-execute 约定。

## 7. 完成前检查

- [ ] 保存 connection、advertisers 和 catalog 快照；
- [ ] 每个使用的数据集都保存 describe/probe 或 sidecar 契约；
- [ ] 所有全量输入 sidecar 均为 `complete`；
- [ ] 查询日期、时区、dataCaliber 和广告主明确；
- [ ] 不可查询项与 0 行结果严格区分；
- [ ] 无本地日报/官方报表、不同层级重复求和，亦无跨来源按日/按键补缺拼接；
- [ ] 必需上下文来自真实上游数据，不是猜测；
- [ ] 核心字段缺失、官方 metadata 警告和 requestId 已记录；
- [ ] 报告包含覆盖矩阵、结论、证据、限制与下一步，而不只是原始表格。
