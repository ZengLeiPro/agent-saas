"""
mitmproxy addon: 自动截获微信公众号 token 参数

启动方式:
    mitmdump -p 8888 -s mitm_addon.py

工作原理:
    监听微信客户端对 mp.weixin.qq.com 的请求，
    自动提取 __biz / uin / key / pass_ticket 等认证参数，
    保存到 data/wechat_token.json 供后续脚本使用。

前置条件:
    1. 安装 mitmproxy CA 证书并设为「始终信任」
    2. macOS 系统代理指向 127.0.0.1:8888（Mac 微信无独立代理设置）
    3. 截获完成后记得关闭系统代理
"""

import json
import os
import time
from urllib.parse import urlparse, parse_qs
from mitmproxy import http

TOKEN_FILE = os.path.join(os.path.dirname(__file__), "data", "wechat_token.json")


def save_token(token_data: dict):
    os.makedirs(os.path.dirname(TOKEN_FILE), exist_ok=True)
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        json.dump(token_data, f, ensure_ascii=False, indent=2)


def response(flow: http.HTTPFlow):
    url = flow.request.pretty_url
    # 只关注微信公众号相关请求
    if "mp.weixin.qq.com/mp/profile_ext" not in url:
        return

    parsed = urlparse(url)
    params = parse_qs(parsed.query)

    # 需要的四个关键参数
    required_keys = ["__biz", "uin", "key", "pass_ticket"]
    extracted = {}
    for k in required_keys:
        values = params.get(k)
        if values:
            extracted[k] = values[0]

    if len(extracted) == len(required_keys):
        token_data = {
            **extracted,
            "captured_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "captured_url": url,
        }
        save_token(token_data)
        print(f"\n{'='*60}")
        print(f"  [OK] 微信 Token 已捕获!")
        print(f"  uin:         {extracted['uin']}")
        print(f"  key:         {extracted['key'][:20]}...")
        print(f"  pass_ticket: {extracted['pass_ticket'][:20]}...")
        print(f"  __biz:       {extracted['__biz']}")
        print(f"  保存到:      {TOKEN_FILE}")
        print(f"{'='*60}\n")
