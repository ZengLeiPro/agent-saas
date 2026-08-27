# GitHub 配置

本文档用于配置 `ZengLeiPro/agent-saas` 的仓库 Ruleset，以及新版发布流程所需的
`staging`、`production` GitHub Environment。

当前值核验日期：`2026-08-27`。本文档按当前 macOS 工作站上的凭据来源编写，交给管理员或其
自动化执行端时，必须在同一工作站和仓库目录执行。文档不包含任何 Secret 明文。

开始前，承载本文档及新版发布实现的 PR 必须已经合并到 `main`。管理员应在 `main` 上确认至少
存在以下契约；缺少任一项即停止，不得使用旧版文档继续配置：

```bash
test -f scripts/staging/ensure-integration-fixture.mjs
grep -F 'Verify migrations and create isolated Integration fixture' \
  .github/workflows/deploy-staging.yml
grep -F 'github-environments-not-configured' infra/staging/resource-plan.json
```

配置必须分为两个阶段：

1. 应用 Ruleset，并创建两个 Environment 的空壳和分支限制。
2. 真实云资源、证据服务和凭据准备完成后，再写入 Environment Secrets/Variables。

不得使用 `TODO`、`UNASSIGNED`、示例地址或临时凭据冒充真实配置。不得在配置过程中运行任何
Workflow、部署服务或修改云资源。

## 1. 不可违反的边界

- 操作仓库固定为 `ZengLeiPro/agent-saas`。
- 执行远端写操作前，必须确认当前 GitHub 身份为仓库所有者 `ZengLeiPro`，且
  `.permissions.admin` 为 `true`。
- 先只读盘点，再执行变更；发现与本文档不一致的已有配置时停止，不得覆盖或删除未知配置。
- 不修改 `.github/workflows/` 下任何文件。
- 不关闭 `App CI / Deploy` 和 `ACS CI / Deploy` 两个旧人工部署入口。
- 不删除、不改名、不迁移现有 Repository Secrets。旧人工入口仍依赖 Repository Secrets。
- 不执行 `workflow_dispatch`，不创建 Release，不创建 RC tag，不 push，不部署。
- 不在命令、日志、文档、Issue 或 PR 中打印 Secret 的值。
- `fc.kaiyan.net` 是共享域名，本次 GitHub 配置不得修改其路由，也不得引入或执行
  `fc3-domain`。

## 2. 权威配置文件

Ruleset 必须以以下仓库文件为准，不得凭界面记忆手工简化：

- `config/github-main-ruleset.json`
- `config/github-rc-tag-ruleset.json`
- 校验及应用工具：`scripts/release/github-ruleset.mjs`

Environment 的名称和字段必须以以下文件为准：

- `.github/workflows/deploy-staging.yml`
- `.github/workflows/promote-release.yml`
- `docs/release-workflow-configuration.md`
- `infra/staging/resource-plan.json`

## 3. 身份和本地仓库前置检查

在仓库根目录执行：

```bash
set -euo pipefail

TARGET_REPOSITORY='ZengLeiPro/agent-saas'
TARGET_OWNER='ZengLeiPro'

test -z "$(git status --porcelain)" || {
  echo 'BLOCKED: 本地工作树不干净，不得切换或覆盖现有修改。' >&2
  exit 1
}

git fetch origin main
git switch main
git pull --ff-only origin main

gh auth status
test "$(gh api user --jq '.login')" = "$TARGET_OWNER" || {
  echo 'BLOCKED: 当前 GitHub 身份不是 ZengLeiPro。' >&2
  exit 1
}
test "$(gh api "repos/$TARGET_REPOSITORY" --jq '.permissions.admin')" = 'true' || {
  echo 'BLOCKED: 当前身份没有仓库 Administration 权限。' >&2
  exit 1
}
```

如果本机尚未登录所有者账号，由所有者本人执行网页授权：

```bash
gh auth login --hostname github.com --web
gh auth switch --hostname github.com --user ZengLeiPro
```

不得索取或传递所有者密码、浏览器 Cookie 或长期 Token。

## 4. 远端只读盘点

