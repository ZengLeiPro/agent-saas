# KY App V2 WP2 expand 迁移审核

## 范围与结论

- 基线：`3ebc3acbf76e5aea5a8dd28fcf5791ff77dfcc89`（WP1 契约完成）。
- 目标：WP2 平台侧非对称部署身份、授权操作与防重放存储。
- 分类：`expand`。只新增 4 列、3 张表、约束和索引；不删列、不删表、不改写已有数据。
- 兼容性：已有安装行通过默认值保持 `auth_mode=v1_symmetric`；V1 读取与凭据测试继续通过。

## 数据与安全检查

- 授权码仅保存 `code_sha256`，不保存明文。
- 部署身份表只保存 P-256 公钥 JWK，不提供私钥字段。
- workload token 和 installation grant 不落库。
- assertion/DPoP 的 `(key_id,jti)` 由 PostgreSQL 主键原子防重放，并保存过期时间供清理。
- 安装身份切换、部署公钥登记和授权码消费在同一事务提交；并发兑换只有一个首次提交者。

## 迁移后置条件

1. 治理 schema version 为 `48`。
2. 安装表存在 `auth_mode`、`deployment_id`、`current_key_id`、`identity_generation`，旧行的 `auth_mode` 为 `v1_symmetric`、generation 为 `0`。
3. enrollment operation、deployment key、DPoP replay 三张表存在。
4. 每个安装最多一把 `current` 和一把 `next` 部署公钥。
5. `code_sha256`、request digest 与 key thumbprint 的格式约束生效。
6. V2 enabled 行必须具有 deployment、current key 与正 generation。

## 已执行证据

- migration 静态测试：2 项通过。
- 配置、旧版凭据与 worker 回归：25 项通过。
- 本机 PostgreSQL 16：4 项通过，覆盖 operation 并发幂等、授权码并发消费、proof 并发占位与敏感字段检查。
- server TypeScript 编译通过。

## 发布与回滚边界

本工作包没有部署，也没有改变 Workflow。发布时必须先执行 expand migration 并逐项读取上述后置条件；观察期内回滚应用代码只需关闭 `kyApp.enrollmentV2`，保留新增结构。不得通过删除新增列或表进行普通回滚。
