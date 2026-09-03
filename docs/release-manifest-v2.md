# Release Manifest v2

Release Manifest v2 在 v1 的组件与不可变制品契约上，新增组件级 Runtime Dependency Identity。新 RC 只写 v2；读取器继续严格支持历史 v1。

## 组件级 Runtime 身份

`artifacts.runtimeDependencies` 分为：

- `server`：绑定实际选中的 Server bundle，覆盖 API 与 Runtime Worker；
- `acs`：绑定实际选中的 ACS Orchestrator bundle。

每项都记录无凭据 URI、文件 digest/size、`sourceSha`、`identityDigest`、`dependencyDigest` 与 `contractDigest`。`sourceSha` 必须等于对应已选组件的源码身份。因此 `web-only`、`app-only`、`ACS-only` 发布可以分别从当前构建或冻结生产基线选择 Server/ACS identity，不再用一份当前构建 identity 描述混合制品。

Staging 与 Production 在写入环境、切换 symlink 或替换进程前会：

1. 校验所有已选 tgz 的 Manifest digest/size；
2. 下载 Server 与 ACS 各自的 Runtime identity；
3. 校验 identity 自摘要及 source/contract/dependency 绑定；
4. 对比 tgz 内嵌 identity 与独立 identity 的精确字节。

发布记录写入前先物化并校验所有实际选中的制品（包括 `keep`），再执行权威 Manifest schema/digest、完整 artifact index 与 Release record 校验；任何选中 tgz、内嵌 identity、独立 identity 或当前构建 index 不一致都不会产生不可变记录。

字段所有权刻意分层，不能互换：artifact index/SBOM 只证明当前构建产生的完整制品集与依赖图；Release Manifest 证明本次实际选择的 `keep/deploy` 组合；Release Evidence 和 baseline component index 证明冻结基线的来源与 aggregate digest；selected staging 目录则保存并逐字节校验最终组合。partial Release 不会把当前构建的总 index/SBOM 冒充成所选组合，也不会仅凭 URI 推断 `keep` 制品。

## 版本与迁移边界

- v1 是严格旧结构：`artifacts` 不包含 `runtimeDependencies`，digest 域保持 `agent-saas-release-manifest-v1\0`。历史不可变 v1 可继续读取和审计，但不再承担 Runtime 组件部署/回退。
- v2 是严格新结构：必须包含 Server/ACS 两份 Runtime identity，digest 域为 `agent-saas-release-manifest-v2\0`。
- 不接受“schemaVersion 仍为 1、但偷偷添加 v2 字段”的中间形态。
- 晋级下载器显式保留 v1 证据校验；v1 仅允许 Runtime 组件全部 `keep` 的 Web-only 晋级。App、Runtime Worker 或 ACS 为 `deploy` 时在任何生产写入前拒绝，因为旧 bundle 没有 Runtime identity/guard，且不能注入当前 main 的 unit。Runtime 回退必须选择已具备 identity 的 v2 RC，或以目标历史源码重建 v2 制品。
- baseline resolver 校验每份 component index 的 aggregate digest，并只返回其中真实存在的 component-scoped Runtime identity；v2 Evidence 对 `keep` 的 Server/ACS 强制要求对应基线 identity，对明确 `deploy` 的组件允许缺失旧基线 identity，以便首次全量 v2 发布完成迁移。Manifest v2 最终仍始终包含两份实际选中 identity；旧 index 不会被静默套用当前 identity。

可审计的非生产完整示例位于 `docs/examples/release-manifest-v2.example.json`。
