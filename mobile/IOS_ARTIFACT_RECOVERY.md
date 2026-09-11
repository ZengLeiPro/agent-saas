# iOS 导出后制品校验故障恢复

## 本次故障边界

运行 `34560936384` / job `103143389157`（源码 `b370df28a6928a359d05fb97517d3d067953e9dc`）
已经完成 Archive 和 IPA Export，随后 `jq` 报解析错误，未完成制品封存，也未开始上传 TestFlight。
这不是此前签名 Secret 被写成短横线的问题，不需要仅因这条日志再次轮换证书或覆盖 Secrets。

## 修复

`verify-mobile-release-artifact.sh` 将描述文件的 Entitlements 先提取为独立 XML plist，再转换 JSON。
完整描述文件中的日期和证书二进制数据不再进入 JSON 转换路径。每个转换步骤独立检查退出状态，
转换错误不会被送进 jq 当作 JSON；只接受单个字典对象，不通过清空或丢弃字段伪造成功。
主应用与 Share Extension 使用相同流程，复用已校验的签名 entitlements，避免重复转换。

保留来源 SHA、版本、签名、Team、Bundle ID、APNs、App Group、Keychain Group、描述文件有效期和证书归属检查。
另外改用 plist 提取检查 ProvisionedDevices 是否存在（它是数组，不能依赖 raw 提取判断存在性），
并使证书指纹匹配完整消费管道，避免提前退出导致 pipefail。校验记录只在 JSON 生成成功后写出。

新增 `ios-artifact-verification.test.mjs` 执行真实校验 Shell，而不是仅断言源码字符串。
macOS PR job 强制使用 `/usr/bin/plutil`，并使用真实 jq、zip、OpenSSL、哈希工具，覆盖 XML/binary plist、
完整描述文件的 date/data、两个 Target、点分构建号、重复校验字节一致性，以及转换和安全门禁失败。
codesign/security 使用本地测试替身，测试包不是可安装 IPA，不接触生产凭据或 Apple。
Linux 可运行同一套测试，但 plist 使用明确标识的行为替身，不能替代 macOS 原生验证。

```bash
node --test mobile/scripts/ios-artifact-verification.test.mjs
bash -n mobile/scripts/verify-mobile-release-artifact.sh
```

## 合并后的真实验证

1. 合并本修复，确认该 main 提交的完整 push CI 及 `Build & Check` 成功。
2. 新建一次「iOS 构建与发布」运行，选择 `main`、`operation=build-and-testflight`，
   `source_sha` 留空使用已通过 CI 的当前 main，或指定包含本修复的完整 SHA。
   不要只 Re-run 旧运行；旧运行仍绑定原始源码和调度版本。
3. 检查 Archive、Export 后的 `M60-04 artifact verified`、IPA 封存和制品上传。
4. 再检查内部 TestFlight 的处理回执：`processingState=VALID`、`internalBuildState=IN_BETA_TESTING`。

本次失败运行没有保存可复用的已验证 IPA，不能用 `operation=testflight` 绕过失败的构建门禁。
后续若签名构建成功、只是 Apple 上传/处理失败，才按原构建的 SHA、run ID、attempt 复用已封存的 IPA。
PR 测试成功不代表生产签名和 Apple 上传已经执行或验证；本修复不修改发布授权、Secrets、版本策略或正式上架流程。
