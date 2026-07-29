#!/usr/bin/env python3
"""ACS-native browser helper with stable profiles and resumable browser leases."""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import json
import os
import re
import signal
import socket
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from urllib.request import ProxyHandler, build_opener
from zoneinfo import ZoneInfo


DEFAULT_TIMEOUT_MS = 30_000
DEFAULT_FONT_WAIT_MS = 3_000
DEFAULT_VIEWPORT = {"width": 1440, "height": 1000}
DEFAULT_SCREEN = {"width": 1920, "height": 1080}
DEFAULT_DEVICE_SCALE_FACTOR = 1
DEFAULT_LOCALE = "zh-CN"
DEFAULT_TIMEZONE_ID = "Asia/Shanghai"
DEFAULT_COLOR_SCHEME = "light"
DEFAULT_BROWSER_CHANNEL = "chromium"
DEFAULT_LEASE_TTL_SECONDS = 30 * 60
MAX_LEASE_TTL_SECONDS = 4 * 60 * 60
MAX_CDP_SCREENSHOT_DIMENSION = 32_767
PLAYWRIGHT_SKIP_FONT_WAIT_ENV = "PW_TEST_SCREENSHOT_NO_FONTS_READY"
CONTROL_SELECTOR = "a,button,input,textarea,select,[role=button],[role=link]"
BLOCK_TITLE_RE = re.compile(
    r"cloudflare|attention required|access denied|just a moment|captcha|人机验证|访问被拒绝|安全验证",
    re.IGNORECASE,
)
SENSITIVE_TEXT_RE = re.compile(
    r"(?i)(authorization|cookie|set-cookie|token|password|passwd|secret|api[-_]?key)"
    r"(\s*[:=]\s*)([^\s,;]+)"
)


class BrowserRuntime:
    def __init__(
        self,
        *,
        playwright: Any,
        context: Any,
        owns_context: bool,
        lock_handle: Any | None = None,
        browser: Any | None = None,
        profile_id: str = "",
        profile_path: Path | None = None,
        lease_id: str | None = None,
    ) -> None:
        self.playwright = playwright
        self.context = context
        self.owns_context = owns_context
        self.lock_handle = lock_handle
        self.browser = browser
        self.profile_id = profile_id
        self.profile_path = profile_path
        self.lease_id = lease_id


def workspace_root() -> Path:
    raw = os.environ.get("WORKSPACE_DIR") or os.environ.get("ACS_WORKSPACE_PATH") or os.getcwd()
    return Path(raw).resolve()


def runtime_root() -> Path:
    path = workspace_root() / ".ky-agent" / "runtime"
    path.mkdir(parents=True, exist_ok=True)
    return path


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
    """Legacy path sanitizer kept only to reuse profiles created before profile IDs existed."""
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
    cleaned = "".join(ch if ch in allowed else "-" for ch in value.strip())
    return cleaned[:80] or "default"


def stable_identifier(value: str) -> str:
    normalized = value.strip() or "default"
    prefix = re.sub(r"[^A-Za-z0-9_-]+", "-", normalized).strip("-")[:48] or "profile"
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}-{digest}"


def inferred_profile_id(url: str | None) -> str:
    if url:
        hostname = (urlsplit(url).hostname or "").lower().strip(".")
        if hostname:
            return f"site:{hostname}"
    return "public"


def resolve_profile_id(args, url: str | None = None) -> tuple[str, bool]:
    profile_id = getattr(args, "profile_id", None)
    legacy_session = getattr(args, "session", None)
    if profile_id and legacy_session:
        raise ValueError("--profile-id 与已废弃的 --session 不能同时使用")
    if profile_id:
        value = profile_id.strip()
        if not value:
            raise ValueError("--profile-id 不能为空")
        return value, False
    if legacy_session:
        value = legacy_session.strip()
        if not value:
            raise ValueError("--session 不能为空")
        return value, True
    return inferred_profile_id(url), False