执行以下命令并保存输出。Secret 命令只返回名称，不返回 Secret 值。

```bash
TARGET_REPOSITORY='ZengLeiPro/agent-saas'

gh api "repos/$TARGET_REPOSITORY/rulesets?per_page=100" \
  --jq 'map({id, name, target, enforcement})'

gh api "repos/$TARGET_REPOSITORY/environments" \
  --jq '{total_count, environments: [.environments[] | {name, protection_rules, deployment_branch_policy}]}'

gh secret list --repo "$TARGET_REPOSITORY"
gh variable list --repo "$TARGET_REPOSITORY"
```

处理原则：

- 已有同名 Ruleset 时，由仓库工具更新并在更新前备份。
- 出现本文档未描述的 Ruleset、Environment 或保护规则时，记录差异并停止，等待所有者确认。
- 不得为了“整理”而删除无关 Ruleset、Environment、Secret 或 Variable。

## 5. 应用并验证 Ruleset

确认第 3、4 节通过后，执行：

```bash
node scripts/release/github-ruleset.mjs \
  --apply \
  --confirm=ZengLeiPro/agent-saas
```

工具会在写入前把现有 Ruleset 备份到：

```text
.release-evidence/github-rulesets-before-<timestamp>.json
```

必须保留并在实施报告中记录实际备份路径。随后再次验证：

```bash
node scripts/release/github-ruleset.mjs --verify
```

预期输出：

```text
main and immutable RC tag rulesets verified
```

### 5.1 main-release-admission 的最终要求

- 名称：`main-release-admission`
- Target：`branch`
- Enforcement：`active`
- Include：`refs/heads/main`
- Exclude：空
- Bypass actors：空
- 禁止删除 `main`
- 禁止 non-fast-forward push，即禁止强推和改写历史
- 必须通过 PR 合并
- 允许 `merge`、`squash`、`rebase`
- 人工 Approving review 数量：`0`
- CODEOWNER 审批：关闭
- Last Push Approval：关闭
- Review 对话必须全部 Resolved：开启
- 新提交使旧 Review 失效：开启
- Required checks：
  - `Build & Check`
  - `ACS Impact Gate`
- Required checks 必须基于最新 `main`：开启

### 5.2 immutable-rc-tags 的最终要求

- 名称：`immutable-rc-tags`
- Target：`tag`
- Enforcement：`active`
- Include：`refs/tags/rc-*`
- Exclude：空
- Bypass actors：空
- 禁止删除匹配的 RC tag
- 禁止更新匹配的 RC tag
- `update_allows_fetch_and_merge`：`false`

## 6. 创建 Environment 空壳

Environment 名称必须完全一致并保持小写：

- `staging`
- `production`

统一保护设置：

- Required reviewers：空
- Wait timer：`0`
- Prevent self-review：关闭
- Deployment branches and tags：只允许 `main` 分支
- 不配置自动部署

以下命令只创建或更新 Environment 结构，不写 Secret/Variable，也不运行 Workflow：

```bash
set -euo pipefail

TARGET_REPOSITORY='ZengLeiPro/agent-saas'

configure_environment() {
  local environment_name="$1"

  jq -n '{
    wait_timer: 0,
    prevent_self_review: false,
    reviewers: [],
    deployment_branch_policy: {
      protected_branches: false,
      custom_branch_policies: true
    }
  }' | gh api \
    --method PUT \
    "repos/$TARGET_REPOSITORY/environments/$environment_name" \
    --input - >/dev/null

  local main_policy_count
  main_policy_count="$(
    gh api "repos/$TARGET_REPOSITORY/environments/$environment_name/deployment-branch-policies" \
      --jq '[.branch_policies[] | select(.name == "main" and .type == "branch")] | length'
  )"

  if [ "$main_policy_count" = '0' ]; then
    gh api \
      --method POST \
      "repos/$TARGET_REPOSITORY/environments/$environment_name/deployment-branch-policies" \
      -f name='main' \
      -f type='branch' >/dev/null
  fi
}

configure_environment staging
configure_environment production
```

创建后读回：

