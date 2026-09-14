# ACS drain 阻塞者处置

生产 Orchestrator 在 `kill -USR2` 后停止接新的长运行请求，等到 `effectiveInflight = 0` 才退出。`effectiveInflight` = HTTP inflight + background recovery + unresolved invocations + `drainBlockers()`。本手册只处理最后一项：ownership journal 里还没终态的记录把 drain 卡住。

Bearer token 在主机 `/etc/agent-saas/acs-orchestrator.env` 的 `ACS_ORCH_AUTH_TOKEN`。命令里不要把 token 写进日志。

## 1. 读 `GET /diagnostics/drain`

```sh
curl -fsS -H "Authorization: Bearer $ACS_ORCH_AUTH_TOKEN" \
  "${ACS_ORCH_BASE_URL:-http://127.0.0.1:3400}/diagnostics/drain"
```

字段：

| 字段                                                           | 含义                                                                                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ownedWork`                                                    | 当前 `drainBlockers()`，非终态 owner 数（不含 durable `background_owned`；journal 不可用时额外 +1）                                         |
| `httpWaiters`                                                  | 还挂在 HTTP 上的 waiter 数                                                                                                                  |
| `journalAvailable`                                             | ConfigMap journal 是否可读                                                                                                                  |
| `persistedUnresolved`                                          | journal 里不是 `stopped` / `not_started` / `background_owned` 的记录数                                                                      |
| `blockers`                                                     | 本地非终态 snapshot，最多 50 条：`operationId` / `kind` / `phase` / `resource` / `sandboxName` / `elapsedMs` / `attemptId` / `invocationId` |
| `requests` / `recovery` / `unresolvedInvocations` / `draining` | HTTP、后台回收、未决 invocation、是否正在 drain                                                                                             |

drain 进行中，进程日志每 60 秒一行 `deployment_drain_blockers operation=… kind=… phase=… resource=… sandbox=… elapsedMs=…`。

## 2. 按 invocation 查 operation

```sh
curl -fsS -H "Authorization: Bearer $ACS_ORCH_AUTH_TOKEN" \
  "${ACS_ORCH_BASE_URL:-http://127.0.0.1:3400}/operations?invocationId=<invocationId>"
```

有 journal 时返回 journal 记录（`provenance=journal`）；否则退回本地 snapshot。`invocationId` 非法返回 400；journal 不可用返回 503。

单条：`GET /operations/:operationId`。

## 3. 什么时候用 `POST /operations/:id/cancel`

需要请求头 `x-acs-attempt-id` 与记录的 `attemptId` 完全一致，否则 409。

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $ACS_ORCH_AUTH_TOKEN" \
  -H "x-acs-attempt-id: <attemptId>" \
  "${ACS_ORCH_BASE_URL:-http://127.0.0.1:3400}/operations/<operationId>/cancel"
```

它**只做本地 abort**，把 resource 写成 `stop_requested`，响应固定 `remoteStopped: false`。不会去 Pod 里停进程，也不会写终态。之后看 reconciler（10 秒一轮）会不会拿到远端回执。

## 4. Sandbox 还在、远端不回执时的安全顺序

1. `POST /operations/:id/cancel`。
2. 等至少一轮 reconciler（约 10 秒）再读 `/diagnostics/drain`。若拿到 `remote_receipt`，记录会变成 `stopped` / `not_started` / `background_owned`。
3. 仍无回执，且确认该 Sandbox **没有用户在用**：由曾磊授权后删除该 Sandbox CR（只删这一条）。下一轮 reconcile 若两次观测到 CR 不存在（或同名但 uid 已变），会用 `sandbox_absent` 证明把记录写成 `stopped/failed`，并从 `drainBlockers` 消失。
4. CR 还在（含 Paused）时，**不会**走 `sandbox_absent`。Pod 不在、只是没回执的记录继续阻塞 drain，这是设计，不要绕。

## 5. 禁止手改 ConfigMap journal

journal 名 `acs-operation-ownership-v1`。不要 `kubectl edit` / 直接改 `journal.json`。CAS 和 `validateOwnershipRecords` 会把格式不对的旧记录判为整个 journal 不可用，drain 会额外 +1 且再也对不上账。