def profile_dir(profile_id: str, *, legacy_session: bool = False) -> Path:
    root = runtime_root() / "browser-profiles"
    root.mkdir(parents=True, exist_ok=True)
    if legacy_session:
        legacy = root / safe_session_name(profile_id)
        if legacy.exists():
            legacy.chmod(0o700)
            return legacy
    path = root / stable_identifier(profile_id)
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def downloads_dir() -> Path:
    raw = os.environ.get("DOWNLOAD_DIR") or os.environ.get("XDG_DOWNLOAD_DIR")
    path = Path(raw).expanduser() if raw else workspace_root() / "downloads"
    if not path.is_absolute():
        path = workspace_root() / path
    path.mkdir(parents=True, exist_ok=True)
    return path


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_json_atomic(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def read_json_object(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def acquire_lock(path: Path, description: str, *, blocking: bool = False) -> Any:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+", encoding="utf-8")
    try:
        operation = fcntl.LOCK_EX if blocking else fcntl.LOCK_EX | fcntl.LOCK_NB
        fcntl.flock(handle.fileno(), operation)
    except BlockingIOError as exc:
        handle.close()
        raise RuntimeError(f"{description} 正在被另一个任务使用，请复用现有 lease 或稍后重试") from exc
    return handle


def release_lock(handle: Any | None) -> None:
    if handle is None:
        return
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


def profile_lock_path(profile_path: Path) -> Path:
    return runtime_root() / "browser-locks" / f"{profile_path.name}.lock"


def browser_identity_defaults() -> dict:
    return {
        "channel": DEFAULT_BROWSER_CHANNEL,
        "locale": os.environ.get("ACS_BROWSER_LOCALE", DEFAULT_LOCALE),
        "timezoneId": os.environ.get("ACS_BROWSER_TIMEZONE_ID", DEFAULT_TIMEZONE_ID),
        "viewport": dict(DEFAULT_VIEWPORT),
        "screen": dict(DEFAULT_SCREEN),
        "deviceScaleFactor": DEFAULT_DEVICE_SCALE_FACTOR,
        "colorScheme": DEFAULT_COLOR_SCHEME,
    }


def ensure_profile_metadata(profile_id: str, profile_path: Path) -> dict:
    meta_path = runtime_root() / "browser-profile-meta" / f"{profile_path.name}.json"
    metadata = read_json_object(meta_path)
    if not metadata:
        metadata = {
            "schemaVersion": 1,
            "profileId": profile_id,
            "profileKey": profile_path.name,
            "createdAt": utc_now_iso(),
            "identity": browser_identity_defaults(),
        }
    metadata["lastUsedAt"] = utc_now_iso()
    write_json_atomic(meta_path, metadata)
    return metadata


def load_playwright():
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


def proxy_settings() -> dict | None:
    proxy_url = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
        or ""
    ).strip()
    if not proxy_url:
        return None
    raw_bypass = (os.environ.get("NO_PROXY") or os.environ.get("no_proxy") or "").strip()
    bypass_items = [
        item.strip()
        for item in raw_bypass.split(",")
        if item.strip() and "/" not in item.strip()
    ]
    settings = {"server": proxy_url}
    if bypass_items:
        settings["bypass"] = ",".join(bypass_items)
    return settings


def launch_options(args, metadata: dict, *, remote_debugging_port: int | None = None) -> dict:
    identity = metadata.get("identity") or browser_identity_defaults()
    browser_args = ["--disable-dev-shm-usage"]
    if remote_debugging_port is not None:
        browser_args.extend(
            [
                f"--remote-debugging-port={remote_debugging_port}",
                "--remote-debugging-address=127.0.0.1",
            ]
        )
    proxy = proxy_settings()
    return {
        "headless": not args.headed,
        "channel": identity.get("channel", DEFAULT_BROWSER_CHANNEL),
        "accept_downloads": True,
        "downloads_path": str(downloads_dir()),
        "viewport": identity.get("viewport", DEFAULT_VIEWPORT),
        "screen": identity.get("screen", DEFAULT_SCREEN),
        "device_scale_factor": identity.get("deviceScaleFactor", DEFAULT_DEVICE_SCALE_FACTOR),
        "locale": identity.get("locale", DEFAULT_LOCALE),
        "timezone_id": identity.get("timezoneId", DEFAULT_TIMEZONE_ID),
        "color_scheme": identity.get("colorScheme", DEFAULT_COLOR_SCHEME),
        "args": browser_args,
        **({"proxy": proxy} if proxy else {}),
    }


def validate_headed_mode(args) -> None:
    if args.headed and sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
        raise RuntimeError("当前 ACS Sandbox 没有 DISPLAY，不能使用 --headed；请使用 lease + 截图人工接力")


def open_owned_runtime(args, url: str | None = None, *, remote_debugging_port: int | None = None) -> BrowserRuntime:
    validate_headed_mode(args)
    profile_id, legacy_session = resolve_profile_id(args, url)
    path = profile_dir(profile_id, legacy_session=legacy_session)
    lock_handle = acquire_lock(profile_lock_path(path), f"浏览器 Profile {profile_id}")
    playwright = None
    context = None
    try:
        metadata = ensure_profile_metadata(profile_id, path)
        sync_playwright = load_playwright()
        playwright = sync_playwright().start()
        context = playwright.chromium.launch_persistent_context(
            str(path),
            **launch_options(args, metadata, remote_debugging_port=remote_debugging_port),
        )
        context.set_default_timeout(args.timeout_ms)
        context.set_default_navigation_timeout(args.timeout_ms)
        return BrowserRuntime(
            playwright=playwright,
            context=context,
            owns_context=True,
            lock_handle=lock_handle,
            browser=context.browser,
            profile_id=profile_id,
            profile_path=path,
        )
    except Exception:
        if context is not None:
            try:
                context.close()
            except Exception:
                pass
        if playwright is not None:
            try:
                playwright.stop()
            except Exception:
                pass
        release_lock(lock_handle)
        raise


def close_runtime(runtime: BrowserRuntime) -> None:
    try:
        if runtime.owns_context:
            runtime.context.close()
    finally:
        try:
            runtime.playwright.stop()
        finally:
            release_lock(runtime.lock_handle)


def first_page(context):
    return context.pages[0] if context.pages else context.new_page()


def goto_if_needed(page, url: str | None, timeout_ms: int, wait_until: str) -> dict:
    if not url:
        return {"requestedUrl": None, "status": None}
    response = page.goto(url, wait_until=wait_until, timeout=timeout_ms)
    return {
        "requestedUrl": redact_url(url),
        "status": response.status if response else None,
        "responseUrl": redact_url(response.url) if response else None,
    }


def wait_for_fonts(page, timeout_ms: int) -> bool:
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
    out.parent.mkdir(parents=True, exist_ok=True)
    fonts_ready = wait_for_fonts(page, font_wait_ms)
    try:
        data = page.screenshot(path=str(out), full_page=full_page, timeout=timeout_ms)
        return {"method": "playwright", "fontsReady": fonts_ready, "sizeBytes": len(data)}
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


FRAME_SUMMARY_JS = f"""
() => {{
  const controlSelector = {json.dumps(CONTROL_SELECTOR)};
  const visible = (el) => {{
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
  }};
  const selectorFor = (el) => {{
    const tag = el.tagName.toLowerCase();
    if (el.id) return `#${{CSS.escape(el.id)}}`;
    const aria = el.getAttribute('aria-label');
    if (aria) return `${{tag}}[aria-label="${{aria.replaceAll('"', '\\"')}}"]`;
    const name = el.getAttribute('name');
    if (name) return `${{tag}}[name="${{name.replaceAll('"', '\\"')}}"]`;
    const type = el.getAttribute('type');
    if (type && (tag === 'input' || tag === 'button')) return `${{tag}}[type="${{type}}"]`;
    return tag;
  }};
  const controls = [];
  const visit = (root, shadowPath) => {{
    for (const el of root.querySelectorAll('*')) {{
      if (el.matches(controlSelector) && visible(el) && controls.length < 300) {{
        controls.push({{
          selector: selectorFor(el),
          shadowPath,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          text: (el.innerText || el.value || el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') || '').trim().slice(0, 160),
          href: el.href || '',
          type: el.getAttribute('type') || '',
          name: el.getAttribute('name') || '',
          placeholder: el.getAttribute('placeholder') || ''
        }});
      }}
      if (el.shadowRoot) visit(el.shadowRoot, `${{shadowPath}} > ${{selectorFor(el)}}::shadow`);
    }}
  }};
  visit(document, 'document');
  return {{
    title: document.title,
    text: (document.body ? document.body.innerText : '').slice(0, 20000),
    controls
  }};
}}
"""


def collect_dom_summary(page) -> dict:
    frames: list[dict] = []
    for index, frame in enumerate(page.frames[:50]):
        try:
            value = frame.evaluate(FRAME_SUMMARY_JS)
            controls = value.get("controls") or []
            for control_index, control in enumerate(controls, start=1):
                control["index"] = control_index
                control["href"] = redact_url(control.get("href"))
            frames.append(
                {
                    "index": index,
                    "name": frame.name or "",
                    "url": redact_url(frame.url),
                    "title": value.get("title", ""),
                    "text": value.get("text", ""),
                    "controls": controls,
                }
            )
        except Exception as exc:
            frames.append(
                {
                    "index": index,
                    "name": frame.name or "",
                    "url": redact_url(frame.url),
                    "error": redact_text(str(exc)),
                    "controls": [],
                    "text": "",
                }
            )
    primary = frames[0] if frames else {}
    return {
        "url": redact_url(page.url),
        "title": primary.get("title", ""),
        "text": primary.get("text", ""),
        "controls": primary.get("controls", []),
        "frames": frames,
    }


def write_snapshot(summary: dict, out: Path | None) -> str:
    lines = [f"URL: {summary.get('url', '')}", f"Title: {summary.get('title', '')}"]
    frames = summary.get("frames") or [summary]
    for frame in frames:
        lines.extend(
            [
                "",
                f"Frame [{frame.get('index', 0)}] name={frame.get('name', '')!r} url={frame.get('url', '')}",
            ]
        )
        if frame.get("error"):
            lines.append(f"Frame error: {frame['error']}")
            continue
        lines.append("Interactive elements:")
        for item in frame.get("controls") or []:
            label = item.get("text") or item.get("placeholder") or item.get("name") or item.get("href") or ""
            shadow = f" shadow={item.get('shadowPath')!r}" if item.get("shadowPath") != "document" else ""
            lines.append(
                f"- [{item.get('index')}] {item.get('tag')} selector={item.get('selector')!r}"
                f"{shadow} role={item.get('role')!r} type={item.get('type')!r} text={label!r}"
            )
        lines.extend(["", "Body text:", frame.get("text", "")])
    content = "\n".join(lines).rstrip() + "\n"
    if out:
        out.write_text(content, encoding="utf-8")
    return content


FINGERPRINT_JS = """
async () => {
  const glCanvas = document.createElement('canvas');
  const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
  let webgl = null;
  if (gl) {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    webgl = {
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
    };
  }
  let permission = null;
  try { permission = (await navigator.permissions.query({name: 'notifications'})).state; } catch (_) {}
  let highEntropy = null;
  if (navigator.userAgentData?.getHighEntropyValues) {
    try {
      highEntropy = await navigator.userAgentData.getHighEntropyValues([
        'architecture', 'bitness', 'model', 'platformVersion', 'fullVersionList', 'wow64'
      ]);
    } catch (_) {}
  }
  return {
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver,
    language: navigator.language,
    languages: navigator.languages,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    maxTouchPoints: navigator.maxTouchPoints,
    cookieEnabled: navigator.cookieEnabled,
    pdfViewerEnabled: navigator.pdfViewerEnabled,
    plugins: [...navigator.plugins].map(p => p.name).slice(0, 20),
    mimeTypes: [...navigator.mimeTypes].map(m => m.type).slice(0, 30),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth
    },
    viewport: {width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio},
    colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    chromeRuntimePresent: Boolean(window.chrome?.runtime),
    notificationsPermission: permission,
    userAgentData: navigator.userAgentData ? {
      brands: navigator.userAgentData.brands,
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform,
      highEntropy
    } : null,
    webgl
  };
}
"""


def collect_fingerprint(page) -> dict:
    try:
        return page.evaluate(FINGERPRINT_JS)
    except Exception as exc:
        return {"error": redact_text(str(exc))}


def redact_url(value: str | None) -> str:
    if not value:
        return ""
    try:
        parts = urlsplit(value)
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    except Exception:
        return redact_text(value)


def redact_text(value: str, limit: int = 1000) -> str:
    redacted = SENSITIVE_TEXT_RE.sub(lambda match: f"{match.group(1)}{match.group(2)}[REDACTED]", value)
    return redacted[:limit]


class EventRecorder:
    def __init__(self, context):
        self.network: list[dict] = []
        self.console: list[dict] = []
        self.page_errors: list[str] = []
        self._attached: set[int] = set()
        for page in context.pages:
            self.attach_page(page)
        context.on("page", self.attach_page)

    def attach_page(self, page) -> None:
        page_key = id(page)
        if page_key in self._attached:
            return
        self._attached.add(page_key)
        page.on("response", self._on_response)
        page.on("requestfailed", self._on_request_failed)
        page.on("console", self._on_console)
        page.on("pageerror", lambda error: self.page_errors.append(redact_text(str(error))))

    def _on_response(self, response) -> None:
        if response.status >= 400:
            self.network.append({"kind": "response", "status": response.status, "url": redact_url(response.url)})

    def _on_request_failed(self, request) -> None:
        self.network.append(
            {
                "kind": "requestfailed",
                "url": redact_url(request.url),
                "failure": redact_text(str(request.failure or "")),
            }
        )

    def _on_console(self, message) -> None:
        if message.type in {"warning", "error"}:
            self.console.append({"type": message.type, "text": redact_text(message.text)})

    def as_dict(self) -> dict:
        return {
            "network": self.network[-100:],
            "console": self.console[-100:],
            "pageErrors": self.page_errors[-50:],
        }


def classify_block(status: int | None, title: str, text: str) -> dict:
    signals: list[str] = []
    if status in {401, 403, 429}:
        signals.append(f"http_{status}")
    sample = f"{title}\n{text[:4000]}"
    if BLOCK_TITLE_RE.search(sample):
        signals.append("challenge_content")
    return {"suspected": bool(signals), "signals": signals}


def run_id(args) -> str:
    value = getattr(args, "run_id", None) or f"run-{uuid.uuid4().hex[:12]}"
    return stable_identifier(value)


def failure_artifact_dir(args) -> Path:
    try:
        today = datetime.now(ZoneInfo(DEFAULT_TIMEZONE_ID)).strftime("%Y%m%d")
    except Exception:
        today = datetime.now().strftime("%Y%m%d")
    path = workspace_root() / "assets" / today / "browser" / "failures" / run_id(args)
    path.mkdir(parents=True, exist_ok=True)
    return path


def save_failure_artifacts(
    runtime: BrowserRuntime,
    args,
    page,
    recorder: EventRecorder,
    error: Exception,
) -> Path:
    out_dir = failure_artifact_dir(args)
    payload: dict = {
        "capturedAt": utc_now_iso(),
        "error": redact_text(str(error), 4000),
        "profileId": runtime.profile_id,
        "leaseId": runtime.lease_id,
        "url": redact_url(getattr(page, "url", "")),
        "events": recorder.as_dict(),
    }
    try:
        summary = collect_dom_summary(page)
        write_snapshot(summary, out_dir / "snapshot.txt")
        payload["block"] = classify_block(None, summary.get("title", ""), summary.get("text", ""))
    except Exception as exc:
        payload["snapshotError"] = redact_text(str(exc))
    try:
        payload["screenshot"] = capture_screenshot(
            page,
            out_dir / "screenshot.png",
            full_page=True,
            timeout_ms=min(args.timeout_ms, 10_000),
            font_wait_ms=min(args.font_wait_ms, 1_000),
        )
    except Exception as exc:
        payload["screenshotError"] = redact_text(str(exc))
    payload["fingerprint"] = collect_fingerprint(page)
    write_json_atomic(out_dir / "diagnostics.json", payload)
    return out_dir


def open_runtime(args, url: str | None = None) -> BrowserRuntime:
    if getattr(args, "lease_id", None):
        return connect_lease_runtime(args)
    return open_owned_runtime(args, url)


def execute_page_command(args, action) -> None:
    runtime = open_runtime(args, getattr(args, "url", None))
    page = first_page(runtime.context)
    recorder = EventRecorder(runtime.context)
    try:
        navigation = goto_if_needed(page, getattr(args, "url", None), args.timeout_ms, args.wait_until)
        action(runtime, page, recorder, navigation)
    except Exception as exc:
        artifacts = save_failure_artifacts(runtime, args, page, recorder, exc)
        print(f"浏览器任务失败，诊断材料已保存: {artifacts}", file=sys.stderr)
        raise
    finally:
        close_runtime(runtime)


def command_snapshot(args) -> None:
    def action(_runtime, page, _recorder, _navigation):
        summary = collect_dom_summary(page)
        out = resolve_workspace_path(args.out)
        content = write_snapshot(summary, out)
        print(content if not out else f"snapshot saved: {out}")

    execute_page_command(args, action)


def command_screenshot(args) -> None:
    def action(_runtime, page, _recorder, _navigation):
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

    execute_page_command(args, action)


def command_pdf(args) -> None:
    def action(_runtime, page, _recorder, _navigation):
        out = resolve_workspace_path(args.out, "assets/browser/page.pdf")
        assert out is not None
        page.pdf(path=str(out), print_background=True)
        print(f"pdf saved: {out}")

    execute_page_command(args, action)


def command_eval(args) -> None:
    def action(_runtime, page, _recorder, _navigation):
        result = page.evaluate(args.expression)
        print(json.dumps(result, ensure_ascii=False, indent=2))

    execute_page_command(args, action)


def command_diagnose(args) -> None:
    def action(runtime, page, recorder, navigation):
        summary = collect_dom_summary(page)
        payload = {
            "capturedAt": utc_now_iso(),
            "profileId": runtime.profile_id,
            "leaseId": runtime.lease_id,
            "navigation": navigation,
            "finalUrl": redact_url(page.url),
            "title": summary.get("title", ""),
            "block": classify_block(navigation.get("status"), summary.get("title", ""), summary.get("text", "")),
            "fingerprint": collect_fingerprint(page),
            "frames": [
                {
                    "index": frame.get("index"),
                    "name": frame.get("name"),
                    "url": frame.get("url"),
                    "controls": len(frame.get("controls") or []),
                    **({"error": frame.get("error")} if frame.get("error") else {}),
                }
                for frame in summary.get("frames") or []
            ],
            "events": recorder.as_dict(),
        }
        out = resolve_workspace_path(args.out)
        if out:
            write_json_atomic(out, payload)
            print(f"diagnostics saved: {out}")
        else:
            print(json.dumps(payload, ensure_ascii=False, indent=2))

    execute_page_command(args, action)


def command_run(args) -> None:
    script_path = resolve_workspace_path(args.script)
    if not script_path or not script_path.exists():
        print(f"错误：脚本不存在: {args.script}", file=sys.stderr)
        sys.exit(2)

    def action(runtime, page, recorder, navigation):
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
            "context": runtime.context,
            "workspace": workspace_root(),
            "downloads": downloads_dir(),
            "Path": Path,
            "json": json,
            "screenshot": screenshot,
            "browser_diagnostics": lambda: {
                "navigation": navigation,
                "fingerprint": collect_fingerprint(page),
                "events": recorder.as_dict(),
            },
        }
        exec(compile(script_path.read_text(encoding="utf-8"), str(script_path), "exec"), namespace)

    execute_page_command(args, action)


