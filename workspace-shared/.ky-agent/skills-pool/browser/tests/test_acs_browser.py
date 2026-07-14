from __future__ import annotations

import base64
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).parents[1] / "scripts" / "acs_browser.py"
SPEC = importlib.util.spec_from_file_location("acs_browser", SCRIPT_PATH)
assert SPEC and SPEC.loader
acs_browser = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(acs_browser)


class FakeCdpSession:
    def __init__(self, data: bytes = b"cdp-image", fail: bool = False):
        self.data = data
        self.fail = fail
        self.calls: list[tuple[str, dict | None]] = []
        self.detached = False

    def send(self, method: str, params: dict | None = None) -> dict:
        self.calls.append((method, params))
        if self.fail:
            raise RuntimeError("cdp failed")
        if method == "Page.getLayoutMetrics":
            return {"cssContentSize": {"width": 1280, "height": 2400}}
        if method == "Page.captureScreenshot":
            return {"data": base64.b64encode(self.data).decode("ascii")}
        raise AssertionError(f"unexpected CDP method: {method}")

    def detach(self) -> None:
        self.detached = True


class FakeContext:
    def __init__(self, cdp: FakeCdpSession):
        self.cdp = cdp

    def new_cdp_session(self, page) -> FakeCdpSession:
        return self.cdp


class FakePage:
    def __init__(self, *, screenshot_data: bytes | None, fonts_ready: bool, cdp: FakeCdpSession):
        self.screenshot_data = screenshot_data
        self.fonts_ready = fonts_ready
        self.context = FakeContext(cdp)
        self.evaluate_timeout: int | None = None

    def evaluate(self, expression: str, timeout_ms: int) -> bool:
        self.evaluate_timeout = timeout_ms
        return self.fonts_ready

    def screenshot(self, *, path: str, full_page: bool, timeout: int) -> bytes:
        if self.screenshot_data is None:
            raise RuntimeError("standard screenshot failed")
        Path(path).write_bytes(self.screenshot_data)
        return self.screenshot_data


class AcsBrowserScreenshotTest(unittest.TestCase):
    def test_load_playwright_disables_unbounded_font_wait_before_driver_start(self) -> None:
        sentinel = object()
        fake_package = types.ModuleType("playwright")
        fake_package.__path__ = []
        fake_sync_api = types.ModuleType("playwright.sync_api")
        fake_sync_api.sync_playwright = sentinel
        with patch.dict(
            sys.modules,
            {"playwright": fake_package, "playwright.sync_api": fake_sync_api},
        ), patch.dict(os.environ, {}, clear=False):
            os.environ.pop(acs_browser.PLAYWRIGHT_SKIP_FONT_WAIT_ENV, None)
            self.assertIs(acs_browser.load_playwright(), sentinel)
            self.assertEqual(os.environ[acs_browser.PLAYWRIGHT_SKIP_FONT_WAIT_ENV], "1")

    def test_standard_screenshot_continues_when_fonts_are_still_pending(self) -> None:
        page = FakePage(
            screenshot_data=b"playwright-image",
            fonts_ready=False,
            cdp=FakeCdpSession(),
        )
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "page.png"
            result = acs_browser.capture_screenshot(
                page,
                out,
                timeout_ms=9_000,
                font_wait_ms=321,
            )
            self.assertEqual(out.read_bytes(), b"playwright-image")
        self.assertEqual(result["method"], "playwright")
        self.assertFalse(result["fontsReady"])
        self.assertEqual(page.evaluate_timeout, 321)

    def test_cdp_fallback_writes_full_page_image_after_standard_failure(self) -> None:
        cdp = FakeCdpSession(data=b"fallback-image")
        page = FakePage(screenshot_data=None, fonts_ready=False, cdp=cdp)
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "page.png"
            result = acs_browser.capture_screenshot(page, out, full_page=True)
            self.assertEqual(out.read_bytes(), b"fallback-image")
        self.assertEqual(result["method"], "cdp-fallback")
        self.assertIn("standard screenshot failed", result["playwrightError"])
        capture_call = next(call for call in cdp.calls if call[0] == "Page.captureScreenshot")
        self.assertEqual(
            capture_call[1]["clip"],
            {"x": 0, "y": 0, "width": 1280.0, "height": 2400.0, "scale": 1},
        )
        self.assertTrue(cdp.detached)

    def test_both_capture_paths_fail_with_combined_error(self) -> None:
        page = FakePage(
            screenshot_data=None,
            fonts_ready=False,
            cdp=FakeCdpSession(fail=True),
        )
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(RuntimeError, "Playwright=.*CDP fallback="):
                acs_browser.capture_screenshot(page, Path(tmp) / "page.png")

    def test_cli_defaults_to_bounded_font_grace_period(self) -> None:
        args = acs_browser.build_parser().parse_args(
            ["screenshot", "https://example.com", "--out", "page.png"]
        )
        self.assertEqual(args.font_wait_ms, acs_browser.DEFAULT_FONT_WAIT_MS)
        self.assertEqual(args.timeout_ms, acs_browser.DEFAULT_TIMEOUT_MS)


if __name__ == "__main__":
    unittest.main()
