---
name: dingtalk-docs
description: 操作钉钉云文档、知识库、电子表格和 AI 表格。触发场景：搜索/读取/创建/编辑钉钉在线文档；遍历知识库/文件夹；读写传统电子表格单元格、工作表、行列、筛选、公式、下拉；操作 AI 表格/多维表的 Base/Table/Field/Record/View/Dashboard/Chart/AI 字段；导入导出文档或表格；管理钉钉文档权限。用户模糊提到“钉钉上的文档/表格/知识库/多维表/AI 表格/仪表盘/单元格/字段/记录”时也应触发。不要用于发送钉钉消息（用 dingtalk-msg）、查询公司 CRM/项目/员工业务库（用 ky-data-query）、或操作本地 xlsx 文件（用 xlsx）。
---

# 钉钉云文档 / 电子表格 / AI 表格

这是钉钉官方 MCP 的轻量调用说明。**不要依赖本文件枚举的旧工具列表**；钉钉 MCP 会更新，具体工具、参数和返回结构以运行时 schema 为准。

## 核心原则：动态 schema 优先

每次执行任务时，先判断目标域，只对相关服务拉取 schema：

```bash
# 云文档 / 知识库 / 文件夹 / 文档权限 / 文档导出
mcporter --config .ky-agent/skills/dingtalk-docs/mcporter.json list dingtalk-docs --schema --json

# 传统电子表格：工作簿、工作表、单元格、公式、行列、筛选、下拉
mcporter --config .ky-agent/skills/dingtalk-docs/mcporter.json list dingtalk-sheet --schema --json

# AI 表格 / 多维表：Base、Table、Field、Record、View、Dashboard、Chart、AI 字段
mcporter --config .ky-agent/skills/dingtalk-docs/mcporter.json list dingtalk-ai-table --schema --json
```

只在需要跨域时才拉多个 schema。不要无脑全量拉三份，太吵，也浪费上下文。

调用工具格式：

```bash
mcporter --config .ky-agent/skills/dingtalk-docs/mcporter.json call <server> <tool> --args '<JSON>' --output json
```

示例：

```bash
mcporter --config .ky-agent/skills/dingtalk-docs/mcporter.json call dingtalk-docs search_documents --args '{"keyword":"项目计划"}' --output json
```

## 域路由

| 用户意图 | MCP 服务 | 判断依据 |
|---|---|---|
| 读写文档正文、搜索文档、知识库/文件夹、文档权限、上传下载、导出 | `dingtalk-docs` | 文档、云文档、知识库、文件夹、在线文档、权限、导出 docx |
| 读写传统表格单元格、公式、工作表、行列、合并、筛选、下拉 | `dingtalk-sheet` | 单元格、工作表、Sheet、A1:C10、公式、行列、筛选、Excel 式表格 |
| 多维表/AI 表格的字段、记录、视图、仪表盘、图表、AI 字段 | `dingtalk-ai-table` | AI 表格、多维表、Base、Table、字段、记录、fieldId、recordId、视图、仪表盘、图表 |

“表格”消歧义：
- 文档正文里的内嵌表格 → `dingtalk-docs` 的文档 block 能力。
- 独立电子表格文件，有单元格地址/公式/工作表 → `dingtalk-sheet`。
- 多维表，有字段/记录/视图/仪表盘 → `dingtalk-ai-table`。

## 工作方式

1. **先取 schema**：根据域路由运行 `mcporter list <server> --schema --json`。
2. **从 schema 里确认工具名、必填参数、参数类型**。不要凭记忆写参数。
3. **先获取 ID 再操作**：nodeId / sheetId / baseId / tableId / fieldId / recordId / viewId / dashboardId / chartId / blockId / resourceId / jobId 都必须来自搜索、列表、读取或创建工具的返回值；禁止编造。
4. **读后再写**：修改已有内容、单元格、记录、权限、视图配置前，先读取现状，除非用户明确给了完整目标和 ID。
5. **返回结果要落到业务语言**：不要把大段 JSON 原样甩给用户。提炼成功/失败、关键 URL/ID、下一步风险。

## 高危操作规则

执行以下操作前必须确认用户意图；如果用户已经明确要求，可继续，但仍要先读取/列出现状：

- 删除文档、文件夹、block、表格、字段、记录、视图、仪表盘、图表、说明文档。
- 覆盖全文、批量替换、批量更新记录、覆盖单元格区域、删除行列、删除筛选/下拉。
- 修改权限、公开分享、移动文件到其他空间、导入数据覆盖结构或创建大量新表。
- 上传/导出涉及敏感内容到第三方公开位置。

安全默认值：
- 文档新增内容优先 `append`，不要默认 `overwrite`。
- 表格写入前先读取目标范围，避免覆盖用户数据。
- AI 表格批量操作分批并报告数量；遇到分页要继续读取，别只看第一页就下结论。
- 异步导出/导入要保存 jobId/importId，并轮询到成功或明确失败。

## 常见工作流（工具名以动态 schema 为准）

### 云文档 / 知识库

- 搜索并读取：`list/search documents` → `get content/info`
- 遍历知识库：`list nodes(workspaceId)`；注意 workspaceId 不是 folderId。
- 创建文档：`create document(name, markdown, folderId/workspaceId?)`
- 追加文档：先读内容/确认 nodeId → `update document(mode=append)`
- 精细编辑 block：`list blocks` → `insert/update/delete block`
- 权限：先 `list permission` → 再 add/update permission
- 导出：`submit export job` → `query export job` → 下载

### 电子表格

- 找表：通常先用 `dingtalk-docs` 搜索文件拿 nodeId，再用 `dingtalk-sheet` 操作。
- 读数据：`get all sheets` → `get range`
- 写数据：先 `get range` 备份/确认 → `update range` 或 `append rows`
- 表结构：`create/update/copy sheet`，行列维度工具要特别看 schema 中的索引语义。
- 筛选/下拉/合并：先读取当前配置，再创建或更新。
- 导出：`submit export job` → `query export job`

### AI 表格 / 多维表

- 找 Base：`list/search bases` → `get base`
- 查结构：`get tables` / `get fields`，拿 fieldId，不要用字段名当 key，除非 schema 明确支持。
- 查记录：`query records`，注意分页、筛选条件、排序结构都以 schema 为准。
- 写记录：`create/update records`，批量上限以 schema 为准；通常单批不要超过 100。
- 建表：`create base` → `create table(fields)` → `create records`
- 视图/仪表盘/图表：创建或更新前先找 schema/example/config 示例工具；不要凭空构造复杂 config。
- AI 字段：先 `get fields` 拿 AI 字段 fieldId → `run ai field`，必要时指定 recordIds。

## 错误处理

- `PERMISSION_DENIED`：提示用户确认当前账号/应用是否有对应文档或空间权限。
- `UNSUPPORTED_CONTENT_TYPE`：该文件可能不是可读写在线文档，改用下载/导出或对应表格服务。
- `BLOCK_NOT_FOUND` / ID 不存在：重新 list，说明文档结构可能已变。
- `Invalid credentials`：MCP 凭证或 key 失效，需要管理员更新配置。
- `paramError`：不要硬试；重新看 schema，校正参数名、类型和必填项。
- 有 `logId/requestId` 时，在给用户的错误摘要里保留，方便排查。

## 何时读取参考文件

本 skill 的 `references/` 目录可能滞后于钉钉 MCP，只能作为经验参考，不可替代动态 schema。

- 需要理解复杂 config 的历史示例时，可读 `references/*.md`。
- 若 references 与 `mcporter list --schema --json` 冲突，**以动态 schema 为准**。