def lease_dir(lease_id: str) -> Path:
    path = runtime_root() / "browser-leases" / stable_identifier(lease_id)
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def lease_meta_path(lease_id: str) -> Path:
    return lease_dir(lease_id) / "lease.json"


def update_lease_metadata(lease_id: str, updates: dict) -> dict:
    directory = lease_dir(lease_id)
    lock = acquire_lock(
        directory / "metadata.lock",
        f"浏览器 lease {lease_id} 元数据",
        blocking=True,
    )
    try:
        path = directory / "lease.json"
        current = read_json_object(path)
        current.update(updates)
        current["updatedAt"] = utc_now_iso()
        write_json_atomic(path, current)
        return current
    finally:
        release_lock(lock)


def process_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def validate_lease_ttl(value: int) -> int:
    if value < 60 or value > MAX_LEASE_TTL_SECONDS:
        raise ValueError(f"lease TTL 必须在 60~{MAX_LEASE_TTL_SECONDS} 秒之间")
    return value


def lease_expiry(ttl_seconds: int) -> tuple[float, str]:
    epoch = time.time() + validate_lease_ttl(ttl_seconds)
    iso = datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")
    return epoch, iso


def touch_lease(lease_id: str, ttl_seconds: int) -> dict:
    ttl = validate_lease_ttl(ttl_seconds)
    current = read_json_object(lease_meta_path(lease_id))
    max_epoch = float(current.get("maxExpiresAtEpoch") or (time.time() + MAX_LEASE_TTL_SECONDS))
    epoch = min(time.time() + ttl, max_epoch)
    iso = datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")
    return update_lease_metadata(
        lease_id,
        {"expiresAtEpoch": epoch, "expiresAt": iso, "lastTouchedAt": utc_now_iso()},
    )


