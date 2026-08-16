#!/usr/bin/env python3
"""为当前提交精确补投一次失败的 GitHub→ACR push webhook。"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Protocol


class GitHubClient(Protocol):
    def get_json(self, path: str) -> Any: ...

    def post(self, path: str) -> int: ...


class GitHubApi:
    def __init__(self, token: str, base_url: str = "https://api.github.com") -> None:
        self.token = token
        self.base_url = base_url.rstrip("/")

    def _request(self, method: str, path: str) -> tuple[int, bytes]:
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=b"" if method == "POST" else None,
            method=method,
            headers={
                "Accept": "application/vnd.github+json",
                "Authorization": f"Bearer {self.token}",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "agent-saas-acr-webhook-recovery",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"GitHub API HTTP {error.code}: {body[:500]}") from error
        except urllib.error.URLError as error:
            raise RuntimeError(f"GitHub API 请求失败: {error.reason}") from error

    def get_json(self, path: str) -> Any:
        status, body = self._request("GET", path)
        if status != 200:
            raise RuntimeError(f"GitHub API GET 返回异常状态: {status}")
        return json.loads(body)

    def post(self, path: str) -> int:
        status, _ = self._request("POST", path)
        return status


def _is_success(status_code: Any) -> bool:
    return isinstance(status_code, int) and 200 <= status_code < 300


def find_failed_delivery(
    client: GitHubClient,
    repository: str,
    hook_id: int,
    commit_sha: str,
) -> dict[str, Any] | None:
    prefix = f"/repos/{repository}/hooks/{hook_id}/deliveries"
    deliveries = client.get_json(f"{prefix}?per_page=100")
    if not isinstance(deliveries, list):
        raise RuntimeError("GitHub webhook delivery 列表格式异常")

    successful_guids = {
        item.get("guid")
        for item in deliveries
        if isinstance(item, dict) and _is_success(item.get("status_code"))
    }
    for item in deliveries:
        if not isinstance(item, dict):
            continue
        if item.get("event") != "push" or _is_success(item.get("status_code")):
            continue
        if item.get("guid") in successful_guids:
            continue
        delivery_id = item.get("id")
        if not isinstance(delivery_id, int):
            continue
        detail = client.get_json(f"{prefix}/{delivery_id}")
        payload = detail.get("request", {}).get("payload", {}) if isinstance(detail, dict) else {}
        if payload.get("ref") == "refs/heads/main" and payload.get("after") == commit_sha:
            return item
    return None


def redeliver_exact_push(
    client: GitHubClient,
    repository: str,
    hook_id: int,
    commit_sha: str,
) -> int | None:
    delivery = find_failed_delivery(client, repository, hook_id, commit_sha)
    if delivery is None:
        return None
    delivery_id = delivery["id"]
    status = client.post(
        f"/repos/{repository}/hooks/{hook_id}/deliveries/{delivery_id}/attempts"
    )
    if status != 202:
        raise RuntimeError(f"GitHub webhook 补投返回异常状态: {status}")
    return delivery_id


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY", ""))
    parser.add_argument("--hook-id", default=os.environ.get("ACR_GITHUB_HOOK_ID", ""))
    parser.add_argument("--sha", default=os.environ.get("GITHUB_SHA", ""))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    token = os.environ.get("ACR_WEBHOOK_REDELIVERY_TOKEN", "").strip()
    if not token:
        print("缺少 ACS_WEBHOOK_REDELIVERY_TOKEN", file=sys.stderr)
        return 2
    if not re.fullmatch(r"[^/\s]+/[^/\s]+", args.repository):
        print("repository 格式无效", file=sys.stderr)
        return 2
    if not str(args.hook_id).isdigit():
        print("hook-id 格式无效", file=sys.stderr)
        return 2
    if not re.fullmatch(r"[0-9a-fA-F]{40}", args.sha):
        print("sha 格式无效", file=sys.stderr)
        return 2

    repository = urllib.parse.quote(args.repository, safe="/")
    try:
        delivery_id = redeliver_exact_push(
            GitHubApi(token), repository, int(args.hook_id), args.sha.lower()
        )
    except (RuntimeError, json.JSONDecodeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    if delivery_id is None:
        print(f"未找到当前 SHA {args.sha} 对应且尚未成功补投的失败 push delivery")
        return 3
    print(f"已请求补投 GitHub webhook delivery {delivery_id}（SHA {args.sha}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
