# wechat-reader

微信公众号文章抓取工具。通过 mitmproxy 截获微信客户端认证参数，调用公众号接口批量抓取文章列表及全文内容。

## 工作原理

```
微信客户端 → mitmproxy(mitm_addon.py) → 截获 token → data/wechat_token.json
                                                              ↓
fetch.py ← 读取 token ← ─────────────────────────────────────┘
    ├── 调用 mp.weixin.qq.com/mp/profile_ext 获取文章列表
    ├── 逐篇抓取文章 HTML 并提取纯文本
    └── 保存到 data/articles/YYYY-MM-DD.json
```

微信公众号接口需要 `uin`、`key`、`pass_ticket` 三个认证参数，这些参数只在微信客户端内部请求中携带，无法直接获取。本工具通过 mitmproxy 中间人代理拦截微信客户端的 HTTPS 请求来提取这些参数。

## 文件结构

```
wechat-reader/
├── fetch.py          # 主抓取脚本（发现公众号 / 抓取文章）
├── mitm_addon.py     # mitmproxy 插件（截获微信 token）
├── accounts.json     # 已关注的公众号列表（name + biz）
└── data/
    ├── wechat_token.json   # 截获的认证参数（自动生成）
    └── articles/           # 抓取结果
        └── YYYY-MM-DD.json # 按日期存储，同日多次运行自动去重合并
```

## 依赖

```bash
pip install requests beautifulsoup4 fake-useragent mitmproxy
```

## 使用流程

### 1. 截获 Token

**a) 安装 mitmproxy CA 证书（首次）**

```bash
# 启动一次 mitmproxy 生成证书
mitmdump -p 8888
# Ctrl+C 退出后，证书在 ~/.mitmproxy/mitmproxy-ca-cert.pem
```

双击 `~/.mitmproxy/mitmproxy-ca-cert.pem` 导入钥匙串，然后在「钥匙串访问」中找到 mitmproxy 证书，双击 → 信任 → 设为「始终信任」。

**b) 启动代理并设置系统代理**

```bash
mitmdump -p 8888 -s mitm_addon.py
```

Mac 微信没有独立的代理设置，需要配置 macOS 系统代理：

> 系统设置 → 网络 → Wi-Fi → 详细信息 → 代理 → 启用「Web 代理(HTTP)」和「安全 Web 代理(HTTPS)」 → 服务器填 `127.0.0.1`，端口填 `8888`

**c) 触发截获**

在微信中打开任意公众号主页，看到终端输出 `[OK] 微信 Token 已捕获!` 即成功，token 自动保存到 `data/wechat_token.json`。

**d) 还原代理**

截获完成后记得关闭系统代理设置，否则断开 mitmproxy 后网络不通。

> Token 有效期约 4 小时，过期后需重复 b-d 步骤重新截获。

### 2. 添加公众号

从一篇文章链接自动识别公众号并添加到追踪列表：

```bash
python fetch.py discover "https://mp.weixin.qq.com/s/xxxxx"
```

脚本会解析文章页面，提取公众号名称和 `__biz` 标识，写入 `accounts.json`。也可直接编辑 `accounts.json` 手动添加。

### 3. 抓取文章

```bash
# 抓取所有公众号的最近 1 页文章（约 10 篇/公众号）
python fetch.py fetch

# 只保留今天发布的文章
python fetch.py fetch --today

# 指定公众号，抓取最近 2 页
python fetch.py fetch --account "版面之外" --pages 2
```

抓取结果保存到 `data/articles/YYYY-MM-DD.json`，格式：

```json
{
  "公众号名称": [
    {
      "title": "文章标题",
      "url": "原文链接",
      "cover": "封面图 URL",
      "date": "2026-02-25",
      "timestamp": 1740000000,
      "content": "文章纯文本内容..."
    }
  ]
}
```

同一天多次运行会自动去重合并（按 URL 判断）。

## 注意事项

- 请求间自动加入 2-6 秒随机延迟，避免触发限流
- 如遇「操作频繁」提示，需等待一段时间后重试
- Token 过期会导致返回空列表，重新截获即可
