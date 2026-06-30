# 钉钉云文档 API 参考（v1.0）

> 新版 MCP 工具完整参数 Schema、返回值格式和调用示例。
> 需要新版 MCP URL：[钉钉文档 MCP 广场](https://mcp.dingtalk.com/#/detail?mcpId=9629)

## 公共说明

### nodeId 格式

所有接受 `nodeId` / `folderId` 的参数均支持两种格式，系统自动识别：
- **文档 URL**：`https://alidocs.dingtalk.com/i/nodes/{dentryUuid}`
- **文档 ID**：32 位字母数字字符串（dentryUuid）

### 公共返回字段

每个工具的返回值都包含以下公共字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `success` | boolean | 是否成功 |
| `logId` | string | 请求追踪 ID，遇到问题时提供给钉钉官方排查 |
| `errorCode` | string | 错误码（仅失败时） |
| `errorMessage` | string | 错误描述（仅失败时） |

---

## 1. search_documents — 搜索文档

根据关键词搜索当前用户有权限访问的文档列表。不传 keyword 时返回最近访问的文档（最多 10 条）。

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `keyword` | string | 否 | 搜索关键词，匹配文档标题和内容。不传则返回最近访问的文档列表 |

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `documents` | array | 文档列表（最多 10 条） |
| `documents[].nodeId` | string | 节点 ID，可直接用于其他工具的 nodeId 参数 |
| `documents[].name` | string | 文档标题（已剔除文件后缀） |
| `documents[].nodeType` | string | 节点结构类型：`folder` 或 `file` |
| `documents[].contentType` | string | 内容类型（nodeType=file 时）：`ALIDOC`/`DOCUMENT`/`IMAGE`/`VIDEO`/`AUDIO`/`ARCHIVE`/`OTHER` |
| `documents[].extension` | string | 文件后缀（不含点号，如 adoc、xlsx、pdf） |
| `documents[].docUrl` | string | 文档访问链接 |
| `documents[].lastEditTime` | integer | 最后编辑时间（毫秒时间戳） |
| `documents[].updateTime` | integer | 最后变更时间（毫秒时间戳） |

**调用示例:**

```bash
# 搜索包含"项目"的文档
mcporter call dingtalk-docs search_documents --args '{"keyword": "项目"}'

# 返回最近访问的文档
mcporter call dingtalk-docs search_documents
```

---

## 2. get_document_content — 获取文档内容

获取钉钉文档的内容，以 Markdown 格式返回。仅支持 contentType=ALIDOC 的在线文档，表格/PPT/PDF 等不支持。

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 文档标识，支持 URL 或 ID 自动识别 |

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `title` | string | 文档标题 |
| `markdown` | string | 文档内容（Markdown 格式） |
| `nodeId` | string | 文档节点 ID |
| `docUrl` | string | 文档访问链接 |

**调用示例:**

```bash
# 通过 nodeId 获取
mcporter call dingtalk-docs get_document_content --args '{"nodeId": "DnRL6jAJMNX9kAgycoLy2vOo8yMoPYe1"}'

# 通过 URL 获取（自动识别）
mcporter call dingtalk-docs get_document_content --args '{"nodeId": "https://alidocs.dingtalk.com/i/nodes/DnRL6jAJMNX9kAgycoLy2vOo8yMoPYe1"}'
```

---

## 3. create_document — 创建文档

创建一篇新的钉钉在线文档，支持同时写入初始内容。不传 folderId 时默认创建到用户"我的文档"根目录。

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `name` | string | 是 | 新文档的标题 |
| `folderId` | string | 否 | 目标文件夹节点 ID，支持 URL 或 ID。不传则创建到根目录（或 workspaceId 的根目录） |
| `workspaceId` | string | 否 | 目标知识库 ID。同时传了 folderId 时以 folderId 为准 |
| `markdown` | string | 否 | 文档初始内容（Markdown 格式）。不传则创建空文档 |

**入参优先级：** `folderId` > `workspaceId` > 默认（我的文档根目录）

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 新文档的节点 ID |
| `name` | string | 文档名称 |
| `folderId` | string | 实际创建位置的父文件夹节点 ID |
| `docUrl` | string | 文档访问链接 |
| `createTime` | integer | 创建时间（毫秒时间戳） |

**调用示例:**

```bash
# 创建空文档到根目录
mcporter call dingtalk-docs create_document --args '{"name": "项目计划"}'

# 创建带初始内容的文档（一步完成）
mcporter call dingtalk-docs create_document --args '{"name": "项目计划", "markdown": "# 项目计划\n\n## 目标\n完成 Q1 目标"}'

# 在指定文件夹下创建
mcporter call dingtalk-docs create_document --args '{"name": "子文档", "folderId": "folder_nodeId"}'

# 在知识库根目录下创建
mcporter call dingtalk-docs create_document --args '{"name": "知识库文档", "workspaceId": "workspace_id"}'
```

---

## 4. update_document — 更新文档内容

更新钉钉文档的内容，支持覆盖和追加两种模式。

**⚠️ overwrite 模式会清空文档全部内容（包括图片、评论等），操作前请先确认用户意图，建议先用 get_document_content 备份。**

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 目标文档标识，支持 URL 或 ID 自动识别 |
| `markdown` | string | 是 | 要写入的 Markdown 内容 |
| `mode` | string | 否 | 更新模式，默认 `overwrite`。可选：`overwrite`（覆盖全文）、`append`（追加到末尾） |

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 文档节点 ID |
| `mode` | string | 使用的更新模式 |
| `suggestion` | string | 修复建议（仅失败时） |

**调用示例:**

```bash
# 覆盖写入（⚠️ 会清空原内容）
mcporter call dingtalk-docs update_document --args '{"nodeId": "doc_nodeId", "markdown": "# 新内容\n\n全量替换", "mode": "overwrite"}'

# 追加内容（安全，不影响现有内容）
mcporter call dingtalk-docs update_document --args '{"nodeId": "doc_nodeId", "markdown": "\n\n## 新章节\n追加的内容", "mode": "append"}'
```

---

## 5. get_document_info — 获取文档元信息

获取文档的元信息（标题、类型、创建时间等），不返回文档正文内容。适合在读取内容前先确认文档类型（contentType=ALIDOC 才支持 Markdown 读写）。

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 文档标识，支持 URL 或 ID 自动识别 |

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 节点 ID |
| `workspaceId` | string | 所属知识库 ID |
| `name` | string | 文档标题（已剔除文件后缀） |
| `docUrl` | string | 文档访问链接 |
| `nodeType` | string | 节点类型：`folder` 或 `file` |
| `contentType` | string | 内容类型（nodeType=file 时）：`ALIDOC`/`DOCUMENT`/`IMAGE`/`VIDEO`/`AUDIO`/`ARCHIVE`/`OTHER` |
| `extension` | string | 文件后缀（不含点号） |
| `folderId` | string | 父文件夹节点 ID |
| `createTime` | integer | 创建时间（毫秒时间戳） |
| `updateTime` | integer | 最后变更时间（毫秒时间戳） |

**调用示例:**

```bash
mcporter call dingtalk-docs get_document_info --args '{"nodeId": "doc_nodeId"}'
```

---

## 6. create_folder — 创建文件夹

在指定位置创建一个新的文件夹。不传 folderId 时默认创建到用户"我的文档"根目录。

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `name` | string | 是 | 新文件夹的名称 |
| `folderId` | string | 否 | 父文件夹节点 ID，支持 URL 或 ID。不传则创建到根目录 |
| `workspaceId` | string | 否 | 目标知识库 ID。同时传了 folderId 时以 folderId 为准 |

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 新文件夹的节点 ID，可作为后续创建操作的 folderId |
| `name` | string | 文件夹名称 |
| `folderId` | string | 父文件夹节点 ID |
| `docUrl` | string | 文件夹访问链接 |
| `createTime` | integer | 创建时间（毫秒时间戳） |

**调用示例:**

```bash
# 在根目录创建文件夹
mcporter call dingtalk-docs create_folder --args '{"name": "2026 项目"}'

# 在指定文件夹下创建子文件夹
mcporter call dingtalk-docs create_folder --args '{"name": "子文件夹", "folderId": "parent_folder_nodeId"}'
```

---

## 7. list_nodes — 遍历文件列表

列出指定文件夹或知识库下的直接子节点列表，支持分页。返回结果基于当前用户的可访问权限过滤。

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `folderId` | string | 否 | 要遍历的文件夹节点 ID，支持 URL 或 ID |
| `workspaceId` | string | 否 | 知识库 ID。同时传了 folderId 时以 folderId 为准 |
| `pageSize` | integer | 否 | 每页数量，默认 50，最大 50 |
| `pageToken` | string | 否 | 分页游标，从上一次返回的 nextPageToken 获取 |

**入参优先级：** `folderId` > `workspaceId` > 默认（我的文档根目录）

| 场景 | folderId | workspaceId | 遍历位置 |
|------|:--------:|:-----------:|---------|
| 指定文件夹 | ✅ 传入 | 可传可不传 | folderId 对应的文件夹 |
| 知识库根目录 | ❌ 不传 | ✅ 传入 | workspaceId 对应的知识库根目录 |
| 我的文档 | ❌ 不传 | ❌ 不传 | 用户"我的文档"根目录 |

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodes` | array | 子节点列表 |
| `nodes[].nodeId` | string | 节点 ID，可直接用于其他工具的 nodeId/folderId 参数 |
| `nodes[].workspaceId` | string | 所属知识库 ID |
| `nodes[].name` | string | 节点名称（已剔除文件后缀） |
| `nodes[].nodeType` | string | 节点类型：`folder`（目录）或 `file`（文件） |
| `nodes[].contentType` | string | 内容类型（nodeType=file 时）：`ALIDOC`/`DOCUMENT`/`IMAGE`/`VIDEO`/`AUDIO`/`ARCHIVE`/`OTHER` |
| `nodes[].extension` | string | 文件后缀（不含点号） |
| `nodes[].docUrl` | string | 访问链接 |
| `nodes[].createTime` | integer | 创建时间（毫秒时间戳） |
| `nodes[].updateTime` | integer | 最后变更时间（毫秒时间戳） |
| `nodes[].hasChildren` | boolean | 是否存在子节点（主要对 folder 有意义） |
| `hasMore` | boolean | 是否还有更多节点 |
| `nextPageToken` | string | 下一页游标（仅 hasMore=true 时返回） |

**nodeType 与 contentType 关系：**

| nodeType | contentType | 说明 |
|----------|------------|------|
| `folder` | —（不返回） | 文件夹，可递归遍历（hasChildren=true 时） |
| `file` | `ALIDOC` | 钉钉在线文档，可用 get_document_content 获取内容 |
| `file` | `DOCUMENT` | 本地文档（docx、xlsx、pptx、pdf 等） |
| `file` | `IMAGE` | 图片 |
| `file` | `VIDEO` | 视频 |
| `file` | `AUDIO` | 音频 |
| `file` | `ARCHIVE` | 压缩包 |
| `file` | `OTHER` | 其他文件 |

**调用示例:**

```bash
# 列出根目录
mcporter call dingtalk-docs list_nodes

# 列出指定文件夹
mcporter call dingtalk-docs list_nodes --args '{"folderId": "folder_nodeId"}'

# 分页获取
mcporter call dingtalk-docs list_nodes --args '{"folderId": "folder_nodeId", "pageSize": 10, "pageToken": "next_page_token"}'
```

---

## 完整工作流示例

### 创建文档并写入内容（一步完成）

```bash
# 直接创建带内容的文档，无需先获取根目录 ID
mcporter call dingtalk-docs create_document --args '{"name": "项目计划", "markdown": "# 项目计划\n\n## 目标\n完成 Q1 目标"}'
```

### 搜索并读取文档

```bash
# 1. 搜索文档，获取 nodeId
mcporter call dingtalk-docs search_documents --args '{"keyword": "项目"}'

# 2. 获取文档内容（直接用 nodeId，无需拼接 URL）
mcporter call dingtalk-docs get_document_content --args '{"nodeId": "<step1返回的nodeId>"}'
```

### 遍历文件夹并读取 ALIDOC 文档

```bash
# 1. 列出文件夹内容
mcporter call dingtalk-docs list_nodes --args '{"folderId": "folder_nodeId"}'

# 2. 对 contentType=ALIDOC 的节点读取内容
mcporter call dingtalk-docs get_document_content --args '{"nodeId": "<nodes[].nodeId>"}'
```

### 创建文件夹并在其中创建文档

```bash
# 1. 创建文件夹
mcporter call dingtalk-docs create_folder --args '{"name": "2026 项目"}'
# 返回 nodeId: "folder_abc123"

# 2. 在文件夹中创建文档
mcporter call dingtalk-docs create_document --args '{"name": "Q1 计划", "folderId": "folder_abc123"}'
```

### 追加内容到已有文档

```bash
# 1. 搜索文档
mcporter call dingtalk-docs search_documents --args '{"keyword": "周报"}'

# 2. 追加内容（不影响现有内容）
mcporter call dingtalk-docs update_document --args '{"nodeId": "<nodeId>", "markdown": "\n\n## 2026-W11\n本周完成了...", "mode": "append"}'
```

### 覆盖更新前先备份

```bash
# 1. 先读取现有内容作为备份
mcporter call dingtalk-docs get_document_content --args '{"nodeId": "doc_nodeId"}'

# 2. 确认用户意图后再覆盖
mcporter call dingtalk-docs update_document --args '{"nodeId": "doc_nodeId", "markdown": "# 全新内容", "mode": "overwrite"}'
```

### Block 精细编辑工作流

```bash
# 1. 查询文档块列表，获取 blockId
mcporter call dingtalk-docs list_document_blocks --args '{"nodeId": "doc_nodeId"}'

# 2. 在指定块之后插入一个段落
mcporter call dingtalk-docs insert_document_block --args '{"nodeId": "doc_nodeId", "element": {"blockType": "paragraph", "paragraph": {"text": "新段落内容"}}, "referenceBlockId": "block_id", "where": "after"}'

# 3. 更新某个段落块的内容
mcporter call dingtalk-docs update_document_block --args '{"nodeId": "doc_nodeId", "blockId": "block_id", "element": {"paragraph": {"elements": [{"textRun": {"content": "更新后的内容"}}]}}}'

# 4. 删除指定块（不可恢复）
mcporter call dingtalk-docs delete_document_block --args '{"nodeId": "doc_nodeId", "blockId": "block_id"}'
```

---

## Block 精细编辑工具

> Block 工具用于对文档进行块级精细操作。块元素的完整数据结构请参考 [dingtalk_document_struct.md](../dingtalk_document_struct.md)。

### 公共说明

- **blockId**：块元素的唯一标识，通过 `list_document_blocks` 获取
- **element**：块元素数据对象，必须包含 `blockType` 字段及对应类型的属性对象
- 所有写操作（insert/update/delete）均需要对文档有**编辑权限**

---

## 8. list_document_blocks — 查询文档块列表

查询指定文档下的一级块元素列表（根节点下第一级 BlockElement），支持按起始/终止位置范围及块类型过滤。返回每个块的 `blockId`、`index` 和完整数据结构。

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 文档标识，支持 URL 或 ID 自动识别 |
| `startIndex` | integer | 否 | 起始位置（≥0），从第 startIndex 个块开始查询，不传则从头开始 |
| `endIndex` | integer | 否 | 终止位置（≥0），查询到第 endIndex 个块为止（含），不传则查询到末尾 |
| `blockType` | string | 否 | 按块类型过滤，不传返回所有类型。枚举值见下表 |

**blockType 枚举值:**

| 值 | 说明 |
|---|---|
| `paragraph` | 段落块 |
| `heading` | 标题块 |
| `blockquote` | 引用块 |
| `callout` | 高亮块 |
| `columns` | 分栏块 |
| `orderedList` | 有序列表块 |
| `unorderedList` | 无序列表块 |
| `table` | 表格块 |
| `tableRow` | 表格行块 |
| `tableCell` | 表格单元格块 |

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `blocks` | array | 块元素列表 |
| `blocks[].blockId` | string | 块元素唯一标识，可用于 insert/update/delete 操作 |
| `blocks[].index` | integer | 块在文档根节点中的位置（从 0 开始） |
| `blocks[].blockType` | string | 块类型 |
| `blocks[].element` | object | 块的完整数据结构 |

**调用示例:**

```bash
# 查询所有块
mcporter call dingtalk-docs list_document_blocks --args '{"nodeId": "doc_nodeId"}'

# 查询第 0-5 个块
mcporter call dingtalk-docs list_document_blocks --args '{"nodeId": "doc_nodeId", "startIndex": 0, "endIndex": 5}'

# 只查询 heading 类型的块
mcporter call dingtalk-docs list_document_blocks --args '{"nodeId": "doc_nodeId", "blockType": "heading"}'
```

---

## 9. insert_document_block — 插入块元素

在指定文档的根目录中插入 1 个块元素，可指定插入位置和方向（之前/之后）。两者均不传时默认插入到文档末尾。目前仅支持插入到根目录（一级节点）。

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 文档标识，支持 URL 或 ID 自动识别 |
| `element` | object | 是 | 块元素数据，必须包含 `blockType` 字段及对应类型的属性对象 |
| `referenceBlockId` | string | 否 | 参考块的 blockId，新块将插入到该块的前面或后面 |
| `index` | integer | 否 | 插入位置（≥0），与 referenceBlockId 二选一，同时传时以 referenceBlockId 为准 |
| `where` | string | 否 | 插入方向，默认 `after`。可选：`before`（之前）、`after`（之后） |

> ⚠️ **注意**：`heading.level` 参数必须传**字符串类型**（如 `"1"`），传整数会导致后端报错。

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `blockId` | string | 新插入块的 blockId |
| `blockType` | string | 新插入块的类型 |
| `index` | integer | 新块在文档中的位置 |
| `message` | string | 操作结果描述 |

**调用示例:**

```bash
# 插入段落到文档末尾
mcporter call dingtalk-docs insert_document_block --args '{
  "nodeId": "doc_nodeId",
  "element": {
    "blockType": "paragraph",
    "paragraph": {"text": "新段落内容"},
    "children": [{"text": "新段落内容"}]
  }
}'

