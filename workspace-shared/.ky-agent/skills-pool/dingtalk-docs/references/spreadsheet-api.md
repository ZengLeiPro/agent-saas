# 钉钉电子表格 API 参考

> MCP 工具前缀：`dingtalk-sheet`
> 调用格式：`SHEET <tool> --args '{ ... }' --output json`
> 电子表格访问地址：`https://alidocs.dingtalk.com/i/nodes/{dentryUuid}`

`SHEET` 是 `mcporter --config <skill_dir>/mcporter.json call dingtalk-sheet` 的简写；`<skill_dir>` 必须由当前 skill 根目录解析，不能写死 `.claude/skills/...`：

```bash
SHEET = mcporter --config <skill_dir>/mcporter.json call dingtalk-sheet
```

钉钉电子表格 MCP 服务当前提供 **37 个工具**，覆盖工作表管理、单元格读写、行列维度操作、合并、筛选、筛选视图、下拉列表、图片插入与异步导出。

---

## 核心概念

| 概念 | 说明 |
|------|------|
| `nodeId` | 电子表格文档标识。支持文档链接 URL（`https://alidocs.dingtalk.com/i/nodes/{dentryUuid}`）或 32 位 `dentryUuid` 字符串，系统自动识别 |
| `sheetId` | 工作表 ID 或名称，可通过 `get_all_sheets` 获取。多数接口同时接受 `id` 和 `name` |
| `range` / `rangeAddress` | 单元格地址，Excel A1 表示法。支持带工作表前缀（如 `Sheet1!A1:D10`），此时前缀覆盖 `sheetId` 参数 |
| `column`（筛选条件中） | 列偏移量，**0-based**，相对于筛选范围的起始列 |
| `dimension` | 行列维度，枚举 `ROWS` / `COLUMNS`（大写） |
| `position` / `startIndex`（维度操作） | 行号 / 列字母，`ROWS` 时为 1-based 行号字符串（如 `"3"`），`COLUMNS` 时为列字母（如 `"A"`、`"AB"`） |
| `index`（工作表索引） | 工作表的位置索引，**0-based** |

> 权限：所有读取操作要求"可阅读"，写操作要求"可编辑"，均不支持跨组织访问。

---

## 工具目录