def available_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_cdp(port: int, timeout_seconds: float) -> bool:
    opener = build_opener(ProxyHandler({}))
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            with opener.open(f"http://127.0.0.1:{port}/json/version", timeout=1) as response:
                if response.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def lease_status_value(lease_id: str) -> dict:
    metadata = read_json_object(lease_meta_path(lease_id))
    if not metadata:
        return {"leaseId": lease_id, "status": "not_found", "alive": False}
    alive = process_alive(metadata.get("pid"))
    status = metadata.get("status", "unknown")
    if status in {"starting", "ready", "stopping"} and not alive:
        status = "stale"
    return {**metadata, "status": status, "alive": alive}


def connect_lease_runtime(args) -> BrowserRuntime:
    lease_id = args.lease_id
    metadata = lease_status_value(lease_id)
    if metadata.get("status") != "ready" or not metadata.get("alive"):
        raise RuntimeError(f"浏览器 lease 不可用: {lease_id} status={metadata.get('status')}")
    if float(metadata.get("expiresAtEpoch") or 0) <= time.time():
        raise RuntimeError(f"浏览器 lease 已过期: {lease_id}")
    action_lock = acquire_lock(lease_dir(lease_id) / "action.lock", f"浏览器 lease {lease_id}")
    playwright = None
    try:
        sync_playwright = load_playwright()
        playwright = sync_playwright().start()
        browser = playwright.chromium.connect_over_cdp(
            f"http://127.0.0.1:{metadata['port']}",
            timeout=args.timeout_ms,
        )
        if not browser.contexts:
            raise RuntimeError(f"浏览器 lease 没有可用 context: {lease_id}")
        context = browser.contexts[0]
        context.set_default_timeout(args.timeout_ms)
        context.set_default_navigation_timeout(args.timeout_ms)
        touch_lease(lease_id, getattr(args, "lease_ttl_seconds", DEFAULT_LEASE_TTL_SECONDS))
        return BrowserRuntime(
            playwright=playwright,
            context=context,
            owns_context=False,
            lock_handle=action_lock,
            browser=browser,
            profile_id=str(metadata.get("profileId") or ""),
            profile_path=Path(metadata["profilePath"]) if metadata.get("profilePath") else None,
            lease_id=lease_id,
        )
    except Exception:
        if playwright is not None:
            try:
                playwright.stop()
            except Exception:
                pass
        release_lock(action_lock)
        raise


