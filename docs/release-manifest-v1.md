# Release Manifest v1

Release Manifest 是阶段 A 的本地、不可变发布契约；它不创建 tag、不上传制品，也不触发部署。

- 每份 Manifest 使用 `schemaVersion: 1`，绑定完整 40 位小写 `releaseSha`、RC tag、创建者、来源 PR、Integration Candidate 和三类权威 check。
- Web、API、Runtime Worker、ACS 分别记录 `deploy|keep`、源码 SHA 和制品 digest；当前 API 与 Runtime Worker 共享同一个 Server bundle，因此必须同时 `deploy` 或同时 `keep` 且 digest 相同；ACS 必须同时记录 Orchestrator artifact digest 与 Sandbox image digest。
- `deploy` 必须使用 `releaseSha`；`keep` 的完整源码和 digest 身份必须等于 `productionBaseline`。
- Server/Web/ACS Orchestrator/ACS image 制品采用无凭据、无签名参数的绝对 URI 或仓库名，并与组件 digest 双向绑定。
- `rollbackTargets` 在 RC 创建时必须等于冻结的生产组件基线；`promotionPolicy` 固化过期时间、最低安全 SHA、N/N+1 兼容声明、兼容测试报告 digest 和人工授权要求。
- `migrationPlan` 固化 `none|expand`、迁移计划 digest 和观察后确认要求；生产晋级禁止执行 contract，contract 只能作为兼容窗口后的独立发布。
- Manifest digest 使用 `sha256(agent-saas-release-manifest-v1\0 + canonical JSON)`，canonical JSON 递归按键排序且保持数组顺序。
- `ReleaseManifestStore` 使用排他创建；相同 `releaseId` 不允许覆盖。读取时重新校验 schema 和 digest。

本地 CLI：

```bash
pnpm -F server exec tsx scripts/release-manifest.mts validate path/to/manifest.json
pnpm -F server exec tsx scripts/release-manifest.mts digest path/to/manifest.json
AGENT_SAAS_RELEASE_MANIFEST_DIR=./data/release-manifests \
  pnpm -F server exec tsx scripts/release-manifest.mts create path/to/manifest.json
```

`create` 仅写入本地 Manifest 目录；生产发布、制品上传与 RC tag 属于后续阶段，不能由此命令触发。

完整的非生产示例位于 `docs/examples/release-manifest-v1.example.json`。示例中的 SHA、digest、run ID 和 URI 仅用于契约测试，不能作为当前生产基线或真实 RC 证据。

## Attestation

RC 状态不回写 Manifest，而是追加到独立 JSONL：

```bash
AGENT_SAAS_RELEASE_ATTESTATION_DIR=./data/release-attestations \
  pnpm -F server exec tsx scripts/release-attestation.mts status \
  rc-20260825-01 sha256:<manifest-digest>
```

追加接口绑定 release ID、Manifest digest、operation key、actor、UTC 时间与原因；相同 operation key 的相同请求幂等，不同内容重放会被拒绝。