```bash
for environment_name in staging production; do
  gh api "repos/ZengLeiPro/agent-saas/environments/$environment_name"
  gh api "repos/ZengLeiPro/agent-saas/environments/$environment_name/deployment-branch-policies"
done
```

每个 Environment 必须只有预期的 `main` branch policy。发现额外分支或 tag policy 时只报告，
不得擅自删除。

## 7. 写入配置值前的硬门禁

先检查 Staging 资源是否达到首次部署就绪状态：

```bash
node <<'NODE'
const { readFileSync } = require('node:fs');
const plan = JSON.parse(readFileSync('infra/staging/resource-plan.json', 'utf8'));
const blockers = Array.isArray(plan.blockingConditions) ? plan.blockingConditions : [];
const allowedSelfReferentialBlocker =
  blockers.length === 1 && blockers[0] === 'github-environments-not-configured';
if (
  plan.status !== 'provisioned' ||
  (plan.firstDeploymentReadiness !== 'ready' && !allowedSelfReferentialBlocker) ||
  (blockers.length > 0 && !allowedSelfReferentialBlocker)
) {
  console.error(`BLOCKED: Staging 未达到首次部署就绪状态：${blockers.join(',')}`);
  process.exit(1);
}
console.log(
  allowedSelfReferentialBlocker
    ? '允许继续：唯一 blocker 正是本次要完成的 GitHub Environments 配置'
    : 'Staging 首次部署资源计划已 ready',
);
NODE
```

这里唯一允许豁免的是本次操作自身将消除的
`github-environments-not-configured`。其他任何 blocker 都必须停止。配置完成后管理员不得自行编辑
`infra/staging/resource-plan.json` 或运行 Workflow；应先返回第 11 节报告，由仓库维护者在线读回后
另行把资源计划切换为 `ready`。

还必须同时确认：

- Staging ECS、数据库、NAS、ACS namespace、OSS 和 DNS 已真实创建并完成隔离验证；共享 NAS
  按清单中的 Staging 子目录、`all_squash` 和单一 `/32` 来源执行逻辑隔离，并接受清单所列残余风险。
- `staging-agent.kaiyan.net` 与 `staging-agent-api.kaiyan.net` 已解析到正确的 Staging 资源。
- Evidence Service 已部署，HTTPS、持久盘、只读 Token 与写入 Token 已分离。
- Staging E2E 专用管理员账号已创建，且不是生产真人账号。
- SSH ED25519 Host Key 指纹来自 ECS 控制台或服务器可信渠道，不得只信任公网
  `ssh-keyscan` 的首次结果。
- OSS 发布记录路径具备不可覆盖/版本控制/WORM 等保留保护。

任一条件不满足时，停止在 Environment 空壳阶段。

## 8. staging Environment 值

### 8.1 Secrets

必须在 `staging` Environment 下配置：

- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `STAGING_ECS_HOST`
- `STAGING_ECS_USER`
- `STAGING_ECS_SSH_KEY`
- `RELEASE_EVIDENCE_TOKEN`
- `STAGING_E2E_USERNAME`
- `STAGING_E2E_PASSWORD`

要求：

- 阿里云凭据必须属于 Staging 专用、最小权限 RAM 身份，不得复用生产身份。
- SSH 私钥必须对应 Staging ECS 用户。
- `RELEASE_EVIDENCE_TOKEN` 必须是 Evidence Service 的只读 Token，不得使用写入 Token。
- E2E 账号必须是隔离 Staging 专用平台管理员测试账号。
- Secret 必须从批准的密码库或凭据交付渠道读取，通过标准输入写入；禁止出现在命令参数、日志或文档中。

安全写入形式如下，实际执行时由安全凭据源向标准输入提供值：

```bash
gh secret set '<SECRET_NAME>' \
  --repo ZengLeiPro/agent-saas \
  --env staging
```

不要在自动化日志中使用 `echo "$SECRET_VALUE"`。

### 8.2 Variables

必须在 `staging` Environment 下配置：

- `STAGING_RELEASE_OSS_URI`
- `RELEASE_EVIDENCE_URL`
- `STAGING_ISOLATION_EVIDENCE_URL`
- `STAGING_SSH_HOST_KEY_SHA256`

