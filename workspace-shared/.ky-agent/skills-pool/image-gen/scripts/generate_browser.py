#!/usr/bin/env python3
"""
Gemini Web UI 图片生成脚本
通过 Playwright 控制 Gemini 网站生成图片。

用法：
    python3 generate_browser.py "<prompt>" -o <output_dir> [options]

依赖：
    - playwright-cli（在 PATH 中）
    - curl（系统自带）

流程：
    1. 启动浏览器 -> 打开 gemini.google.com/app
    2. 点击制作图片进入图片生成模式
    3. fill 输入 prompt -> 点击发送
    4. 轮询 snapshot 等待下载按钮出现
    5. 点击下载 -> 等待文件落盘 -> 复制到输出目录
"""

import subprocess
import time
import os
import sys
import shutil
import re
import argparse
import glob


BROWSER_API = "http://localhost:3000/internal/browser"
SESSION_PREFIX = "img-gen"
SESSION_RE = re.compile(r"^[A-Za-z0-9_-]+$")
POLL_INTERVAL = 8
MAX_GENERATION_WAIT = 300
MAX_DOWNLOAD_WAIT = 30

# Button text candidates (tried in order, first match wins)
CREATE_IMAGE_TEXTS = ["制作图片", "生成图片", "Create image", "Generate image"]
SEND_TEXTS = ["发送", "Send", "Submit"]
DOWNLOAD_TEXTS = ["下载完整尺寸的图片", "下载图片", "Download full-size image", "Download image"]
GENERATING_TEXTS = ["停止回答", "Stop generating", "Stop"]


def rand_suffix():
    import random, string
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))


def curl_ensure(username):
    import json
    result = subprocess.run(
        ["curl", "-sf", "-X", "POST", f"{BROWSER_API}/ensure",
         "-H", "Content-Type: application/json",
         "-d", json.dumps({"username": username})],
        capture_output=True, text=True
    )
    return json.loads(result.stdout) if result.returncode == 0 else None


def run_pw(args, session, timeout=30):
    """Execute playwright-cli command, return stdout+stderr."""
    if not SESSION_RE.match(session):
        raise ValueError("Invalid session name")
    cmd = ["playwright-cli", f"-s={session}", *args]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    return result.stdout + result.stderr


def get_snapshot(session, timeout=30):
    """Run snapshot and read actual yml content (not metadata)."""
    output = run_pw(["snapshot"], session, timeout)
    matches = re.findall(r'\[Snapshot\]\((.+?\.yml)\)', output)
    if matches:
        yml_rel = matches[-1]
        workspace = os.environ.get("WORKSPACE_DIR") or os.getcwd()
        yml_path = os.path.join(workspace, yml_rel)
        if os.path.exists(yml_path):
            with open(yml_path, 'r') as f:
                return f.read()
    return output


def find_ref(snapshot_content, text_fragment):
    """Find element ref containing text_fragment.

    Strategy:
    1. If the matched line itself has [ref=eN], return it directly.
    2. Otherwise, walk upward by indentation to find the nearest ancestor with a ref.
       This correctly handles cases like `- text: xxx` child nodes that have no ref.
    """
    lines = snapshot_content.split('\n')
    for i, line in enumerate(lines):
        if text_fragment not in line:
            continue
        # Current line has ref — return directly
        m = re.search(r'\[ref=(e\d+)]', line)
        if m:
            return m.group(1)
        # No ref on this line — walk up by indentation to find parent with ref
        current_indent = len(line) - len(line.lstrip())
        for j in range(i - 1, -1, -1):
            parent_indent = len(lines[j]) - len(lines[j].lstrip())
            if parent_indent < current_indent:
                m = re.search(r'\[ref=(e\d+)]', lines[j])
                if m:
                    return m.group(1)
                # Parent has no ref either, continue climbing with tighter indent
                current_indent = parent_indent
    return None


def find_ref_candidates(snapshot_content, candidates):
    """Try multiple text candidates in order, return the first matching ref."""
    for text in candidates:
        ref = find_ref(snapshot_content, text)
        if ref:
            return ref
    return None


def find_textbox_ref(snapshot_content):
    """Find the first textbox element ref in the snapshot."""
    for line in snapshot_content.split('\n'):
        if 'textbox ' in line:
            m = re.search(r'\[ref=(e\d+)]', line)
            if m:
                return m.group(1)
    return None


