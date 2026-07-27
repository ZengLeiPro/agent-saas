# Agent SaaS 容器执行边界

## 产品链路

唯恩发票 POC 的权威链路是：

1. 用户在 Agent SaaS 对话；
2. Agent 调用 `wain-invoice`；
3. T100 查询、Excel 下载与解析都在用户专属 ACS Linux Sandbox 中执行；
4. 施耐德登录使用 HTTP 会话保存验证码对应的 `JSESSIONID`；
5. 用户人工读取验证码；
6. Agent 在下一轮复用同一个会话登录，并把 cookies 注入 ACS Playwright Chromium；
7. 浏览器操作、结果下载和审计证据继续保存在该用户 workspace。

不需要 Windows Hand，也不需要访问客户个人电脑。

## 网络条件

施耐德门户是公网地址，ACS 必须可以访问：

```text
https://vendor.schneider-electric.cn/
```

T100 文档当前给出的是唯恩内网地址：

```text
http://10.9.15.62:8000/
```

客户需要将两个只读接口映射为 ACS 可访问地址，或提供等价网络通道。平台通过 `WAIN_T100_ORDER_URL` 和 `WAIN_T100_EXCEL_URL` 注入实际地址，不把地址、口令或 token 写入技能仓库。

公网映射至少应满足：

- 只允许 ACS 固定 SNAT 出口 IP；
- 优先 HTTPS；
- 若客户提供鉴权，凭据只进入平台 Secret；
- 查询和 Excel 下载先开放，T100 回写继续保持未开放。

## 旧站浏览器兼容

客户原始说明写明“Chrome 无法提交数据”，公开登录页源码也会在非 IE User-Agent 下弹兼容性提醒。但登录页使用的是标准 HTML 表单：

```text
POST /webportal/LoginAction.do
method=loginProcess
loginName=...
password=...
veryCode=...
```

当前实现采用：

- HTTP Session：获取验证码、保持 `JSESSIONID`、提交登录；
- IE11 User-Agent：避免旧站仅按 UA 做兼容性阻断；
- Playwright Chromium：执行登录后的页面识别、填写、下载和取证。

最终“确认”能否仅靠 Chromium 完成仍需第一条真实单据验证。如果失败，下一步是在 ACS 内依据真实 DOM/Network 复现最终 HTTP 表单，而不是改用客户 Windows。

## 验收分层

| 验收层 | 当前执行位置 | 成功条件 |
|---|---|---|
| 查询与 Excel 预检 | ACS | 两个 T100 接口可达，严格业务规则通过 |
| 登录接力 | ACS + 用户对话 | 验证码图片可展示，同一 JSESSIONID 登录成功 |
| 到最终确认页 | ACS Chromium | 四个发票字段逐标签一致 |
| 施耐德最终确认 | ACS Chromium/HTTP | 页面或响应出现明确成功证据 |
| T100 回写 | 暂不执行 | 等客户后续提供正式接口契约 |

Windows EXE 只作为历史现场备份，不属于 Agent SaaS 的验收链路。
