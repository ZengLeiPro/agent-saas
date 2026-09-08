# ACR 精确镜像准备与恢复

Staging 发布固定触发 SHA；镜像仍必须通过构建记录、源码日志和两次 digest 读回校验。禁止通过构建最新 main、改标签或部署后继镜像冒充原候选。

## 运行链路

1. `prepare-evidence` 完成候选与生产基线证据。
2. `prepare-acs` 在部署锁外查询精确镜像，同一 SHA 串行准备。已有 RC 由后续部署阶段验证并复用，不重新构建。
3. 记录缺失持续 30 秒后，只补投同一 SHA、`refs/heads/main` 且失败的 GitHub push delivery。已成功或已补投的同 GUID 不再补投；不调用 ACR 手动构建 API。
4. 补投接受后最多等 5 分钟出现构建记录；排队最多 20 分钟，构建最多 30 分钟；整体绝对上限 45 分钟。每组查询包含分页与校验，最多 120 秒，超时至多重试三次。每 15 秒输出查询心跳或阶段进度。
5. 经校验的镜像证据通过当前 run/attempt 专属 artifact 交给部署 job。占用部署锁后只进行有界、单次复核，证据必须与准备阶段完全一致；不在锁内等待构建或补投。

## 一次性运维前置条件

Staging Environment 保留专用 `ACR_READ_ACCESS_KEY_ID` / `ACR_READ_ACCESS_KEY_SECRET`，不得替换为云管理员凭据。

自动恢复另需经仓库管理员确认的配置：

- Variable `ACR_GITHUB_HOOK_ID`：可选覆盖值，默认复用现有 ACS Workflow 的 `649018221` 配置。恢复前通过 GitHub API 检查该钩子的 ID、启用状态和 push 订阅；如绑定已轮换，应由管理员核对后更新变量。
- Secret `ACS_WEBHOOK_REDELIVERY_TOKEN`：复用现有仓库级 Secret，或在 Staging Environment 覆盖。仅授目标仓库 webhook 查询和补投所需权限。普通 `GITHUB_TOKEN` 不代替此权限。

恢复凭据缺失不影响已有精确镜像的发布，但无法修复丢失的 push 投递。已通过只读元数据确认仓库级 Secret 名称存在；未读取其值，未验证其在线权限。代码不自动授予权限、不创建或修改 webhook、不变更 ACR 源仓库绑定。

无对应失败 delivery、已返回 2xx 却未生成构建、之前补投仍失败、扫描超过安全范围时，必须查看 GitHub delivery 与 ACR 源码绑定/授权状态；自动恢复会明确停止，不盲目重建。超时导致补投结果不确定时，后续运行先读投递记录，不直接重发。

## 验收与回滚

- 本地：`node --test scripts/release/acr-recovery.test.mjs scripts/release/wait-for-acr-image.test.mjs`，覆盖状态机、失败投递跨页确认、超时进程组清理及原有 SHA/digest 防篡改校验。
- Staging：经授权发布新代码后，确认镜像准备在部署锁外，summary 与 `prepared-acs-<run>-<attempt>` 诊断包含结果。精确镜像成功、补投权限不足、补投接受但未入队必须呈现不同结果。
- 自动恢复真实验收需要管理员配置上述权限并有真实失败投递；本地模拟通过不代表云端恢复已验收。
- 生产不因本修复自动部署。Staging 使用相同不可变镜像证据供后续正常晋级消费。
- 回滚本次提交可恢复旧准备链路；已经运行的 Workflow 不会因新代码提交而热更新，需要经授权取消旧任务并启动新版本。删除恢复凭证配置前应确认没有使用中的任务。
