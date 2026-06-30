#!/usr/bin/env python3
"""
Legacy Gemini Web UI image generation path.

This path used to drive gemini.google.com through the old macOS
playwright-cli + /internal/browser stack. That stack is not part of the ACS
Sandbox runtime contract, so this script intentionally fails fast.
"""

from __future__ import annotations

import sys


def main() -> None:
    print(
        "错误：Gemini Web UI 浏览器生图路径已在 ACS runtime 中禁用。\n"
        "原因：旧实现依赖 playwright-cli 和 localhost:3000/internal/browser，"
        "这不是 ACS Sandbox 的受控能力。\n"
        "请改用默认 GPT-Image-2、Gemini API 或 Seedream API；如需恢复 Web UI，"
        "必须先基于 browser skill 的 ACS-native Python Playwright 重新实现。",
        file=sys.stderr,
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
