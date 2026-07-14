#!/usr/bin/env python3
"""
ACS-native browser helper.

This helper uses Python Playwright inside the current sandbox. It does not call
the legacy host-side /internal/browser API and does not depend on playwright-cli.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path


DEFAULT_TIMEOUT_MS = 30_000
DEFAULT_FONT_WAIT_MS = 3_000
DEFAULT_VIEWPORT = {"width": 1440, "height": 1000}
MAX_CDP_SCREENSHOT_DIMENSION = 32_767
PLAYWRIGHT_SKIP_FONT_WAIT_ENV = "PW_TEST_SCREENSHOT_NO_FONTS_READY"


def workspace_root() -> Path:
    raw = os.environ.get("WORKSPACE_DIR") or os.environ.get("ACS_WORKSPACE_PATH") or os.getcwd()
    return Path(raw).resolve()


def resolve_workspace_path(raw: str | None, default: str | None = None) -> Path | None:
    value = raw or default
    if not value:
        return None
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = workspace_root() / path
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def safe_session_name(value: str) -> str:
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
    cleaned = "".join(ch if ch in allowed else "-" for ch in value.strip())
    return cleaned[:80] or "default"


def profile_dir(session: str) -> Path:
    path = workspace_root() / ".ky-agent" / "runtime" / "browser-profiles" / safe_session_name(session)
    path.mkdir(parents=True, exist_ok=True)
    return path


def downloads_dir() -> Path:
    raw = os.environ.get("DOWNLOAD_DIR") or os.environ.get("XDG_DOWNLOAD_DIR")
    path = Path(raw).expanduser() if raw else workspace_root() / "downloads"
    if not path.is_absolute():
        path = workspace_root() / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def load_playwright():
    # Playwright otherwise waits on document.fonts.ready for every page and
    # locator screenshot. A single permanently pending webfont can block the
    # screenshot until the whole action times out. Keep a short, bounded grace
    # period in capture_screenshot(), but never let fonts make screenshots fail.
    os.environ[PLAYWRIGHT_SKIP_FONT_WAIT_ENV] = "1"
    try:
        from playwright.sync_api import sync_playwright
    except Exception as exc:  # pragma: no cover - depends on runtime image
        print(
            "错误：当前 ACS runtime 缺少 Python Playwright。请修复 sandbox 镜像或 "
            "workspace runtime venv，不要在普通任务里全局安装依赖。\n"
            f"原始错误: {exc}",
            file=sys.stderr,
        )
        sys.exit(2)
    return sync_playwright


def open_context(args):
    sync_playwright = load_playwright()
    playwright = sync_playwright().start()
    context = playwright.chromium.launch_persistent_context(
        str(profile_dir(args.session)),
        headless=not args.headed,
        accept_downloads=True,
        downloads_path=str(downloads_dir()),
        viewport=DEFAULT_VIEWPORT,
        args=["--disable-dev-shm-usage"],
    )
    context.set_default_timeout(args.timeout_ms)
    context.set_default_navigation_timeout(args.timeout_ms)
    return playwright, context


def close_context(playwright, context) -> None:
    try:
        context.close()
    finally:
        playwright.stop()


def first_page(context):
    return context.pages[0] if context.pages else context.new_page()


def goto_if_needed(page, url: str | None, timeout_ms: int, wait_until: str) -> None:
    if not url:
        return
    page.goto(url, wait_until=wait_until, timeout=timeout_ms)


def wait_for_fonts(page, timeout_ms: int) -> bool:
    """Give webfonts a bounded grace period without making screenshots depend on them."""
    if timeout_ms <= 0:
        return False
    try:
        return bool(
            page.evaluate(
                """
                async (timeoutMs) => {
                  if (!document.fonts || document.fonts.status === "loaded") return true;
                  return await Promise.race([
                    document.fonts.ready.then(() => true, () => false),
                    new Promise(resolve => setTimeout(() => resolve(false), timeoutMs)),
                  ]);
                }
                """,
                timeout_ms,
            )
        )
    except Exception:
        return False


def _cdp_screenshot(page, out: Path, full_page: bool) -> bytes:
    """Capture the current Chromium surface without Playwright's preparation pipeline."""
    client = page.context.new_cdp_session(page)
    try:
        file_type = "jpeg" if out.suffix.lower() in {".jpg", ".jpeg"} else "png"
        params: dict = {
            "format": file_type,
            "captureBeyondViewport": full_page,
            "fromSurface": True,
        }
        if file_type == "jpeg":
            params["quality"] = 90
        if full_page:
            metrics = client.send("Page.getLayoutMetrics")
            content_size = metrics.get("cssContentSize") or metrics.get("contentSize") or {}
            width = min(
                MAX_CDP_SCREENSHOT_DIMENSION,
                max(1, float(content_size.get("width", DEFAULT_VIEWPORT["width"]))),
            )
            height = min(
                MAX_CDP_SCREENSHOT_DIMENSION,
                max(1, float(content_size.get("height", DEFAULT_VIEWPORT["height"]))),
            )
            params["clip"] = {"x": 0, "y": 0, "width": width, "height": height, "scale": 1}
        result = client.send("Page.captureScreenshot", params)
        data = base64.b64decode(result["data"])
        out.write_bytes(data)
        return data
    finally:
        try:
            client.detach()
        except Exception:
            pass