# 在指定块之后插入标题（注意 level 必须是字符串）
mcporter call dingtalk-docs insert_document_block --args '{
  "nodeId": "doc_nodeId",
  "element": {
    "blockType": "heading",
    "heading": {"level": "2", "text": "二级标题"}
  },
  "referenceBlockId": "block_id",
  "where": "after"
}'

# 在指定块之前插入引用块
mcporter call dingtalk-docs insert_document_block --args '{
  "nodeId": "doc_nodeId",
  "element": {
    "blockType": "blockquote",
    "blockquote": {"indent": {"left": 32}},
    "children": [{"text": "引用内容"}]
  },
  "referenceBlockId": "block_id",
  "where": "before"
}'

# 插入表格（使用 dingtalk_document_struct.md 中的 table 结构）
mcporter call dingtalk-docs insert_document_block --args '{
  "nodeId": "doc_nodeId",
  "element": {
    "blockType": "table",
    "table": {
      "rolSize": 2,
      "colSize": 3,
      "cells": [["表头1", "表头2", "表头3"], ["数据1", "数据2", "数据3"]]
    }
  }
}'

# 插入高亮块（callout）
mcporter call dingtalk-docs insert_document_block --args '{
  "nodeId": "doc_nodeId",
  "element": {
    "blockType": "callout",
    "callout": {"sticker": "灯泡", "showstk": true, "bgcolor": "#FFF9C4", "border": "#FFD700"},
    "children": [{"blockType": "paragraph", "paragraph": {"text": "高亮内容"}}]
  }
}'
```

---

## 10. update_document_block — 更新块元素

更新指定文档中某一个块元素的属性。本操作为 **PATCH（局部更新）** 语义，只修改 `element` 中传入的字段，未传入的字段保持原值不变。

**⚠️ 目前仅支持更新 `paragraph`（段落）类型的块，其他类型会返回 `UNSUPPORTED_BLOCK_TYPE` 错误。**

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 文档标识，支持 URL 或 ID 自动识别 |
| `blockId` | string | 是 | 要更新的块的 blockId，通过 `list_document_blocks` 获取 |
| `element` | object | 是 | 要更新的块属性，PATCH 语义，只更新传入的字段 |

> ⚠️ **注意**：`indent` 参数类型为**对象**（如 `{"indentFirstLine": {"unit": "pt", "value": 24}}`），传入整数会报错。

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `blockId` | string | 被更新块的 blockId |
| `message` | string | 操作结果描述 |

**调用示例:**

```bash
# 更新段落文字内容
mcporter call dingtalk-docs update_document_block --args '{
  "nodeId": "doc_nodeId",
  "blockId": "block_id",
  "element": {
    "paragraph": {
      "elements": [{"textRun": {"content": "更新后的文字内容"}}]
    }
  }
}'

