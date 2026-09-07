# 套餐到期手动编辑：数据库变更审核

仅新增 `${tablePrefix}_provider_plan_expiry_edits` 表及 `(identity_key, id DESC)` 索引，在现有额度 store.init 的 advisory lock 内通过 CREATE TABLE/INDEX IF NOT EXISTS 创建。原快照表不变，无 ALTER/DROP、无历史回填、无外键或级联删除。旧版本可忽略新增表，回滚时保留表和记录。

- Codex identity_key 为服务端授权邮箱 trim + lowercase 加供应商前缀；不合并邮箱别名。相同邮箱删除再添加后继承，邮箱缺失时禁止编辑。
- 火山 identity_key 使用现有分组账号键。前端不能指定邮箱或修改人。
- 每次保存/清除追加一条记录，NULL 表示清除覆盖值；记录认证用户、数据库时间，按 id 取最后写入的设置。账号移除、快照 prune 均不删除编辑历史。
- overview 合并设置，不修改供应商原始 plan，不影响调度、凭据续期和额度告警。
- 日期录入固定北京时间，数据库 TIMESTAMPTZ 保存实际时刻。接口受 requirePlatformAdmin 保护并校验 ISO 日期。

验证：独立本地 PostgreSQL 16 临时实例，通过重复 init、跨 store 实例读取、清除、隔离账号和 prune 后保留审计测试（server/src/quota/providerPlanExpiry.pg.test.ts）；服务测试覆盖同邮箱更换 credentialRef 继承与火山回退；路由测试覆盖权限、伪造 userId 拒绝及日期校验。前端测试覆盖北京时间转换、取消、保存、失败保留输入和清除。

生产数据库变更必须在正式发布时走 expand 观察与只读 postcondition 回读；本 PR 合并不直接执行生产 DDL。