def capture_screenshot(
    page,
    out: Path,
    *,
    full_page: bool = False,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    font_wait_ms: int = DEFAULT_FONT_WAIT_MS,
) -> dict:
    """Take a screenshot without allowing webfonts to become a hard dependency."""
    out.parent.mkdir(parents=True, exist_ok=True)
    fonts_ready = wait_for_fonts(page, font_wait_ms)
    try:
        data = page.screenshot(path=str(out), full_page=full_page, timeout=timeout_ms)
        return {
            "method": "playwright",
            "fontsReady": fonts_ready,
            "sizeBytes": len(data),
        }
    except Exception as playwright_error:
        try:
            data = _cdp_screenshot(page, out, full_page)
        except Exception as cdp_error:
            raise RuntimeError(
                f"截图失败：Playwright={playwright_error}; CDP fallback={cdp_error}"
            ) from cdp_error
        return {
            "method": "cdp-fallback",
            "fontsReady": fonts_ready,
            "sizeBytes": len(data),
            "playwrightError": str(playwright_error),
        }


def collect_dom_summary(page) -> dict:
    return page.evaluate(
        """
        () => {
          const text = document.body ? document.body.innerText : "";
          const selectorFor = (el) => {
            const tag = el.tagName.toLowerCase();
            if (el.id) return `#${CSS.escape(el.id)}`;
            const aria = el.getAttribute("aria-label");
            if (aria) return `${tag}[aria-label="${aria.replaceAll('"', '\\"')}"]`;
            const name = el.getAttribute("name");
            if (name) return `${tag}[name="${name.replaceAll('"', '\\"')}"]`;
            const type = el.getAttribute("type");
            if (type && (tag === "input" || tag === "button")) {
              return `${tag}[type="${type.replaceAll('"', '\\"')}"]`;
            }
            return tag;
          };
          const controls = Array.from(document.querySelectorAll(
            "a,button,input,textarea,select,[role=button],[role=link]"
          )).slice(0, 200).map((el, index) => ({
            index: index + 1,
            selector: selectorFor(el),
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute("role") || "",
            text: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "").trim().slice(0, 160),
            href: el.href || "",
            type: el.getAttribute("type") || "",
            name: el.getAttribute("name") || "",
            placeholder: el.getAttribute("placeholder") || ""
          }));
          return {
            url: location.href,
            title: document.title,
            text: text.slice(0, 20000),
            controls
          };
        }
        """
    )


def write_snapshot(summary: dict, out: Path | None) -> str:
    controls = summary.get("controls") or []
    lines = [
        f"URL: {summary.get('url', '')}",
        f"Title: {summary.get('title', '')}",
        "",
        "Interactive elements:",
    ]
    for item in controls:
        label = item.get("text") or item.get("placeholder") or item.get("name") or item.get("href") or ""
        lines.append(
            f"- [{item.get('index')}] {item.get('tag')} selector={item.get('selector')!r} "
            f"role={item.get('role')!r} type={item.get('type')!r} text={label!r}"
        )
    lines.extend(["", "Body text:", summary.get("text", "")])
    content = "\n".join(lines).rstrip() + "\n"
    if out:
        out.write_text(content, encoding="utf-8")
    return content


def command_snapshot(args) -> None:
    playwright, context = open_context(args)
    try:
        page = first_page(context)
        goto_if_needed(page, args.url, args.timeout_ms, args.wait_until)
        summary = collect_dom_summary(page)
        content = write_snapshot(summary, resolve_workspace_path(args.out))
        print(content if not args.out else f"snapshot saved: {resolve_workspace_path(args.out)}")
    finally:
        close_context(playwright, context)


