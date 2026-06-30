# 钉钉 AI 表格 API 参考

> MCP 工具前缀：`dingtalk-ai-table`
> 调用格式：`TABLE <tool> --args '{ ... }' --output json`
> AI 表格访问地址：`https://docs.dingtalk.com/i/nodes/{baseId}`

---

## 工具目录

### Base 管理
| # | 工具 | 说明 |
|---|------|------|
| 1 | [list_bases](#list_bases) | 列出当前用户可访问的 Base |
| 2 | [search_bases](#search_bases) | 按名称关键词搜索 Base |
| 3 | [get_base](#get_base) | 获取 Base 资源目录（tables / dashboards） |
| 4 | [create_base](#create_base) | 创建新 Base |
| 5 | [update_base](#update_base) | 更新 Base 名称 / 备注 |
| 6 | [delete_base](#delete_base) | 删除 Base（不可逆） |

### Table & Field 管理
| # | 工具 | 说明 |
|---|------|------|
| 7 | [get_tables](#get_tables) | 批量获取 Table 元信息与字段/视图目录 |
| 8 | [create_table](#create_table) | 在 Base 中新建 Table 并附带初始字段 |
| 9 | [update_table](#update_table) | 重命名 Table |
| 10 | [delete_table](#delete_table) | 删除 Table（不可逆） |
| 11 | [get_fields](#get_fields) | 获取字段完整配置（含 options、aiConfig） |
| 12 | [create_fields](#create_fields) | 在已有 Table 中批量新增字段 |
| 13 | [update_field](#update_field) | 更新字段名称 / 配置 / AI 配置 |
| 14 | [delete_field](#delete_field) | 删除字段（不可逆） |

### Record CRUD
| # | 工具 | 说明 |
|---|------|------|
| 15 | [query_records](#query_records) | 按条件 / ID 查询记录（支持筛选、排序、分页） |
| 16 | [create_records](#create_records) | 批量新增记录 |
| 17 | [update_records](#update_records) | 批量更新记录 |
| 18 | [delete_records](#delete_records) | 批量删除记录（不可逆） |

### View 管理
| # | 工具 | 说明 |
|---|------|------|
| 19 | [get_views](#get_views) | 获取视图完整配置 |
| 20 | [create_view](#create_view) | 创建视图 |
| 21 | [update_view](#update_view) | 更新视图名称 / 配置 |
| 22 | [delete_view](#delete_view) | 删除视图（不可逆） |

### 导入导出 & 附件
| # | 工具 | 说明 |
|---|------|------|
| 23 | [export_data](#export_data) | 导出 Base / Table / View 数据 |
| 24 | [prepare_import_upload](#prepare_import_upload) | 为导入文件申请上传地址 |
| 25 | [import_data](#import_data) | 执行导入任务 |
| 26 | [prepare_attachment_upload](#prepare_attachment_upload) | 为附件字段文件申请上传地址 |

### 模板
| # | 工具 | 说明 |
|---|------|------|
| 27 | [search_templates](#search_templates) | 按关键词搜索 AI 表格模板 |

### Dashboard 仪表盘
| # | 工具 | 说明 |
|---|------|------|
| 28 | [get_dashboard_config_example](#get_dashboard_config_example) | 获取 dashboard config 的 JSONC 结构示例 |
| 29 | [get_dashboard](#get_dashboard) | 获取 dashboard 详情（含 charts summary） |
| 30 | [create_dashboard](#create_dashboard) | 在 Base 下创建 dashboard |
| 31 | [update_dashboard](#update_dashboard) | 更新 dashboard 配置 |
| 32 | [delete_dashboard](#delete_dashboard) | 删除 dashboard（级联删除其 charts，不可逆） |

### Chart 图表
| # | 工具 | 说明 |
|---|------|------|
| 33 | [get_dashboard_widgets_example](#get_dashboard_widgets_example) | 获取各类型 chart widget config 示例 |
| 34 | [get_chart](#get_chart) | 获取 chart 详情（config + layout） |
| 35 | [create_chart](#create_chart) | 在 dashboard 下创建 chart |
| 36 | [update_chart](#update_chart) | 更新 chart 配置或布局 |
| 37 | [delete_chart](#delete_chart) | 删除 chart（不可逆） |

### 共享（分享链接）
| # | 工具 | 说明 |
|---|------|------|
| 38 | [get_dashboard_share](#get_dashboard_share) | 查询 dashboard 分享配置 |
| 39 | [update_dashboard_share](#update_dashboard_share) | 开启/关闭 dashboard 分享并设置类型 |
| 40 | [get_chart_share](#get_chart_share) | 查询 chart 分享配置 |
| 41 | [update_chart_share](#update_chart_share) | 开启/关闭 chart 分享并设置类型 |

### 其他能力
| # | 工具 | 说明 |
|---|------|------|
| 42 | [copy_base](#copy_base) | 将 Base 复制到指定目录（可仅复制结构） |
| 43 | [get_base_primary_doc_id](#get_base_primary_doc_id) | 由记录获取主键文档的 dentryUuid |
| 44 | [run_ai_field](#run_ai_field) | 触发 AI 字段运行（支持整列或指定记录） |
| 45 | [create_guide_document](#create_guide_document) | 在 Base 中创建说明文档 |
| 46 | [update_guide_document](#update_guide_document) | 重命名说明文档 |
| 47 | [delete_guide_document](#delete_guide_document) | 删除说明文档（不可逆） |

---

## Base 管理

### list_bases

列出当前用户可访问的 AI 表格 Base，默认按最近访问排序，支持分页游标续取。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| limit | number | 否 | 每页数量，默认 10，最大 10 |
| cursor | string | 否 | 分页游标；首次不传，传入上次返回的游标获取下一页 |

#### 出参

返回 `bases[]`（每项含 `baseId`、`baseName`）及分页游标 `cursor`（为空表示已取完）。

#### 调用示例

```bash
TABLE list_bases --args '{}' --output json
TABLE list_bases --args '{"limit":10,"cursor":"next_xxx"}' --output json
```

---

### search_bases

按名称关键词搜索 Base，结果按相关性排序。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| query | string | 是 | Base 名称关键词，建议至少 2 个字符 |
| cursor | string | 否 | 分页游标，首次不传 |

#### 出参

返回 `bases[]`（含 `baseId`、`baseName`）及分页游标。

#### 调用示例

```bash
TABLE search_bases --args '{"query":"项目管理"}' --output json
```

---

### get_base

获取指定 Base 的资源目录级信息（baseName、tables、dashboards 的 summary），不含字段与记录详情。这是 Base 级目录入口，后续需要 tableId 优先从此处获取。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base 唯一标识，优先使用 search_bases / list_bases 返回值 |

#### 出参

返回 `baseName`、`tables[]`（含 `tableId`、`tableName`）、`dashboards[]`（含 `dashboardId`、`dashboardName`）。

#### 调用示例

```bash
TABLE get_base --args '{"baseId":"base_xxx"}' --output json
```

---

### create_base

创建一个新的 AI 表格 Base。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseName | string | 是 | Base 名称，1-50 字符；会去除首尾空格后校验 |
| templateId | string | 否 | 模板 ID，默认创建空 Base；可通过 search_templates 获取 |

#### 出参

返回 `baseId`、`baseName`。

#### 调用示例

```bash
TABLE create_base --args '{"baseName":"Q2 项目跟踪"}' --output json
TABLE create_base --args '{"baseName":"新员工入职","templateId":"tpl_xxx"}' --output json
```

---

### update_base

更新 Base 名称（可选备注）。不支持修改主题、封面等扩展属性。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 目标 Base ID |
| newBaseName | string | 是 | 新名称，1-50 字符 |
| description | string | 否 | 备注文本 |

#### 出参

返回更新后的 Base 信息。

#### 调用示例

```bash
TABLE update_base --args '{"baseId":"base_xxx","newBaseName":"Q3 项目跟踪","description":"季度更新"}' --output json
```

---

### delete_base

删除指定 Base。**高风险、不可逆**。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 待删除 Base ID，建议先通过 get_base 确认目标 |
| reason | string | 否 | 一句话描述删除原因，用于审计 |

#### 出参

返回操作结果。

#### 调用示例

```bash
TABLE delete_base --args '{"baseId":"base_xxx","reason":"测试数据清理"}' --output json
```

---

## Table & Field 管理

### get_tables

批量获取指定 Tables 的表级信息、字段目录与视图目录。字段列表仅含 `fieldId`、`fieldName`、`type`、`description`；views 仅含 `viewId`、`viewName`、`type`。若需字段完整配置，再调用 get_fields。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base ID |
| tableIds | string[] | 否 | Table ID 列表，单次最多 10 个；不传则返回当前 Base 下全部表。建议显式传入以控制返回体大小 |

#### 出参

返回 `tables[]`，每个 table 含 `tableId`、`tableName`、`description`、`fields[]`、`views[]`。

#### 调用示例

```bash
TABLE get_tables --args '{"baseId":"base_xxx"}' --output json
TABLE get_tables --args '{"baseId":"base_xxx","tableIds":["tbl_a","tbl_b"]}' --output json
```

---

### create_table

在指定 Base 中新建表格，可在创建时附带初始字段。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 目标 Base ID |
| tableName | string | 是 | 表格名称，1~100 字符；不能包含 `/ \ ? * [ ] :` 等字符。若与已有表重名，系统自动续号 |
| fields | object[] | 是 | 初始字段列表，至少 1 个，单次最多 15 个。若传空数组，系统自动补一个名为"标题"的 primaryDoc 首列 |

**fields 元素结构：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| fieldName | string | 是 | 字段名称，最大 100 字，不支持换行 |
| type | string | 是 | 字段类型，见 [字段类型参考](#字段类型参考) |
| config | object | 否 | 字段配置，结构因 type 而异，见 [字段类型参考](#字段类型参考) |

#### 出参

返回 `tableId`、`tableName`（可能已续号）、创建的字段列表。

#### 调用示例

```bash
TABLE create_table --args '{
  "baseId": "base_xxx",
  "tableName": "任务跟踪",
  "fields": [
    {"fieldName":"任务名称","type":"text"},
    {"fieldName":"优先级","type":"singleSelect","config":{"options":[{"name":"高"},{"name":"中"},{"name":"低"}]}},
    {"fieldName":"截止日期","type":"date","config":{"formatter":"YYYY-MM-DD"}},
    {"fieldName":"负责人","type":"user","config":{"multiple":false}}
  ]
}' --output json
```

---

### update_table

重命名指定 Table。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base ID |
| tableId | string | 是 | 目标 Table ID |
| newTableName | string | 是 | 新表名；不能包含 `/ \ ? * [ ] :` 等特殊字符 |

#### 出参

返回更新后的 Table 信息。

#### 调用示例

```bash
TABLE update_table --args '{"baseId":"base_xxx","tableId":"tbl_xxx","newTableName":"任务清单 v2"}' --output json
```

---

### delete_table

删除指定 Table。**不可逆，数据永久丢失**。调用前请先通过 get_base / get_tables 确认目标。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 目标 Base ID |
| tableId | string | 是 | 将被删除的 Table ID |
| reason | string | 否 | 删除原因，用于审计 |

#### 出参

返回操作结果。

#### 调用示例

```bash
TABLE delete_table --args '{"baseId":"base_xxx","tableId":"tbl_xxx","reason":"合并到主表"}' --output json
```

---

### get_fields

批量获取指定字段的详细信息，包括 fieldId、名称、类型、description 及完整配置（格式化、选项、AI 配置等）。适用于在 get_tables 拿到字段目录后，按需展开少量字段的完整配置。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| fieldIds | string[] | 否 | 字段 ID 列表，单次最多 10 个；不传则返回全部字段。建议显式传入以控制返回体大小 |

#### 出参

返回 `fields[]`，每个字段含 `fieldId`、`fieldName`、`type`、`description`、`config`，AI 字段额外包含同级 `aiConfig`。

#### 调用示例

```bash
TABLE get_fields --args '{"baseId":"base_xxx","tableId":"tbl_xxx","fieldIds":["fld_a","fld_b"]}' --output json
```

---

### create_fields

在已有表格中批量新增字段。单次最多 15 个。允许部分成功，返回结果逐项标明成功/失败。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| fields | object[] | 是 | 待新增字段列表，至少 1 个，单次最多 15 个 |

**fields 元素结构：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| fieldName | string | 是 | 字段名称，最大 100 字，不支持换行 |
| type | string | 是 | 字段类型，见 [字段类型参考](#字段类型参考)。创建 AI 字段时 type 须与 aiConfig.outputType 对应（见下方映射） |
| config | object | 否 | 字段配置，结构因 type 而异 |
| aiConfig | object | 否 | AI 字段配置，见 [aiConfig 结构](#aiconfig-结构) |

**AI 字段 outputType 与 type 映射：**

| outputType | type |
|------------|------|
| text | text |
| select | singleSelect |
| multiSelect | multipleSelect |
| number | number |
| currency | currency |
| image | attachment |
| video | attachment |

#### 出参

返回创建结果列表，顺序与入参一致，每项含成功/失败状态，失败项含 `reason`。

#### 调用示例

```bash
TABLE create_fields --args '{
  "baseId": "base_xxx",
  "tableId": "tbl_xxx",
  "fields": [
    {"fieldName":"总金额","type":"formula","config":{"formula":"[单价] * [数量]"}},
    {"fieldName":"关联订单","type":"bidirectionalLink","config":{"linkedTableId":"tbl_yyy","multiple":true}}
  ]
}' --output json
```

---

### update_field

更新指定字段的名称或配置。**不可变更字段类型（type 不可修改）**。`newFieldName`、`config`、`aiConfig` 至少传入一项。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| fieldId | string | 是 | Field ID |
| newFieldName | string | 否 | 更新后的字段名称，最大 100 字 |
| config | object | 否 | 更新后的字段物理配置。**更新 singleSelect / multipleSelect 的 options 时需传完整列表（含已有选项），系统以新列表整体覆盖。已有选项应回传原 id，新增选项无需传 id** |
| aiConfig | object | 否 | 更新后的 AI 配置（整体替换）。传入时 `outputType` 与 `prompt` 均为必填。结构见 [aiConfig 结构](#aiconfig-结构) |

**config.options 元素结构（仅 singleSelect / multipleSelect）：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| id | string | 否 | 已有选项的 ID；新增选项无需传。若传入的 id 在当前配置中不存在，系统忽略该 id 并按新增处理 |
| name | string | 是 | 选项名称。若 id 合法但 name 变了，会保留 id 并更新名称 |

#### 出参

返回更新后的字段信息。

#### 调用示例

```bash
TABLE update_field --args '{
  "baseId": "base_xxx",
  "tableId": "tbl_xxx",
  "fieldId": "fld_xxx",
  "newFieldName": "任务状态",
  "config": {
    "options": [
      {"id":"opt_001","name":"待处理"},
      {"id":"opt_002","name":"进行中"},
      {"name":"已完成"}
    ]
  }
}' --output json
```

---

### delete_field

删除指定 Table 中的一个字段。**不可逆，会永久删除字段及其所有数据**。禁止删除主字段和最后一个字段。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| fieldId | string | 是 | 待删除字段 ID |

#### 出参

返回操作结果。

#### 调用示例

```bash
TABLE delete_field --args '{"baseId":"base_xxx","tableId":"tbl_xxx","fieldId":"fld_xxx"}' --output json
```

---

## Record CRUD

### query_records

查询指定表格中的记录。支持两种模式：

- **按 ID 取**：传入 `recordIds`（单次最多 100 个），直接获取指定记录，忽略 filters 和 sort。
- **条件查**：通过 `filters` 过滤、`sort` 排序、`cursor` 分页遍历。

两种模式均可通过 `fieldIds` 限制返回字段以节省 token。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| recordIds | string[] | 否 | 记录 ID 列表，单次最多 100 个。传入时忽略 filters / sort |
| fieldIds | string[] | 否 | 返回字段 ID 列表，单次最多 100 个；省略则返回所有字段 |
| filters | object | 否 | 结构化过滤条件，见下方 filters 结构 |
| keyword | string | 否 | 全文关键词，对整表做文本匹配搜索 |
| sort | object[] | 否 | 排序条件列表，按数组顺序依次生效 |
| limit | number | 否 | 单次返回最大记录数，默认 100，最大 100 |
| cursor | string | 否 | 分页游标，首次不传；cursor 为空表示已取完 |

**sort 元素结构：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| fieldId | string | 是 | 排序字段 ID |
| direction | string | 否 | `asc`（默认）或 `desc` |

**filters 结构：**

```json
{
  "operator": "and | or",
  "operands": [
    {
      "operator": "<比较操作符>",
      "operands": ["<fieldId>", "<比较值>"]
    }
  ]
}
```

**比较操作符一览：**

| 操作符 | 适用类型 | 含义 |
|--------|----------|------|
| `eq` | 通用 | 等于 |
| `ne` | 通用 | 不等于 |
| `exist` | 通用 | 有值（无需第二个 operand） |
| `un_exist` | 通用 | 为空（无需第二个 operand） |
| `lt` | 数值 | 小于 |
| `gt` | 数值 | 大于 |
| `lte` | 数值 | 小于等于 |
| `gte` | 数值 | 大于等于 |
| `contain` | 文本 | 包含 |
| `exclusive` | 文本 | 不包含 |
| `all_of` | 多选 | 全包含 |
| `any_of` | 多选 | 包含任一 |
| `none_of` | 多选 | 不包含任一 |
| `date_eq` | 日期 | 日期等于 |
| `before` | 日期 | 早于 |
| `after` | 日期 | 晚于 |
| `not_before` | 日期 | 不早于 |
| `not_after` | 日期 | 不晚于 |
| `from_now` | 日期 | 未来 N 天内（值为天数） |
| `date_between` | 日期 | 区间（值为 `[start, end]` 时间戳数组） |

> singleSelect / multipleSelect 字段的过滤值推荐传 option ID（可通过 get_fields 获取）。

#### 出参

返回 `records[]`（含 `recordId`、`cells`）及分页 `cursor`。

#### 调用示例

```bash
# 条件查询
TABLE query_records --args '{
  "baseId": "base_xxx",
  "tableId": "tbl_xxx",
  "filters": {
    "operator": "and",
    "operands": [
      {"operator":"eq","operands":["fldStatusId","opt_doing"]},
      {"operator":"gte","operands":["fldNumId","100"]}
    ]
  },
  "sort": [{"fieldId":"fldDateId","direction":"desc"}],
  "limit": 50
}' --output json

# 按 ID 精准取
TABLE query_records --args '{
  "baseId": "base_xxx",
  "tableId": "tbl_xxx",
  "recordIds": ["rec_001","rec_002"],
  "fieldIds": ["fld_a","fld_b"]
}' --output json
```

---

### create_records

在指定表格中批量新增记录。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| records | object[] | 是 | 待创建的记录列表，单次最多 100 条 |

**records 元素结构：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| cells | object | 是 | 字段值映射，key 为 fieldId，value 为写入值。格式见 [单元格写入格式参考](#单元格写入格式参考) |

#### 出参

返回创建的 `records[]`，含 `recordId`。

#### 调用示例

```bash
TABLE create_records --args '{
  "baseId": "base_xxx",
  "tableId": "tbl_xxx",
  "records": [
    {
      "cells": {
        "fldTextId": "新任务",
        "fldSelectId": "高",
        "fldDateId": "2026-04-01",
        "fldUserId": [{"userId":"staff_001","corpId":"dingxxxxxxxx"}]
      }
    }
  ]
}' --output json
```

---

### update_records

批量更新指定记录的字段值。只需传入需修改的字段，未传入的字段保持原值。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| records | object[] | 是 | 待更新的记录列表，单次最多 100 条 |

**records 元素结构：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| recordId | string | 是 | Record ID |
| cells | object | 是 | 字段值映射，key 为 fieldId，value 为新值。格式见 [单元格写入格式参考](#单元格写入格式参考) |

#### 出参

返回更新结果。

#### 调用示例

```bash
TABLE update_records --args '{
  "baseId": "base_xxx",
  "tableId": "tbl_xxx",
  "records": [
    {
      "recordId": "rec_001",
      "cells": {
        "fldStatusId": {"id":"opt_done","name":"已完成"},
        "fldNumId": 99
      }
    }
  ]
}' --output json
```

---

### delete_records

批量删除记录。**不可逆，数据永久丢失**。调用前建议先通过 query_records 确认目标。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| recordIds | string[] | 是 | 待删除的记录 ID 列表，最多 100 条 |

#### 出参

返回操作结果。

#### 调用示例

```bash
TABLE delete_records --args '{"baseId":"base_xxx","tableId":"tbl_xxx","recordIds":["rec_001","rec_002"]}' --output json
```

---

## View 管理

### get_views

获取指定数据表中的视图完整信息，包括列顺序、筛选、排序、分组、条件格式等。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| viewIds | string[] | 否 | 视图 ID 列表，单次最多 10 个；省略则返回当前表下全部视图 |

#### 出参

返回 `views[]`，含完整配置（visibleFieldIds、filter、sort、group 等）。

#### 调用示例

```bash
TABLE get_views --args '{"baseId":"base_xxx","tableId":"tbl_xxx"}' --output json
```

---

### create_view

在指定数据表下创建新视图。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| viewType | string | 是 | 视图类型：`Grid`、`FormDesigner`、`Gantt`、`Calendar`、`Kanban`、`Gallery` |
| viewName | string | 否 | 视图名称；未传时自动生成 |
| viewSubType | string | 否 | 视图子类型 |
| viewDescription | object | 否 | 视图描述 |
| config | object | 否 | 视图配置，见下方 config 结构 |

**config 结构：**

| 参数名 | 类型 | 说明 |
|--------|------|------|
| visibleFieldIds | string[] | 可见字段及顺序（fieldId 列表）。首列字段必须在数组第一位，不能隐藏 |
| filter | object[] | 筛选规则列表 |
| sort | object[] | 排序规则列表 |
| group | object[] | 分组规则列表 |

#### 出参

返回创建的视图信息（含 `viewId`）。

#### 调用示例

```bash
TABLE create_view --args '{
  "baseId": "base_xxx",
  "tableId": "tbl_xxx",
  "viewType": "Kanban",
  "viewName": "任务看板",
  "config": {
    "visibleFieldIds": ["fld_primary","fld_status","fld_assignee"]
  }
}' --output json
```

---

### update_view

更新指定视图的名称、描述或配置。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| viewId | string | 是 | 目标视图 ID |
| newViewName | string | 否 | 新的视图名称 |
| viewDescription | object | 否 | 新的视图描述；清空传 `{"content":[]}` |
| config | object | 否 | 视图配置更新项 |

**config 结构：**

| 参数名 | 类型 | 说明 |
|--------|------|------|
| visibleFieldIds | string[] | 新的可见字段及顺序（需传全量）。首列字段必须在第一位 |
| filter | object[] | 新的筛选规则，全量覆盖 |
| sort | object[] | 新的排序规则，全量覆盖 |
| group | object[] | 新的分组规则，全量覆盖 |
| fieldWidths | object | 列宽映射（key 为 fieldId，value 为像素宽度，默认 200）。**仅支持 Grid 视图** |

#### 出参

返回更新后的视图信息。

#### 调用示例

```bash
TABLE update_view --args '{
  "baseId": "base_xxx",
  "tableId": "tbl_xxx",
  "viewId": "viw_xxx",
  "newViewName": "按优先级排序",
  "config": {
    "sort": [{"fieldId":"fldPriorityId","direction":"asc"}]
  }
}' --output json
```

---

### delete_view

删除指定视图。**不可逆**。禁止删除数据表中的最后一个视图；锁定视图不允许删除。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| tableId | string | 是 | Table ID |
| viewId | string | 是 | 要删除的视图 ID |

#### 出参

返回操作结果。

#### 调用示例

```bash
TABLE delete_view --args '{"baseId":"base_xxx","tableId":"tbl_xxx","viewId":"viw_xxx"}' --output json
```

---

## 导入导出 & 附件

### export_data

导出 AI 表格数据的统一入口。异步任务模式——不传 `taskId` 时创建新任务并同步等待；传入 `taskId` 时继续等待已有任务。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| scope | string | 创建时必填 | 导出范围：`all`（整个 Base）、`table`（指定表）、`view`（指定视图）。scope=table 时须传 tableId；scope=view 时须传 tableId 和 viewId |
| format | string | 创建时必填 | 导出格式：`excel`、`attachment`、`excel_and_attachment`、`excel_with_inline_images` |
| tableId | string | 否 | Table ID，scope=table/view 时必填 |
| viewId | string | 否 | View ID，scope=view 时必填 |
| taskId | string | 否 | 已有导出任务 ID；传入时不要再传 scope / format / tableId / viewId |
| timeoutMs | number | 否 | 单次等待超时（毫秒），默认 30000，范围 200~30000 |

#### 出参

若在等待窗口内完成：返回 `downloadUrl`、`fileName`。若未完成：返回 `taskId` 供下次继续等待。

#### 调用示例

```bash
# 导出整个 Base 为 Excel
TABLE export_data --args '{"baseId":"base_xxx","scope":"all","format":"excel"}' --output json

# 继续等待未完成的任务
TABLE export_data --args '{"baseId":"base_xxx","taskId":"task_xxx"}' --output json

# 导出指定视图（含内嵌图片）
TABLE export_data --args '{
  "baseId": "base_xxx",
  "scope": "view",
  "format": "excel_with_inline_images",
  "tableId": "tbl_xxx",
  "viewId": "viw_xxx"
}' --output json
```

---

### prepare_import_upload

为导入任务申请 OSS 直传地址。返回 `uploadUrl` 和 `importId`。客户端通过 HTTP PUT 上传文件至 `uploadUrl`，完成后将 `importId` 传入 import_data 触发导入。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| fileName | string | 是 | 文件名，须带扩展名（如 `data.xlsx`），扩展名作为导入格式依据 |
| fileSize | number | 是 | 文件大小（字节数） |

#### 出参

返回 `uploadUrl`（OSS 直传地址）和 `importId`。

#### 调用示例

```bash
TABLE prepare_import_upload --args '{"baseId":"base_xxx","fileName":"data.xlsx","fileSize":92250}' --output json
```

---

### import_data

将已通过 prepare_import_upload 上传完成的文件导入 AI 表格。每个 Sheet 新建为独立数据表（不支持追加到已有表）。内部同步等待导入完成，超时后可重复调用同一 `importId` 继续等待。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| importId | string | 是 | prepare_import_upload 返回的 importId |
| timeout | number | 否 | 本次最长等待时间（秒），默认 30，范围 5~30 |

#### 出参

返回导入结果，含新建的 tables 信息。若未完成，再次传入同一 importId 继续等待。

#### 调用示例

```bash
TABLE import_data --args '{"importId":"imp_xxx","timeout":30}' --output json
```

---

### prepare_attachment_upload

为单个 attachment 字段文件申请带容量校验的 OSS 直传地址。**仅适用于"先上传本地文件再写入 attachment 字段"场景**。若已有在线 URL，直接在 create_records / update_records 的 attachment 字段中传 `[{"url":"https://..."}]` 即可。

上传流程：
1. 调用本工具获取 `uploadUrl` 和 `fileToken`
2. 向 `uploadUrl` 发起 PUT 请求（必须携带 `Content-Type` header，值为文件的 MIME type）
3. 在 create_records / update_records 的 attachment 字段中写入 `[{"fileToken":"..."}]`

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID |
| fileName | string | 是 | 文件名，须包含扩展名（如 `report.xlsx`、`photo.png`） |
| size | number | 是 | 文件大小（字节），必须大于 0 |
| mimeType | string | 否 | 文件 MIME type（如 `application/pdf`）。不传时按扩展名推断。若传入，上传时 Content-Type 必须与此一致 |

#### 出参

返回 `uploadUrl`（OSS 直传地址）和 `fileToken`。

#### 调用示例

```bash
TABLE prepare_attachment_upload --args '{
  "baseId": "base_xxx",
  "fileName": "report.pdf",
  "size": 204800,
  "mimeType": "application/pdf"
}' --output json
```

---

## 模板

### search_templates

按名称关键词搜索 AI 表格模板，支持分页。模板预览：`https://docs.dingtalk.com/table/template/{templateId}`

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| query | string | 是 | 模板名称关键词 |
| limit | number | 否 | 每页返回数量，默认 10，最大 30 |
| cursor | string | 否 | 分页游标，首次不传；后续传入上次返回的 nextCursor |

#### 出参

返回 `templates[]`（含 `templateId`、`name`、`description`）及分页信息 `hasMore`、`nextCursor`。`templateId` 可直接用于 create_base。

#### 调用示例

```bash
TABLE search_templates --args '{"query":"OKR"}' --output json
TABLE search_templates --args '{"query":"项目","limit":20,"cursor":"next_xxx"}' --output json
```

---

## Dashboard 仪表盘

> **典型工作流**：`get_base` → 取 dashboardId → `get_dashboard` 查看现状 → 需新建/修改时先调 `get_dashboard_config_example` 拿 JSONC 结构 → `create_dashboard` / `update_dashboard`。Dashboard 下的 chart 由独立的 Chart 工具集管理。

### get_dashboard_config_example

返回 dashboard config 的完整结构示例（JSONC 格式，含注释说明每个字段的含义和约束）。作为 create_dashboard / update_dashboard 的 `config` 入参结构参考，调用前应先读取。

#### 入参

无（空对象 `{}`）。

#### 出参

返回 JSONC 格式的 config 完整示例文本，包含 dashboardName、filters、layout 等字段及其语义注释；具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE get_dashboard_config_example --args '{}' --output json
```

---

### get_dashboard

获取指定 dashboard 的详细信息。返回 dashboardName、filters、layout，以及该 dashboard 下的 charts summary（chartId、chartName、chartType）。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases / get_base 获取 |
| dashboardId | string | 是 | 目标 dashboard 的唯一标识，可通过 get_base 获取 |

#### 出参

返回 `dashboardName`、`filters`、`layout`、`charts[]`（含 `chartId`、`chartName`、`chartType`）。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE get_dashboard --args '{"baseId":"<baseId>","dashboardId":"<dashboardId>"}' --output json
```

---

### create_dashboard

在指定 Base 下创建 dashboard。**调用前必须先调用 `get_dashboard_config_example` 了解 config 入参结构和要求**。返回新创建的 dashboard 详情。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases 获取 |
| config | object | 是 | Dashboard 配置对象，必须按 get_dashboard_config_example 返回的 JSONC 结构和注释构造符合要求的 JSON |

#### 出参

返回新创建 dashboard 的详情（含 dashboardId、dashboardName 等）；具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE create_dashboard --args '{
  "baseId": "<baseId>",
  "config": { /* 按 get_dashboard_config_example 返回结构填写 */ }
}' --output json
```

---

### update_dashboard

更新指定 dashboard 的配置。**调用前必须先调用 `get_dashboard_config_example` 了解 config 入参结构和要求**。返回更新后的 dashboard 详情。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases 获取 |
| dashboardId | string | 是 | 目标 dashboard 的唯一标识，可通过 get_base 获取 |
| config | object | 是 | Dashboard 配置对象，必须按 get_dashboard_config_example 返回的 JSONC 结构构造。传入需要更新的字段，未传入的字段保持原值 |

#### 出参

返回更新后的 dashboard 详情；具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE update_dashboard --args '{
  "baseId": "<baseId>",
  "dashboardId": "<dashboardId>",
  "config": { /* 仅传需要更新的字段 */ }
}' --output json
```

---

### delete_dashboard

删除指定 dashboard。**会级联删除该 dashboard 下的所有 chart；操作不可逆**。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases 获取 |
| dashboardId | string | 是 | 目标 dashboard 的唯一标识，可通过 get_base 获取 |
| reason | string | 否 | 删除原因，用于审计 |

#### 出参

返回操作结果。

#### 调用示例

```bash
TABLE delete_dashboard --args '{"baseId":"<baseId>","dashboardId":"<dashboardId>","reason":"重构看板"}' --output json
```

---

## Chart 图表

> **典型工作流**：`get_dashboard` → 取 chartId / 当前 layout → 需新建/修改时先调 `get_dashboard_widgets_example` 拿对应图表类型的 widget config 示例 → `create_chart` / `update_chart`。
>
> **布局规则**：仪表盘为 12 列网格（行数无限），同一行 chart 高度需一致、宽度总和需正好填满 12 列以避免空白；总计类图表排在上部，详细图表排在下部；新增前用 get_dashboard 读取现有布局，必要时通过 update_chart 调整既有 chart 让位。

### get_dashboard_widgets_example

返回所有图表类型的 widget config 示例（JSONC 格式，含字段语义注释）。作为 create_chart / update_chart 的 `config` 入参结构参考，根据目标图表类型选取对应示例。

#### 入参

无（空对象 `{}`）。

#### 出参

返回 JSONC 文本，包含各 chartType 的 config 模板（含 sheet=tableId、view=viewId 等占位与注释）；具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE get_dashboard_widgets_example --args '{}' --output json
```

---

### get_chart

获取指定 chart 的详细信息。返回所属 dashboardId、chartName、chartType、widget.config 以及布局项。返回的 config 中 `sheet` 为该图表引用的数据表 tableId，`view` 为视图 viewId。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases 获取 |
| dashboardId | string | 是 | 所属 dashboard 的唯一标识，可通过 get_base 获取 |
| chartId | string | 是 | 目标 chart 的唯一标识，可通过 get_dashboard 获取 |

#### 出参

返回 `dashboardId`、`chartName`、`chartType`、`widget.config`（含 `sheet`=tableId、`view`=viewId）、`layout`。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE get_chart --args '{"baseId":"<baseId>","dashboardId":"<dashboardId>","chartId":"<chartId>"}' --output json
```

---

### create_chart

在指定 dashboard 下创建 chart。**调用前必须先调用 `get_dashboard_widgets_example` 了解 config 入参结构和要求**。返回新创建的 chart 详情。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases 获取 |
| dashboardId | string | 是 | 所属 dashboard 的唯一标识，可通过 get_base 获取；若需进一步确认该 dashboard 下的 chart summary，可先调用 get_dashboard |
| config | object | 是 | 图表配置对象，必须按 get_dashboard_widgets_example 返回的 JSONC 结构构造，仅需将占位值替换为真实值 |
| layout | object | 是 | 图表在 dashboard 中的位置与大小，见下表 |

**layout 子字段：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| x | number | 是 | 横坐标（列），网格共 12 列 |
| y | number | 是 | 纵坐标（行） |
| w | number | 是 | 宽度（所占列数） |
| h | number | 是 | 高度（所占行数） |
| parentId | string | 否 | 父容器 ID |

#### 出参

返回新创建 chart 的详情（含 chartId、chartName 等）；具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE create_chart --args '{
  "baseId": "<baseId>",
  "dashboardId": "<dashboardId>",
  "config": { /* 按 get_dashboard_widgets_example 选定图表类型并填值 */ },
  "layout": {"x":0, "y":0, "w":6, "h":4}
}' --output json
```

---

### update_chart

更新指定 chart 的配置或布局。**调用前必须先调用 `get_dashboard_widgets_example` 了解 config 入参结构和要求**。返回更新后的 chart 详情。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases 获取 |
| dashboardId | string | 是 | 所属 dashboard 的唯一标识，可通过 get_base 获取 |
| chartId | string | 是 | 目标 chart 的唯一标识，可通过 get_dashboard 获取 |
| config | object | 是 | 图表配置对象，必须按 get_dashboard_widgets_example 返回的 JSONC 结构构造 |
| layout | object | 否 | 不提供则不更改布局；提供时 x/y/w/h 全部必填（schema 中类型为 string） |

**layout 子字段（更新接口 schema 标注为 string 类型，按字符串数字传值）：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| x | string | 是 | 横坐标（列） |
| y | string | 是 | 纵坐标（行） |
| w | string | 是 | 宽度（列数） |
| h | string | 是 | 高度（行数） |
| parentId | string | 否 | 父容器 ID |

#### 出参

返回更新后的 chart 详情；具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE update_chart --args '{
  "baseId": "<baseId>",
  "dashboardId": "<dashboardId>",
  "chartId": "<chartId>",
  "config": { /* 完整 widget config */ },
  "layout": {"x":"0","y":"4","w":"12","h":"4"}
}' --output json
```

---

### delete_chart

删除指定 chart，并同步删除其在 dashboard 中对应的布局项。**操作不可逆**。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases 获取 |
| dashboardId | string | 是 | 所属 dashboard 的唯一标识，可通过 get_base 获取 |
| chartId | string | 是 | 目标 chart 的唯一标识，可通过 get_dashboard 获取 |
| reason | string | 否 | 删除原因 |

#### 出参

返回操作结果。

#### 调用示例

```bash
TABLE delete_chart --args '{"baseId":"<baseId>","dashboardId":"<dashboardId>","chartId":"<chartId>","reason":"图表过时"}' --output json
```

---

## 共享（分享链接）

> **shareType 枚举**：`PUBLIC`（任何人均可通过链接访问，无需鉴权）、`ORG`（仅限当前组织成员访问）。仅在 `enabled=true` 时生效；默认 `PUBLIC`。
> 开启分享后返回的 `shareUrl` 可直接发送他人；关闭分享时 shareType 无意义。

### get_dashboard_share

查询指定 dashboard 的当前分享配置。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases / get_base 获取 |
| dashboardId | string | 是 | 目标 dashboard 的唯一标识，可通过 get_base 获取 |

#### 出参

返回 `enabled`（分享是否开启）、`shareType`（PUBLIC / ORG）、`shareUrl`（分享链接，未开启时为 null）等。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE get_dashboard_share --args '{"baseId":"<baseId>","dashboardId":"<dashboardId>"}' --output json
```

---

### update_dashboard_share

开启或关闭指定 dashboard 的分享，并设置分享类型。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases / get_base 获取 |
| dashboardId | string | 是 | 目标 dashboard 的唯一标识，可通过 get_base 获取 |
| enabled | boolean | 是 | `true` 开启分享，`false` 关闭分享 |
| shareType | string | 否 | 分享类型：`PUBLIC` 或 `ORG`，仅在 enabled=true 时生效；默认 `PUBLIC` |
| allowBackToDoc | boolean | 否 | 是否允许查看者通过分享页返回源 AI 表格文档；不传则保持原配置 |

#### 出参

返回更新后的分享配置（含 `shareUrl`，可直接发送给他人）。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
# 开启 ORG 范围分享
TABLE update_dashboard_share --args '{
  "baseId": "<baseId>",
  "dashboardId": "<dashboardId>",
  "enabled": true,
  "shareType": "ORG",
  "allowBackToDoc": false
}' --output json

# 关闭分享
TABLE update_dashboard_share --args '{"baseId":"<baseId>","dashboardId":"<dashboardId>","enabled":false}' --output json
```

---

### get_chart_share

查询指定 chart 的当前分享配置。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases 获取 |
| dashboardId | string | 是 | 所属 dashboard 的唯一标识，可通过 get_base 获取 |
| chartId | string | 是 | 目标 chart 的唯一标识，可通过 get_dashboard 获取 |

#### 出参

返回 `enabled`、`shareType`（PUBLIC / ORG）、`shareUrl`（未开启时为 null）等。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE get_chart_share --args '{"baseId":"<baseId>","dashboardId":"<dashboardId>","chartId":"<chartId>"}' --output json
```

---

### update_chart_share

开启或关闭指定 chart 的分享，并设置分享类型。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 所属 Base 的唯一标识，可通过 list_bases / search_bases 获取 |
| dashboardId | string | 是 | 所属 dashboard 的唯一标识，可通过 get_base 获取 |
| chartId | string | 是 | 目标 chart 的唯一标识，可通过 get_dashboard 获取 |
| enabled | boolean | 是 | `true` 开启分享，`false` 关闭分享 |
| shareType | string | 否 | 分享类型：`PUBLIC` 或 `ORG`，仅在 enabled=true 时生效；默认 `PUBLIC` |
| allowBackToDoc | boolean | 否 | 是否允许查看者通过分享页返回源 AI 表格文档；不传则保持原配置 |

#### 出参

返回更新后的分享配置（含 `shareUrl`）。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE update_chart_share --args '{
  "baseId": "<baseId>",
  "dashboardId": "<dashboardId>",
  "chartId": "<chartId>",
  "enabled": true,
  "shareType": "PUBLIC"
}' --output json
```

---

## 其他能力

### copy_base

将当前 AI 表格复制到指定目录下。可选择完整复制（含数据）或仅复制结构（不含记录）。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 源 Base 标识，支持 dentryUuid / baseId（32 位字母数字字符串） |
| targetFolderId | string | 是 | 目标父节点标识，最终生效值必须为 dentryUuid（32 位字母数字字符串）；若用户提供的是文档链接，需先通过文档 DWS 获取该目录的 dentryUuid 再传入 |
| onlyCopyMeta | boolean | 是 | 是否仅复制基础元数据。`true`=仅复制表/字段结构（不复制实际记录数据），`false`=完整复制全部内容与结构 |

#### 出参

返回复制后新 Base 的标识信息。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
# 完整复制
TABLE copy_base --args '{
  "baseId": "<baseIdOrDentryUuid>",
  "targetFolderId": "<targetFolderDentryUuid>",
  "onlyCopyMeta": false
}' --output json

# 仅复制结构（不带数据）
TABLE copy_base --args '{
  "baseId": "<baseIdOrDentryUuid>",
  "targetFolderId": "<targetFolderDentryUuid>",
  "onlyCopyMeta": true
}' --output json
```

---

### get_base_primary_doc_id

根据 baseId、tableId 和 recordId 获取主键字段（primaryDoc 类型字段）所对应文档的 dentryUuid。拿到 dentryUuid 后即可用钉钉文档相关工具读取或编辑该文档内容。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID，可通过 list_bases 或 search_bases 获取 |
| tableId | string | 是 | Table ID，可通过 get_tables 或 get_base 获取 |
| recordId | string | 是 | 记录 ID，可通过 query_records 获取 |

#### 出参

返回该记录主键文档的 `dentryUuid`，可作为钉钉文档 MCP 工具的 nodeId 进一步操作。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE get_base_primary_doc_id --args '{
  "baseId": "<baseId>",
  "tableId": "<tableId>",
  "recordId": "<recordId>"
}' --output json
```

---

### run_ai_field

触发指定 AI 字段的运行任务。支持同时运行多个 AI 字段（单次最多 10 个），每个字段独立提交任务。**仅提交任务即返回，不等待运行完成**；返回包含文档链接，可打开文档查看进度和结果。部分字段处于运行中（幂等冲突）不影响其他字段提交，整体仍返回 success。

> **典型工作流**：`get_fields` 取出 AI 类型字段的 fieldId（必须是 AI 字段）→ 如只跑指定记录，则先用 `query_records` 取出 recordIds → 调用 `run_ai_field`。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | 目标 Base ID，通过 list_bases / search_bases 获取 |
| tableId | string | 是 | 包含 AI 字段的 Table ID，通过 get_base / get_tables 获取 |
| fieldIds | string[] | 是 | 待运行的 AI 字段 ID 列表；每个字段必须是 AI 类型字段；单次最多 10 个 |
| recordIds | string[] | 否 | 指定运行的记录 ID 列表。不传时**整列运行**（刷新所有记录）；传入时仅运行指定记录，单次最多 500 条 |

#### 出参

返回提交结果与文档链接（用于查看运行进度）。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
# 整列刷新（不传 recordIds）
TABLE run_ai_field --args '{
  "baseId": "<baseId>",
  "tableId": "<tableId>",
  "fieldIds": ["<aiFieldId1>","<aiFieldId2>"]
}' --output json

# 指定记录运行
TABLE run_ai_field --args '{
  "baseId": "<baseId>",
  "tableId": "<tableId>",
  "fieldIds": ["<aiFieldId1>"],
  "recordIds": ["<recordId1>","<recordId2>"]
}' --output json
```

---

### create_guide_document

在指定 Base 中创建一个说明文档（位于 Base 导航栏中的文档节点，用于记录使用说明、数据字典等）。**每个 Base 最多 5 个说明文档，需要管理员权限**。返回的 `documentId` 可作为钉钉文档 MCP 的 nodeId 进一步读写文档内容。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID，可通过 list_bases 或 search_bases 获取 |
| name | string | 否 | 说明文档名称；不传时系统自动生成默认名称 |

#### 出参

返回新建说明文档的 `documentId` 与 `name`。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE create_guide_document --args '{"baseId":"<baseId>","name":"使用说明"}' --output json
```

---

### update_guide_document

更新指定 Base 中的说明文档（重命名）。**需要管理员权限**。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID，可通过 list_bases 或 search_bases 获取 |
| documentId | string | 是 | 说明文档 ID，可通过 get_base 返回的 documents 列表获取 |
| newDocumentName | string | 是 | 新的说明文档名称 |

#### 出参

返回更新后的说明文档 `documentId` 与 `name`。具体返回字段以官方实际响应为准。

#### 调用示例

```bash
TABLE update_guide_document --args '{
  "baseId": "<baseId>",
  "documentId": "<documentId>",
  "newDocumentName": "数据字典 v2"
}' --output json
```

---

### delete_guide_document

删除指定 Base 中的说明文档。**不可逆，文档内容将永久丢失，需要管理员权限**。调用前请先通过 get_base 确认目标 documentId 与名称，避免误删。

#### 入参

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseId | string | 是 | Base ID，可通过 list_bases 或 search_bases 获取 |
| documentId | string | 是 | 说明文档 ID，可通过 get_base 返回的 documents 列表获取 |
| reason | string | 否 | 一句话描述删除原因，用于审计 |

#### 出参

返回操作结果。

#### 调用示例

```bash
TABLE delete_guide_document --args '{"baseId":"<baseId>","documentId":"<documentId>","reason":"内容已废弃"}' --output json
```

---

## 字段类型参考

### 类型总表

| type | 中文名 | 需要 config | 备注 |
|------|--------|-------------|------|
| `text` | 文本 | 否 | |
| `number` | 数字 | 可选（formatter） | |
| `singleSelect` | 单选 | **是**（options） | |
| `multipleSelect` | 多选 | **是**（options） | |
| `date` | 日期 | 可选（formatter） | |
| `currency` | 货币 | 可选（currencyType, formatter） | |
| `user` | 人员 | 可选（multiple） | |
| `department` | 部门 | 可选（multiple） | |
| `group` | 群组 | 可选（multiple） | |
| `progress` | 进度 | 可选（formatter, customizeRange, min, max） | |
| `rating` | 评分 | 可选（min, max, icon） | max 范围 1~10 |
| `checkbox` | 勾选 | 否 | |
| `attachment` | 附件 | 否 | |
| `url` | 链接 | 否 | |
| `richText` | 富文本 | 否 | |
| `telephone` | 电话 | 否 | |
| `email` | 邮件 | 否 | |
| `idCard` | 身份证 | 否 | |
| `barcode` | 条码 | 否 | |
| `geolocation` | 地理位置 | 否 | |
| `primaryDoc` | 文档 | 否 | 仅限第一列 |
| `formula` | 公式 | 是（formula） | |
| `unidirectionalLink` | 单向关联 | **是**（linkedTableId, multiple） | |
| `bidirectionalLink` | 双向关联 | **是**（linkedTableId, multiple） | 反向关联端由系统自动创建 |
| `creator` | 创建人 | 否 | 系统只读字段 |
| `lastModifier` | 最后编辑人 | 否 | 系统只读字段 |
| `createdTime` | 创建时间 | 否 | 系统只读字段 |
| `lastModifiedTime` | 最后编辑时间 | 否 | 系统只读字段 |

### config 详细结构

#### number — formatter

可选值：`INT` | `FLOAT_1` | `FLOAT_2` | `FLOAT_3` | `FLOAT_4` | `THOUSAND` | `THOUSAND_FLOAT` | `PERCENT` | `PERCENT_FLOAT`

```json
{"formatter": "FLOAT_2"}
```

#### currency — currencyType & formatter

- **currencyType**：`CNY` | `HKD` | `USD` | `EUR` | `GBP` | `MOP` | `VND` | `JPY` | `KRW` | `AED` | `AUD` | `BRL` | `CAD` | `CHF` | `INR` | `IDR` | `MXN` | `MYR` | `PHP` | `PLN` | `RUB` | `SGD` | `THB` | `TRY` | `TWD`
- **formatter**（可省略，默认 FLOAT_2）：`INT` | `FLOAT_1` | `FLOAT_2` | `FLOAT_3` | `FLOAT_4`

```json
{"currencyType": "CNY", "formatter": "FLOAT_2"}
```

#### date — formatter

可选值：`YYYY-MM-DD` | `YYYY-MM-DD HH:mm` | `YYYY-MM-DD HH:mm:ss` | `YYYY/MM/DD` | `YYYY/MM/DD HH:mm`

```json
{"formatter": "YYYY-MM-DD"}
```

#### singleSelect / multipleSelect — options

创建时只需传 `name`，`id` 由系统生成。更新时已有选项应回传原 `id`。

```json
{"options": [{"name": "高"}, {"name": "中"}, {"name": "低"}]}
```

#### user / department / group — multiple

`true`（多选，默认）| `false`（单选）

```json
{"multiple": false}
```

#### progress — formatter & customizeRange

```json
// 默认范围（0~1 即 0%~100%）
{"formatter": "PERCENT"}

// 自定义范围（customizeRange 必须为 true）
{"formatter": "PERCENT", "min": 0, "max": 1, "customizeRange": true}
```

#### rating — min, max, icon

`max` 范围 1~10。

```json
{"min": 1, "max": 5, "icon": "star"}
```

#### formula — formula

使用 AI 表格公式字符串格式，方括号内填写表内字段名。

```json
{"formula": "[单价] * [数量]"}
```

#### unidirectionalLink / bidirectionalLink — linkedTableId & multiple

```json
{"linkedTableId": "<tableId>", "multiple": true}
```

bidirectionalLink 的反向关联端由系统自动创建。

---

### aiConfig 结构

AI 字段的完整配置（用于 create_fields 和 update_field）。

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| outputType | string | 是 | 输出类型：`text`、`select`、`multiSelect`、`number`、`currency`、`image`、`video` |
| prompt | object[] | 是 | Prompt 片段列表 |
| autoRecompute | boolean | 否 | 引用字段变化后是否自动重算 |
| enableThinking | boolean | 否 | 是否启用深度思考 |
| enableWebSearch | boolean | 否 | 是否启用联网搜索 |
| computeOnEmptyRef | boolean | 否 | 引用字段为空时是否仍触发计算，默认 false |
| imageConfig | object | 否 | 图片生成配置（仅 outputType=image） |
| videoConfig | object | 否 | 视频生成配置（仅 outputType=video） |

**prompt 元素结构：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| type | string | 是 | `text` 或 `fieldRef` |
| value | string | type=text 时必填 | 文本片段内容 |
| fieldId | string | type=fieldRef 时必填 | 被引用字段的 fieldId |

**imageConfig 结构：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| resolution | string | 是 | 分辨率：`1280*1280`、`1024*1024`、`800*1200`、`1200*800`、`960*1280`、`1280*960`、`720*1280`、`1280*720`、`1344*576` |
| aiGeneratedWatermark | boolean | 是 | 是否生成 AI 水印 |

**videoConfig 结构：**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| resolution | string | 是 | 分辨率：`480p`、`720p`、`1080p` |
| aspectRatio | string | 是 | 宽高比：`832*480`、`480*832`、`624*624`、`1280*720`、`720*1280`、`960*960`、`1088*832`、`832*1088`、`1920*1080`、`1080*1920`、`1440*1440`、`1632*1248`、`1248*1632` |
| duration | number | 否 | 时长：`5` 或 `10` |

**aiConfig 示例：**

```json
{
  "outputType": "text",
  "prompt": [
    {"type": "text", "value": "根据以下信息生成摘要："},
    {"type": "fieldRef", "fieldId": "fld_content"}
  ],
  "autoRecompute": true,
  "enableWebSearch": false
}
```

---

## 单元格写入格式参考

在 create_records 和 update_records 的 `cells` 中，各字段类型的值格式如下：

| 字段类型 | 写入格式 | 示例 |
|----------|----------|------|
| text | 字符串 | `"文本内容"` |
| number | 数字（也接受字符串） | `123.45` |
| currency | 数字 | `99.99` |
| progress | 数字，范围 0~1（即 0%~100%） | `0.75` |
| rating | 数字，须在字段 min~max 范围内 | `4` |
| singleSelect | 选项名称字符串，或 `{"id":"opt_xxx"}` / `{"id":"opt_xxx","name":"进行中"}`。对象写入以 id 为准；直接传 option id 字符串会报错。写入不存在的名称时系统自动补选项 | `"高"` 或 `{"id":"opt_xxx","name":"高"}` |
| multipleSelect | 名称字符串数组，或对象数组（每项须带 id）。直接传 id 字符串数组会报错 | `["标签A","标签B"]` 或 `[{"id":"opt_a","name":"标签A"}]` |
| date | 日期字符串、RFC3339 字符串或毫秒时间戳 | `"2026-03-15"` 或 `"2026-03-15T09:00+08:00"` |
| checkbox | boolean | `true` |
| user | 用户对象数组 | `[{"userId":"staff_001","corpId":"dingxxxxxxxx"}]` |
| department | 部门对象数组 | `[{"deptId":"52528700"}]` |
| group | 群组对象数组（注意 key 是 `cid` 不是 openConversationId） | `[{"cid":"74577067501"}]` |
| url | 对象或字符串（兼容） | `{"text":"钉钉","link":"https://dingtalk.com"}` |
| richText | 对象（markdown 格式） | `{"markdown":"**加粗**\n普通文字"}` |
| telephone / email / barcode / idCard | 字符串 | `"13800138000"` |
| attachment | fileToken 数组、URL 数组或完整对象数组（整体覆盖）。URL 转存为异步 best-effort | `[{"fileToken":"ft_xxx"}]` 或 `[{"url":"https://..."}]` |
| geolocation | 对象（location 为 `[经度, 纬度]` 字符串数组） | `{"address":"杭州市","name":"阿里中心","location":["120.007","30.271"]}` |
| unidirectionalLink / bidirectionalLink | 关联记录 ID 对象 | `{"linkedRecordIds":["recA","recB"]}` |
| creator / lastModifier / createdTime / lastModifiedTime | **系统只读，禁止写入** | - |
