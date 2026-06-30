#!/usr/bin/env python3
"""
从 Claude Code 会话文件中提取主 agent 会话的用户消息，生成结构化摘要。

用途：在心跳轮询时运行，让 Agent 了解用户最近在做什么。
安全：自动从 cwd 推断 workspace name，每个用户只能查看自己的会话记录。

用法：
    python3 extract-user-messages.py                    # 提取今天的
    python3 extract-user-messages.py -d 2026-03-03      # 提取指定日期的
    python3 extract-user-messages.py -n 2               # 提取最近 2 天的
    python3 extract-user-messages.py -o /path/out.md    # 指定输出文件
"""

import argparse
import json
import glob
import os
import re
import sys
from datetime import datetime, timedelta, timezone

PROJECTS_DIR = os.path.expanduser("~/.claude/projects")
# 按优先级尝试多种路径模式（不同时期部署的目录结构不同）
WORKSPACE_BASES = [
    "-Users-admin-workspace-",              # 当前: /Users/admin/workspace/{name}
    "-Users-admin-code-agent-workspace-",   # 旧: /Users/admin/code/agent/workspace/{name}
]
WORKSPACE_ROOT = os.path.expanduser("~/workspace")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
CST = timezone(timedelta(hours=8))


def detect_workspace_from_cwd():
    """从 cwd 推断 workspace name（安全：只能查看自己的会话）"""
    cwd = os.getcwd()
    # 期望格式: /Users/admin/workspace/{name} 或其子目录
    if cwd.startswith(WORKSPACE_ROOT + "/"):
        rest = cwd[len(WORKSPACE_ROOT) + 1:]
        name = rest.split("/")[0]
        # 排除 .shared 等非用户目录
        if name and not name.startswith("."):
            return name
    return None


def parse_args():
    p = argparse.ArgumentParser(description="Extract user messages from Claude Code sessions")
    p.add_argument("-d", "--date", help="Target date (YYYY-MM-DD), default today CST")
    p.add_argument("-n", "--days", type=int, default=1, help="Number of days to look back (default 1 = today only)")
    p.add_argument("-o", "--output", help="Output file path (default stdout)")
    return p.parse_args()


def get_target_dates(args):
    """返回需要扫描的日期列表 (CST)"""
    if args.date:
        base = datetime.strptime(args.date, "%Y-%m-%d")
    else:
        base = datetime.now(CST)
    dates = []
    for i in range(args.days):
        d = base - timedelta(days=i)
        dates.append(d.strftime("%Y-%m-%d"))
    return dates


def is_main_session(filename):
    """主会话文件是 UUID 格式，子 agent 文件以 agent- 开头"""
    name = os.path.splitext(filename)[0]
    return bool(UUID_RE.match(name))


def clean_user_text(text):
    """剥离系统注入的内容，只保留用户实际输入"""
    # 剥离 <memory-context>...</memory-context>
    if "<memory-context>" in text:
        parts = text.split("</memory-context>")
        text = parts[-1].strip() if len(parts) > 1 else ""

    # 剥离 <system-reminder>...</system-reminder>
    text = re.sub(r"<system-reminder>.*?</system-reminder>", "", text, flags=re.DOTALL).strip()

    # 剥离 Skill 自动注入的内容（以 "Base directory for this skill:" 开头的整段）
    if text.startswith("Base directory for this skill:"):
        return ""

    # 剥离消息开头的时间戳前缀 [2026/03/04 周一 02:19]（兼容不含星期的旧格式）
    text = re.sub(r"^\[[\d/]+\s+(?:周[一二三四五六日]\s+)?[\d:]+\]\s*", "", text)

    return text


def ts_to_cst(ts_str):
    """ISO timestamp -> CST datetime"""
    if not ts_str:
        return None
    try:
        dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
        return dt.astimezone(CST)
    except Exception:
        return None