格式要求：

| Variable                         | 当前确定值                                               |
| -------------------------------- | -------------------------------------------------------- |
| `STAGING_RELEASE_OSS_URI`        | `oss://agent-saas-release-records`                       |
| `RELEASE_EVIDENCE_URL`           | `https://staging-agent-api.kaiyan.net/release-evidence`  |
| `STAGING_ISOLATION_EVIDENCE_URL` | `https://staging-agent-api.kaiyan.net/staging-isolation` |
| `STAGING_SSH_HOST_KEY_SHA256`    | `SHA256:g0fYRjn8eK4ohBjNVXMKgmLqSWW0u8SRi/ICEN/AEpA`     |

发布记录 bucket 位于 `cn-shenzhen`，当前已读回 Versioning 为 `Enabled`。管理员仍需在最终报告中
附上 WORM/保留策略读回；不得仅凭本文档文字假定保留策略有效。

`STAGING_E2E_INTEGRATION_TASK_ID` 无需配置。Workflow 会在首个不可变 RC 启动并完成数据库迁移后，
创建一个 `canceled` 的 Staging 隔离 fixture，事务性读回后仅写入当前 job 环境。它只用于验证
Taskboard 迁移、租户归属和鉴权读取，不表示发生过真实合并。

写入形式：

```bash
gh variable set '<VARIABLE_NAME>' \
  --repo ZengLeiPro/agent-saas \
  --env staging \
  --body '<VERIFIED_VALUE>'
```

### 8.3 当前工作站上的安全写入命令

以下命令不会把 Secret 打印到终端。必须逐条执行并检查退出状态，禁止加 `set -x`：

```bash
set -euo pipefail

TARGET_REPOSITORY='ZengLeiPro/agent-saas'
STAGING_HOST='120.76.54.103'
STAGING_USER='root'
STAGING_KEY='/Users/kaiyan001/.ssh/id_ed25519'

security find-generic-password \
  -s agent-saas-staging-ram-access-key \
  -a agent-saas-staging-deploy -w \
  | jq -r .accessKeyId \
  | gh secret set ALIYUN_ACCESS_KEY_ID --repo "$TARGET_REPOSITORY" --env staging

security find-generic-password \
  -s agent-saas-staging-ram-access-key \
  -a agent-saas-staging-deploy -w \
  | jq -r .accessKeySecret \
  | gh secret set ALIYUN_ACCESS_KEY_SECRET --repo "$TARGET_REPOSITORY" --env staging

printf '%s' "$STAGING_HOST" \
  | gh secret set STAGING_ECS_HOST --repo "$TARGET_REPOSITORY" --env staging
printf '%s' "$STAGING_USER" \
  | gh secret set STAGING_ECS_USER --repo "$TARGET_REPOSITORY" --env staging
gh secret set STAGING_ECS_SSH_KEY --repo "$TARGET_REPOSITORY" --env staging \
  < "$STAGING_KEY"

ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -i "$STAGING_KEY" "$STAGING_USER@$STAGING_HOST" \
  'cat /etc/agent-saas-staging/release-evidence-read.token' \
  | gh secret set RELEASE_EVIDENCE_TOKEN \
      --repo "$TARGET_REPOSITORY" --env staging

printf '%s' 'staging-e2e-admin' \
  | gh secret set STAGING_E2E_USERNAME --repo "$TARGET_REPOSITORY" --env staging
security find-generic-password \
  -s agent-saas-staging-e2e -a staging-e2e-admin -w \
  | gh secret set STAGING_E2E_PASSWORD --repo "$TARGET_REPOSITORY" --env staging

gh variable set STAGING_RELEASE_OSS_URI \
  --repo "$TARGET_REPOSITORY" --env staging \
  --body 'oss://agent-saas-release-records'
gh variable set RELEASE_EVIDENCE_URL \
  --repo "$TARGET_REPOSITORY" --env staging \
  --body 'https://staging-agent-api.kaiyan.net/release-evidence'
gh variable set STAGING_ISOLATION_EVIDENCE_URL \
  --repo "$TARGET_REPOSITORY" --env staging \
  --body 'https://staging-agent-api.kaiyan.net/staging-isolation'
gh variable set STAGING_SSH_HOST_KEY_SHA256 \
  --repo "$TARGET_REPOSITORY" --env staging \
  --body 'SHA256:g0fYRjn8eK4ohBjNVXMKgmLqSWW0u8SRi/ICEN/AEpA'
```