# 仅更新折叠状态（不影响文字）
mcporter call dingtalk-docs update_document_block --args '{
  "nodeId": "doc_nodeId",
  "blockId": "block_id",
  "element": {
    "paragraph": {"collapsed": true}
  }
}'

# 同时更新文字和缩进
mcporter call dingtalk-docs update_document_block --args '{
  "nodeId": "doc_nodeId",
  "blockId": "block_id",
  "element": {
    "paragraph": {
      "elements": [{"textRun": {"content": "更新后的文字"}}],
      "indent": {"indentFirstLine": {"unit": "pt", "value": 24}}
    }
  }
}'
```

---

## 11. delete_document_block — 删除块元素

删除指定文档中的某一个块元素。**此操作不可恢复**，删除前请先用 `list_document_blocks` 确认 blockId。

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 文档标识，支持 URL 或 ID 自动识别 |
| `blockId` | string | 是 | 要删除的块的 blockId，通过 `list_document_blocks` 获取 |

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `blockId` | string | 被删除块的 blockId |
| `message` | string | 操作结果描述 |

**调用示例:**

```bash
# 删除指定块
mcporter call dingtalk-docs delete_document_block --args '{"nodeId": "doc_nodeId", "blockId": "block_id"}'
```

> **批量删除建议**：批量删除多个块时，建议**从后向前**按 index 倒序删除，避免删除后 index 位移导致定位错误。

---

## Block 工具错误码汇总

| 错误码 | 说明 |
|---|---|
| `ARGUMENT_ILLEGAL` | 参数非法：nodeId/blockId 为空、文档不存在、无访问权限、跨组织文档 |
| `BLOCK_NOT_FOUND` | 指定的 blockId 在文档中不存在 |
| `UNSUPPORTED_BLOCK_TYPE` | 不支持的块类型（update_document_block 目前仅支持 paragraph） |
| `invalidRequest.inputArgs.invalid` | 输入参数校验失败（如 startIndex > endIndex、blockType 枚举值非法） |

---

## 12. create_file — 创建文件

在指定位置创建一个新文件，支持钉钉在线文档、表格、演示、白板、脑图、多维表和文件夹七种类型。

**入参:**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `name` | string | 是 | 新文件的名称 |
| `type` | string | 是 | 文件类型，枚举值见下表 |
| `folderId` | string | 否 | 目标文件夹节点 ID，支持 URL 或 ID。不传时：有 workspaceId 则创建在知识库根目录，否则创建在"我的文档"根目录 |
| `workspaceId` | string | 否 | 目标知识库 ID，支持知识库 ID 或知识库 URL。同时传了 folderId 时以 folderId 为准 |

**入参优先级：** `folderId` > `workspaceId` > 默认（我的文档根目录）

**`type` 枚举值:**

| type 值 | 兼容数字值 | 含义 | 返回 contentType |
|---------|:---------:|------|:---------------:|
| `adoc` | `"0"` | 钉钉在线文档 | `ALIDOC` |
| `axls` | `"1"` | 钉钉表格 | `WORKBOOK` |
| `appt` | `"2"` | 钉钉演示（PPT） | `PPT` |
| `adraw` | `"3"` | 钉钉白板 | `WBD` |
| `amind` | `"6"` | 钉钉脑图 | `MIND` |
| `able` | `"7"` | 钉钉多维表 | `NOTABLE` |
| `folder` | `"13"` | 文件夹 | `FOLDER` |

**出参:**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 新建节点的 ID（dentryUuid） |
| `name` | string | 节点名称 |
| `folderId` | string | 实际创建位置的父文件夹节点 ID |
| `nodeType` | string | 节点结构类型：`folder` 或 `file` |
| `contentType` | string | 内容类型（见 type 枚举表） |
| `extension` | string | 文件后缀（不含点号，如 `adoc`、`axls`） |
| `docUrl` | string | 节点访问链接 |
| `createTime` | integer | 创建时间（毫秒时间戳） |
| `lastEditTime` | integer | 最后编辑时间（毫秒时间戳） |
| `message` | string | 操作结果描述 |

**调用示例:**

```bash
# 创建钉钉在线文档到"我的文档"根目录
mcporter call dingtalk-docs create_file --args '{"name": "2026 Q2 计划", "type": "adoc"}'

