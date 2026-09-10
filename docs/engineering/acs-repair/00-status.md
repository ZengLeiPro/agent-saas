# ACS / DWS 修复状态索引

审计基线：`30cacdc2e05a993f9a47a79c6dc035deffeb9171`。本文件所在提交是 PR #608 的实现与证据候选；最终精确 SHA 由 PR 检查和合并记录固定。

## 结论

代码范围 A/B/C 已实现：

- A：等待、取消与诊断均有边界；未知远端 owner 保留为阻断，不伪造终态。
- B：执行器下发 capability 与精确 fence；runner 产出签名终态；晚到终态、进程重启及周期 reconciliation 只按精确 receipt 收口 lease/journal。
- C：ACS 提供独立 DWS receiver control plane；Server 以 PostgreSQL owner、原始 inbox、业务提交后 ACK 为权威；T0 只有取得旧 invocation 的 journal 终态证明后才原子切换到 `durable-v1`。

临时 authoring workflow 与 helper 已删除。新增生产源均进入 ACS bundle 输入、native control 复制、镜像 smoke、迁移审查和行数棘轮。

## 已执行验证

- ACS：60 个测试文件、461 项测试通过；typecheck、build 通过。
- PostgreSQL：完整关键门禁通过（postcondition 5/5、Server 141/141、KY App Server 13/13）；其中 DWS 11/11 覆盖迁移、owner fence、原始 inbox、业务提交后 ACK 和重复投递。
- Linux native control：root 运行 23 通过/1 跳过；UID/GID 65534 运行 24/24 通过，含同 UID receipt 保密。
- Server：新增迁移、路由和 durable gateway 定向测试 6/6 通过；typecheck、build 通过。
- 工程门禁：ratchets 通过；迁移 postcondition PostgreSQL 测试 5/5 通过（含 V47 破坏性反向验证）；最终全量 Linux 结果以 PR CI 为准。

macOS 全量 Server 测试不作为结果：仓库的 trusted descriptor-relative I/O 明确要求 Linux `/proc`，本机执行产生 `ENOTSUP` 级联失败。该次运行记录为环境不适用，不记为 PASS；Linux PR CI 必须通过才可合并。

## 尚未执行的外部动作

本任务只执行代码、PR、CI 和合并；未执行 staging/production 发布、重启、删除、运行时配置变更或业务事件重放。历史 DWS 完整性仍为 `NOT_RUN / BLOCKED`，不能由单元测试或当前 inflight 数量推断。

发布顺序仍是 exact SHA CI → 获授权的 staging RC → 同一 RC promotion。T0 生产激活需要另行授权，并必须先记录真实部署身份、旧 owner/invocation、journal 证明与具体 reader-capable rollback floor。
