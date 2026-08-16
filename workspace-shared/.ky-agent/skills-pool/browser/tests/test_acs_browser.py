from __future__ import annotations

import base64
import importlib.util
import io
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
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


class AcsBrowserRuntimeTest(unittest.TestCase):
    def test_reexec_requirement_tracks_dedicated_interpreter_availability_and_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "browser-python"
            current = Path(tmp) / "workspace-python"
            self.assertFalse(
                acs_browser.browser_runtime_reexec_required(
                    runtime_python=target,
                    current_executable=str(current),
                )
            )
            target.write_text("", encoding="utf-8")
            current.write_text("", encoding="utf-8")
            self.assertTrue(
                acs_browser.browser_runtime_reexec_required(
                    runtime_python=target,
                    current_executable=str(current),
                )
            )
            self.assertFalse(
                acs_browser.browser_runtime_reexec_required(
                    runtime_python=target,
                    current_executable=str(target),
                )
            )

    def test_reexec_preserves_script_arguments_and_environment(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "browser-python"
            current = Path(tmp) / "workspace-python"
            target.write_text("", encoding="utf-8")
            current.write_text("", encoding="utf-8")
            with patch.object(acs_browser, "BROWSER_RUNTIME_PYTHON", target), patch.object(
                sys, "executable", str(current)
            ), patch.object(
                sys,
                "argv",
                [str(SCRIPT_PATH), "snapshot", "https://example.com"],
            ), patch.object(acs_browser.os, "execve") as execve:
                self.assertTrue(acs_browser.reexec_browser_runtime_if_needed())
            executable, argv, environment = execve.call_args.args
            self.assertEqual(executable, str(target))
            self.assertEqual(
                argv,
                [str(target), str(SCRIPT_PATH.resolve()), "snapshot", "https://example.com"],
            )
            self.assertEqual(environment, os.environ)

    def test_load_playwright_raises_domain_error_when_dependency_is_missing(self) -> None:
        with patch.dict(sys.modules, {"playwright": None, "playwright.sync_api": None}):
            with self.assertRaises(acs_browser.BrowserDependencyError) as caught:
                acs_browser.load_playwright()
        self.assertIsInstance(caught.exception.__cause__, ModuleNotFoundError)
        self.assertIn("缺少 Python Playwright", str(caught.exception))

    def test_main_preserves_dependency_failure_exit_code_without_traceback(self) -> None:
        args = SimpleNamespace(func=lambda _args: (_ for _ in ()).throw(
            acs_browser.BrowserDependencyError("缺少 Python Playwright")
        ))
        parser = SimpleNamespace(parse_args=lambda: args)
        with patch.object(acs_browser, "reexec_browser_runtime_if_needed", return_value=False), patch.object(
            acs_browser, "build_parser", return_value=parser
        ), patch("sys.stderr", new_callable=io.StringIO) as stderr:
            with self.assertRaises(SystemExit) as caught:
                acs_browser.main()
        self.assertEqual(caught.exception.code, 2)
        self.assertIn("缺少 Python Playwright", stderr.getvalue())


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


class FakeLaunchContext:
    def __init__(self):
        self.browser = SimpleNamespace(version="145.0")
        self.default_timeout = None
        self.default_navigation_timeout = None
        self.closed = False

    def set_default_timeout(self, value):
        self.default_timeout = value

    def set_default_navigation_timeout(self, value):
        self.default_navigation_timeout = value

    def close(self):
        self.closed = True


class FakeChromium:
    def __init__(self):
        self.calls = []
        self.context = FakeLaunchContext()

    def launch_persistent_context(self, path, **options):
        self.calls.append((path, options))
        return self.context


class FakePlaywright:
    def __init__(self):
        self.chromium = FakeChromium()
        self.stopped = False

    def stop(self):
        self.stopped = True


class FakeSyncPlaywright:
    def __init__(self):
        self.instance = FakePlaywright()

    def start(self):
        return self.instance


class AcsBrowserIdentityTest(unittest.TestCase):
    def test_stable_identifier_avoids_sanitizer_collisions(self) -> None:
        self.assertNotEqual(
            acs_browser.stable_identifier("account/a"),
            acs_browser.stable_identifier("account-a"),
        )
        self.assertEqual(
            acs_browser.stable_identifier("account/a"),
            acs_browser.stable_identifier("account/a"),
        )

    def test_profile_id_is_inferred_from_origin_when_not_explicit(self) -> None:
        args = SimpleNamespace(profile_id=None, session=None)
        self.assertEqual(
            acs_browser.resolve_profile_id(args, "https://Portal.Example.com/login?token=x"),
            ("site:portal.example.com", False),
        )

    def test_profile_and_run_ids_are_separate_cli_concepts(self) -> None:
        args = acs_browser.build_parser().parse_args(
            [
                "snapshot",
                "https://example.com",
                "--profile-id",
                "vendor-main",
                "--run-id",
                "invoice-20260730",
            ]
        )
        self.assertEqual(args.profile_id, "vendor-main")
        self.assertEqual(args.run_id, "invoice-20260730")
        self.assertIsNone(args.session)

    def test_existing_legacy_session_directory_is_reused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"WORKSPACE_DIR": tmp}, clear=False
        ):
            legacy = Path(tmp) / ".ky-agent" / "runtime" / "browser-profiles" / "old-session"
            legacy.mkdir(parents=True)
            resolved = acs_browser.profile_dir("old-session", legacy_session=True)
            self.assertEqual(resolved, legacy.resolve())

    def test_profile_identity_is_frozen_after_first_creation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ,
            {
                "WORKSPACE_DIR": tmp,
                "ACS_BROWSER_LOCALE": "zh-CN",
                "ACS_BROWSER_TIMEZONE_ID": "Asia/Shanghai",
            },
            clear=False,
        ):
            profile = acs_browser.profile_dir("vendor-main")
            first = acs_browser.ensure_profile_metadata("vendor-main", profile)
            os.environ["ACS_BROWSER_LOCALE"] = "en-US"
            second = acs_browser.ensure_profile_metadata("vendor-main", profile)
            self.assertEqual(first["identity"]["locale"], "zh-CN")
            self.assertEqual(second["identity"]["locale"], "zh-CN")
            self.assertEqual(second["identity"]["timezoneId"], "Asia/Shanghai")

    def test_launch_uses_regular_chromium_and_coherent_identity(self) -> None:
        args = SimpleNamespace(
            profile_id="vendor-main",
            session=None,
            headed=False,
            timeout_ms=12_345,
        )
        fake_sync = FakeSyncPlaywright()
        proxy_names = {
            "HTTP_PROXY": "",
            "HTTPS_PROXY": "",
            "http_proxy": "",
            "https_proxy": "",
        }
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"WORKSPACE_DIR": tmp, **proxy_names}, clear=False
        ), patch.object(acs_browser, "load_playwright", return_value=lambda: fake_sync):
            runtime = acs_browser.open_owned_runtime(args, "https://example.com")
            try:
                _path, options = fake_sync.instance.chromium.calls[0]
                self.assertEqual(options["channel"], "chromium")
                self.assertEqual(options["locale"], "zh-CN")
                self.assertEqual(options["timezone_id"], "Asia/Shanghai")
                self.assertEqual(options["viewport"], acs_browser.DEFAULT_VIEWPORT)
                self.assertEqual(options["screen"], acs_browser.DEFAULT_SCREEN)
                self.assertNotIn("user_agent", options)
                self.assertEqual(runtime.context.default_timeout, 12_345)
            finally:
                acs_browser.close_runtime(runtime)
        self.assertTrue(fake_sync.instance.stopped)


