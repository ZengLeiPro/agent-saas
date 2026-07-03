#!/usr/bin/env python3
"""镜像构建期自检：Python playwright 期望的 chromium 构建号必须已预装在 PLAYWRIGHT_BROWSERS_PATH。

背景：/ms-playwright 的浏览器二进制由 Node 侧 `playwright install chromium`（版本锁在
pnpm-lock.yaml）预装；sandbox 运行时 venv 里的 Python playwright 版本由
acs-orchestrator/requirements/base.txt 决定。两边 minor 版本不一致时，Python playwright
会到不存在的构建号目录找可执行文件，browser skill 运行时报
"Executable doesn't exist at /ms-playwright/chromium_headless_shell-XXXX/..."。

本脚本在 Dockerfile acs-deps stage 用 wheelhouse 里的 playwright wheel 跑一次，
版本不齐 → 构建直接失败（fail-fast），而不是等到线上 agent 报修。

修复方式：把 base.txt 的 playwright 版本与 pnpm-lock 中 server 的 playwright minor 对齐。
"""

import json
import os
import pathlib
import sys

import playwright


def main() -> int:
    browsers_root = pathlib.Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/ms-playwright"))
    pkg_dir = pathlib.Path(playwright.__file__).parent
    browsers_json = pkg_dir / "driver" / "package" / "browsers.json"
    data = json.loads(browsers_json.read_text())

    # browsers.json 里的 name → 磁盘目录前缀
    required = {
        "chromium": "chromium",
        "chromium-headless-shell": "chromium_headless_shell",
    }

    checked: list[str] = []
    missing: list[str] = []
    for browser in data["browsers"]:
        prefix = required.get(browser["name"])
        if not prefix:
            continue
        expected_dir = browsers_root / f"{prefix}-{browser['revision']}"
        checked.append(f"{browser['name']}={browser['revision']}")
        if not expected_dir.is_dir():
            missing.append(str(expected_dir))

    if len(checked) < len(required):
        print(f"FAIL: browsers.json 中未找到全部必需浏览器条目，仅有: {checked}", file=sys.stderr)
        return 1

    if missing:
        installed = sorted(p.name for p in browsers_root.iterdir()) if browsers_root.is_dir() else []
        print("FAIL: Python playwright 期望的浏览器构建缺失:", file=sys.stderr)
        for path in missing:
            print(f"  缺: {path}", file=sys.stderr)
        print(f"  实际预装: {installed}", file=sys.stderr)
        print(
            "  修复: 将 acs-orchestrator/requirements/base.txt 的 playwright 版本"
            "与 pnpm-lock.yaml 中 server 的 playwright minor 对齐",
            file=sys.stderr,
        )
        return 1

    print(f"OK: playwright(python)={playwright.__file__} 浏览器构建号对齐: {', '.join(checked)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