### 工作表管理（6 个）
| # | 工具 | 说明 |
|---|------|------|
| 1 | [create_workspace_sheet](#create_workspace_sheet) | 在知识库/文件夹/我的文档下新建电子表格文件 |
| 2 | [get_all_sheets](#get_all_sheets) | 列出表格内所有工作表 |
| 3 | [get_sheet](#get_sheet) | 获取单个工作表详情 |
| 4 | [create_sheet](#create_sheet) | 新增工作表 |
| 5 | [update_sheet](#update_sheet) | 重命名/移位/隐藏/冻结工作表 |
| 6 | [copy_sheet](#copy_sheet) | 在同一表格内复制工作表 |

### 单元格读写（5 个）
| # | 工具 | 说明 |
|---|------|------|
| 7 | [get_range](#get_range) | 读取单元格区域（值/公式/显示值） |
| 8 | [update_range](#update_range) | 写入区域：值、公式、超链接、格式 |
| 9 | [append_rows](#append_rows) | 在数据末尾追加若干行 |
| 10 | [find_cells](#find_cells) | 查找匹配的单元格地址 |
| 11 | [replace_all](#replace_all) | 全局查找替换 |

### 行列维度（5 个）
| # | 工具 | 说明 |
|---|------|------|
| 12 | [add_dimension](#add_dimension) | 在末尾追加空行/空列 |
| 13 | [insert_dimension](#insert_dimension) | 在指定位置之前插入行/列 |
| 14 | [delete_dimension](#delete_dimension) | 从指定位置开始删除行/列 |
| 15 | [update_dimension](#update_dimension) | 批量设置行高/列宽/显隐 |
| 16 | [move_dimension](#move_dimension) | 移动一段连续行/列到目标位置 |

### 合并 / 取消合并（2 个）
| # | 工具 | 说明 |
|---|------|------|
| 17 | [merge_cells](#merge_cells) | 合并单元格区域 |
| 18 | [unmerge_range](#unmerge_range) | 取消范围内的合并 |

### 筛选 Filter（7 个）
| # | 工具 | 说明 |
|---|------|------|
| 19 | [get_filter](#get_filter) | 获取当前工作表的筛选信息 |
| 20 | [create_filter](#create_filter) | 创建筛选 |
| 21 | [update_filter](#update_filter) | 批量更新多列筛选条件 |
| 22 | [delete_filter](#delete_filter) | 删除筛选 |
| 23 | [set_filter_criteria](#set_filter_criteria) | 设置单列筛选条件 |
| 24 | [clear_filter_criteria](#clear_filter_criteria) | 清除单列筛选条件 |
| 25 | [sort_filter](#sort_filter) | 按筛选范围内指定列排序 |

### 筛选视图 Filter View（6 个）
| # | 工具 | 说明 |
|---|------|------|
| 26 | [get_filter_views](#get_filter_views) | 列出所有筛选视图 |
| 27 | [create_filter_view](#create_filter_view) | 创建筛选视图 |
| 28 | [update_filter_view](#update_filter_view) | 更新筛选视图名称/范围/条件 |
| 29 | [delete_filter_view](#delete_filter_view) | 删除筛选视图 |
| 30 | [set_filter_view_criteria](#set_filter_view_criteria) | 设置筛选视图的单列条件 |
| 31 | [clear_filter_view_criteria](#clear_filter_view_criteria) | 清除筛选视图的单列条件 |

### 下拉列表 Dropdown（3 个）
| # | 工具 | 说明 |
|---|------|------|
| 32 | [set_dropdown_lists](#set_dropdown_lists) | 在单元格范围内设置下拉选项 |
| 33 | [get_dropdown_lists](#get_dropdown_lists) | 查询范围内的下拉配置 |
| 34 | [delete_dropdown_lists](#delete_dropdown_lists) | 删除范围内的下拉配置 |

### 图片（1 个）
| # | 工具 | 说明 |
|---|------|------|
| 35 | [write_image](#write_image) | 将图片资源插入到单元格 |

### 异步导出（2 个）
| # | 工具 | 说明 |
|---|------|------|
| 36 | [submit_export_job](#submit_export_job) | 提交导出 xlsx 任务 |
| 37 | [query_export_job](#query_export_job) | 查询导出任务状态并取下载链接 |

---

## 典型工作流

```
列工作表 → 读数据：       get_all_sheets → get_range
列工作表 → 写数据：       get_all_sheets → update_range / append_rows
查找定位单元格：          find_cells → 后续读/写
插入筛选：               create_filter → set_filter_criteria（或 update_filter 批量）
个人化筛选视图：          create_filter_view → set_filter_view_criteria
合并单元格：              merge_cells；取消：unmerge_range
插入/隐藏 N 行：          insert_dimension → update_dimension(hidden=true)
导出 xlsx：              submit_export_job → 轮询 query_export_job
图片插入：                上传得到 resourceId/resourceUrl → write_image
```

---

## 工作表管理

### create_workspace_sheet

创建一篇新的钉钉在线电子表格。三种位置：传 `folderId` → 该文件夹下；只传 `workspaceId` → 该知识库根目录；都不传 → 用户"我的文档"根目录。要求对目标位置有写入权限。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 新表格的标题 |
| folderId | string | 否 | 目标文件夹的节点 ID（dentryUuid），支持文件夹链接 URL 或 ID |
| workspaceId | string | 否 | 目标知识库 ID。同时传 folderId 时以 folderId 为准 |

#### 出参

返回新建表格的标识信息（`nodeId` / `dentryUuid` 等）；具体返回字段以官方实际响应为准。

#### 调用示例

```bash
SHEET create_workspace_sheet --args '{"name":"Q2 项目跟踪"}' --output json
SHEET create_workspace_sheet --args '{"name":"销售明细","folderId":"<folderId>"}' --output json
SHEET create_workspace_sheet --args '{"name":"团队 OKR","workspaceId":"<workspaceId>"}' --output json
```

---

### get_all_sheets

获取电子表格中的所有工作表列表，返回每个工作表的 `id` 和 `name`，是后续多数操作的入口。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |

#### 出参

返回工作表数组，每项含 `id`、`name`。

#### 调用示例

```bash
SHEET get_all_sheets --args '{"nodeId":"<nodeId>"}' --output json
```

---

### get_sheet

获取单个工作表的详细信息（ID、名称、可见性、行列数、最后非空行列位置等）。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 否 | 工作表 ID 或名称。不传时行为以官方文档为准 |

#### 出参

返回 `id`、`name`、`visibility`、`rowCount`、`columnCount`、最后非空行列位置等。具体字段以官方实际响应为准。

#### 调用示例

```bash
SHEET get_sheet --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>"}' --output json
```

---

### create_sheet

在表格中创建一个新工作表。名称重复时系统自动重命名为合法值。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 表格文件 ID（dentryUuid 或 URL） |
| name | string | 是 | 新工作表的名称，重名时自动重命名 |

#### 出参

返回新工作表的 `id` 与最终 `name`。

#### 调用示例

```bash
SHEET create_sheet --args '{"nodeId":"<nodeId>","name":"明细"}' --output json
```

---

### update_sheet

更新工作表属性：名称（`title`）、位置（`index`）、可见性（`hidden`）、冻结行列（`frozenRowCount` / `frozenColumnCount`）。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 表格文件 ID（URL 或 dentryUuid） |
| sheetId | string | 是 | 目标工作表的 ID 或名称 |
| title | string | 否 | 新名称，最长 100 字符；重名时自动追加后缀 |
| index | number | 否 | 新位置索引，0-based；0 表示最前 |
| hidden | boolean | 否 | 是否隐藏，true 隐藏 / false 显示 |
| frozenRowCount | number | 否 | 冻结行数，0 取消冻结 |
| frozenColumnCount | number | 否 | 冻结列数，0 取消冻结 |

#### 出参

返回更新后的工作表属性。

#### 调用示例

```bash
SHEET update_sheet --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>","title":"汇总表","frozenRowCount":1}' --output json
```

---

### copy_sheet

在同一表格内复制指定工作表为副本，可指定副本名称与位置。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 表格文件 ID（URL 或 dentryUuid） |
| sheetId | string | 是 | 源工作表 ID 或名称 |
| title | string | 否 | 副本名称 |
| index | number | 否 | 副本位置索引（0-based），不传时放在源工作表之后 |

#### 出参

返回副本工作表的 `id`、`name`、`index` 等。

#### 调用示例

```bash
SHEET copy_sheet --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>","title":"明细-备份"}' --output json
```

---

## 单元格读写

> 读：`get_range`；写：`update_range` / `append_rows`；定位：`find_cells`；批量改：`replace_all`。

### get_range

读取指定区域的单元格数据。`range` 支持带工作表前缀（如 `<sheetId>!A1:D10`），此时忽略 `sheetId`。不传 `range` 时自动检测实际数据范围。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 否 | 工作表 ID 或名称，不传则读第一个工作表 |
| range | string | 否 | A1 表示法范围，如 `A1:D10` 或 `<sheetId>!A1:D10`。不传则读取实际数据范围 |

#### 出参

返回二维数组，第一维=行、第二维=列。包含字段：`values`（公式计算后的结果）、`formulas`（原始公式）、`displayValues`（界面显示值）等。

#### 调用示例

```bash
SHEET get_range --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>","range":"A1:D10"}' --output json
SHEET get_range --args '{"nodeId":"<nodeId>","range":"Sheet1!A:A"}' --output json
```

---

### update_range

写入指定区域的单元格内容、超链接、字体/背景/对齐/数字格式等。`values` 与 `hyperlinks` 可共存，同一单元格上 `hyperlinks` 优先级更高。二维数组各项行列维度需与 `rangeAddress` 一致；外层数组最大长度 1000。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 表格文件 ID（URL 或 dentryUuid） |
| sheetId | string | 是 | 工作表 ID 或名称 |
| rangeAddress | string | 是 | 目标区域，A1 表示法，如 `A1:B3` |
| values | string[][] | 否 | 二维数组。元素可为字符串、公式（如 `=SUM(B2:B4)`）或 `null`（清除单元格） |
| hyperlinks | object[][] | 否 | 二维数组，元素为 `{type, link, text}` 对象或 `null`。`type` 可选 `path`（外链）/ `sheet`（工作表）/ `range`（单元格） |
| numberFormat | string | 否 | 整个 range 共用一个格式字符串。常用：`General`、`@`（文本）、`#,##0`、`#,##0.00`、`0%`、`yyyy/m/d`、`hh:mm:ss`、`¥#,##0`、`$#,##0` |
| fontSizes | number[][] | 否 | 字号二维数组，正整数 |
| fontColors | string[][] | 否 | 字体色二维数组，`#RRGGBB` 十六进制 |
| fontWeights | string[][] | 否 | 字体粗细二维数组，元素取 `bold` / `normal` |
| backgroundColors | string[][] | 否 | 背景色二维数组，`#RRGGBB` 十六进制 |
| horizontalAlignments | string[][] | 否 | 水平对齐二维数组，元素取 `left` / `center` / `right` / `general` |
| verticalAlignments | string[][] | 否 | 垂直对齐二维数组，元素取 `top` / `middle` / `bottom` |
| wordWrap | string | 否 | 整个 range 共用单值字符串。取 `overflow` / `clip` / `autoWrap`（驼峰，非下划线） |

#### 出参

返回写入区域的 A1 地址（如 `{"a1Notation":"A1:B2"}`）；具体字段以官方实际响应为准。

#### 调用示例

```bash
# 写入值
SHEET update_range --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>","rangeAddress":"A1:B2",
  "values":[["1","2"],["3","4"]]
}' --output json

# 写入公式 + 数字格式
SHEET update_range --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>","rangeAddress":"C1:C3",
  "values":[["=A1+B1"],["=A2+B2"],["=SUM(C1:C2)"]],
  "numberFormat":"#,##0.00"
}' --output json

# 超链接
SHEET update_range --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>","rangeAddress":"A1",
  "hyperlinks":[[{"type":"path","link":"https://www.dingtalk.com","text":"DingTalk"}]]
}' --output json
```

---

### append_rows

在工作表末尾（最后非空行下方）追加若干行；工作表为空时从第一行开始。追加列数应与已有数据保持一致。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| values | string[][] | 是 | 二维数组，外层每个元素一行 |

#### 出参

返回追加数据所在的单元格范围（A1 表示法）。

#### 调用示例

```bash
SHEET append_rows --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "values":[["张三","13800000000"],["李四","13900000000"]]
}' --output json
```

---

### find_cells

查找匹配指定文本的所有单元格地址。支持子字符串匹配（默认）、大小写、整单元格匹配、正则、搜索公式文本、包含隐藏单元格等模式。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| text | string | 是 | 查找内容，非空；`useRegExp=true` 时作为正则 |
| range | string | 否 | A1 表示法限定搜索范围，如 `A1:D100`、`A:A`、`1:1`。不传则搜索整个工作表 |
| matchCase | boolean | 否 | 是否区分大小写，**默认 true**（注意与 replace_all 不同） |
| matchEntireCell | boolean | 否 | 单元格内容完全一致才算匹配，默认 false |
| useRegExp | boolean | 否 | 将 text 作为正则，默认 false |
| matchFormulaText | boolean | 否 | 在公式文本中查找而非计算结果，默认 false |
| includeHidden | boolean | 否 | 是否搜索隐藏单元格，默认 false |

#### 出参

返回所有匹配单元格的 A1 地址列表；无匹配返回空数组。

#### 调用示例

```bash
SHEET find_cells --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "text":"待办","matchEntireCell":true
}' --output json
```

---

### replace_all

全局查找并替换文本，返回被替换的单元格数量。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| text | string | 是 | 要查找的文本，非空 |
| replaceText | string | 是 | 替换后的文本，可为空字符串（即删除匹配内容） |
| range | string | 否 | A1 表示法限定替换范围；不传则全表 |
| matchCase | boolean | 否 | 是否区分大小写，默认 false |
| matchEntireCell | boolean | 否 | 是否要求文本完全匹配整个单元格，默认 false |
| useRegExp | boolean | 否 | 是否使用正则，默认 false |
| includeHidden | boolean | 否 | 是否包含隐藏行/列，默认 false |

#### 出参

返回被替换的单元格数量。

#### 调用示例

```bash
SHEET replace_all --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "text":"未开始","replaceText":"待处理"
}' --output json
```

---

## 行列维度

> `dimension` 统一取 `ROWS` / `COLUMNS`（大写）。
> `position` / `startIndex` 的写法：`ROWS` 时是 1-based 行号字符串（`"3"`），`COLUMNS` 时是列字母字符串（`"A"`、`"AB"`）。携带工作表前缀（`Sheet1!3`）时覆盖 `sheetId`。

### add_dimension

在工作表末尾追加空行或空列。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| dimension | string | 是 | `ROWS` 或 `COLUMNS` |
| length | number | 是 | 追加数量，正整数（≥1） |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET add_dimension --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>","dimension":"ROWS","length":5}' --output json
```

---

### insert_dimension

在指定位置**之前**插入若干空行或空列。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 表格文件 ID（URL 或 dentryUuid） |
| sheetId | string | 是 | 工作表 ID 或名称（若 position 带 `Sheet1!` 前缀则被覆盖） |
| dimension | string | 是 | `ROWS` 或 `COLUMNS` |
| position | string | 是 | `ROWS`：1-based 行号字符串（`"3"` 表示第 3 行之前插入）；`COLUMNS`：列字母（`"A"`、`"AB"`） |
| length | number | 是 | 插入数量，正整数（≥1） |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET insert_dimension --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "dimension":"ROWS","position":"3","length":2
}' --output json
```

---

### delete_dimension

从指定位置开始连续删除若干行或列。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 表格文件 ID（URL 或 dentryUuid） |
| sheetId | string | 是 | 工作表 ID 或名称（被 position 前缀覆盖） |
| dimension | string | 是 | `ROWS` 或 `COLUMNS` |
| position | string | 是 | 删除起始位置；`ROWS` 时为 1-based 行号字符串，`COLUMNS` 时为列字母 |
| length | number | 是 | 删除数量，正整数（≥1） |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET delete_dimension --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "dimension":"COLUMNS","position":"D","length":1
}' --output json
```

---

### update_dimension

批量更新若干连续行/列的显隐与行高/列宽，`hidden` 与 `pixelSize` 至少传一个。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 表格文件 ID（URL 或 dentryUuid） |
| sheetId | string | 是 | 工作表 ID 或名称（被 startIndex 前缀覆盖） |
| dimension | string | 是 | `ROWS`（行高/行显隐）或 `COLUMNS`（列宽/列显隐） |
| startIndex | string | 是 | `ROWS` 时 1-based 行号字符串，`COLUMNS` 时列字母 |
| length | number | 是 | 连续更新数量，正整数（≥1），最多 5000 |
| hidden | boolean | 否 | true 隐藏 / false 显示。与 pixelSize 至少传一个 |
| pixelSize | number | 否 | 行高或列宽（像素），非负整数。与 hidden 至少传一个 |

#### 出参

返回操作结果。

#### 调用示例

```bash
# 隐藏第 3~5 行
SHEET update_dimension --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "dimension":"ROWS","startIndex":"3","length":3,"hidden":true
}' --output json

# 把 A、B、C 三列宽度设为 200px
SHEET update_dimension --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "dimension":"COLUMNS","startIndex":"A","length":3,"pixelSize":200
}' --output json
```

---

### move_dimension

把一段连续的行或列移动到目标索引。索引均为 0-based 且 `endIndex` 包含。`destinationIndex` 不能在 `[startIndex, endIndex]` 范围内：向下/向右移动时应 `> endIndex`，向上/向左移动时应 `< startIndex`。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| dimension | string | 是 | `ROWS` 或 `COLUMNS` |
| startIndex | number | 是 | 源起始索引（0-based，包含） |
| endIndex | number | 是 | 源结束索引（0-based，包含） |
| destinationIndex | number | 是 | 移动后源段将从该索引开始（0-based） |

#### 出参

返回操作结果。

#### 调用示例

```bash
# 把第 2~4 行（1-based）移到第 8 行（1-based）之前 → 0-based: 1,3 → dest=7
SHEET move_dimension --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "dimension":"ROWS","startIndex":1,"endIndex":3,"destinationIndex":7
}' --output json
```

---

## 合并 / 取消合并

### merge_cells

将指定区域合并为一个或多个合并区域。`mergeType` 控制合并方式。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 表格文件 ID（URL 或 dentryUuid） |
| sheetId | string | 是 | 工作表 ID 或名称（被 rangeAddress 前缀覆盖） |
| rangeAddress | string | 是 | A1 表示法范围；支持 `Sheet1!A1:B3` |
| mergeType | string | 否 | `mergeAll`（合并所有，默认）/ `mergeRows`（按行合并）/ `mergeColumns`（按列合并） |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET merge_cells --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "rangeAddress":"A1:C1","mergeType":"mergeAll"
}' --output json
```

---

### unmerge_range

取消指定范围内所有的合并单元格。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| rangeAddress | string | 是 | A1 表示法范围 |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET unmerge_range --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>","rangeAddress":"A1:D5"}' --output json
```

---

## 筛选 Filter

> **流程**：先 `create_filter` 在指定 range 创建筛选；之后用 `update_filter`（批量）或 `set_filter_criteria`（单列）设置条件；不需要时 `delete_filter` 或 `clear_filter_criteria`。
> **每个工作表只能有一个筛选**，重复 `create_filter` 会报错。
> 筛选类型 `filterType`：`values`（按值，配合 `visibleValues[]`）、`condition`（按条件，配合 `conditions[]`）、`color`（按颜色，配合 `backgroundColor` / `fontColor` 二选一）。
> 条件操作符 `operator`：`equal`、`not-equal`、`contains`、`not-contains`、`starts-with`、`not-starts-with`、`ends-with`、`not-ends-with`、`greater`、`greater-equal`、`less`、`less-equal`。
> 多条件逻辑 `conditionOperator`：`and`（默认）/ `or`，仅当 `conditions` 含 2 个条件时有效。
> `column`：列偏移量，0-based，相对于筛选范围首列。

### get_filter

获取当前工作表的筛选范围与各列筛选条件详情。未设置筛选时返回空。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |

#### 出参

返回筛选范围以及各列的 `filterType` 与对应条件字段（`visibleValues` / `conditions` / `backgroundColor` 等）。

#### 调用示例

```bash
SHEET get_filter --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>"}' --output json
```

---

### create_filter

在指定范围创建筛选。每个工作表只能有一个筛选；已存在时会报错。可在创建时同步设置 `criteria`。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| range | string | 是 | A1 表示法筛选范围，如 `A1:E10` |
| criteria | object[] | 否 | 各列条件数组，元素：`{column, filterType, visibleValues?, conditions?}` |

`criteria` 每项字段：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| column | number | 是 | 列偏移量，0-based，相对于 range 首列 |
| filterType | string | 是 | `values` / `condition` / `color` |
| visibleValues | string[] | 否 | filterType=values 时使用 |
| conditions | object[] | 否 | filterType=condition 时使用；元素 `{operator, value}` |

#### 出参

返回创建结果。

#### 调用示例

```bash
SHEET create_filter --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>","range":"A1:E100",
  "criteria":[{"column":0,"filterType":"values","visibleValues":["进行中","待处理"]}]
}' --output json
```

---

### update_filter

批量更新多列筛选条件。要求已存在筛选；会替换指定列的条件，未指定列保持不变。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| criteria | object[] | 是 | 各列条件数组（结构同 create_filter 的 criteria 项） |

#### 出参

返回更新结果。

#### 调用示例

```bash
SHEET update_filter --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "criteria":[
    {"column":0,"filterType":"values","visibleValues":["进行中"]},
    {"column":2,"filterType":"condition","conditions":[{"operator":"greater","value":"100"}]}
  ]
}' --output json
```

---

### delete_filter

删除工作表的筛选。删除后筛选下拉箭头消失、所有隐藏行恢复显示。无筛选时调用会报错。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET delete_filter --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>"}' --output json
```

---

### set_filter_criteria

设置筛选中**单列**的筛选条件。要求已存在筛选。与 `update_filter` 的区别：只改单列。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| column | number | 是 | 列偏移量，0-based，相对于筛选范围首列 |
| filterCriteria | object | 是 | 见下方结构 |

`filterCriteria` 字段：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| filterType | string | 是 | `values` / `condition` / `color` |
| visibleValues | string[] | 否 | filterType=values 时使用 |
| conditions | object[] | 否 | filterType=condition 时使用，**最多 2 个**；元素 `{operator, value}` |
| conditionOperator | string | 否 | 两条件之间逻辑 `and`（默认）/ `or` |
| backgroundColor | string | 否 | filterType=color 时按背景色筛选；与 fontColor 二选一 |
| fontColor | string | 否 | filterType=color 时按字体色筛选；与 backgroundColor 二选一 |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET set_filter_criteria --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>","column":1,
  "filterCriteria":{"filterType":"condition","conditions":[{"operator":"contains","value":"VIP"}]}
}' --output json
```

---

### clear_filter_criteria

清除筛选中某一列的筛选条件。不删除整个筛选；指定列没有条件时调用不会报错。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| column | number | 是 | 列偏移量，0-based |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET clear_filter_criteria --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>","column":0}' --output json
```

---

### sort_filter

按筛选范围内指定列对数据排序。会实际改变工作表行的物理顺序，要求已存在筛选。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| field | object | 是 | 排序规则，结构：`{column, ascending?}` |

`field` 字段：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| column | number | 是 | 列偏移量，0-based |
| ascending | boolean | 否 | 是否升序，默认 true；false 为降序 |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET sort_filter --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "field":{"column":2,"ascending":false}
}' --output json
```

---

## 筛选视图 Filter View

> 筛选视图是**个人化**的数据过滤方式，每个工作表可有多个，互不影响，也不影响全局筛选。
> 流程：`create_filter_view` → `set_filter_view_criteria`（或在 `update_filter_view` 中传 criteria 批量）→ `clear_filter_view_criteria` / `delete_filter_view`。

### get_filter_views

获取工作表所有筛选视图列表，含视图 ID、名称、范围。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |

#### 出参

返回筛选视图数组（含 `id`、`name`、`range` 等）。

#### 调用示例

```bash
SHEET get_filter_views --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>"}' --output json
```

---

### create_filter_view

创建筛选视图。可在创建时同步设置 `criteria`。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| name | string | 是 | 筛选视图名称 |
| range | string | 是 | A1 表示法范围，如 `A1:E10` |
| criteria | object[] | 否 | 各列条件数组（同 filter 的 criteria，可含 color/condition/values 全部字段） |

`criteria` 每项字段：`column` / `filterType` / `visibleValues` / `conditions` / `conditionOperator` / `backgroundColor` / `fontColor`。

#### 出参

返回新建筛选视图的 ID。

#### 调用示例

```bash
SHEET create_filter_view --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>",
  "name":"我的视图","range":"A1:E100",
  "criteria":[{"column":0,"filterType":"values","visibleValues":["待处理"]}]
}' --output json
```

---

### update_filter_view

更新筛选视图的名称、范围或筛选条件，三者至少传一个。`criteria` 仅替换指定列。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| filterViewId | string | 是 | 目标筛选视图 ID，可通过 get_filter_views 获取 |
| name | string | 否 | 新名称 |
| range | string | 否 | 新范围（A1 表示法） |
| criteria | object[] | 否 | 各列条件（结构同 create_filter_view 的 criteria） |

> `name` / `range` / `criteria` 至少传一个。

#### 出参

返回更新结果。

#### 调用示例

```bash
SHEET update_filter_view --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>","filterViewId":"<filterViewId>",
  "name":"高优先级"
}' --output json
```

---

### delete_filter_view

删除筛选视图（不影响全局筛选与其他视图）。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| filterViewId | string | 是 | 目标筛选视图 ID |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET delete_filter_view --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>","filterViewId":"<filterViewId>"}' --output json
```

---

### set_filter_view_criteria

设置筛选视图的某一列筛选条件，仅影响当前视图。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| filterViewId | string | 是 | 目标筛选视图 ID |
| column | number | 是 | 列偏移量，0-based，相对于筛选视图范围首列 |
| filterCriteria | object | 是 | 结构同 set_filter_criteria 的 filterCriteria |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET set_filter_view_criteria --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>","filterViewId":"<filterViewId>",
  "column":0,
  "filterCriteria":{"filterType":"values","visibleValues":["进行中"]}
}' --output json
```

---

### clear_filter_view_criteria

清除筛选视图中某一列的筛选条件，仅影响当前视图。指定列没有条件时调用不会报错。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| filterViewId | string | 是 | 目标筛选视图 ID |
| column | number | 是 | 列偏移量，0-based |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET clear_filter_view_criteria --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>","filterViewId":"<filterViewId>","column":2
}' --output json
```

---

## 下拉列表 Dropdown

> 下拉选项值**不能包含英文逗号**；选项数组至少 1 项。

### set_dropdown_lists

在指定单元格范围内设置下拉列表。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| range | string | 是 | A1 表示法范围，如 `A2:A100` |
| options | object[] | 是 | 下拉选项数组（至少 1 项）；每项 `{value, color?}` |
| enableMultiSelect | boolean | 否 | 是否允许多选，默认 false |

`options` 每项字段：

| 子字段 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| value | string | 是 | 选项值，不能包含英文逗号 |
| color | string | 否 | 选项背景色，`#RRGGBB` 十六进制 |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET set_dropdown_lists --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>","range":"B2:B100",
  "options":[
    {"value":"待处理","color":"#FFF2CC"},
    {"value":"进行中","color":"#DDEBF7"},
    {"value":"已完成","color":"#E2EFDA"}
  ]
}' --output json
```

---

### get_dropdown_lists

查询指定范围内的所有下拉列表配置。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| range | string | 是 | A1 表示法范围，如 `A1`、`A1:A100`、`B2:D10` |

#### 出参

返回范围内各单元格的下拉配置；具体字段以官方实际响应为准。

#### 调用示例

```bash
SHEET get_dropdown_lists --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>","range":"B2:B100"}' --output json
```

---

### delete_dropdown_lists

删除指定单元格范围内的下拉列表配置。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 电子表格文档 URL 或 dentryUuid |
| sheetId | string | 是 | 工作表 ID 或名称 |
| range | string | 是 | A1 表示法范围 |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET delete_dropdown_lists --args '{"nodeId":"<nodeId>","sheetId":"<sheetId>","range":"B2:B100"}' --output json
```

---

## 图片

### write_image

在指定单元格区域中插入图片。前置流程：先获取上传凭证（`uploadUrl` / `resourceId` / `resourceUrl`），用 HTTP PUT 把图片传到 `uploadUrl`，再调用本接口。

> 上传凭证的获取走 dingtalk-docs（DOC）的"获取上传资源"接口，具体调用以官方文档为准。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 表格文件 ID（URL 或 dentryUuid） |
| sheetId | string | 是 | 工作表 ID 或名称 |
| rangeAddress | string | 是 | 目标区域 A1 表示法，如 `A1:B3` |
| resourceId | string | 是 | 上传凭证返回的资源 ID |
| resourceUrl | string | 是 | 上传凭证返回的资源链接 |
| width | number | 否 | 显示宽度 |
| height | number | 否 | 显示高度 |

#### 出参

返回操作结果。

#### 调用示例

```bash
SHEET write_image --args '{
  "nodeId":"<nodeId>","sheetId":"<sheetId>","rangeAddress":"A1:B3",
  "resourceId":"<resourceId>","resourceUrl":"<resourceUrl>",
  "width":200,"height":150
}' --output json
```

---

## 异步导出

> 流程：`submit_export_job` 拿到 `jobId` → 轮询 `query_export_job` 直到任务完成 → 拿到 xlsx 下载链接。

### submit_export_job

将钉钉在线电子表格导出为 xlsx。**仅支持 xlsx**（`exportFormat` 必须为 `"xlsx"`）。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| nodeId | string | 是 | 要导出的电子表格 URL 或 dentryUuid。仅支持 alxs（在线电子表格） |
| exportFormat | string | 是 | 导出格式，必须为 `"xlsx"` |

#### 出参

返回 `jobId`，用于 `query_export_job` 查询。

#### 调用示例

```bash
SHEET submit_export_job --args '{"nodeId":"<nodeId>","exportFormat":"xlsx"}' --output json
```

---

### query_export_job

查询导出任务状态。完成后返回 xlsx 下载链接。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| jobId | string | 是 | 由 submit_export_job 返回的导出任务 ID |

#### 出参

返回任务状态以及完成时的下载链接；具体字段以官方实际响应为准。

#### 调用示例

```bash
SHEET query_export_job --args '{"jobId":"<jobId>"}' --output json
```

---

## 常见错误与排查

- `invalidRequest.resource.notWorkbook`：传入的 nodeId 不是电子表格（如传成了钉钉文字文档）。
- `invalidRequest.document.stillInitializing`：文档初始化中，稍后重试。
- `forbidden.accessDenied` / `forbidden.acrossOrg`：操作人无权限或被禁止跨组织访问。
- `invalidRequest.resource.notFound`：nodeId / sheetId / filterViewId 不存在。
- 已有筛选时再次 `create_filter`、无筛选时 `delete_filter` 都会报错。
- `update_dimension` 中 `hidden` 与 `pixelSize` 至少传一个；`length` 上限 5000。
- `update_filter_view` 至少传 `name` / `range` / `criteria` 之一。
- `set_dropdown_lists` 中选项值不能包含英文逗号。

> 具体错误码与响应字段以官方实际返回为准。
