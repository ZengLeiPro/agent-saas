# PR731 gws runtime auth injection 无结构变更审核

## 审核范围

- 基线：`5351a0493d82d22a979757a84c7cce1e59d72891`（本 PR 相对 `origin/main`）。该三份源码 blob 与全部既有历史生产基线记录中的字节相同。
- 目标文件：`server/src/app/runtimeGovernanceConnectors.ts`、`server/src/data/oauthGrants/store.ts`、`server/src/data/oauthGrants/types.ts`。
- 关联：OAuth reconnect 后 `revocation_stage` 残留导致 `GOOGLE_WORKSPACE_CLI_TOKEN` 不注入。

## 结论

三文件均分类为 `no-schema-change`。`oauthGrants/store.ts` 的 `init` 建表 / 索引语句逐字未变；本次只改运行期 `ensureProjection` / `recordProjection`：在 status 重新变为 `active` 时清掉残留 `revocation_*` 字段，并抽出 `isOAuthGrantRuntimeUsable`。`runtimeGovernanceConnectors.ts` 只改授权判定与投影触发条件。没有新增、修改或删除表、列、索引、约束、启动建表、数据库后置条件、数据回填或数据删除。

不需要 `release-migration: expand`、数据库 postconditions 或独立 contract release。运行期 `UPDATE`/`INSERT` 只写既有列，不改变 schema。

## 验证证据

- `server/src/__tests__/oauthGrantStore.test.ts`：active 再投影清掉 `revocation_stage`；`ensureProjection` 把 revoked/残留撤销恢复为 runtime-usable；`isOAuthGrantRuntimeUsable` 拒绝 active+revocation_stage 残留。

源码摘要、基线摘要和本文摘要逐条绑定在 `config/release-migration-reviews.json`。任一受审源码或证据发生字节变化都必须重新审核。本文只记录源码与数据库结构判断，不代表生产已经发布。