class FakeFrame:
    def __init__(self, name, url, value=None, error=None):
        self.name = name
        self.url = url
        self.value = value
        self.error = error

    def evaluate(self, _expression):
        if self.error:
            raise RuntimeError(self.error)
        return self.value


class AcsBrowserDiagnosticsTest(unittest.TestCase):
    def test_snapshot_includes_iframes_and_redacts_link_queries(self) -> None:
        page = SimpleNamespace(
            url="https://example.com/main?secret=1",
            frames=[
                FakeFrame(
                    "",
                    "https://example.com/main?secret=1",
                    {
                        "title": "Main",
                        "text": "main text",
                        "controls": [
                            {
                                "href": "https://example.com/download?token=secret",
                                "tag": "a",
                                "text": "下载",
                                "selector": "a",
                                "shadowPath": "document",
                            }
                        ],
                    },
                ),
                FakeFrame(
                    "invoice",
                    "https://vendor.example.com/frame?sid=secret",
                    {"title": "Invoice", "text": "frame text", "controls": []},
                ),
            ],
        )
        summary = acs_browser.collect_dom_summary(page)
        self.assertEqual(len(summary["frames"]), 2)
        self.assertEqual(summary["frames"][1]["name"], "invoice")
        self.assertEqual(summary["frames"][0]["controls"][0]["href"], "https://example.com/download")
        rendered = acs_browser.write_snapshot(summary, None)
        self.assertIn("Frame [1] name='invoice'", rendered)
        self.assertNotIn("token=secret", rendered)

    def test_block_classification_uses_status_and_challenge_content(self) -> None:
        result = acs_browser.classify_block(403, "Just a moment...", "Cloudflare")
        self.assertTrue(result["suspected"])
        self.assertEqual(result["signals"], ["http_403", "challenge_content"])

    def test_sensitive_event_text_is_redacted(self) -> None:
        value = acs_browser.redact_text("authorization: Bearer-abc token=secret")
        self.assertNotIn("Bearer-abc", value)
        self.assertNotIn("secret", value)
        self.assertIn("[REDACTED]", value)