def command_lease_serve(args) -> None:
    ttl = validate_lease_ttl(args.lease_ttl_seconds)
    existing = lease_status_value(args.lease_id)
    profile_id, _legacy = resolve_profile_id(args, args.url)
    if existing.get("alive") and existing.get("status") in {"starting", "ready"}:
        if existing.get("profileId") != profile_id:
            raise RuntimeError(
                f"lease {args.lease_id} 已绑定 Profile {existing.get('profileId')}，不能改绑为 {profile_id}"
            )
        metadata = touch_lease(args.lease_id, ttl)
        print(json.dumps({**metadata, "alive": True, "reused": True}, ensure_ascii=False, indent=2))
        return
    if existing.get("alive") and existing.get("status") == "stopping":
        raise RuntimeError(f"lease {args.lease_id} 正在停止，请等待其变为 stopped 后再启动")

    directory = lease_dir(args.lease_id)
    host_lock = acquire_lock(directory / "host.lock", f"浏览器 lease {args.lease_id} host")
    try:
        existing = lease_status_value(args.lease_id)
        if existing.get("alive") and existing.get("status") in {"starting", "ready"}:
            if existing.get("profileId") != profile_id:
                raise RuntimeError(
                    f"lease {args.lease_id} 已绑定 Profile {existing.get('profileId')}，不能改绑为 {profile_id}"
                )
            metadata = touch_lease(args.lease_id, ttl)
            print(json.dumps({**metadata, "alive": True, "reused": True}, ensure_ascii=False, indent=2), flush=True)
            return

        stop_path = directory / "stop.requested"
        if stop_path.exists():
            stop_path.unlink()
        port = available_local_port()
        epoch, iso = lease_expiry(ttl)
        max_epoch, max_iso = lease_expiry(MAX_LEASE_TTL_SECONDS)
        update_lease_metadata(
            args.lease_id,
            {
                "schemaVersion": 1,
                "leaseId": args.lease_id,
                "profileId": profile_id,
                "status": "starting",
                "port": port,
                "createdAt": utc_now_iso(),
                "expiresAtEpoch": epoch,
                "expiresAt": iso,
                "maxExpiresAtEpoch": max_epoch,
                "maxExpiresAt": max_iso,
                "url": redact_url(args.url),
                "error": None,
                "pid": os.getpid(),
                "profilePath": None,
                "browserVersion": None,
                "readyAt": None,
                "lastTouchedAt": None,
                "stopRequestedAt": None,
                "stoppedAt": None,
            },
        )
        args.port = port
        command_lease_host(args)
    finally:
        release_lock(host_lock)


