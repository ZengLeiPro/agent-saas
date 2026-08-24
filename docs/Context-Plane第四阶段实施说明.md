# Context Plane 第四阶段实施说明

> 分支：`feat/context-product-graph-phase4`
>
> 初始基线：`origin/main@2420e01e`（包含 PR #139 merge commit `0407bb40`）
>
> 状态：Phase 4 产品界面、授权 API 与有限关系图谱已在本地实现；尚未 push、创建 PR、部署或执行生产 migration。本文只描述仓库中的真实能力。

## 1. 本阶段交付范围

Phase 4 继续复用「组织管理 → 记忆与知识」入口，没有新建平行应用壳。产品层新增五个顶层区域：

- 资源治理：保留原有来源、Collection、Assignment、同步水位与 consumer 状态；
- Context Center：展示各来源的治理状态，不允许枚举原始业务 Evidence；
- Timeline：按真实 source record/revision 的业务时间浏览，支持筛选、签名分页与降级提示；
- 实体：浏览 Person / Customer / Project / Meeting / Task，进入画像、Timeline、关系和纠正记录；
- 待审核：处理 `proposed` 与 `conflicted` 的组织派生项。

实体画像固定为 `role / tasks / workflow / artifacts / knowhow` 五类 facet。画像项、Timeline、关系、审核项和纠正记录均携带 Evidence 引用；点击引用后才通过加密 handle 请求授权后的详情。

## 2. 产品 API

现有 admin router 下新增：

- `GET /api/admin/context-plane/timeline`
- `GET /api/admin/context-plane/entities`
- `GET /api/admin/context-plane/entities/:id`
- `GET /api/admin/context-plane/entities/:id/profile`
- `GET /api/admin/context-plane/entities/:id/relations?depth=1|2`
- `GET /api/admin/context-plane/reviews`
- `GET /api/admin/context-plane/evidence?id=<encryptedHandle>`
- `POST /api/admin/context-plane/entities/:id/corrections`
- `POST /api/admin/context-plane/reviews/:itemId/decision`

Server、Shared 与 Web 使用严格 DTO。派生 item 类型 `Decision / Status / Task / Risk / Commitment` 与画像 facet 类型分开建模；审核写入只返回严格的终态 `status`，避免“数据库已成功、前端却因响应多字段报失败”。

列表消费签名 cursor 并支持“加载更多”。内部候选达到 200 条、授权过滤、Evidence 缺失或关系剪枝时，响应会明确 `degraded=true`；达到上限后不伪装成完整结果。

## 3. 授权与 Evidence 边界

Admin 身份不等于内容读取权限。所有读取继续执行：

1. 服务端认证注入 `tenantId / actorId`；
2. Governance Assignment 计算 Collection 范围；
3. 当前 record 必须未删除、未撤权、partition 未 refused；
4. 调用 source-native authorizer；未知来源或授权异常 fail closed；
5. Evidence 必须精确绑定授权 item、record revision 与 evidence ID。

Evidence handle 使用 tenant-bound AES-256-GCM stateless token；cursor 使用 HMAC 签名。handle 不暴露 locator 明文，也不能跨 tenant 重放。详情优先展示 Evidence 自带的 source、author、excerpt、URL 与业务时间；locator-only Evidence 从已授权 exact revision 的 content/time 生成有限回退，不使用演示数据。

关系读取逐条校验 edge 的 from/to 实际 current record locator，并对每一跳重新执行 Assignment、当前状态与 native ACL。隐藏节点会剪枝且不能继续扩展，管理员身份不能绕过。

## 4. 纠正与审核写入

纠正必须指定 `targetItemId` 并选择该目标自身的 Evidence：

- personal correction 只影响本人；
- organization correction 需要服务端 role gate；
- personal 与 organization 使用独立 CAS revision；
- reject 精确绑定 target generation、item ID、value fingerprint 和 itemEvidence，不按相同文本全实体误伤；
- correction 与 review 均 append-only，不篡改 source record。

写事务先锁 current entity、exact item 与 Evidence，再执行 live reauthorization callback。callback 重新解析 Assignment、组织角色和 native ACL，并核对不可变快照；授权收紧、目标漂移或回调异常均 fail closed。

冲突审核先锁 current entity、完整组织 sibling group 与 Evidence，生成稳定 snapshot fingerprint，再进行整组 live reauthorization。只有快照数量、内容、Evidence 与授权全部一致时才允许 confirm/reject；个人 item 不进入组织冲突组，也不会被批量 supersede。

## 5. v26 关系域

Governance ledger v26 是 additive migration：

