#!/usr/bin/env python3
"""
微信公众号文章抓取工具

用法:
    # 从文章链接自动发现公众号 biz 并添加到 accounts.json
    python fetch.py --discover "https://mp.weixin.qq.com/s/xxxxx"

    # 抓取所有公众号的今日文章
    python fetch.py --today

    # 抓取指定公众号的最近 N 页文章
    python fetch.py --account "版面之外" --pages 2

    # 抓取所有公众号最近1页文章（不限日期）
    python fetch.py --all
"""

import argparse
import json
import os
import re
import sys
import time
import random
from datetime import datetime, date
from urllib.parse import urlparse, parse_qs

import requests
from bs4 import BeautifulSoup
from fake_useragent import UserAgent

requests.packages.urllib3.disable_warnings()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
TOKEN_FILE = os.path.join(DATA_DIR, "wechat_token.json")
ACCOUNTS_FILE = os.path.join(BASE_DIR, "accounts.json")
ARTICLES_DIR = os.path.join(DATA_DIR, "articles")

os.makedirs(ARTICLES_DIR, exist_ok=True)


def load_token() -> dict | None:
    if not os.path.exists(TOKEN_FILE):
        return None
    with open(TOKEN_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def load_accounts() -> list[dict]:
    if not os.path.exists(ACCOUNTS_FILE):
        return []
    with open(ACCOUNTS_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data.get("accounts", [])


def save_accounts(accounts: list[dict]):
    with open(ACCOUNTS_FILE, "w", encoding="utf-8") as f:
        json.dump({"accounts": accounts}, f, ensure_ascii=False, indent=2)


def delay(min_s=2, max_s=5):
    t = min_s + random.random() * (max_s - min_s)
    time.sleep(t)


class WechatFetcher:
    def __init__(self):
        self.session = requests.Session()
        self.headers = {"User-Agent": UserAgent().chrome}
        self.token = load_token()

    def ensure_token(self):
        if not self.token:
            print("[ERROR] 未找到 token，请先运行 mitmproxy 截获 token:")
            print("  1. 启动代理:  mitmdump -p 8888 -s mitm_addon.py")
            print("  2. 设置微信代理指向 127.0.0.1:8888")
            print("  3. 在微信中打开任意公众号主页")
            sys.exit(1)
        # 检查 token 时效（粗略判断，超过 4 小时提示）
        captured = self.token.get("captured_at", "")
        if captured:
            try:
                dt = datetime.strptime(captured, "%Y-%m-%d %H:%M:%S")
                hours = (datetime.now() - dt).total_seconds() / 3600
                if hours > 4:
                    print(f"[WARN] Token 已捕获 {hours:.1f} 小时前，可能已过期")
            except ValueError:
                pass

    def discover_biz(self, article_url: str) -> dict | None:
        """从一篇文章链接中提取公众号名称和 __biz"""
        print(f"[INFO] 正在解析文章: {article_url}")
        try:
            res = self.session.get(article_url, headers=self.headers, verify=False, timeout=15)
        except Exception as e:
            print(f"[ERROR] 请求失败: {e}")
            return None

        if "wx_follow_nickname" not in res.text:
            print("[ERROR] 无法解析文章内容（可能需要微信环境）")
            return None

        soup = BeautifulSoup(res.text, "html.parser")

        # 提取公众号名称
        nickname = None
        el = soup.find("div", class_="wx_follow_nickname")
        if el:
            nickname = el.get_text().strip()
        else:
            el = soup.find("a", id="js_name")
            if el:
                nickname = el.get_text().strip()
        if not nickname:
            nickname = "未知公众号"

        # 提取 __biz
        biz_match = re.search(r'biz:\s*["\']([^"\']+)["\']', res.text)
        if not biz_match:
            # 尝试从 URL 参数中提取
            biz_match = re.search(r'__biz=([^&"\']+)', res.text)
        if not biz_match:
            print("[ERROR] 无法提取 __biz")
            return None

        biz = biz_match.group(1)
        print(f"[OK] 公众号: {nickname}, biz: {biz}")
        return {"name": nickname, "biz": biz}

    def get_article_list(self, biz: str, page: int = 0) -> list[dict]:
        """获取指定公众号的指定页文章列表"""
        self.ensure_token()

        offset = page * 10
        url = (
            f"https://mp.weixin.qq.com/mp/profile_ext?"
            f"action=getmsg"
            f"&__biz={biz}"
            f"&f=json"
            f"&offset={offset}"
            f"&count=10"
            f"&is_ok=1"
            f"&scene=124"
            f"&uin={self.token['uin']}"
            f"&key={self.token['key']}"
            f"&pass_ticket={self.token['pass_ticket']}"
            f"&wxtoken="
            f"&appmsg_token="
            f"&x5=0"
        )

        try:
            res = self.session.get(url, headers=self.headers, verify=False, timeout=15)
        except Exception as e:
            print(f"[ERROR] 请求文章列表失败: {e}")
            return []

        if "app_msg_ext_info" not in res.text:
            if "操作频繁" in res.text:
                print("[ERROR] 操作频繁，已被限流")
            elif "home_page_list" in res.text and "[]" in res.text:
                print("[ERROR] 请求异常，可能 token 已过期")
            else:
                print(f"[ERROR] 未获取到文章列表 (page={page+1})")
            return []

        try:
            data = json.loads(res.text)
            msg_list = json.loads(data["general_msg_list"])["list"]
        except (json.JSONDecodeError, KeyError) as e:
            print(f"[ERROR] 解析响应失败: {e}")
            return []

        articles = []
        for item in msg_list:
            ts = item["comm_msg_info"]["datetime"]
            pub_date = datetime.fromtimestamp(ts).strftime("%Y-%m-%d")

            # 主文章
            ext = item.get("app_msg_ext_info", {})
            if ext.get("title"):
                articles.append({
                    "title": ext["title"],
                    "url": ext.get("content_url", "").replace("&amp;", "&").replace("#wechat_redirect", ""),
                    "cover": ext.get("cover", ""),
                    "date": pub_date,
                    "timestamp": ts,
                })

            # 多图文中的其他文章
            for sub in ext.get("multi_app_msg_item_list", []):
                if sub.get("title"):
                    articles.append({
                        "title": sub["title"],
                        "url": sub.get("content_url", "").replace("&amp;", "&").replace("#wechat_redirect", ""),
                        "cover": sub.get("cover", ""),
                        "date": pub_date,
                        "timestamp": ts,
                    })

        print(f"  第 {page+1} 页: {len(articles)} 篇文章")
        return articles

    def fetch_article_content(self, article_url: str) -> str | None:
        """获取单篇文章的纯文本内容"""
        if not article_url:
            return None
        try:
            res = self.session.get(article_url, headers=self.headers, verify=False, timeout=15)
        except Exception as e:
            print(f"[ERROR] 获取文章内容失败: {e}")
            return None

        if "wx_follow_nickname" not in res.text and "js_content" not in res.text:
            return None

        soup = BeautifulSoup(res.text, "html.parser")
        content_el = soup.find("div", id="js_content")
        if content_el:
            return content_el.get_text(separator="\n", strip=True)
        # fallback: 提取全文
        return soup.get_text(separator="\n", strip=True)


def cmd_discover(args):
    fetcher = WechatFetcher()
    info = fetcher.discover_biz(args.url)
    if not info:
        return

    accounts = load_accounts()
    # 检查是否已存在
    existing = next((a for a in accounts if a["biz"] == info["biz"]), None)
    if existing:
        print(f"[INFO] 该公众号已在列表中: {existing['name']}")
        existing["name"] = info["name"]  # 更新名称
    else:
        accounts.append(info)
        print(f"[OK] 已添加到 accounts.json")
    save_accounts(accounts)


def cmd_fetch(args):
    fetcher = WechatFetcher()
    fetcher.ensure_token()

    accounts = load_accounts()
    if not accounts:
        print("[ERROR] accounts.json 中没有公众号，请先用 --discover 添加")
        return

    # 筛选指定公众号
    if args.account:
        accounts = [a for a in accounts if a["name"] == args.account]
        if not accounts:
            print(f"[ERROR] 未找到公众号: {args.account}")
            return

    today_str = date.today().strftime("%Y-%m-%d")
    all_results = {}
    pages = args.pages or 1

    for acc in accounts:
        if not acc.get("biz"):
            print(f"[SKIP] {acc['name']}: 缺少 biz")
            continue

        print(f"\n[FETCH] {acc['name']} (biz={acc['biz']})")
        acc_articles = []
        for page in range(pages):
            articles = fetcher.get_article_list(acc["biz"], page)
            if not articles:
                break
            acc_articles.extend(articles)
            if page < pages - 1:
                delay(3, 6)

        # 如果 --today，只保留今天的
        if args.today:
            acc_articles = [a for a in acc_articles if a["date"] == today_str]
            print(f"  今日文章: {len(acc_articles)} 篇")

        # 获取文章全文
        for i, article in enumerate(acc_articles):
            print(f"  [{i+1}/{len(acc_articles)}] {article['title']}")
            content = fetcher.fetch_article_content(article["url"])
            article["content"] = content or ""
            if i < len(acc_articles) - 1:
                delay(1, 3)

        if acc_articles:
            all_results[acc["name"]] = acc_articles

        # 公众号之间的间隔
        delay(3, 6)

    # 保存结果
    if all_results:
        output_file = os.path.join(ARTICLES_DIR, f"{today_str}.json")
        # 追加模式：如果文件已存在，合并
        if os.path.exists(output_file):
            with open(output_file, "r", encoding="utf-8") as f:
                existing = json.load(f)
            for name, arts in all_results.items():
                if name in existing:
                    # 去重：按 url 判断
                    existing_urls = {a["url"] for a in existing[name]}
                    for a in arts:
                        if a["url"] not in existing_urls:
                            existing[name].append(a)
                else:
                    existing[name] = arts
            all_results = existing

        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(all_results, f, ensure_ascii=False, indent=2)

        total = sum(len(v) for v in all_results.values())
        print(f"\n[DONE] 共 {len(all_results)} 个公众号, {total} 篇文章")
        print(f"  保存到: {output_file}")
    else:
        print("\n[INFO] 未获取到任何文章")


def main():
    parser = argparse.ArgumentParser(description="微信公众号文章抓取工具")
    subparsers = parser.add_subparsers(dest="command")

    # discover
    p_discover = subparsers.add_parser("discover", help="从文章链接发现公众号并添加")
    p_discover.add_argument("url", help="微信文章链接")

    # fetch
    p_fetch = subparsers.add_parser("fetch", help="抓取公众号文章")
    p_fetch.add_argument("--account", help="指定公众号名称（不指定则抓取全部）")
    p_fetch.add_argument("--pages", type=int, default=1, help="每个公众号抓取页数（默认1，约10篇）")
    p_fetch.add_argument("--today", action="store_true", help="只保留今天发布的文章")

    args = parser.parse_args()

    if args.command == "discover":
        cmd_discover(args)
    elif args.command == "fetch":
        cmd_fetch(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