# 在指定文件夹下创建表格
mcporter call dingtalk-docs create_file --args '{"name": "数据统计", "type": "axls", "folderId": "folder_nodeId"}'

# 在知识库根目录下创建多维表
mcporter call dingtalk-docs create_file --args '{"name": "项目看板", "type": "able", "workspaceId": "workspace_id"}'

# 在指定文件夹下创建子文件夹
mcporter call dingtalk-docs create_file --args '{"name": "2026 项目", "type": "folder", "folderId": "folder_nodeId"}'

# 创建脑图
mcporter call dingtalk-docs create_file --args '{"name": "架构设计", "type": "amind"}'

# 创建白板
mcporter call dingtalk-docs create_file --args '{"name": "头脑风暴", "type": "adraw"}'

# 创建演示文稿
mcporter call dingtalk-docs create_file --args '{"name": "季度汇报", "type": "appt"}'
```

**错误码:**

| 错误码 | 说明 |
|---|---|
| `invalidRequest.inputArgs.invalid` | 参数非法：name 为空、type 不在枚举范围、folderId 格式不合法（非 32 位字母数字字符串或 URL） |
| `ARGUMENT_ILLEGAL` | 目标位置不存在或无写入权限 |

---

## 文件上传 / 下载工具

> **完整文件上传流程（三步）**：
> 1. `get_file_upload_info` 获取 OSS 上传 URL（resourceUrl）+ 签名 headers + uploadKey
> 2. AI Agent 自行发起 HTTP PUT 请求到 resourceUrl，请求头携带返回的 headers（`Content-Type` 必须设置为空字符串 `""`），Body 为文件二进制内容，期望响应 HTTP 200
> 3. `commit_uploaded_file` 传入 uploadKey 完成文件入库
>
> **完整文件下载流程（两步）**：
> 1. `download_file` 获取 resourceUrl + 签名 headers
> 2. AI Agent 自行发起 HTTP GET 请求到 resourceUrl（取列表第一个），携带 headers，下载文件二进制内容

---

## 13. get_file_upload_info — 获取文件上传凭证

上传本地文件到钉钉知识库或"我的文档"的第一步，返回 OSS 上传地址、签名 headers 和 uploadKey。第二步 HTTP PUT 成功后必须调用 `commit_uploaded_file` 才能完成入库。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `folderId` | string | 否 | 目标文件夹节点 ID（dentryUuid），支持 URL 或 ID。不传时：有 workspaceId 则上传到该知识库根目录，否则上传到用户"我的文档"根目录 |
| `workspaceId` | string | 否 | 目标知识库标识，支持知识库 ID 或知识库 URL。同时传了 folderId 时以 folderId 为准 |

**入参优先级：** `folderId` > `workspaceId` > 默认（我的文档根目录）

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `uploadKey` | string | 上传唯一标识，提交时需回传给 `commit_uploaded_file` |
| `resourceUrl` | string/array | OSS 上传目标 URL（HTTP PUT 用） |
| `headers` | object | HTTP PUT 必须携带的签名请求头键值对；`Content-Type` 应设置为空字符串 `""` |
| `expirationSeconds` | integer | 凭证有效期（秒），过期需重新申请 |

> 出参字段名以官方实际响应为准。

**调用示例：**

```bash
# 上传到"我的文档"根目录
mcporter call dingtalk-docs get_file_upload_info --args '{}'