## 9. production Environment 值

### 9.1 Secrets

必须在 `production` Environment 下配置：

- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `ECS_HOST`
- `ECS_USER`
- `ECS_SSH_KEY`
- `PRODUCTION_OBSERVATION_TOKEN`

要求：

- 使用生产专用、最小权限的 RAM 与 SSH 身份。
- `PRODUCTION_OBSERVATION_TOKEN` 必须是生产观察证据服务的只读 Token。
- Environment Secret 可以与现有 Repository Secret 使用同一真实生产凭据，但必须由可信凭据源重新写入；
  GitHub 不允许读取已保存 Secret 的明文。
- 不得删除同名 Repository Secrets，旧人工部署入口仍依赖它们。

安全写入形式：

```bash
gh secret set '<SECRET_NAME>' \
  --repo ZengLeiPro/agent-saas \
  --env production
```

### 9.2 Variables

必须在 `production` Environment 下配置：

- `PRODUCTION_OBSERVATION_URL`
- `PRODUCTION_SSH_HOST_KEY_SHA256`
- `RELEASE_RECORD_OSS_URI`

格式要求：

| Variable                         | 当前确定值                                                    |
| -------------------------------- | ------------------------------------------------------------- |
| `PRODUCTION_OBSERVATION_URL`     | `https://staging-agent-api.kaiyan.net/production-observation` |
| `PRODUCTION_SSH_HOST_KEY_SHA256` | `SHA256:IwX0iO/NoCSv02g4Zczm9+OD+ESws26lr09d0UWPlCI`          |
| `RELEASE_RECORD_OSS_URI`         | `oss://agent-saas-release-records`                            |

生产观察当前由隔离部署的 Evidence Service 统一提供读端点，因此 URL 使用 Staging API 域名，但其
查询必须绑定生产 release ID 与 Manifest digest；这不表示生产应用部署在 Staging ECS。

写入形式：

```bash
gh variable set '<VARIABLE_NAME>' \
  --repo ZengLeiPro/agent-saas \
  --env production \
  --body '<VERIFIED_VALUE>'
```

### 9.3 当前工作站上的生产配置命令

生产 ECS 身份和观察证据只读 Token 的来源已确定。生产 RAM AccessKey 没有保存在当前 macOS
Keychain，且 GitHub 无法反向读取现有 Repository Secret 明文；管理员必须从现有生产部署凭据的
原始密码库取得 `ALIYUN_ACCESS_KEY_ID`、`ALIYUN_ACCESS_KEY_SECRET`，通过标准输入写入。拿不到
原始来源时必须停止，不得把 Staging RAM、初始化 RAM 或临时高权限 RAM 当成生产发布身份。