class AcsBrowserLeaseTest(unittest.TestCase):
    def test_lease_metadata_can_be_touched_and_reported_stale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"WORKSPACE_DIR": tmp}, clear=False
        ):
            acs_browser.update_lease_metadata(
                "qr-login",
                {"leaseId": "qr-login", "status": "ready", "pid": 999_999},
            )
            touched = acs_browser.touch_lease("qr-login", 120)
            self.assertGreater(touched["expiresAtEpoch"], time.time())
            status = acs_browser.lease_status_value("qr-login")
            self.assertEqual(status["status"], "stale")
            self.assertFalse(status["alive"])

    def test_lease_ttl_has_safe_bounds(self) -> None:
        with self.assertRaises(ValueError):
            acs_browser.validate_lease_ttl(59)
        with self.assertRaises(ValueError):
            acs_browser.validate_lease_ttl(acs_browser.MAX_LEASE_TTL_SECONDS + 1)
        self.assertEqual(acs_browser.validate_lease_ttl(300), 300)

    def test_lease_commands_parse_expected_contract(self) -> None:
        args = acs_browser.build_parser().parse_args(
            [
                "lease-serve",
                "--lease-id",
                "vendor-login",
                "--profile-id",
                "vendor-main",
                "--url",
                "https://example.com/login",
            ]
        )
        self.assertEqual(args.lease_id, "vendor-login")
        self.assertEqual(args.profile_id, "vendor-main")
        self.assertEqual(args.lease_ttl_seconds, acs_browser.DEFAULT_LEASE_TTL_SECONDS)

    def test_lease_snapshot_can_continue_current_page_without_navigation(self) -> None:
        args = acs_browser.build_parser().parse_args(
            ["snapshot", "--lease-id", "vendor-login", "--run-id", "resume"]
        )
        self.assertIsNone(args.url)
        self.assertEqual(args.lease_id, "vendor-login")

    def test_lease_serve_initializes_absolute_cap_and_hosts_in_foreground(self) -> None:
        args = acs_browser.build_parser().parse_args(
            ["lease-serve", "--lease-id", "vendor-login", "--profile-id", "vendor-main"]
        )
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"WORKSPACE_DIR": tmp}, clear=False
        ), patch.object(acs_browser, "available_local_port", return_value=54_321), patch.object(
            acs_browser, "command_lease_host"
        ) as host:
            acs_browser.command_lease_serve(args)
            metadata = acs_browser.read_json_object(acs_browser.lease_meta_path("vendor-login"))
            self.assertEqual(args.port, 54_321)
            self.assertEqual(metadata["status"], "starting")
            self.assertEqual(metadata["pid"], os.getpid())
            self.assertLessEqual(
                metadata["maxExpiresAtEpoch"] - time.time(),
                acs_browser.MAX_LEASE_TTL_SECONDS,
            )
            host.assert_called_once_with(args)

    def test_lease_host_persists_dependency_failure_as_error(self) -> None:
        args = SimpleNamespace(lease_id="missing-playwright", url=None, port=54_321)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"WORKSPACE_DIR": tmp}, clear=False
        ), patch.object(acs_browser.signal, "signal"), patch.object(
            acs_browser,
            "open_owned_runtime",
            side_effect=acs_browser.BrowserDependencyError("缺少 Python Playwright"),
        ):
            acs_browser.update_lease_metadata(
                args.lease_id,
                {
                    "leaseId": args.lease_id,
                    "status": "starting",
                    "stoppedAt": None,
                    "error": None,
                },
            )
            with self.assertRaises(acs_browser.BrowserDependencyError):
                acs_browser.command_lease_host(args)
            metadata = acs_browser.read_json_object(acs_browser.lease_meta_path(args.lease_id))
        self.assertEqual(metadata["status"], "error")
        self.assertIn("缺少 Python Playwright", metadata["error"])
        self.assertIsNone(metadata["stoppedAt"])

    def test_lease_touch_cannot_extend_past_absolute_cap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, patch.dict(
            os.environ, {"WORKSPACE_DIR": tmp}, clear=False
        ):
            absolute_cap = time.time() + 90
            acs_browser.update_lease_metadata(
                "bounded",
                {
                    "leaseId": "bounded",
                    "status": "ready",
                    "pid": os.getpid(),
                    "maxExpiresAtEpoch": absolute_cap,
                },
            )
            touched = acs_browser.touch_lease("bounded", 300)
            self.assertEqual(touched["expiresAtEpoch"], absolute_cap)


if __name__ == "__main__":
    unittest.main()
