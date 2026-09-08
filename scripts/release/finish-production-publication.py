#!/usr/bin/env python3
"""Temporary exact patch for PR 593; deleted after its verified source commit."""
from pathlib import Path

def replace_once(path, old, new):
    p = Path(path)
    text = p.read_text()
    assert text.count(old) == 1, f'{path}: missing or ambiguous patch anchor'
    p.write_text(text.replace(old, new))

path = 'scripts/release/read-production-state.mjs'
replace_once(path,
    "  label = 'Candidate private ConfigIdentity',\n}) {",
    "  label = 'Candidate private ConfigIdentity',\n  productionConfigPath,\n}) {")
replace_once(path,
    "  const expected = configIdentitySide(expectedConfigIdentity, `${label} computed configIdentity`, {\n    observed: Object.hasOwn(expectedConfigIdentity, 'versionResolution'),\n  });",
    "  const computed = configIdentitySide(expectedConfigIdentity, `${label} computed configIdentity`, {\n    observed: Object.hasOwn(expectedConfigIdentity, 'versionResolution'),\n  });\n  // Only production deployment callers select an online authority. Staging and\n  // pure candidate checks retain their independently bound expected identity.\n  const expected = productionConfigPath\n    ? publishedExpected(productionConfigPath, releaseId, computed)\n    : computed;")
path = 'scripts/release/deploy-production-release.sh'
p = Path(path)
s = p.read_text()
old = "await validatePrivateConfigIdentityReleaseBinding({\n  privateSnapshotPath: snapshotPath,\n  ...binding,"
assert s.count(old) == 2
p.write_text(s.replace(old, "await validatePrivateConfigIdentityReleaseBinding({\n  productionConfigPath: '/etc/agent-saas/config.json',\n  privateSnapshotPath: snapshotPath,\n  ...binding,"))

path = 'docs/config-identity.md'
p = Path(path)
s = p.read_text()
heading = '# ConfigIdentity：发布级有效配置身份\n'
assert s.count(heading) == 1
s = s.replace(heading, heading + '\n> 2026-09-09 补充：生产模型管理已增加签名的在线配置发布权威。下文的 `.release.env` 仍是不可变的代码发布基线；同一代码版本上经过受控保存的配置，以签名在线版本作为 expected。详见本文末节和 `docs/plans/production-model-config-online-save.md`。\n')
s += '''

## 生产模型配置在线发布（PR #593）

模型管理的生产保存不再通过设置 `allowProductionMutation: true` 绕过门禁。模型路由使用独立的受控发布器，先校验当前基线、CAS 和生产二次确认，再生成签名候选，等待 API 与 Runtime Worker 分别应用并读回目标版本后返回成功。其他普通配置路由不因此获得生产写入能力。

`/etc/agent-saas/config-publications` 保存权限受限的 Ed25519 密钥、签名版本头、追加事件与完整配置快照。密钥和初始基线只由受控部署中的 `config-publication-cli.js prepare` 创建，Runtime、GET、摘要计算和刷新不创建或重绑定信任。该目录包含敏感配置快照，不能公开、提交 Git 或作为公开 CI artifact。

代码发布身份保持不变。同一 releaseId 的在线配置使用签名 current 记录的 expected；不同代码 release 使用自己的密封发布环境与解析器计算的 expected，并且仍验证磁盘对应受信快照。普通文件改写不会自动升级为可信 expected。发布现场采集、运行工具准入和旧实例回滚边界都遵守这一选择规则。

`applying`、`rolling_back`、`recovery_required` 不允许以旧 `consistent` 状态继续准入新工作。保存成功要求两个真实进程的回执同时满足 revision、sequence、phase、原始摘要、有效身份、releaseId、角色、PID、进程出生时间、boot ID 及新鲜度约束；更换进程不能复用旧回执。

持久提交后的最终回执丢失返回 `CONFIG_MUTATION_COMMITTED`，不得展示为保存成功或无条件重试。提交前失败先恢复旧文件与两端运行态；无法证明完整恢复时保持 `CONFIG_RUNTIME_RESTORE_FAILED` 和受限状态。自动恢复会重试死去事务拥有者留下的日志；底层进程无法应用或凭据不可用时需要先恢复运行条件，不能删掉签名日志强行放行。

本机制使用现有单主机 API/Worker 和受信 root 运维边界，不声称抵御已经控制主机 root 的攻击者，也不作为多主机配置共识协议。旧凭据保留用于在途请求及恢复快照，本次没有实现自动历史 Secret 回收。
'''
p.write_text(s)
print('Patched old-instance rollback boundaries without weakening code-release or staging validation.')