def command_lease_status(args) -> None:
    print(json.dumps(lease_status_value(args.lease_id), ensure_ascii=False, indent=2))


def command_lease_touch(args) -> None:
    status = lease_status_value(args.lease_id)
    if status.get("status") != "ready" or not status.get("alive"):
        raise RuntimeError(f"浏览器 lease 不可续租: {args.lease_id} status={status.get('status')}")
    metadata = touch_lease(args.lease_id, args.lease_ttl_seconds)
    print(json.dumps({**metadata, "alive": True}, ensure_ascii=False, indent=2))


def verified_lease_host_pid(pid: int, lease_id: str) -> bool:
    command_path = Path(f"/proc/{pid}/cmdline")
    if not command_path.exists():
        return False
    try:
        command = command_path.read_bytes().replace(b"\x00", b" ").decode("utf-8", errors="replace")
    except OSError:
        return False
    return "acs_browser.py lease-serve" in command and lease_id in command


def command_lease_stop(args) -> None:
    status = lease_status_value(args.lease_id)
    if status.get("status") == "not_found":
        print(json.dumps(status, ensure_ascii=False, indent=2))
        return
    directory = lease_dir(args.lease_id)
    (directory / "stop.requested").write_text(utc_now_iso() + "\n", encoding="utf-8")
    update_lease_metadata(args.lease_id, {"status": "stopping", "stopRequestedAt": utc_now_iso()})
    pid = status.get("pid")
    deadline = time.time() + 10
    while process_alive(pid) and time.time() < deadline:
        time.sleep(0.2)
    if process_alive(pid) and verified_lease_host_pid(pid, args.lease_id):
        os.kill(pid, signal.SIGTERM)
        deadline = time.time() + 5
        while process_alive(pid) and time.time() < deadline:
            time.sleep(0.2)
    final = lease_status_value(args.lease_id)
    if final.get("alive"):
        raise RuntimeError(f"浏览器 lease 未能停止: {args.lease_id} pid={pid}")
    final = update_lease_metadata(args.lease_id, {"status": "stopped", "stoppedAt": utc_now_iso()})
    print(json.dumps({**final, "alive": False}, ensure_ascii=False, indent=2))


