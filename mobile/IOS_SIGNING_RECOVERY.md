# iOS 签名凭据初始化故障恢复

## 问题与修复范围

2026-09-11 的 Actions run `34547504615` / job `103103257765` 在原生构建启动后立即失败。
初始化脚本把 `gh secret set --body -` 当作从 stdin 读取，实际会把短横线作为 Secret 的值。
修复后的脚本省略四条签名 Secret 命令的 `--body`，并在原生构建中校验 Base64、报告失败阶段与退出码。

**合并代码不会修改已存储的 GitHub Secrets。** 必须从原始凭据重新写入 `mobile-build-production`
环境的四项签名 Secret，之后才能验证真实签名构建。本修复不自动轮换证书、不上传 TestFlight，
也不改变来源校验、签名身份校验或发布环境授权规则。

## 已初始化环境：只修复四项 Secret

在持有原始凭据、已通过 `gh auth status` 的可信机器上执行。先把下面四个路径改为真实的本机绝对路径；
P12、主应用及 Share Extension 描述文件必须属于同一套已审核的生产身份。
密码从原始 `credentials.json` 读取，不粘贴到命令行、工单、PR 或日志中。

```bash
set +x
set -euo pipefail
REPOSITORY='ZengLeiPro/agent-saas'
CREDENTIALS_JSON='/absolute/path/to/credentials.json'
APP_P12='/absolute/path/to/distribution.p12'
APP_PROFILE='/absolute/path/to/app.mobileprovision'
SHARE_PROFILE='/absolute/path/to/share.mobileprovision'

gh auth status
openssl base64 -A -in "$APP_P12" |
  gh secret set IOS_DISTRIBUTION_P12_BASE64 --repo "$REPOSITORY" --env mobile-build-production
node -e 'const fs=require("node:fs"); const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); const p=c.ios?.AgentSaaS?.distributionCertificate?.password; if(typeof p!=="string" || !p) process.exit(1); process.stdout.write(p);' "$CREDENTIALS_JSON" |
  gh secret set IOS_DISTRIBUTION_P12_PASSWORD --repo "$REPOSITORY" --env mobile-build-production
openssl base64 -A -in "$APP_PROFILE" |
  gh secret set IOS_APP_PROFILE_BASE64 --repo "$REPOSITORY" --env mobile-build-production
openssl base64 -A -in "$SHARE_PROFILE" |
  gh secret set IOS_SHARE_PROFILE_BASE64 --repo "$REPOSITORY" --env mobile-build-production
```

这些命令只更新 Secret，不重置 environment 的审批、分支保护或等待规则。
`gh secret list --env mobile-build-production --repo ZengLeiPro/agent-saas` 可以检查名称和更新时间，
但不能用来证明 Secret 内容正确；最终仍需通过真实构建验证。

新环境可以使用修复后的 `mobile/scripts/init-ios-github-release.sh`：先不带 `--apply` 做预检，
核对它设置的环境规则后再显式执行 `--apply`。已有环境的本次恢复优先使用上面的定向更新命令。

## 验证

1. 在已合并修复且通过 CI 的 main 提交上，手动启动“iOS 构建与发布”，先选 `operation=build`，
   `source_sha` 留空或指定该提交。不要选择旧源码 SHA，否则仍会执行旧版原生脚本。
2. 检查原生工程生成、Pod 安装、Archive、IPA 导出和签名校验。错误会带安全的阶段标签，
   例如 `stage=decode-IOS_APP_PROFILE_BASE64 failed (exit=3)`；不要开启 `set -x` 排查签名步骤。
3. 确认真实 IPA 构建成功后，再按正常授权流程发布内部 TestFlight。无凭据回归测试通过不等于签名构建通过。

本地回归测试无需 pnpm 依赖、GitHub 访问或 Apple 凭据：

```bash
node --test mobile/scripts/ios-signing-secrets.test.mjs
bash -n mobile/scripts/init-ios-github-release.sh
bash -n mobile/scripts/build-ios-native.sh
```

测试使用合成凭据与假的 `gh` / `security` 命令，覆盖 stdin 精确传输、P8 兼容性、仅预检不写入、
写入失败中止、非法/缺失 Base64、不泄露凭据、换行/无填充 Base64 兼容性及文件权限；
它们不连接 Apple，也不证明证书有效、描述文件匹配或 IPA 可安装。
