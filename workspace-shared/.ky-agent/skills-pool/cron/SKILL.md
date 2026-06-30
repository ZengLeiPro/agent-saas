---
name: cron
description: 管理定时任务（创建、查看、编辑、删除、立即执行）。当用户要求创建、修改、查看或删除定时任务时使用此 Skill。
---

# 定时任务管理

使用 `mcp__cron__manage` 工具，传入一个 JSON `request` 参数。

## Action 列表

### list — 列出所有任务

```json
{"action": "list"}
{"action": "list", "includeDisabled": false}
```

### get — 获取任务详情

```json
{"action": "get", "id": "任务ID"}
```

### create — 创建任务

必填：`name` + `schedule` + `payload`。

```json
{
  "action": "create",
  "name": "每日日报",
  "schedule": {"kind": "cron", "expr": "0 9 * * 1-5", "tz": "Asia/Shanghai"},
  "payload": {"kind": "agentTurn", "message": "请生成今日工作日报"}
}
```

### update — 更新任务（只传要改的字段）

必填：`id`，其余字段可选。

```json
{"action": "update", "id": "任务ID", "schedule": {"kind": "cron", "expr": "0 10 * * 1-5", "tz": "Asia/Shanghai"}}
{"action": "update", "id": "任务ID", "payload": {"model": "gpt-5.5"}}
{"action": "update", "id": "任务ID", "payload": {"timeoutSeconds": 3600}}
{"action": "update", "id": "任务ID", "payload": {"context": {"memory": false}}}
{"action": "update", "id": "任务ID", "payload": {"kind": "agentTurn", "message": "新的提示词"}}
{"action": "update", "id": "任务ID", "enabled": false}
```

`payload` 更新规则：
- 可以只传要改的字段；未传 `kind` 时，按当前任务的 payload 类型部分更新。
- 修改 `agentTurn.model` 不需要重传完整 prompt，直接传 `{"payload":{"model":"..."}}`。
- 如果要在 `agentTurn` 与 `systemEvent` 之间切换，必须传完整 payload（如 `{"kind":"agentTurn","message":"..."}` 或 `{"kind":"systemEvent","text":"..."}`）。

### delete — 删除任务

```json
{"action": "delete", "id": "任务ID"}
```

### run — 立即执行一次

```json
{"action": "run", "id": "任务ID"}
```

## schedule 格式

```json
{"kind": "every", "everyMs": 1800000}
{"kind": "cron", "expr": "0 9 * * 1-5", "tz": "Asia/Shanghai"}
{"kind": "at", "atMs": 1709280000000}
```

| 字段 | every | cron | at |
|------|-------|------|----|
| `everyMs` | 必填，间隔毫秒 | — | — |
| `anchorMs` | 可选，对齐锚点 | — | — |
| `expr` | — | 必填，5 字段 cron 表达式 | — |
| `tz` | — | 可选，IANA 时区 | — |
| `atMs` | — | — | 必填，Unix 毫秒时间戳 |

## payload 格式

```json
{"kind": "agentTurn", "message": "你要 Agent 做的事情"}
{"kind": "systemEvent", "text": "系统通知文本"}
```

agentTurn 可选字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | string | 模型覆盖 |
| `maxTurns` | number | 最大轮次 |
| `timeoutSeconds` | number | 超时秒数 |
| `context` | object | 上下文注入配置（见下） |

### context 格式（可选）

控制 Agent 执行时加载哪些上下文。所有字段默认 `true`，省略 `context` 等同于全部加载。

```json
{"systemPrompt": true, "persona": true, "memory": true}
```

| 字段 | 说明 |
|------|------|
| `systemPrompt` | 是否加载系统提示语（含 SOUL 规范；关闭后 Agent 退化为最简助手） |
| `persona` | 是否加载用户自定义人格（PERSONA.md） |
| `memory` | 是否加载 MEMORY.md 长期记忆 |

示例：纯工具执行任务，不需要人格和记忆：
```json
{"kind": "agentTurn", "message": "检查服务器状态", "context": {"persona": false, "memory": false}}
```

## notify 格式（可选）

```json
{"enabled": true, "channel": "web"}
{"enabled": true, "channel": "dingtalk", "dingtalk": {"mode": "user", "userId": "xxx"}}
{"enabled": true, "channel": "dingtalk", "dingtalk": {"mode": "chat", "chatId": "xxx"}}
{"enabled": true, "channel": "both", "dingtalk": {"mode": "user", "userId": "xxx"}}
```

可选：`onSuccess`（成功时通知，默认 true）、`onError`（失败时通知，默认 true）。

## 完整示例

### 每小时巡检 + 失败钉钉通知

```json
{
  "action": "create",
  "name": "服务巡检",
  "schedule": {"kind": "every", "everyMs": 3600000},
  "payload": {"kind": "agentTurn", "message": "检查所有服务运行状态，发现异常时报告"},
  "notify": {"enabled": true, "channel": "dingtalk", "dingtalk": {"mode": "user", "userId": "manager001"}, "onSuccess": false, "onError": true}
}
```

## 注意事项

- 时间戳均为毫秒级 Unix timestamp
- cron 表达式为标准 5 字段格式（分 时 日 月 周）
- `owner` 由系统自动注入（从会话上下文获取），无需手动传入
- `list` 只返回你有权查看的任务，`update`/`delete`/`run` 只能操作自己的任务