def get_latest_download(cli_dir, after_ts):
    """Find Gemini image downloaded after after_ts."""
    pattern = os.path.join(cli_dir, "Gemini-Generated-Image-*")
    files = glob.glob(pattern)
    for f in sorted(files, key=os.path.getmtime, reverse=True):
        if os.path.getmtime(f) > after_ts:
            return f
    return None


def log(session, msg):
    print(f"[{session}] {msg}")


def main():
    parser = argparse.ArgumentParser(description="Gemini Web UI image generation")
    parser.add_argument("prompt", help="Image description prompt")
    parser.add_argument("-o", "--output-dir", required=True, help="Output directory")
    parser.add_argument("--session", help="Session name (auto-generated if omitted)")
    args = parser.parse_args()

    output_dir = args.output_dir
    os.makedirs(output_dir, exist_ok=True)

    session = args.session or f"{SESSION_PREFIX}-{rand_suffix()}"
    if not SESSION_RE.match(session):
        print("Invalid --session. Use letters, numbers, underscore, or hyphen only.", file=sys.stderr)
        sys.exit(2)
    workspace = os.environ.get("WORKSPACE_DIR") or os.getcwd()
    username = os.path.basename(workspace)
    cli_dir = os.path.join(workspace, ".playwright-cli")

    log(session, "Starting image generation...")

    try:
        # 1. Start browser
        log(session, "1. Starting browser...")
        ensure_result = curl_ensure(username)
        if not ensure_result or not ensure_result.get("ok"):
            log(session, "Error: cannot start browser")
            sys.exit(1)

        # 2. Open Gemini
        log(session, "2. Opening Gemini...")
        run_pw(["open"], session)
        run_pw(["goto", "https://gemini.google.com/app"], session)
        time.sleep(4)

        # 3. Click "Create image" button
        log(session, "3. Clicking create image...")
        snap = get_snapshot(session)
        ref = find_ref_candidates(snap, CREATE_IMAGE_TEXTS)
        if not ref:
            log(session, "Error: create image button not found")
            sys.exit(1)
        run_pw(["click", ref], session)
        time.sleep(2)

        # 4. Fill prompt
        log(session, "4. Filling prompt...")
        snap = get_snapshot(session)
        ref = find_textbox_ref(snap)
        if not ref:
            log(session, "Error: textbox not found")
            sys.exit(1)

        run_pw(["fill", ref, args.prompt], session, timeout=60)
        time.sleep(1)

        # 5. Click send
        log(session, "5. Sending...")
        snap = get_snapshot(session)
        ref = find_ref_candidates(snap, SEND_TEXTS)
        if not ref:
            log(session, "Error: send button not found")
            sys.exit(1)
        run_pw(["click", ref], session)

        send_ts = time.time()

        # 6. Poll for generation completion
        log(session, "6. Waiting for image generation...")
        elapsed = 0
        download_ref = None

        while elapsed < MAX_GENERATION_WAIT:
            time.sleep(POLL_INTERVAL)
            elapsed += POLL_INTERVAL

            snap = get_snapshot(session)

            download_ref = find_ref_candidates(snap, DOWNLOAD_TEXTS)
            if download_ref:
                log(session, f"   Generation complete (~{elapsed}s)")
                break

            if any(t in snap for t in GENERATING_TEXTS):
                log(session, f"   Still generating... ({elapsed}s)")
                continue

            if elapsed > 30:
                log(session, f"   Waiting... ({elapsed}s)")

        if not download_ref:
            log(session, "Error: generation timed out")
            sys.exit(1)

        # 7. Click download
        log(session, "7. Downloading image...")
        run_pw(["click", download_ref], session)

        # 8. Wait for file
        downloaded = None
        dl_elapsed = 0
        while dl_elapsed < MAX_DOWNLOAD_WAIT:
            time.sleep(2)
            dl_elapsed += 2
            downloaded = get_latest_download(cli_dir, send_ts)
            if downloaded:
                break

        if not downloaded:
            log(session, "Error: download file not found")
            sys.exit(1)

        # 9. Copy to output
        filename = os.path.basename(downloaded)
        output_path = os.path.join(output_dir, filename)
        shutil.copy2(downloaded, output_path)

        log(session, f"Done: {output_path}")
        print(output_path)

    finally:
        try:
            run_pw(["close"], session)
        except Exception:
            pass


if __name__ == "__main__":
    main()