# 上传到指定文件夹
mcporter call dingtalk-docs get_file_upload_info --args '{"folderId": "<folderId>"}'

# 上传到指定知识库根目录
mcporter call dingtalk-docs get_file_upload_info --args '{"workspaceId": "<workspaceId>"}'
```

---

## 14. commit_uploaded_file — 提交已上传文件

文件上传三步流程的最后一步：在 HTTP PUT 成功（响应 200）后，调用本工具将文件提交入库。如果 HTTP PUT 失败，**不得**调用本工具。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `uploadKey` | string | 是 | `get_file_upload_info` 返回的 uploadKey |
| `name` | string | 是 | 文件最终展示名称（含后缀，如 `Q1 Report.xlsx`）。命名规则：头尾不能有空格；不能含制表符、`*`、`"`、`<`、`>`、`|`；不能以 `.` 结尾 |
| `fileSize` | number | 否 | 文件大小（字节）。填写后服务端会校验与实际上传内容是否一致 |
| `folderId` | string | 否 | 目标文件夹节点 ID，必须与第一步 `get_file_upload_info` 传入的一致 |
| `workspaceId` | string | 否 | 目标知识库标识。同时传了 folderId 时以 folderId 为准 |
| `convertToOnlineDoc` | boolean | 否 | 是否将上传的 Office 文件（如 .xlsx、.docx）转换为钉钉在线文档，默认 `false` |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 新建文件节点 ID |
| `name` | string | 实际文件名 |
| `folderId` | string | 实际入库位置的父文件夹节点 ID |
| `docUrl` | string | 文件访问链接 |

> 出参字段以官方实际响应为准。

**调用示例：**

```bash
# 提交普通文件
mcporter call dingtalk-docs commit_uploaded_file --args '{
  "uploadKey": "<uploadKey>",
  "name": "Q1 Report.xlsx",
  "fileSize": 1048576,
  "folderId": "<folderId>"
}'

# 上传 Office 文件并转换为钉钉在线文档
mcporter call dingtalk-docs commit_uploaded_file --args '{
  "uploadKey": "<uploadKey>",
  "name": "项目方案.docx",
  "convertToOnlineDoc": true
}'
```

---

## 15. download_file — 获取文件下载凭证

获取知识库文件的临时下载 URL 与签名 headers，Agent 自行通过 HTTP GET 完成下载。凭证有过期时间，过期后需重新调用获取新凭证。仅支持文件节点（非文件夹）。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 文件节点标识，支持 URL（`https://alidocs.dingtalk.com/i/nodes/{dentryUuid}`）或 dentryUuid（32 位字母数字字符串）。必须指向文件节点 |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `resourceUrl` | array | 下载 URL 列表，取**第一个**作为 GET 目标（优先级最高） |
| `headers` | object | HTTP GET 必须携带的签名请求头键值对 |
| `expirationSeconds` | integer | 凭证有效期（秒） |