def command_screenshot(args) -> None:
    playwright, context = open_context(args)
    try:
        page = first_page(context)
        goto_if_needed(page, args.url, args.timeout_ms, args.wait_until)
        out = resolve_workspace_path(args.out, "assets/browser/screenshot.png")
        assert out is not None
        result = capture_screenshot(
            page,
            out,
            full_page=args.full_page,
            timeout_ms=args.timeout_ms,
            font_wait_ms=args.font_wait_ms,
        )
        if args.text_out:
            write_snapshot(collect_dom_summary(page), resolve_workspace_path(args.text_out))
        print(
            f"screenshot saved: {out} method={result['method']} "
            f"fontsReady={str(result['fontsReady']).lower()} size={result['sizeBytes']}"
        )
    finally:
        close_context(playwright, context)


def command_pdf(args) -> None:
    playwright, context = open_context(args)
    try:
        page = first_page(context)
        goto_if_needed(page, args.url, args.timeout_ms, args.wait_until)
        out = resolve_workspace_path(args.out, "assets/browser/page.pdf")
        assert out is not None
        page.pdf(path=str(out), print_background=True)
        print(f"pdf saved: {out}")
    finally:
        close_context(playwright, context)


def command_eval(args) -> None:
    playwright, context = open_context(args)
    try:
        page = first_page(context)
        goto_if_needed(page, args.url, args.timeout_ms, args.wait_until)
        result = page.evaluate(args.expression)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    finally:
        close_context(playwright, context)


def command_run(args) -> None:
    script_path = resolve_workspace_path(args.script)
    if not script_path or not script_path.exists():
        print(f"错误：脚本不存在: {args.script}", file=sys.stderr)
        sys.exit(2)
    playwright, context = open_context(args)
    try:
        page = first_page(context)
        goto_if_needed(page, args.url, args.timeout_ms, args.wait_until)

        def screenshot(
            path: str,
            *,
            full_page: bool = False,
            timeout_ms: int | None = None,
            font_wait_ms: int | None = None,
        ) -> dict:
            out = resolve_workspace_path(path)
            if out is None:
                raise ValueError("截图输出路径不能为空")
            return capture_screenshot(
                page,
                out,
                full_page=full_page,
                timeout_ms=timeout_ms if timeout_ms is not None else args.timeout_ms,
                font_wait_ms=font_wait_ms if font_wait_ms is not None else args.font_wait_ms,
            )

        namespace = {
            "__name__": "__acs_browser_task__",
            "page": page,
            "context": context,
            "workspace": workspace_root(),
            "downloads": downloads_dir(),
            "Path": Path,
            "json": json,
            "screenshot": screenshot,
        }
        exec(compile(script_path.read_text(encoding="utf-8"), str(script_path), "exec"), namespace)
    finally:
        close_context(playwright, context)


def add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--session", default="default", help="持久浏览器 profile 名称，默认 default")
    parser.add_argument("--headed", action="store_true", help="有显示服务时可用；ACS 默认应使用无头模式")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument(
        "--font-wait-ms",
        type=int,
        default=DEFAULT_FONT_WAIT_MS,
        help="截图前等待网页字体的最长时间；超时仍会捕获当前画面，默认 3000ms",
    )
    parser.add_argument(
        "--wait-until",
        choices=["commit", "domcontentloaded", "load", "networkidle"],
        default="domcontentloaded",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ACS-native Playwright browser helper")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("snapshot", help="打开 URL 并输出文本/交互元素摘要")
    add_common(p)
    p.add_argument("url")
    p.add_argument("--out", help="保存 snapshot 文本的路径")
    p.set_defaults(func=command_snapshot)

    p = sub.add_parser("screenshot", help="打开 URL 并截图")
    add_common(p)
    p.add_argument("url")
    p.add_argument("--out", required=True)
    p.add_argument("--text-out", help="同时保存文本 snapshot")
    p.add_argument("--full-page", action="store_true")
    p.set_defaults(func=command_screenshot)

    p = sub.add_parser("pdf", help="打开 URL 并导出 PDF")
    add_common(p)
    p.add_argument("url")
    p.add_argument("--out", required=True)
    p.set_defaults(func=command_pdf)

    p = sub.add_parser("eval", help="打开 URL 并执行 page.evaluate 表达式")
    add_common(p)
    p.add_argument("url")
    p.add_argument("expression")
    p.set_defaults(func=command_eval)

    p = sub.add_parser("run", help="执行自定义 Python Playwright 脚本")
    add_common(p)
    p.add_argument("script")
    p.add_argument("--url", help="脚本执行前先打开的 URL")
    p.set_defaults(func=command_run)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
