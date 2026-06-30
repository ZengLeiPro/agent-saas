#!/usr/bin/env python3
"""
AI 新闻 + 科技商业精选抓取脚本

数据源：
  - AIbase（中国 AI 新闻，仅标题）
  - AI HubToday（AI 日报精选，仅标题）
  - Readhub·AI（AI 快讯聚合，仅标题）
  - TechURLs → Techmeme/TechCrunch（英文科技，Techmeme 带摘要级长标题）
  - 虎嗅（编辑精选深度文章，带摘要，RSS 直连）
  - 36氪（科技商业，带摘要，RSS 直连）

用法：python fetch.py [-o /tmp/ai-news-latest.json]
"""

import argparse
import hashlib
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urljoin, urlparse, urlunparse

import feedparser
import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter, Retry

try:
    from dateutil import parser as dtparser
except ImportError:
    dtparser = None

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
UTC = timezone.utc
DEFAULT_OUTPUT = "/tmp/ai-news-latest.json"
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------
@dataclass
class NewsItem:
    title: str
    url: str
    source: str
    published_at: str | None  # ISO 8601 or None
    summary: str | None = None  # 摘要（虎嗅/36氪 RSS 提供）


# ---------------------------------------------------------------------------
# HTTP session
# ---------------------------------------------------------------------------
def create_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(
        total=3, connect=3, read=3,
        backoff_factor=0.8,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset(["GET", "POST"]),
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    session.headers.update({
        "User-Agent": BROWSER_UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    return session


# ---------------------------------------------------------------------------
# URL normalization
# ---------------------------------------------------------------------------
TRACKING_PARAMS = {
    "ref", "spm", "fbclid", "gclid", "igshid",
    "mkt_tok", "mc_cid", "mc_eid", "_hsenc", "_hsmi",
}

def normalize_url(raw_url: str) -> str:
    try:
        parsed = urlparse(raw_url.strip())
        if not parsed.scheme:
            return raw_url.strip()
        query = [
            (k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True)
            if not k.lower().startswith("utm_") and k.lower() not in TRACKING_PARAMS
        ]
        parsed = parsed._replace(
            scheme=parsed.scheme.lower(),
            netloc=parsed.netloc.lower(),
            fragment="",
            query=urlencode(query, doseq=True),
        )
        return urlunparse(parsed).rstrip("/")
    except Exception:
        return raw_url.strip()


# ---------------------------------------------------------------------------
# HTML to plain text (for RSS summary)
# ---------------------------------------------------------------------------
def html_to_text(html: str, max_len: int = 200) -> str | None:
    if not html:
        return None
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ", strip=True)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None
    if len(text) > max_len:
        text = text[:max_len] + "…"
    return text


# ---------------------------------------------------------------------------
# Date parsing
# ---------------------------------------------------------------------------
def parse_relative_time_zh(text: str, now: datetime) -> datetime | None:
    text = (text or "").strip()
    if not text:
        return None
    if "刚刚" in text:
        return now
    m = re.search(r"(\d+)\s*分钟前", text)
    if m:
        return now - timedelta(minutes=int(m.group(1)))
    m = re.search(r"(\d+)\s*小时前", text)
    if m:
        return now - timedelta(hours=int(m.group(1)))
    m = re.search(r"(\d+)\s*天前", text)
    if m:
        return now - timedelta(days=int(m.group(1)))
    m = re.fullmatch(r"(?:今天)?\s*(\d{1,2}):(\d{2})", text)
    if m:
        candidate = now.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        if candidate > now + timedelta(minutes=5):
            candidate -= timedelta(days=1)
        return candidate
    m = re.fullmatch(r"昨天\s*(\d{1,2}):(\d{2})", text)
    if m:
        return (now - timedelta(days=1)).replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
    m = re.fullmatch(r"(?:\d{4}年\s*)?(\d{1,2})月(\d{1,2})日", text)
    if m:
        try:
            candidate = datetime(now.year, int(m.group(1)), int(m.group(2)), tzinfo=UTC)
            if candidate > now + timedelta(days=2):
                candidate = datetime(now.year - 1, int(m.group(1)), int(m.group(2)), tzinfo=UTC)
            return candidate
        except Exception:
            return None
    return None


def parse_unix_timestamp(value) -> datetime | None:
    try:
        n = float(value)
    except Exception:
        return None
    if n > 10_000_000_000:
        n /= 1000.0
    try:
        return datetime.fromtimestamp(n, tz=UTC)
    except Exception:
        return None


def parse_date_any(value, now: datetime) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(UTC)
    if isinstance(value, (int, float)):
        return parse_unix_timestamp(value)
    s = str(value).strip()
    if not s:
        return None
    if s.startswith("$D"):
        s = s[2:]
    if re.fullmatch(r"\d{12,}", s):
        return parse_unix_timestamp(int(s))
    if re.fullmatch(r"\d{9,11}", s):
        return parse_unix_timestamp(int(s))
    dt = parse_relative_time_zh(s, now)
    if dt:
        return dt
    # TechURLs format: 2026-02-19 11:54:21AM UTC
    m = re.search(r"(\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}:\d{2}[AP]M)\s+UTC", s)
    if m:
        try:
            dt = datetime.strptime(m.group(1), "%Y-%m-%d %I:%M:%S%p")
            return dt.replace(tzinfo=UTC)
        except Exception:
            pass
    if dtparser:
        try:
            dt = dtparser.parse(s, tzinfos={"UT": 0, "UTC": 0, "GMT": 0})
            if not dt.tzinfo:
                dt = dt.replace(tzinfo=UTC)
            return dt.astimezone(UTC)
        except Exception:
            return None
    return None


def fmt_dt(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# Mojibake fix
# ---------------------------------------------------------------------------
def maybe_fix_mojibake(text: str) -> str:
    s = (text or "").strip()
    if not s:
        return s
    if re.search(r"[Ãâåèæïð]|[\x80-\x9f]|æ|ç|å|é", s) is None:
        return s
    for enc in ("latin1", "cp1252"):
        try:
            fixed = s.encode(enc).decode("utf-8")
            if fixed and fixed != s:
                return fixed
        except Exception:
            continue
    return s


# ---------------------------------------------------------------------------
# Source: AIbase
# ---------------------------------------------------------------------------
def fetch_aibase(session: requests.Session, now: datetime) -> list[NewsItem]:
    r = session.get("https://www.aibase.com/zh/news", timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    items: list[NewsItem] = []
    for a in soup.select("a[href^='/news/']"):
        h3 = a.select_one("h3")
        if not h3:
            continue
        title = h3.get_text(" ", strip=True)
        href = a.get("href", "").strip()
        if not title or not href:
            continue
        time_text = ""
        time_tag = a.select_one("div.text-sm.text-gray-400 span")
        if time_tag:
            time_text = time_tag.get_text(" ", strip=True)
        published = parse_date_any(time_text, now)
        items.append(NewsItem(
            title=title,
            url=urljoin("https://www.aibase.com", href),
            source="AIbase",
            published_at=fmt_dt(published),
        ))
    return items


# ---------------------------------------------------------------------------
# Source: AI HubToday
# ---------------------------------------------------------------------------
def _is_hubtoday_generic(title: str) -> bool:
    t = (title or "").strip()
    if not t or len(t) < 5:
        return True
    if any(kw in t for kw in ("详情见官方介绍", "原文链接", "查看详情", "点击查看", "详情", "自媒体账号")):
        return True
    return bool(re.search(r"\(AI资讯\)\s*$", t))


def fetch_ai_hubtoday(session: requests.Session, now: datetime) -> list[NewsItem]:
    r = session.get("https://ai.hubtoday.app/", timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    issue_date = None
    text = soup.get_text(" ", strip=True)
    m = re.search(r"AI资讯日报\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})", text)
    if m:
        issue_date = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), tzinfo=UTC)

    items: list[NewsItem] = []
    seen_urls: set[str] = set()

    def add(title: str, href: str, fallback_title: str = "") -> None:
        title = (title or "").strip()
        href = (href or "").strip()
        fallback_title = (fallback_title or "").strip()
        if _is_hubtoday_generic(title) and fallback_title:
            title = fallback_title
        if _is_hubtoday_generic(title) or not href.startswith("http"):
            return
        if "source.hubtoday.app" in href:
            return
        key = normalize_url(href)
        if key in seen_urls:
            return
        seen_urls.add(key)
        items.append(NewsItem(
            title=title,
            url=href,
            source="AI HubToday",
            published_at=fmt_dt(issue_date),
        ))

    for p in soup.select("article .content li p"):
        link = p.select_one("a[href^='http']")
        if not link:
            continue
        strong = p.find("strong")
        add(strong.get_text(" ", strip=True) if strong else "", link.get("href", ""))

    for a in soup.select("article .content a[target='_blank']"):
        fb = ""
        p = a.find_parent("p")
        if p:
            strong = p.find("strong")
            if strong:
                fb = strong.get_text(" ", strip=True)
        add(a.get_text(" ", strip=True), a.get("href", ""), fb)

    for a in soup.select("article a[href^='http']"):
        fb = ""
        p = a.find_parent("p")
        if p:
            strong = p.find("strong")
            if strong:
                fb = strong.get_text(" ", strip=True)
        add(a.get_text(" ", strip=True), a.get("href", ""), fb)

    return items


# ---------------------------------------------------------------------------
# Source: TopHub → Readhub·AI only
# ---------------------------------------------------------------------------
def fetch_tophub_readhub_ai(session: requests.Session, now: datetime) -> list[NewsItem]:
    r = session.get("https://tophub.today/", timeout=30)
    r.raise_for_status()
    html = r.content.decode("utf-8", errors="replace")
    if "�" in html:
        for enc in ("gb18030",):
            try:
                candidate = r.content.decode(enc, errors="replace")
                if candidate.count("�") < html.count("�"):
                    html = candidate
            except Exception:
                continue
    soup = BeautifulSoup(html, "html.parser")

    items: list[NewsItem] = []
    for block in soup.select(".cc-cd"):
        source_tag = block.select_one(".cc-cd-lb span")
        board_tag = block.select_one(".cc-cd-sb-st")
        source_name = maybe_fix_mojibake(source_tag.get_text(" ", strip=True)) if source_tag else ""
        board_name = maybe_fix_mojibake(board_tag.get_text(" ", strip=True)) if board_tag else ""
        label = f"{source_name} · {board_name}" if board_name else source_name

        if "readhub" not in label.lower() or "ai" not in label.lower():
            continue

        for a in block.select(".cc-cd-cb-l a"):
            row = a.select_one(".cc-cd-cb-ll")
            title_tag = row.select_one(".t") if row else None
            title = maybe_fix_mojibake(
                title_tag.get_text(" ", strip=True) if title_tag else a.get_text(" ", strip=True)
            )
            href = a.get("href", "").strip()
            if not title or not href:
                continue
            full_url = href if href.startswith("http") else urljoin("https://tophub.today", href)
            row_text = row.get_text(" ", strip=True) if row else ""
            published = parse_relative_time_zh(row_text, now)
            items.append(NewsItem(
                title=title,
                url=full_url,
                source="Readhub·AI",
                published_at=fmt_dt(published),
            ))
    return items


# ---------------------------------------------------------------------------
# Source: TechURLs → Techmeme + TechCrunch only
# ---------------------------------------------------------------------------
TECHURLS_KEEP = {"techmeme", "techcrunch"}

def fetch_techurls_selected(session: requests.Session, now: datetime) -> list[NewsItem]:
    r = session.get("https://techurls.com/", timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    items: list[NewsItem] = []
    for block in soup.select("div.publisher-block"):
        primary_tag = block.select_one(".publisher-text .primary")
        primary = primary_tag.get_text(strip=True) if primary_tag else block.get("data-publisher", "unknown")
        secondary_tag = block.select_one(".publisher-text .secondary")
        secondary = secondary_tag.get_text(strip=True) if secondary_tag else ""
        source = f"{primary} · {secondary}" if secondary and secondary != primary else primary

        if primary.lower() not in TECHURLS_KEEP:
            continue

        for link_row in block.select("div.publisher-link"):
            a = link_row.select_one("a.article-link")
            if not a or not a.get("href"):
                continue
            title = a.get_text(" ", strip=True)
            url = a["href"].strip()
            time_hint = ""
            aside = link_row.select_one(".aside .text")
            if aside:
                time_hint = aside.get("title", "") or aside.get_text(" ", strip=True)
            published = parse_date_any(time_hint, now)
            items.append(NewsItem(
                title=title,
                url=url,
                source=source,
                published_at=fmt_dt(published),
            ))
    return items


# ---------------------------------------------------------------------------
# Source: 虎嗅 (RSS 直连，带摘要)
# ---------------------------------------------------------------------------
def fetch_huxiu_rss(session: requests.Session, now: datetime) -> list[NewsItem]:
    parsed = feedparser.parse("https://www.huxiu.com/rss/0.xml")
    items: list[NewsItem] = []
    for entry in parsed.entries:
        title = str(entry.get("title", "")).strip()
        url = str(entry.get("link", "")).strip()
        if not title or not url:
            continue
        pub = (
            parse_date_any(entry.get("published"), now)
            or parse_date_any(entry.get("updated"), now)
        )
        summary = html_to_text(entry.get("summary", ""))
        items.append(NewsItem(
            title=title,
            url=url,
            source="虎嗅",
            published_at=fmt_dt(pub),
            summary=summary,
        ))
    return items


# ---------------------------------------------------------------------------
# Source: 36氪 (RSS 直连，带摘要)
# ---------------------------------------------------------------------------
def fetch_36kr_rss(session: requests.Session, now: datetime) -> list[NewsItem]:
    parsed = feedparser.parse("https://36kr.com/feed")
    items: list[NewsItem] = []
    for entry in parsed.entries:
        title = str(entry.get("title", "")).strip()
        url = str(entry.get("link", "")).strip()
        if not title or not url:
            continue
        pub = (
            parse_date_any(entry.get("published"), now)
            or parse_date_any(entry.get("updated"), now)
        )
        summary = html_to_text(entry.get("summary", ""))
        items.append(NewsItem(
            title=title,
            url=url,
            source="36氪",
            published_at=fmt_dt(pub),
            summary=summary,
        ))
    return items


# ---------------------------------------------------------------------------
# Deduplication
# ---------------------------------------------------------------------------
def dedup_items(items: list[NewsItem]) -> list[NewsItem]:
    seen: set[str] = set()
    result: list[NewsItem] = []
    for item in items:
        key = (normalize_url(item.url) + "||" + item.title.strip().lower())
        h = hashlib.sha1(key.encode("utf-8")).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        result.append(item)
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
SOURCES = [
    ("AIbase", fetch_aibase),
    ("AI HubToday", fetch_ai_hubtoday),
    ("Readhub·AI", fetch_tophub_readhub_ai),
    ("TechURLs", fetch_techurls_selected),
    ("虎嗅", fetch_huxiu_rss),
    ("36氪", fetch_36kr_rss),
]


def main():
    parser = argparse.ArgumentParser(description="AI 新闻 + 科技商业精选抓取")
    parser.add_argument("-o", "--output", default=DEFAULT_OUTPUT, help="输出 JSON 路径")
    args = parser.parse_args()

    session = create_session()
    now = datetime.now(UTC)

    all_items: list[NewsItem] = []
    stats: list[dict] = []

    for name, fetcher in SOURCES:
        try:
            t0 = datetime.now(UTC)
            result = fetcher(session, now)
            duration = int((datetime.now(UTC) - t0).total_seconds() * 1000)
            all_items.extend(result)
            stats.append({"source": name, "count": len(result), "duration_ms": duration, "ok": True})
            print(f"  ✓ {name}: {len(result)} 条 ({duration}ms)")
        except Exception as e:
            stats.append({"source": name, "count": 0, "duration_ms": 0, "ok": False, "error": str(e)})
            print(f"  ✗ {name}: {e}", file=sys.stderr)

    deduped = dedup_items(all_items)

    # 24h 时间窗口过滤：丢弃超过 24 小时的旧条目
    cutoff = (now - timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%SZ")
    filtered: list[NewsItem] = []
    dropped = 0
    for item in deduped:
        if item.published_at and item.published_at < cutoff:
            dropped += 1
            continue
        filtered.append(item)
    if dropped:
        print(f"  ⏰ 已过滤 {dropped} 条超过 24h 的旧数据")

    output = {
        "generated_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_raw": len(all_items),
        "total_deduped": len(deduped),
        "total_filtered": len(filtered),
        "stats": stats,
        "items": [asdict(item) for item in filtered],
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"\n共 {len(filtered)} 条（去重 {len(deduped)}，原始 {len(all_items)}）→ {args.output}")


if __name__ == "__main__":
    main()