> 出参字段以官方实际响应为准。

**调用示例：**

```bash
# 获取下载凭证
mcporter call dingtalk-docs download_file --args '{"nodeId": "<nodeId>"}'

# 通过 URL 获取
mcporter call dingtalk-docs download_file --args '{"nodeId": "https://alidocs.dingtalk.com/i/nodes/<dentryUuid>"}'
```

---

## 16. get_doc_attachment_upload_info — 获取文档附件上传凭证

为指定钉钉在线文档申请附件上传凭证。流程：调用本工具拿到 uploadUrl 与 resourceId → HTTP PUT 上传文件二进制（`Content-Type` 必须与入参 `mimeType` 一致，`Content-Length` 必须与 `fileSize` 一致）→ 用 resourceId 在文档中通过 `insert_document_block` 插入 `attachment` 类型块。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 文档 nodeId，支持文档 URL 或 dentryUuid 自动识别 |
| `fileName` | string | 是 | 附件文件名（含扩展名），最大 300 个字符。示例：`report.pdf` |
| `fileSize` | number | 是 | 附件大小（字节），必须 > 0。示例：`1048576`（即 1MB） |
| `mimeType` | string | 是 | 附件 MIME 类型，必须是合法 MIME。示例：`application/pdf`、`image/png`、`text/plain` |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `uploadUrl` | string | OSS 上传地址（HTTP PUT 目标） |
| `resourceId` | string | 附件资源 ID，上传成功后用于在文档中插入 `attachment` 块或后续 `download_doc_attachment` 下载 |

> 出参字段以官方实际响应为准。uploadUrl 有时效性，请尽快完成 PUT 上传。

**调用示例：**

```bash
# 申请 PDF 附件上传
mcporter call dingtalk-docs get_doc_attachment_upload_info --args '{
  "nodeId": "<nodeId>",
  "fileName": "report.pdf",
  "fileSize": 1048576,
  "mimeType": "application/pdf"
}'
```

---

## 文档节点管理工具（删除 / 重命名 / 复制 / 移动）

---

## 17. delete_document — 删除文档/文件夹（移入回收站）

将指定节点移入回收站，30 天内可从回收站恢复，超过 30 天将被永久删除。删除文件夹时，子节点会一并移入回收站。

**支持范围：** 知识库下的文档/文件夹节点；钉盘"我的文件"或团队空间下的文件/文件夹（钉盘场景仍建议走钉盘 MCP）。

**不支持：** 直接删除知识库本身（workspace）；直接删除团队空间（space）。

**权限要求：** 对目标节点有管理权限（owner 或被授予管理权限的成员）。

**⚠️ 删除操作不可立即撤销，调用前请向用户确认。**

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 要删除的节点标识，支持文档/文件夹 URL 或 dentryUuid |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 被删除的节点 ID |
| `message` | string | 操作结果描述 |

> 出参字段以官方实际响应为准。

**调用示例：**

```bash
mcporter call dingtalk-docs delete_document --args '{"nodeId": "<nodeId>"}'
```

---

## 18. rename_document — 重命名文档/文件夹

对知识库下的文档或文件夹节点进行重命名。**需要对目标节点有编辑权限。**

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 要重命名的节点标识，支持文档/文件夹 URL 或 dentryUuid |
| `newName` | string | 是 | 新名称，不能为空，长度不超过 255 个字符 |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 被重命名的节点 ID |
| `name` | string | 重命名后的名称 |
| `message` | string | 操作结果描述 |

> 出参字段以官方实际响应为准。

**调用示例：**

```bash
mcporter call dingtalk-docs rename_document --args '{
  "nodeId": "<nodeId>",
  "newName": "2026 Q2 项目计划"
}'
```

---

## 19. copy_document — 复制文档到目标位置

将指定节点复制到目标文件夹或目标知识库根目录。支持知识库节点（文档、文件夹）和钉盘文件/文件夹。

**权限要求：** 对源节点有可查看下载权限；对目标文件夹有写入权限。

**⚠️ 注意：** 复制操作底层可能异步执行，异步时操作已提交但新节点 ID 无法立即返回，请稍后查看目标文件夹确认结果。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 源节点标识，支持文档/文件夹 URL 或 dentryUuid |
| `targetFolderId` | string | 否 | 目标文件夹的 dentryUuid（32 位字母数字字符串），复制后的节点将放置在此文件夹下 |
| `workspaceId` | string | 否 | 目标知识库标识（ID 或知识库 URL）。当 targetFolderId 不传时复制到该知识库根目录。与 targetFolderId 至少传一个；都不传时默认复制到当前用户"我的文档"根目录 |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 新节点 ID（同步时返回；异步时可能为空） |
| `async` | boolean | 是否异步执行 |
| `message` | string | 操作结果描述 |

> 出参字段以官方实际响应为准。异步场景下请稍后查看目标文件夹确认。

**调用示例：**

```bash
# 复制到指定文件夹
mcporter call dingtalk-docs copy_document --args '{
  "nodeId": "<sourceNodeId>",
  "targetFolderId": "<targetFolderId>"
}'

# 复制到指定知识库根目录
mcporter call dingtalk-docs copy_document --args '{
  "nodeId": "<sourceNodeId>",
  "workspaceId": "<workspaceId>"
}'
```

---

## 20. move_document — 移动文档到目标位置

将指定节点移动到目标文件夹或目标知识库根目录。支持知识库节点（文档、文件夹）和钉盘文件/文件夹。

**权限要求：** 对源节点有编辑权限；对目标文件夹有写入权限。

**⚠️ 注意：** 移动操作底层可能异步执行，异步时操作已提交但无法立即确认完成，请稍后查看目标文件夹确认结果。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 源节点标识，支持文档/文件夹 URL 或 dentryUuid |
| `targetFolderId` | string | 否 | 目标文件夹的 dentryUuid（32 位字母数字字符串），节点将被移动到此文件夹下 |
| `workspaceId` | string | 否 | 目标知识库标识（ID 或知识库 URL）。当 targetFolderId 不传时移动到该知识库根目录。同时传了 targetFolderId 时以 targetFolderId 为准；都不传时默认移动到当前用户"我的文档"根目录 |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 被移动节点的 ID |
| `async` | boolean | 是否异步执行 |
| `message` | string | 操作结果描述 |