def command_lease_host(args) -> None:
    stop_requested = [False]

    def handle_stop(_signum, _frame):
        stop_requested[0] = True

    signal.signal(signal.SIGTERM, handle_stop)
    signal.signal(signal.SIGINT, handle_stop)
    runtime = None
    outcome = "stopped"
    try:
        runtime = open_owned_runtime(args, args.url, remote_debugging_port=args.port)
        page = first_page(runtime.context)
        if args.url:
            goto_if_needed(page, args.url, args.timeout_ms, args.wait_until)
        if not wait_for_cdp(args.port, 10):
            raise RuntimeError("Chromium 已启动，但 CDP endpoint 未就绪")
        version = runtime.browser.version if runtime.browser else None
        ready = update_lease_metadata(
            args.lease_id,
            {
                "status": "ready",
                "pid": os.getpid(),
                "port": args.port,
                "profileId": runtime.profile_id,
                "profilePath": str(runtime.profile_path),
                "browserVersion": version,
                "readyAt": utc_now_iso(),
                "error": None,
            },
        )
        print(json.dumps({**ready, "alive": True, "reused": False}, ensure_ascii=False, indent=2), flush=True)
        stop_file = lease_dir(args.lease_id) / "stop.requested"
        while not stop_requested[0] and not stop_file.exists():
            metadata = read_json_object(lease_meta_path(args.lease_id))
            if float(metadata.get("expiresAtEpoch") or 0) <= time.time():
                outcome = "expired"
                break
            time.sleep(0.5)
    except Exception as exc:
        outcome = "error"
        update_lease_metadata(args.lease_id, {"status": "error", "error": redact_text(str(exc), 4000)})
        raise
    finally:
        if runtime is not None:
            try:
                close_runtime(runtime)
            except Exception as close_error:
                if outcome != "error":
                    outcome = "error"
                    update_lease_metadata(
                        args.lease_id,
                        {"status": "error", "error": redact_text(str(close_error), 4000)},
                    )
        if outcome != "error":
            update_lease_metadata(
                args.lease_id,
                {"status": outcome, "stoppedAt": utc_now_iso(), "error": None},
            )


