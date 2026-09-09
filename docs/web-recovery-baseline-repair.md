# Production Web recovery 基线审计与修复

## 适用的失败

APP CI 34253411466 attempt 4 在正式上传之前执行 `cmp` 时报告：

```text
web-before/index.html web-recovery-before/index.html differ: byte 358, line 11
```

这是旧 OSS 与旧 recovery HTTP 响应不一致，不是新旧构建之间正常的差异。
这次日志没有保存两份 HTML 内容，不能仅凭它证明哪一份是正确的，也不能证明
是 Nginx 路由、文件修改还是某次独立发布造成的。不要通过删掉 cmp 或重新构建
同一 SHA 来认可现有字节。

另一个代码层确定性缺陷是 `deploy-recovery-web.sh` 曾在 `releases/<sha>` 已存在时
跳过解包、直接复用目录，而 compatibility 发布会重新构建、重新写入发布身份。
相同源码 SHA 不能证明两次制品字节相同。本 PR 在复用前比较内容，不同则保留
原目录并安装到事务独立目录；它是可复现的缺陷，但尚未被证明是本次现场分叉的唯一原因。

## 使用顺序

合并本 PR 后，进入 Actions → **Production Web Recovery Repair**，选择 `main`：

1. 首先运行 `mode=audit`。它读取可信 Production identity，通过现有的不可变
   baseline resolver 找到当前 Web 制品，校验 SHA-256 后安全解包。不会使用本次
   main 新构建来代替当前线上基线。审计仍会取得生产互斥锁并写诊断临时文件。
2. 查看 `web-recovery-audit-<run>-<attempt>` 中的 JSON。它分别比较 **制品/OSS**、
   **OSS/recovery 磁盘**、**recovery 磁盘/HTTP**，输出文件名、摘要、长度、首次
   差异位置，不上传 HTML、私有 runtime identity 或任何凭证。
3. 仅当 `sourceVerified=true`、`recoveryHeader=true`、`repairable=true`，并确认
   报告中的 SHA/digest 是预期线上版本后，运行 `mode=repair`，勾选
   `confirm_recovery_only`，粘贴完整 `planDigest` 到 `expected_plan_digest`。
   repair 会重新读取全部基线；任何受审核字节或 current 指针发生变化都拒绝旧计划。
4. 修复使用该份已经验证的制品，而不是仅覆盖 index.html。仅通过现有 activation/
   rollback 事务切换 recovery current。成功必须再次证明磁盘和 HTTP 全文件一致、
   OSS 仍然是原字节、可信 Production identity 未改变。
5. 修复成功后，可重跑原来失败的 Web-only 发布 Run，继续发布其原提交；原有 cmp、元数据校验和生产锁不变。
   若改为从最新 main 新建发布，仍要通过累计差异分类。新增发布工具链路径可能
   被现有 ECS 分类器保守阻断；不要放宽分类器，可使用既有 RC Promotion 路径。
   修复旧 recovery 不等于发布了新 Web，也不等于 Staging 门禁通过。

`mode=audit` 任务成功表示**审计完成**，不表示两个站点一致；必须看 `converged`。
修复成功报告带 `status=repaired`。一致基线的 repair 是无操作，不创建新版本。

## 失败关闭与权限边界

- OSS 与已校验的不可变制品不同：报告 `artifact/OSS`，**禁止自动以 OSS 为真覆盖 recovery**。
  需要单独审查 OSS 偏移或可信制品来源，不能强制跳过。
- recovery HTML 没有 `X-Agent-Saas-Recovery: true`：不能证明命中了恢复站点，先审查
  生效的 Nginx 配置，禁止自动修复错误 vhost。
- GET/SSH/制品解析或基线解析失败：停止，不将 403/网络错误当作对象不存在。
- 链接、设备文件、路径穿越、规范化重名、文件/目录冲突或超限归档：拒绝解包。
- 原始 Web tgz 可能在写入 release-identity.json **之前**封存，因此该文件单独校验
  Production schema、源码 SHA、Web digest 及组件 releaseId（若存在），然后保留
  其已验证的 OSS 原始字节。其他文件必须逐字节与归档相同，不能只信身份声明。
- 对 `assets/*.js`、`*.mjs`、`*.css`，按既有上传脚本的 `gzip -n -9` 验证
  OSS 存储字节及 gzip Content-Encoding，再与 recovery 的原始内容比较；不把
  正常压缩当成漂移，也不接受损坏压缩或缺失编码声明。
- 沿用 GitHub `production` 环境保护、`production-runtime` 并发组、已固定的 SSH
  host key，以及主机共享锁。默认 audit，repair 必须显式确认和绑定审核摘要。
- 不修改 OSS 对象/ACL、DNS、Nginx 配置、可信 identity、API、Worker 或 ACS。
- 普通执行/验收失败时按 activation receipt 恢复旧 current/previous 并验证旧观测；
  已追加的不可变 hash 资源可以保留。若锁丢失或回滚失败，不强行写入并明确报错。
  Runner 被强制终止时不能保证进程内补偿执行，保留服务器
  `transactions/repair-<run>.<attempt>.activation`，依既有 recovery 回滚流程处置。
- 不自动清理服务器上的修复制品、旧 recovery 目录与 receipt，供故障审计使用。

## 回归验证

```bash
node --test scripts/release/web-recovery-repair.test.mjs
bash -n scripts/deploy-recovery-web.sh
```

Node 包装测试纳入现有 `scripts/release/*.test.mjs` 门禁，Python 测试仅使用标准库；
新工作流在读取/修改云端基线之前也执行同一回归测试。云端 audit/repair 只能由
人工在已合并的 main 运行；创建 PR 本身不会执行修复或生产部署。