```bash
set -euo pipefail

TARGET_REPOSITORY='ZengLeiPro/agent-saas'
PRODUCTION_HOST='47.106.14.205'
PRODUCTION_USER='root'
PRODUCTION_KEY='/Users/kaiyan001/Documents/Macbook_Pro.pem'
STAGING_HOST='120.76.54.103'
STAGING_KEY='/Users/kaiyan001/.ssh/id_ed25519'

# 这两项由批准的生产凭据源通过标准输入写入：
gh secret set ALIYUN_ACCESS_KEY_ID \
  --repo "$TARGET_REPOSITORY" --env production
gh secret set ALIYUN_ACCESS_KEY_SECRET \
  --repo "$TARGET_REPOSITORY" --env production

printf '%s' "$PRODUCTION_HOST" \
  | gh secret set ECS_HOST --repo "$TARGET_REPOSITORY" --env production
printf '%s' "$PRODUCTION_USER" \
  | gh secret set ECS_USER --repo "$TARGET_REPOSITORY" --env production
gh secret set ECS_SSH_KEY --repo "$TARGET_REPOSITORY" --env production \
  < "$PRODUCTION_KEY"

ssh -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -i "$STAGING_KEY" "root@$STAGING_HOST" \
  'cat /etc/agent-saas-staging/release-evidence-read.token' \
  | gh secret set PRODUCTION_OBSERVATION_TOKEN \
      --repo "$TARGET_REPOSITORY" --env production

gh variable set PRODUCTION_OBSERVATION_URL \
  --repo "$TARGET_REPOSITORY" --env production \
  --body 'https://staging-agent-api.kaiyan.net/production-observation'
gh variable set PRODUCTION_SSH_HOST_KEY_SHA256 \
  --repo "$TARGET_REPOSITORY" --env production \
  --body 'SHA256:IwX0iO/NoCSv02g4Zczm9+OD+ESws26lr09d0UWPlCI'
gh variable set RELEASE_RECORD_OSS_URI \
  --repo "$TARGET_REPOSITORY" --env production \
  --body 'oss://agent-saas-release-records'
```

## 10. 最终读回验收

### 10.1 Ruleset

```bash
node scripts/release/github-ruleset.mjs --verify
```

必须通过，不得只依赖 GitHub 页面截图。

### 10.2 Environment 和分支策略

```bash
for environment_name in staging production; do
  gh api "repos/ZengLeiPro/agent-saas/environments/$environment_name" \
    --jq '{name, protection_rules, deployment_branch_policy}'
  gh api "repos/ZengLeiPro/agent-saas/environments/$environment_name/deployment-branch-policies" \
    --jq '{total_count, branch_policies}'
done
```

要求：

- 两个 Environment 都存在。
- 没有 Required Reviewer。
- Wait timer 为 0。
- 自我审批保护未启用。
- 自定义分支策略只包含 `main`。

### 10.3 Secret 名称

```bash
gh secret list --repo ZengLeiPro/agent-saas --env staging
gh secret list --repo ZengLeiPro/agent-saas --env production
```

只能核验名称和更新时间。GitHub 不提供 Secret 明文读回，因此还必须记录凭据来源、版本或轮换编号，
但不得记录 Secret 值。

### 10.4 Variable 实值

```bash
gh variable list --repo ZengLeiPro/agent-saas --env staging
gh variable list --repo ZengLeiPro/agent-saas --env production
```

逐项确认：

- 没有空值、`TODO`、`UNASSIGNED`、localhost 或示例域名。
- URL 使用 HTTPS 且端点正确。
- OSS URI 使用 `oss://`。
- 两个发布记录 OSS URI 完全一致。
- 两个 SSH 指纹都使用 `SHA256:` 格式并已有可信来源证明。

## 11. 完成报告模板

配置完成后按以下格式报告，不得把“创建空壳”写成“发布就绪”：

```text
仓库：ZengLeiPro/agent-saas
执行身份：ZengLeiPro
Administration 权限读回：true

Ruleset：
- main-release-admission：active / 验证通过
- immutable-rc-tags：active / 验证通过
- 写入前备份：<实际备份路径>

Environment：
- staging：已创建；保护规则与 main 分支限制已读回
- production：已创建；保护规则与 main 分支限制已读回

Environment 配置值：
- staging Secrets：<仅列名称和更新时间，或说明尚未配置>
- staging Variables：<列名称和经过脱敏的值，或说明尚未配置>
- production Secrets：<仅列名称和更新时间，或说明尚未配置>
- production Variables：<列名称和经过脱敏的值，或说明尚未配置>

未执行：
- 未运行任何 Workflow
- 未部署 Staging 或 Production
- 未创建/更新/删除云资源
- 未关闭 App CI / Deploy 或 ACS CI / Deploy

尚未满足的外部条件：
- <逐项列出，不得省略>
```

Ruleset 和 Environment 配置完成，只代表 GitHub 发布控制面准备完成。只有 Staging 隔离资源、DNS、
证据服务、真实 E2E、不可变 RC、生产基线和至少 15 分钟生产观察全部形成权威证据后，才能声明新版
发布链路就绪。