> 出参字段以官方实际响应为准。

**调用示例：**

```bash
# 移动到指定文件夹
mcporter call dingtalk-docs move_document --args '{
  "nodeId": "<sourceNodeId>",
  "targetFolderId": "<targetFolderId>"
}'

# 移动到指定知识库根目录
mcporter call dingtalk-docs move_document --args '{
  "nodeId": "<sourceNodeId>",
  "workspaceId": "<workspaceId>"
}'
```

---

## 21. download_doc_attachment — 下载文档内附件

获取钉钉文档中指定附件的临时下载 URL。前置依赖：先调用 `list_document_blocks` 获取文档块列表，找到 `blockType=attachment` 的块元素，提取其 `resourceId` 作为本工具入参。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 文档 nodeId，支持文档 URL 或 dentryUuid |
| `resourceId` | string | 是 | 附件资源 ID（从 `list_document_blocks` 返回的 attachment 块中提取） |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `downloadUrl` | string | 附件的 OSS 临时下载链接，Agent 自行 HTTP GET 下载 |

> 出参字段以官方实际响应为准。downloadUrl 有时效性，请尽快完成下载。

**调用示例：**

```bash
# 1. 先查询文档块列表，找到 attachment 块的 resourceId
mcporter call dingtalk-docs list_document_blocks --args '{"nodeId": "<nodeId>", "blockType": "attachment"}'

# 2. 下载附件
mcporter call dingtalk-docs download_doc_attachment --args '{
  "nodeId": "<nodeId>",
  "resourceId": "<resourceId>"
}'
```

---

## 权限管理工具

> **角色枚举（roleId）**：
>
> | roleId | 说明 |
> |---|---|
> | `OWNER` | 所有者（不可通过 `add_permission` / `update_permission` 添加或变更） |
> | `MANAGER` | 管理员 |
> | `EDITOR` | 可编辑 |
> | `DOWNLOADER` | 可下载（含查看） |
> | `READER` | 仅可查看 |
>
> **共性要求：** 仅支持 USER 类型成员；userIds 为钉钉 staffId（外部 userId，由钉钉开放平台颁发，通常为数字字符串），如只有 unionId 需先通过钉钉开放平台「根据 unionId 获取 userId」接口换取。单次最多 30 个，超出需分批。**操作者必须在该节点上具备 EDITOR 及以上角色（OWNER / MANAGER / EDITOR）。**

---

## 22. add_permission — 添加文档权限

为知识库节点（文档、文件夹、文件）批量添加成员权限。**`OWNER` 角色不可通过本接口添加。**

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 目标节点的 nodeId，可通过 `list_nodes` 获取 |
| `roleId` | string | 是 | 授予的角色，取值：`MANAGER`、`EDITOR`、`DOWNLOADER`、`READER` |
| `userIds` | array<string> | 是 | 被授权的用户 userId 列表（钉钉 staffId），至少 1 个，单次最多 30 个 |
| `workspaceId` | string | 否 | 目标知识库标识，选填。仅用于辅助构造返回的 docUrl，业务实际依赖 nodeId 定位节点 |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 节点 ID |
| `docUrl` | string | 节点访问链接（传入 workspaceId 时更完整） |
| `successUserIds` | array<string> | 添加成功的 userId 列表 |
| `failedUserIds` | array<string> | 添加失败的 userId 列表 |

> 出参字段以官方实际响应为准。

**调用示例：**

```bash
# 给两位成员授予 EDITOR 角色
mcporter call dingtalk-docs add_permission --args '{
  "nodeId": "<nodeId>",
  "roleId": "EDITOR",
  "userIds": ["123456789", "987654321"]
}'

# 授予只读权限
mcporter call dingtalk-docs add_permission --args '{
  "nodeId": "<nodeId>",
  "roleId": "READER",
  "userIds": ["123456789"],
  "workspaceId": "<workspaceId>"
}'
```

---

## 23. update_permission — 更新权限角色

批量调整成员在节点上的角色。同一成员在同一节点只能拥有一个角色，变更后旧角色自动替换。

**注意事项：**
- `OWNER` 角色不可通过本接口变更。
- 若成员的角色来自父节点的权限继承（PASS_ON 模式），且继承的角色高于目标角色，接口会拒绝操作。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 目标节点的 nodeId |
| `roleId` | string | 是 | 变更后的角色，取值：`MANAGER`、`EDITOR`、`DOWNLOADER`、`READER` |
| `userIds` | array<string> | 是 | 要变更角色的用户 userId 列表（钉钉 staffId），至少 1 个，单次最多 30 个 |
| `workspaceId` | string | 否 | 目标知识库标识，选填。仅用于辅助构造返回的 docUrl |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 节点 ID |
| `docUrl` | string | 节点访问链接 |
| `successUserIds` | array<string> | 变更成功的 userId 列表 |
| `failedUserIds` | array<string> | 变更失败的 userId 列表（如继承角色冲突） |

> 出参字段以官方实际响应为准。

**调用示例：**

```bash
# 将成员角色从 READER 提升为 EDITOR
mcporter call dingtalk-docs update_permission --args '{
  "nodeId": "<nodeId>",
  "roleId": "EDITOR",
  "userIds": ["123456789"]
}'
```

---

## 24. list_permission — 列出文档当前权限

查询知识库节点的成员权限列表。**本接口不支持游标翻页，不存在 nextToken**，底层一次性返回全量成员后在内存中按 maxResults 截断。若发生截断（出参 `truncated=true`），可通过 `totalCount` 感知全量成员数，并通过 `filterRoleIds` 收窄查询范围。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 目标节点的 nodeId |
| `maxResults` | number | 否 | 期望返回的最大成员条数，默认 30，最大 200 |
| `filterRoleIds` | array<string> | 否 | 按角色过滤，取值：`OWNER`、`MANAGER`、`EDITOR`、`DOWNLOADER`、`READER`。不传时返回所有角色 |
| `workspaceId` | string | 否 | 目标知识库标识，选填。仅用于辅助构造返回的 docUrl |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `nodeId` | string | 节点 ID |
| `docUrl` | string | 节点访问链接 |
| `members` | array | 成员权限列表 |
| `members[].userId` | string | 成员 userId（钉钉 staffId） |
| `members[].roleId` | string | 成员角色：`OWNER`/`MANAGER`/`EDITOR`/`DOWNLOADER`/`READER` |
| `totalCount` | integer | 全量成员数（用于感知截断） |
| `truncated` | boolean | 是否发生截断（全量数 > maxResults 时为 true） |