def extract_session(filepath):
    """从一个 jsonl 文件中提取用户消息"""
    messages = []
    meta = {}

    # 读 meta
    sid = os.path.splitext(os.path.basename(filepath))[0]
    meta_path = os.path.join(os.path.dirname(filepath), sid + ".meta.json")
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
        except Exception:
            pass

    with open(filepath) as f:
        for line in f:
            try:
                obj = json.loads(line)
            except Exception:
                continue

            if obj.get("type") != "user":
                continue

            ts = obj.get("timestamp", "")
            content = obj.get("message", {}).get("content", [])
            texts = []
            # 兼容 content 既可能是 str（整段文本一次性写入），也可能是 list[dict|str]（分块）。
            # 之前对 str 直接 for c in content 会逐字符迭代，每字符长度=1 被 len>5 全部过滤，
            # 导致整个会话被判为"无用户主动会话"（实测 04-27 的 b03121bf 31 条消息全清零）。
            if isinstance(content, str):
                cleaned = clean_user_text(content)
                if cleaned and len(cleaned) > 5:
                    texts.append(cleaned)
            else:
                for c in content:
                    if isinstance(c, dict) and c.get("type") == "text":
                        cleaned = clean_user_text(c["text"])
                        if cleaned and len(cleaned) > 5:
                            texts.append(cleaned)
                    elif isinstance(c, str):
                        cleaned = clean_user_text(c)
                        if cleaned and len(cleaned) > 5:
                            texts.append(cleaned)

            if texts:
                messages.append({
                    "timestamp": ts,
                    "cst": ts_to_cst(ts),
                    "text": "\n".join(texts),
                    "msg_index": len(messages),  # 在原始会话中的序号
                })

    return {
        "session_id": sid[:8],
        "channel": meta.get("channel", "unknown"),
        "messages": messages,
    }


def format_output(sessions_by_date):
    """生成结构化 Markdown 输出"""
    lines = []

    for date, sessions in sorted(sessions_by_date.items(), reverse=True):
        lines.append(f"# 用户活动摘要 — {date}\n")

        web_sessions = [s for s in sessions if s["channel"] == "web"]

        # cron 会话中，跳过首条消息（自动化 prompt），保留后续人类追加的消息
        cron_followup_sessions = []
        for s in sessions:
            if s["channel"] != "cron":
                continue
            followup_msgs = [m for m in s["messages"] if m.get("msg_index", 0) > 0]
            if followup_msgs:
                cron_followup_sessions.append({
                    "session_id": s["session_id"],
                    "channel": "cron",
                    "messages": followup_msgs,
                })

        if not web_sessions and not cron_followup_sessions:
            lines.append("> 当日无用户主动会话。\n")
            continue

        session_groups = [("web", "主动会话", web_sessions),
                          ("cron", "Cron 会话追加交互", cron_followup_sessions)]

        for channel, label, channel_sessions in session_groups:
            if not channel_sessions:
                continue

            lines.append(f"## {label} ({len(channel_sessions)} sessions)\n")

            for s in sorted(channel_sessions, key=lambda x: x["messages"][0]["timestamp"] if x["messages"] else ""):
                # 用第一条消息的时间作为 session 时间标记
                first_ts = s["messages"][0]["cst"]
                time_label = first_ts.strftime("%H:%M") if first_ts else "??:??"
                lines.append(f"### [{time_label}] session {s['session_id']}\n")

                for msg in s["messages"]:
                    t = msg["cst"]
                    time_str = t.strftime("%H:%M") if t else "??:??"
                    text = msg["text"]
                    # 截断过长的消息（保留前 800 字符）
                    if len(text) > 800:
                        text = text[:800] + " [...]"
                    # 缩进多行
                    text_lines = text.split("\n")
                    formatted = text_lines[0]
                    if len(text_lines) > 1:
                        formatted += "\n" + "\n".join("  " + l for l in text_lines[1:])
                    lines.append(f"- **{time_str}** {formatted}\n")

        lines.append("---\n")

    return "\n".join(lines)