- 扩展 `context_entity_links`，增加 from/to entity、relation class、authority、review status、Evidence、有效期与 lifecycle；
- 新增 tenant-first `context_relation_candidates`，持久化尚未解析的关系候选；
- 建立 exact Evidence / revision FK、CHECK 与 tenant-first pending/from/to/source 索引；
- migration 使用 PostgreSQL guard，允许重复执行而不重复创建 constraint。

关系类别明确区分：

- `explicit`：上游稳定 native ID 明确给出的关系；
- `cooccurrence`：只允许作为显式标注的共现候选；
- `inferred`：只能是 `proposed`，不能自动扩大授权或进入 authoritative 路径。

当前 projector 只物化可信 typed envelope 中的显式关系，例如 Task→Project、Task→Person、Project→Customer、Meeting→Project。目标实体晚到时 candidate 保持 pending；目标出现或 revision 更新后 resolver 会补建/刷新 incoming edge。删除、撤权和 source revision 替换会传播到 candidate 与 link。

Runtime 在没有新 outbox 事件时仍会有界排空 pending candidate，每批 100、每轮最多 100 页；达到上限会保留 pending 并记录告警，不 busy loop、不丢数据。

## 6. 有限关系检索与评测

关系读取使用 PostgreSQL 邻接表，不引入专用图数据库：

- 默认一跳；产品可选择最大二跳；
- 防环、候选上限、稳定 cursor；
- UI 显示每条边的实际 `fromEntity → targetEntity` 与 depth，不把二跳伪装成中心实体直连；
- 不渲染全局大图，不按姓名、手机号或公司名自动合并实体。

离线 evaluator 比较：A 无关系、B 一跳、C 有限 walk。指标包括 macro precision/recall、MRR、hit rate、候选总数/均值、citation precision、追问率、P95 latency 与 ACL leak。B/C 的 citation、follow-up、latency、ACL audit 任一无样本时都不得判定有增量。

默认增量门槛：Recall 至少提升 5 个百分点、追问率至少下降 10 个百分点、citation precision 下降不超过 1 个百分点、ACL leak 必须为 0。该门槛只判断有限 walk 是否值得继续，不代表专用图数据库已经必要；是否引入图数据库仍需独立规模与延迟基准。

## 7. 刻意保留的边界

- 当前不是专用图数据库，只是 PostgreSQL durable candidate + adjacency + 最大二跳；
- 当前没有自动实体合并，也没有自动 inferred relation producer；
- DWS 在完整 policy 可复用前不进入产品 Timeline；
- 候选窗口上限为 200，超过时明确 degraded，而不是无界扫描业务库；
- correction/review 不等同于自动执行外部动作；本阶段没有新增自动发消息、改任务或部署能力；
- 未执行生产 migration、部署、push、PR 或 merge。

## 8. 验证与发布门槛

本地定向测试覆盖 strict DTO、Timeline/实体/画像/分页、Evidence 详情、scope correction CAS、exact target/evidence、冲突审核快照授权、关系乱序补建、incoming revision、删除撤权、pending drain、bounded walk 与 A/B/C evaluator。

本地已通过：

- 最近一次三包全量（`origin/main@dc60b435`）：Server 502 个测试文件、5,141 个测试通过，30 个文件 / 168 个 PostgreSQL 或环境集成测试明确 skip，另有 3 个既有 todo；Shared 56 个测试文件、829 个测试通过；Web 219 个测试文件、1,679 个测试通过；
- 再次 rebase 到 `origin/main@754c052c` 后，受影响定向链通过：Server 12 个文件 / 101 个测试、Shared 2 个文件 / 43 个测试、Web 4 个文件 / 42 个测试；三包 typecheck、ratchet、API boundary、scenario lint/sanitize、Server build、OSS build 与 Web startup budget 均再次通过；
- Server / Shared / Web coverage；
- Server build、Web production build、OSS split-domain build；
- typecheck、ratchet、API boundary、scenario lint/sanitize、OSS dist contract、Web startup budget；
- `git diff --check` 与敏感凭据模式扫描。

当前环境未配置 `TEST_DATABASE_URL`，也没有可用的本地 Docker PostgreSQL，因此 PostgreSQL integration tests 会明确 skip。`preflight:pr` 在入口按设计失败并提示缺少 `TEST_DATABASE_URL`；这不能记为 preflight 通过。合并前必须由 PostgreSQL 16 CI 实跑 v26 migration/FK/CHECK、并发锁序、candidate resolver、correction/review 事务与跨租户拒绝。

完整发布门槛还包括 PostgreSQL 16 CI 与完整 `preflight:pr`。任何一项失败都不得写成“已完成上线”。
