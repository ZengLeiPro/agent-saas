from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest
from requests.cookies import RequestsCookieJar

from clients.schneider import portal_playwright as portal


TASK = {
    "statement_no": "STATEMENT001",
    "portal_url": "https://vendor.example/login.jsp",
    "portal_username": "user",
    "portal_password": "password",
}


class FakeResponse:
    def __init__(self, url: str, body: bytes):
        self.url = url
        self.content = body
        self.encoding = None
        self.status_code = 200

    @property
    def text(self):
        return self.content.decode(self.encoding or "utf-8")

    def raise_for_status(self):
        return None


def test_create_login_challenge_persists_same_session(monkeypatch, tmp_path):
    html = (
        '<form name="userInfoForm" method="post" action="/webportal/LoginAction.do">'
        '<img src="/verifyCodeServlet" id="imgObj"></form>'
    ).encode("gbk")

    class FakeSession:
        def __init__(self):
            self.cookies = RequestsCookieJar()
            self.cookies.set(
                "JSESSIONID",
                "session-1",
                domain="vendor.example",
                path="/",
                secure=True,
            )
            self.calls = 0

        def get(self, url, **_):
            self.calls += 1
            if self.calls == 1:
                return FakeResponse("https://vendor.example/login.jsp", html)
            return FakeResponse("https://vendor.example/verifyCodeServlet", b"\x89PNG\r\n")

    monkeypatch.setattr(portal.requests, "Session", FakeSession)
    result = portal.create_login_challenge({}, TASK, tmp_path)

    assert result["status"] == "captcha_required"
    assert result["taskReference"] == "STATEMENT001"
    captcha_path = Path(result["captchaPath"])
    challenge_path = Path(result["challengeFile"])
    assert captcha_path.exists()
    assert challenge_path.exists()
    assert captcha_path.parent == challenge_path.parent
    state = json.loads(challenge_path.read_text(encoding="utf-8"))
    assert state["formAction"] == "https://vendor.example/webportal/LoginAction.do"
    assert state["cookies"][0]["name"] == "JSESSIONID"


def test_login_reuses_challenge_cookie_and_returns_playwright_cookies(
    monkeypatch, tmp_path
):
    challenge = tmp_path / "challenge.json"
    challenge.write_text(
        json.dumps(
            {
                "version": 1,
                "taskReference": "STATEMENT001",
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "loginUrl": "https://vendor.example/login.jsp",
                "formAction": "https://vendor.example/webportal/LoginAction.do",
                "userAgent": portal.IE11_USER_AGENT,
                "cookies": [
                    {
                        "name": "JSESSIONID",
                        "value": "session-1",
                        "domain": "vendor.example",
                        "path": "/",
                        "secure": True,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    class FakeSession:
        instance = None

        def __init__(self):
            self.cookies = RequestsCookieJar()
            self.posted = None
            FakeSession.instance = self

        def post(self, url, **kwargs):
            self.posted = (url, kwargs)
            self.cookies.set(
                "AUTH",
                "ok",
                domain="vendor.example",
                path="/",
                secure=True,
            )
            return FakeResponse(
                "https://vendor.example/webPortalSystem/index.jsp",
                "<html>登录成功</html>".encode("gbk"),
            )

    class Audit:
        def info(self, *_):
            pass

    monkeypatch.setattr(portal.requests, "Session", FakeSession)
    cookies = portal._login_with_challenge(TASK, "A1B2", challenge, Audit())

    posted = FakeSession.instance.posted
    assert posted[1]["data"]["veryCode"] == "A1B2"
    assert FakeSession.instance.cookies.get("JSESSIONID") == "session-1"
    assert {item["name"] for item in cookies} == {"JSESSIONID", "AUTH"}


def test_login_rejects_challenge_for_other_statement(tmp_path):
    challenge = tmp_path / "challenge.json"
    challenge.write_text(
        json.dumps(
            {
                "taskReference": "OTHER",
                "createdAt": datetime.now(timezone.utc).isoformat(),
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(RuntimeError, match="对账单号不一致"):
        portal._login_with_challenge(TASK, "A1B2", challenge, object())


class FakeOptions:
    def __init__(self, values):
        self.values = values

    def all_inner_texts(self):
        return self.values


class FakeSelect:
    def __init__(self, options, visible=True, enabled=True):
        self.options = options
        self.visible = visible
        self.enabled = enabled

    def is_visible(self):
        return self.visible

    def is_enabled(self):
        return self.enabled

    def locator(self, selector):
        assert selector == "option"
        return FakeOptions(self.options)


class FakeSelects:
    def __init__(self, selects):
        self.selects = selects

    def count(self):
        return len(self.selects)

    def nth(self, index):
        return self.selects[index]


class FakeScope:
    def __init__(self, url, name="", options=None, html="<html></html>"):
        self.url = url
        self.name = name
        self.selects = [FakeSelect(item) for item in options or []]
        self.html = html

    def locator(self, selector):
        if selector == "select":
            return FakeSelects(self.selects)
        if selector.startswith("input[name='vmiType']"):
            return FakeSelects([FakeSelect([])])
        raise AssertionError(selector)

    def content(self):
        return self.html


class FakePage(FakeScope):
    def __init__(self, child=None):
        super().__init__(
            "https://vendor.example/webPortalSystem/apInvoice/index.jsp",
            html="<html><title>发票管理--&gt;生成发票信息</title></html>",
        )
        self.context = object()
        self.main_frame = object()
        self.frames = [self.main_frame] + ([child] if child else [])

    def wait_for_timeout(self, _):
        raise AssertionError("可交互 frame 已存在时不应继续等待")

    def screenshot(self, path, **_):
        from pathlib import Path

        Path(path).write_bytes(b"PNG")

    def title(self):
        return "发票管理-->生成发票信息"


def test_invoice_scope_ignores_hidden_title_and_uses_interactive_frame():
    frame = FakeScope(
        "https://vendor.example/webPortalSystem/apInvoice/content.jsp",
        name="invoice-main",
        options=[
            ["请选择", "AVXE—开关设备"],
            ["请选择", "非寄售", "寄售"],
        ],
    )
    page = FakePage(frame)

    result = portal._wait_invoice_scope(
        page,
        company_code="AVXE",
        kind="non_consignment",
        timeout=1,
    )

    assert result is frame


def test_initial_portal_capture_includes_top_page_and_child_frames(tmp_path):
    frame = FakeScope(
        "https://vendor.example/webPortalSystem/apInvoice/content.jsp",
        name="invoice-main",
        html="<html><body>业务正文</body></html>",
    )
    page = FakePage(frame)

    class Audit:
        screenshot_dir = tmp_path / "screenshots"
        dom_dir = tmp_path / "dom"

    Audit.screenshot_dir.mkdir()
    Audit.dom_dir.mkdir()

    portal._capture_portal_state(
        page,
        Audit(),
        "01-发票页初始",
        [{"type": "pageerror", "message": "示例错误"}],
    )

    assert (Audit.screenshot_dir / "01-发票页初始.png").exists()
    assert (Audit.dom_dir / "01-发票页初始-00.html").exists()
    assert (Audit.dom_dir / "01-发票页初始-01.html").exists()
    diagnostics = json.loads(
        (Audit.dom_dir / "01-发票页初始-诊断.json").read_text(encoding="utf-8")
    )
    assert diagnostics["pageTitle"] == "发票管理-->生成发票信息"
    assert diagnostics["frames"][1]["name"] == "invoice-main"
    assert diagnostics["browserEvents"][0]["type"] == "pageerror"
