# PR #642：组织业务系统安装范围退役与无结构变化审核

## 本轮范围与业务边界

沿用原 PR 的方向：退役组织级 `integrated_system` 安装名单。已发布业务系统不再因组织缺少该 scope、历史 selected 空集合、名单不含当前系统而被隐藏或阻止安装。不是“所有人可访问所有系统”。

已有组织接入的响应不再包含 `eligible`，前端按真实组织数据、有效联系人、已发布摘要和重复接入状态判断是否可以提交；加载失败不作为允许。平台已有组织接入入口仍只允许平台管理员；组织直接安装仍只允许本组织管理员或平台管理员。服务端保留发布状态、有效联系人、地址安全、配置版本与发布摘要 CAS、已有实例一致性和恢复时的身份复验。

安装后的成员/Agent 使用授权继续由 `system_installation` assignments 决定。首次启用不会默认给全员授权；停用保留配置但停止有效访问，显式 deny 仍优先。安装放开不改变签名、一次性凭据、DNS、ready、工具注册与交付检查。

当前安装模型按 `(tenant_id, system_id)` 唯一约束限制同组织同系统实例，并用已有接入执行锁处理并发提交。本改造不引入新的数值实例配额，也未把列表分页的 `limit` 当作配额。其他资源权益、组织策略及计费机制没有放开。

## 数据处理

新组织和缺失范围回填只生成六类仍受治理的 scope。历史 `integrated_system` 行及其名单、版本、审计数据保留，不执行删除、改成 all 或重写历史 SQL。回填循环仅遍历有效默认范围，历史第七类既不影响六类的回填计数，也不会被覆写。治理读取隐藏该历史类型，preview 和 PUT 拒绝继续配置，其余类型不受影响。保留旧类型声明用于历史数据读取。

本说明取代历史接入文档中“先配置 integrated_system 名单”和“回读 eligible=true 才能接入”的要求；不修改已经绑定历史审核摘要的文档。

## 精确的迁移分类复审

本轮仅复审 `server/src/data/entitlements/store.ts`。当前 main 比较基线：`eec01d4c1d043a3de0eec54f9fc1ab8d64651c4b`。

基线文件 SHA-256：`f160feb35b7adf2906bef78f737e1d75e2416e5abc73ce05669e9417ccb12870`。

目标文件 SHA-256：`d0dd587354bd1d4e6ce9e3d259087f6656ab119720c12e4d62a66661e9712748`。

两端差异限定为：`completeResourceScopes` 删除一个 integrated_system 默认条目；缺失范围回填从完整枚举改为遍历该默认 Map；增加说明注释。所有 SQL 字面量、事务结构、迁移 runner、表名、列、索引和约束不变。回填的集合变化只是不再插入已经退役的范围；现存数据没有更新或删除。因此分类为 **no-schema-change**，不是 expand 或 contract，不需要虚构数据库后置条件。

历史登记的复用采用可验证的组合审核：保留每条记录的真实 baselineDigest、原理由、全部其他文件及原证据；仅当其旧 targetDigest 等于上述已核实的基线文件摘要时，更新本文件 targetDigest 并追加本说明的摘要。原基线更早的已有审核仍负责其到旧 target 的差异，本说明只负责旧 target 到新 target 的上述窄差异。此前没有此路径的记录，仅在其真实基线文件与上述旧 target 完全相同的条件下追加本路径。未知前态一律中止，不能批量更新摘要放行。

当前 main 增加仅包含本文件的一条精确审核记录。迁移分类器、后置条件门禁、历史 migration 内容及正式 CI workflow 均保持不变。审核测试继续限制精确路径集合，增加本文件/证据篡改拒绝验证；不是删除或跳过原验证。

## 验收入口与证据边界

- `entitlementScopeBaseline.pg.test.ts`：新组织六类范围、回填幂等、历史第七类原样保留且不计入回填。
- `scopeRetirement.pg.test.ts`：真实 Express/PG 下无范围、空名单、其他系统名单、all 四类安装；非管理员、跨组织、未发布系统和无效联系人拒绝；安装不会产生全员授权。
- `existingOnboard.pg.test.ts`：响应不含 eligible、联系人和组织复验、并发幂等、配置 CAS 与逐步交付检查。
- `CreateDeliveryForm.test.tsx`：缺少 eligible 或收到旧 false 值都不再错误阻断；加载错误、无成员、无发布摘要、切换组织与重复提交仍受保护。
- `managementFlow.pg.test.ts`：成员与 Agent 分配、显式 deny、停用和恢复的真实权限链路。
- `e2e/ky-app-management.playwright.config.ts`：生产 React 组件 + 真实 Express/PG，验证新组织无需 scope 预置即可安装及一次性凭据流程。夹具仅本地身份；不保存秘密截图或 trace。

这些是确定性验收入口，不宣称代替真实生产登录、外部 DNS 与企业业务系统实机联调。合并依据还必须包括最终提交的完整 CI 成功记录、无冲突和无未解决评审。此改造不部署生产、不主动合并 PR。

## 随规则变化复审的两份测试证据

仅更新以下两份已登记测试证据的摘要。范围基线测试从七类默认值改为六类，保留既有范围与回填检查，新增历史第七类不覆写及计数幂等回归。已有组织接入测试移除安装名单阻断断言，新增无 eligible 响应及恢复时组织/联系人的复验；原有权限隔离、并发幂等、CAS、凭据、DNS、ready 和成员授权断言均保留。没有修改测试所证明的其他历史源文件分类，也不允许自动刷新任何未列出的证据。

`server/src/__tests__/entitlementScopeBaseline.pg.test.ts`：`sha256:2f56a3bd26b1635524682b4fa583c3e0ab215a5e9536fcba2b4d43bcfcb6bc23` → `sha256:256bbc63240bd82319442845594884f1cd1e34c09c7d28f29e13071438e19a3b`。

`server/src/kyapp/delivery/existingOnboard.pg.test.ts`：`sha256:feeb81b6fd080244206582855c44f77c08b23d2669ac6ebae41d6480ee735970` → `sha256:c9c2a1691f893034e0a771196f4edd6fb73cbf003f995d882ee43f34331efe01`。

新增的安装范围退役、既有组织接入和安装授权生命周期 PG 回归已登记到标准 `scripts/pr-preflight-task.sh postgres` 门禁。浏览器装配入口移除已退役的运营页面导入与路由，只保留真实存在的系统目录、组织系统和凭据领取入口；不通过空组件或接口 mock 掩盖失效入口。
