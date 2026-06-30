#!/usr/bin/env python3
"""YouTube 播客 RSS 监控 — 检查第一梯队频道的新播客集。

纯 RSS 方案，零外部依赖（仅 stdlib）。
输出 JSON 到 /tmp/youtube-podcasts-latest.json，供 cron agent 消费。

用法：
    python3 fetch.py              # 默认检查最近 48 小时
    python3 fetch.py --hours 72   # 自定义时间窗口
"""

import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

# ─── 第一梯队频道 ───
CHANNELS = [
    {
        "name": "Lex Fridman",
        "handle": "lexfridman",
        "channel_id": "UCSHZKyawb77ixDdsGog4iWA",
        "tags": ["AI", "科技", "哲学", "深度访谈"],
    },
    {
        "name": "Dwarkesh Patel",
        "handle": "DwarkeshPatel",
        "channel_id": "UCXl4i9dYBrFOabk0xGmbkRA",
        "tags": ["AI", "科技", "历史", "深度访谈"],
    },
    {
        "name": "All-In Podcast",
        "handle": "allin",
        "channel_id": "UCESLZhusAkFfsNsApnjF_Cg",
        "tags": ["科技", "风投", "政经"],
    },
    {
        "name": "20VC with Harry Stebbings",
        "handle": "20VC",
        "channel_id": "UCf0PBRjhf0rF8fWBIxTuoWA",
        "tags": ["VC", "SaaS", "创业"],
    },
    {
        "name": "Acquired",
        "handle": "AcquiredFM",
        "channel_id": "UCyFqFYfTW2VoIQKylJ04Rtw",
        "tags": ["商业史", "公司分析"],
    },
    {
        "name": "The Interview (NYT)",
        "handle": "theinterviewpodcast",
        "channel_id": "UCPwWvr4tFnmOLpjzmIbDMgQ",
        "tags": ["人物访谈", "政商文化"],
    },
    {
        "name": "Interesting Times (Ross Douthat)",
        "handle": "InterestingTimesNYT",
        "channel_id": "UCJugC7hlL5uNoii46ICyUvw",
        "tags": ["政治", "文化评论"],
    },
    {
        "name": "Stripe",
        "handle": "Stripe",
        "channel_id": "UCM1guA1E-RHLO2OyfQPOkEQ",
        "tags": ["SaaS", "创业", "风投"],
    },
]

RSS_URL_TEMPLATE = "https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}"
NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "media": "http://search.yahoo.com/mrss/",
    "yt": "http://www.youtube.com/xml/schemas/2015",
}

OUTPUT_PATH = "/tmp/youtube-podcasts-latest.json"


def fetch_rss(channel_id: str) -> str:
    url = RSS_URL_TEMPLATE.format(channel_id=channel_id)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="replace")


def parse_feed(xml_text: str, channel: dict, cutoff: datetime) -> list[dict]:
    """解析 RSS feed，返回 cutoff 之后发布的非 Shorts 视频。"""
    root = ET.fromstring(xml_text)
    entries = root.findall("atom:entry", NS)
    results = []

    for entry in entries:
        # 发布时间
        pub_text = entry.findtext("atom:published", "", NS)
        if not pub_text:
            continue
        pub_dt = datetime.fromisoformat(pub_text.replace("Z", "+00:00"))
        if pub_dt < cutoff:
            continue

        # URL 和 Shorts 过滤
        link_el = entry.find('atom:link[@rel="alternate"]', NS)
        if link_el is None:
            continue
        video_url = link_el.get("href", "")
        if "/shorts/" in video_url:
            continue

        # 基本信息
        video_id = entry.findtext("yt:videoId", "", NS)
        title = entry.findtext("atom:title", "", NS)

        # 描述（来自 media:group/media:description）
        media_group = entry.find("media:group", NS)
        description = ""
        if media_group is not None:
            description = media_group.findtext("media:description", "", NS)

        # 缩略图
        thumbnail = ""
        if media_group is not None:
            thumb_el = media_group.find("media:thumbnail", NS)
            if thumb_el is not None:
                thumbnail = thumb_el.get("url", "")

        results.append(
            {
                "channel_name": channel["name"],
                "channel_handle": channel["handle"],
                "channel_tags": channel["tags"],
                "video_id": video_id,
                "title": title,
                "url": video_url,
                "published": pub_dt.isoformat(),
                "description": description[:500],
                "thumbnail": thumbnail,
            }
        )

    return results


def main():
    hours = 48
    if "--hours" in sys.argv:
        idx = sys.argv.index("--hours")
        if idx + 1 < len(sys.argv):
            hours = int(sys.argv[idx + 1])

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    print(f"检查最近 {hours} 小时内的新视频（cutoff: {cutoff.isoformat()}）")

    all_new = []
    for ch in CHANNELS:
        try:
            xml_text = fetch_rss(ch["channel_id"])
            new_videos = parse_feed(xml_text, ch, cutoff)
            print(f"  {ch['name']:40s} → {len(new_videos)} 条新视频")
            all_new.extend(new_videos)
        except Exception as e:
            print(f"  {ch['name']:40s} → 错误: {e}", file=sys.stderr)

    # 按发布时间倒序
    all_new.sort(key=lambda x: x["published"], reverse=True)

    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(all_new, f, ensure_ascii=False, indent=2)

    print(f"\n共 {len(all_new)} 条新视频，已写入 {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
