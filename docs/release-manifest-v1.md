# Release Manifest v1

Release Manifest 是阶段 A 的本地、不可变发布契约；它不创建 tag、不上传制品，也不触发部署。

- 每份 Manifest 绑定一个完整 40 位 `releaseSha` 和四个组件：`web`、`api`、`runtimeWorker`、`acs`。
- 每个组件明确为 `deploy` 或 `keep`。`deploy` 必须使用 `releaseSha`，`keep` 必须等于 `productionBaseline`。
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