def main():
    args = parse_args()
    target_dates = get_target_dates(args)

    # 从 cwd 自动推断 workspace name（安全隔离：只能查看自己的会话）
    workspace = detect_workspace_from_cwd()
    if not workspace:
        print(f"Error: 无法从当前目录推断 workspace name。", file=sys.stderr)
        print(f"请在用户 workspace 目录下运行此脚本（如 /Users/admin/workspace/huangyp/）。", file=sys.stderr)
        print(f"当前目录: {os.getcwd()}", file=sys.stderr)
        return

    # 尝试多种路径模式找到项目目录
    project_dir = None
    for base in WORKSPACE_BASES:
        candidate = os.path.join(PROJECTS_DIR, base + workspace)
        if os.path.isdir(candidate):
            project_dir = candidate
            break
    if not project_dir:
        tried = [base + workspace for base in WORKSPACE_BASES]
        print(f"Error: project dir not found for workspace '{workspace}'. Tried: {', '.join(tried)}")
        return

    # 权限检测：尝试列出目录内容，sandbox 可能允许 stat 但拒绝 readdir
    try:
        dir_entries = os.listdir(project_dir)
    except PermissionError:
        print(f"Error: 无权读取 {project_dir}（sandbox 限制）。", file=sys.stderr)
        print(f"需要在 sandbox allowRead 中添加此路径。", file=sys.stderr)
        return

    if not dir_entries:
        print(f"# 用户活动摘要\n\n> 项目目录为空: {project_dir}\n")
        return

    # 计算文件 mtime 过滤范围 (UTC)
    earliest_date = min(target_dates)
    earliest_dt = datetime.strptime(earliest_date, "%Y-%m-%d").replace(tzinfo=CST)
    earliest_utc = earliest_dt.astimezone(timezone.utc).timestamp()

    sessions_by_date = {d: [] for d in target_dates}

    for fpath in glob.glob(os.path.join(project_dir, "*.jsonl")):
        fname = os.path.basename(fpath)
        sid = os.path.splitext(fname)[0]

        # 只看主会话
        if not is_main_session(sid):
            continue

        # 只看目标日期范围内修改过的文件
        if os.path.getmtime(fpath) < earliest_utc:
            continue

        # 跳过空文件
        if os.path.getsize(fpath) < 50:
            continue

        session = extract_session(fpath)
        if not session["messages"]:
            continue

        # 按消息时间归入对应日期
        # 一个跨午夜的 session 可能需要同时出现在多个日期中
        added_dates = set()
        for msg in session["messages"]:
            if msg["cst"]:
                msg_date = msg["cst"].strftime("%Y-%m-%d")
                if msg_date in sessions_by_date and msg_date not in added_dates:
                    existing_ids = [s["session_id"] for s in sessions_by_date[msg_date]]
                    if session["session_id"] not in existing_ids:
                        # 为跨日期的 session 创建按日期过滤的副本
                        filtered = {
                            "session_id": session["session_id"],
                            "channel": session["channel"],
                            "messages": [m for m in session["messages"]
                                         if m["cst"] and m["cst"].strftime("%Y-%m-%d") == msg_date],
                        }
                        if filtered["messages"]:
                            sessions_by_date[msg_date].append(filtered)
                    added_dates.add(msg_date)

    # 移除空日期
    sessions_by_date = {d: ss for d, ss in sessions_by_date.items() if ss}

    # 全局去重：跨 session 的相同消息内容只保留第一次出现
    seen_texts = set()
    for date in sessions_by_date:
        for session in sessions_by_date[date]:
            deduped = []
            for msg in session["messages"]:
                # 用前200字符作为去重 key
                key = msg["text"][:200]
                if key not in seen_texts:
                    seen_texts.add(key)
                    deduped.append(msg)
            session["messages"] = deduped
        # 移除消息被清空的 session
        sessions_by_date[date] = [s for s in sessions_by_date[date] if s["messages"]]

    # 再次清理空日期
    sessions_by_date = {d: ss for d, ss in sessions_by_date.items() if ss}

    if not sessions_by_date:
        output = f"# 用户活动摘要\n\n> 目标日期 {', '.join(target_dates)} 无用户活动记录。\n"
    else:
        output = format_output(sessions_by_date)

    if args.output:
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        with open(args.output, "w") as f:
            f.write(output)
        print(f"Written to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
