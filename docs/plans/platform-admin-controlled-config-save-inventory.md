# 平台管理配置写入清单

开始实施基线：`origin/main@a7da7be10303c701e4ef49e6f2162d9da7155e13`；交付前刷新并 rebase 到 `origin/main@63f75cc7999d0c4c7b7deacb6fca5d250a14a974`。本清单按实际存储和运行消费者分类。

| 操作                                 | HTTP 入口                                                        | 实际字段/存储                                                   | 运行消费者                      | 状态                            |
| ------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------- | ------------------------------- |
| 模型、记忆索引、辅助模型、标题提示语 | `PUT /api/admin/models`                                          | `models`、`memory.index`、辅助链、`systemPrompts.utility.title` | model/index/prompt resolver     | 保留 #593；标题共用同一键       |
| 工具整包/单工具                      | `PUT /api/admin/tool-controls[/:toolId]`                         | `toolControls`、`webTools`                                      | tool registry、Web provider     | 接入 save/tool scope            |
| 工具描述                             | 同上                                                             | 独立 `ToolDescriptionStore`                                     | descriptor resolver             | 保留独立 CAS                    |
| 系统提示语                           | `PUT/DELETE /api/admin/system-prompts/:promptId`                 | `systemPrompts` 合法键                                          | prompt registry                 | 接入 set/reset；fresh raw       |
| 记忆轮询                             | `PUT /api/admin/memory-polling`                                  | `memory.polling`                                                | polling scheduler               | 接入；与 index 分离             |
| 生图引擎/定价                        | `PUT .../image-gen-pricing/config`、`PUT .../image-gen-pricing`  | `imageGenTools` + Vault；pricing 独立 scope                     | image selector/pricing registry | 接入；新增双进程 consumer       |
| STT                                  | `PUT /api/admin/audio-transcribe`                                | `stt`、三凭据、pricing                                          | transcription runtime           | 接入                            |
| 执行环境池                           | `PUT /api/admin/tenant-remote-hands`                             | `tenantRemoteHands` + Vault                                     | lifecycle/dispatch resolver     | 接入；新增快照 consumer         |
| 环境池健康探测                       | `POST .../:id/health`                                            | 不持久化                                                        | 单次探测                        | 排除配置事务                    |
| Codex 参数/排序                      | `PUT /api/admin/codex-subscription`、`PUT .../credentials/order` | `codexSubscription`                                             | selector、HTTP/WS               | 接入                            |
| Codex 授权开始/轮询                  | `POST .../device/start`、`POST .../poll`、`GET .../device/:id`   | 授权 session                                                    | OAuth                           | 不写 AppConfig；GET 只读        |
| Codex 登记/删除                      | `POST .../complete`、两个 `DELETE`                               | 候选 ref + `codexSubscription`                                  | selector/WS                     | 接入 complete/remove/disconnect |
| 配置操作结果查询                     | `GET /api/admin/config-operations/:operationId`                  | 私有 operation journal（摘要，无明文 Secret）                   | 无；只读事务证据                | 原操作者可查；不触发重发        |
| 出口策略                             | `PUT /api/admin/egress-config`                                   | 独立 egress store                                               | egress policy                   | 排除；保持独立签名/CAS          |
| ACS/调度运行控制                     | `PATCH /api/admin/runtime-operations/*/runtime-config`           | 独立运行控制 store                                              | ACS/scheduler                   | 排除；不是 AppConfig            |
| 注册设置                             | `/api/admin/signup-config`                                       | 独立 signup store                                               | auth/signup                     | 排除                            |
| ACS 运维/推广/切色                   | runtime operations/release                                       | 运维状态/发布权威                                               | systemd/ACS                     | 排除；保持发布互斥              |

扫描覆盖管理路由写方法、`configMutationService.mutate`、JSONC 写入、配置文件写入和独立 store。新增 AppConfig 写入口必须登记 operation scope 和真实 consumer，否则生产发布失败关闭。