def add_common(parser: argparse.ArgumentParser, *, include_lease: bool = True) -> None:
    parser.add_argument("--profile-id", help="稳定浏览器身份；同一站点账号跨任务复用同一值")
    parser.add_argument("--run-id", help="本次执行标识，仅用于诊断材料，不决定登录态")
    parser.add_argument("--session", help=argparse.SUPPRESS)
    if include_lease:
        parser.add_argument("--lease-id", help="连接已启动的 ACS 浏览器 lease")
        parser.add_argument(
            "--lease-ttl-seconds",
            type=int,
            default=DEFAULT_LEASE_TTL_SECONDS,
            help=f"连接 lease 后续租时长，默认 {DEFAULT_LEASE_TTL_SECONDS} 秒",
        )
    parser.add_argument("--headed", action="store_true", help="仅在 ACS 提供 DISPLAY 时可用")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS)
    parser.add_argument(
        "--font-wait-ms",
        type=int,
        default=DEFAULT_FONT_WAIT_MS,
        help="截图前等待网页字体的最长时间；超时仍捕获当前画面",
    )
    parser.add_argument(
        "--wait-until",
        choices=["commit", "domcontentloaded", "load", "networkidle"],
        default="domcontentloaded",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="ACS-native Playwright browser helper")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("snapshot", help="打开 URL 并输出顶层、iframe 与开放 Shadow DOM 摘要")
    add_common(p)
    p.add_argument("url", nargs="?", help="URL；连接 lease 时省略可继续当前页面")
    p.add_argument("--out")
    p.set_defaults(func=command_snapshot)

    p = sub.add_parser("screenshot", help="打开 URL 并截图")
    add_common(p)
    p.add_argument("url", nargs="?", help="URL；连接 lease 时省略可截图当前页面")
    p.add_argument("--out", required=True)
    p.add_argument("--text-out")
    p.add_argument("--full-page", action="store_true")
    p.set_defaults(func=command_screenshot)

    p = sub.add_parser("pdf", help="打开 URL 并导出 PDF")
    add_common(p)
    p.add_argument("url", nargs="?", help="URL；连接 lease 时省略可导出当前页面")
    p.add_argument("--out", required=True)
    p.set_defaults(func=command_pdf)

    p = sub.add_parser("eval", help="打开 URL 并执行 page.evaluate 表达式")
    add_common(p)
    p.add_argument("url", nargs="?", help="URL；连接 lease 时省略可操作当前页面")
    p.add_argument("expression")
    p.set_defaults(func=command_eval)

    p = sub.add_parser("diagnose", help="采集浏览器环境、frame、网络与挑战页诊断")
    add_common(p)
    p.add_argument("url", nargs="?", help="URL；连接 lease 时省略可诊断当前页面")
    p.add_argument("--out")
    p.set_defaults(func=command_diagnose)

    p = sub.add_parser("run", help="执行自定义 Python Playwright 脚本")
    add_common(p)
    p.add_argument("script")
    p.add_argument("--url")
    p.set_defaults(func=command_run)

    p = sub.add_parser("lease-serve", help="在 ACS durable 后台 Shell 中托管浏览器 lease")
    add_common(p, include_lease=False)
    p.add_argument("--lease-id", required=True)
    p.add_argument("--lease-ttl-seconds", type=int, default=DEFAULT_LEASE_TTL_SECONDS)
    p.add_argument("--url")
    p.set_defaults(func=command_lease_serve)

    p = sub.add_parser("lease-status", help="查看浏览器 lease 状态")
    p.add_argument("--lease-id", required=True)
    p.set_defaults(func=command_lease_status)

    p = sub.add_parser("lease-touch", help="续租浏览器 lease")
    p.add_argument("--lease-id", required=True)
    p.add_argument("--lease-ttl-seconds", type=int, default=DEFAULT_LEASE_TTL_SECONDS)
    p.set_defaults(func=command_lease_touch)

    p = sub.add_parser("lease-stop", help="安全停止指定浏览器 lease")
    p.add_argument("--lease-id", required=True)
    p.set_defaults(func=command_lease_stop)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