> 出参字段以官方实际响应为准。

**调用示例：**

```bash
# 查询所有成员权限（默认 30 条）
mcporter call dingtalk-docs list_permission --args '{"nodeId": "<nodeId>"}'

# 只查 EDITOR / MANAGER 角色，最多 200 条
mcporter call dingtalk-docs list_permission --args '{
  "nodeId": "<nodeId>",
  "filterRoleIds": ["EDITOR", "MANAGER"],
  "maxResults": 200
}'
```

---

## 异步导出工具

> **完整文档导出流程**：
> 1. `submit_export_job` 提交导出任务（目前仅支持导出为 docx 格式），获取 `jobId`
> 2. 轮询 `query_export_job` 查询任务状态，直到任务完成
> 3. 任务完成后从返回值中拿到下载链接，自行 HTTP GET 下载

---

## 25. submit_export_job — 提交异步导出任务

提交钉钉在线文档导出任务，将文档异步导出为 Office docx 文件。**目前仅支持导出为 docx 格式**（未来会扩展）。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `nodeId` | string | 是 | 要导出的文档标识，支持文档 URL 或 dentryUuid。**仅支持钉钉在线文档类型（contentType=ALIDOC）** |
| `exportFormat` | string | 是 | 导出目标格式。文档侧仅支持 `docx`；不传将返回 `invalidRequest.argument.illegal` 错误，传入其他值返回 `invalidRequest.export.unsupportedFormat` 错误 |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `jobId` | string | 导出任务 ID，用于后续 `query_export_job` 查询状态 |

> 出参字段以官方实际响应为准。

**调用示例：**

```bash
# 提交导出任务
mcporter call dingtalk-docs submit_export_job --args '{
  "nodeId": "<nodeId>",
  "exportFormat": "docx"
}'
```

---

## 26. query_export_job — 查询导出任务状态/结果

查询通过 `submit_export_job` 提交的导出任务执行状态，任务完成时返回文件下载链接。

**入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|:----:|------|
| `jobId` | string | 是 | 由 `submit_export_job` 返回的导出任务 ID |

**出参：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `jobId` | string | 任务 ID |
| `status` | string | 任务状态（如 `PENDING`/`RUNNING`/`SUCCESS`/`FAILED`，具体取值以官方实际响应为准） |
| `downloadUrl` | string | 导出文件的下载链接（仅 status=SUCCESS 时返回） |

> 出参字段以官方实际响应为准。建议轮询间隔 2-5 秒，直到 status 进入终态。

**调用示例：**

```bash
# 1. 提交任务，拿到 jobId
mcporter call dingtalk-docs submit_export_job --args '{"nodeId": "<nodeId>", "exportFormat": "docx"}'

# 2. 轮询任务状态
mcporter call dingtalk-docs query_export_job --args '{"jobId": "<jobId>"}'

# 3. status=SUCCESS 后，从 downloadUrl 自行下载 docx 文件
```

---

## 完整工作流补充示例

### 上传本地文件到知识库

```bash
# Step 1: 获取上传凭证
mcporter call dingtalk-docs get_file_upload_info --args '{"folderId": "<folderId>"}'
# 返回: { uploadKey, resourceUrl, headers, expirationSeconds }

# Step 2: AI Agent 自行 HTTP PUT 文件二进制
# curl -X PUT "<resourceUrl>" -H "<headers>..." -H "Content-Type: " --data-binary @local.xlsx

# Step 3: 提交入库
mcporter call dingtalk-docs commit_uploaded_file --args '{
  "uploadKey": "<uploadKey>",
  "name": "Q1 Report.xlsx",
  "fileSize": 1048576,
  "folderId": "<folderId>"
}'
```

### 下载知识库文件

```bash
# Step 1: 获取下载凭证
mcporter call dingtalk-docs download_file --args '{"nodeId": "<nodeId>"}'
# 返回: { resourceUrl: ["<url1>", "<url2>"], headers, expirationSeconds }

# Step 2: AI Agent 自行 HTTP GET（取 resourceUrl 第一个）
# curl -L "<resourceUrl[0]>" -H "<headers>..." -o local.xlsx
```

### 导出钉钉在线文档为 docx

```bash
# Step 1: 提交导出任务
mcporter call dingtalk-docs submit_export_job --args '{"nodeId": "<nodeId>", "exportFormat": "docx"}'
# 返回: { jobId: "<jobId>" }

# Step 2: 轮询任务状态
mcporter call dingtalk-docs query_export_job --args '{"jobId": "<jobId>"}'
# 完成时返回: { status: "SUCCESS", downloadUrl: "<url>" }

# Step 3: 自行 HTTP GET 下载 docx
```

### 文档权限批量授予

```bash
# 1. 列出当前节点权限
mcporter call dingtalk-docs list_permission --args '{"nodeId": "<nodeId>"}'

# 2. 给新成员授予 EDITOR
mcporter call dingtalk-docs add_permission --args '{
  "nodeId": "<nodeId>",
  "roleId": "EDITOR",
  "userIds": ["123456789", "987654321"]
}'

# 3. 升级某位 READER 为 EDITOR
mcporter call dingtalk-docs update_permission --args '{
  "nodeId": "<nodeId>",
  "roleId": "EDITOR",
  "userIds": ["123456789"]
}'
```

### 文档生命周期管理

```bash
# 重命名
mcporter call dingtalk-docs rename_document --args '{"nodeId": "<nodeId>", "newName": "2026 Q2 项目计划"}'

# 复制到另一个文件夹
mcporter call dingtalk-docs copy_document --args '{"nodeId": "<nodeId>", "targetFolderId": "<targetFolderId>"}'

# 移动到另一个知识库
mcporter call dingtalk-docs move_document --args '{"nodeId": "<nodeId>", "workspaceId": "<workspaceId>"}'

# 删除（移入回收站，30 天内可恢复）
mcporter call dingtalk-docs delete_document --args '{"nodeId": "<nodeId>"}'
```
