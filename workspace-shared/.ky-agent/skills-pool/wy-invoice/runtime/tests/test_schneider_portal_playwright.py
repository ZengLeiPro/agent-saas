from __future__ import annotations

import json
from datetime import datetime, timezone

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
    assert (tmp_path / "登录接力" / "STATEMENT001" / "登录验证码.png").exists()
    state = json.loads(
        (tmp_path / "登录接力" / "STATEMENT001" / "challenge.json").read_text(
            encoding="utf-8"
        )
    )
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
