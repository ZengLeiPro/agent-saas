#!/usr/bin/env python3
"""
GPT-Image-2 图像生成脚本（通过平台 CLIProxyAPI 中转）

直调 CLIProxyAPI 的 OpenAI 兼容端点：
  - 文生图：POST /v1/images/generations（JSON）
  - 以图生图：POST /v1/images/edits（multipart/form-data）

环境变量：
  CLIPROXY_BASE_URL  CLIProxyAPI base URL；未设置时回退到 http://127.0.0.1:8317
  CLIPROXY_API_KEY   必须由 ACS secret/env 注入；不从用户 HOME 读取

参数尽量对齐 generate_gemini.py：
  -s 尺寸 / -a 宽高比 映射到 gpt-image-2 实际支持的 size
  -n 多图串行生成，并通过跨进程文件锁保证 gpt-image-2 单飞
  --ref 本地路径或 URL（URL 自动下载到临时文件再上传）
  --quality 暴露给 agent：low / medium / high / auto
"""

import argparse
import base64
import json
import mimetypes
import os
import re
import shutil
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import fcntl

VALID_SIZES = {"512", "1K", "2K", "4K"}
VALID_ASPECTS = {
    "1:1", "1:4", "1:8", "2:3", "3:2", "3:4",
    "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
}
VALID_QUALITY = {"low", "medium", "high", "auto"}

# gpt-image-2 实际支持的 size（实测，2026-05-18）
SUPPORTED_SIZES = {"1024x1024", "1024x1536", "1536x1024", "2048x2048", "auto"}

DEFAULT_BASE_URL = "http://127.0.0.1:8317"
LOCK_PATH = os.environ.get(
    "GPT_IMAGE_2_LOCK_PATH",
    os.path.join(os.getcwd(), ".cache", "image-gen", "gpt-image-2.lock"),
)
RETRY_DELAYS = [15, 30, 60]
RETRYABLE_HTTP_CODES = {429, 500, 502, 503, 504}
RETRYABLE_ERROR_MARKERS = (
    "auth_unavailable",
    "no auth available",
    "stream disconnected before completion",
    "stream closed before response.completed",
)


def _resolve_config():
    base_url = os.environ.get("CLIPROXY_BASE_URL", "").strip() or DEFAULT_BASE_URL
    api_key = os.environ.get("CLIPROXY_API_KEY", "").strip()
    if not api_key:
        print(
            "错误：找不到 CLIPROXY_API_KEY。\n"
            "  请由 ACS secret/env 注入 CLIPROXY_API_KEY；不要把 key 写入 skill、"
            "用户 HOME 配置、日志或对话。",
            file=sys.stderr,
        )
        sys.exit(2)
    return base_url.rstrip("/"), api_key


class _GptImage2Lock:
    """跨进程单飞锁：避免多个 gpt-image-2 请求同时打爆同一个平台 CLIProxyAPI。"""

    def __init__(self, path: str):
        self.path = path
        self._fp = None

    def __enter__(self):
        lock_dir = os.path.dirname(self.path)
        if lock_dir:
            os.makedirs(lock_dir, exist_ok=True)
        self._fp = open(self.path, "a+", encoding="utf-8")
        print(f"等待 GPT-Image-2 队列锁: {self.path}", file=sys.stderr)
        fcntl.flock(self._fp.fileno(), fcntl.LOCK_EX)
        self._fp.seek(0)
        self._fp.truncate()
        self._fp.write(f"pid={os.getpid()} ts={int(time.time())}\n")
        self._fp.flush()
        print("已获得 GPT-Image-2 队列锁，开始生成", file=sys.stderr)
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._fp:
            try:
                fcntl.flock(self._fp.fileno(), fcntl.LOCK_UN)
            finally:
                self._fp.close()
        print("已释放 GPT-Image-2 队列锁", file=sys.stderr)


def _is_retryable_http_error(code: int, body: str) -> bool:
    lower = body.lower()
    return code in RETRYABLE_HTTP_CODES or any(m in lower for m in RETRYABLE_ERROR_MARKERS)


def _map_size(size_token: str, aspect: str) -> str:
    """
    把 (-s, -a) 软约束映射到 gpt-image-2 实际支持的 size。
    优先看 aspect 方向，再看 size token 决定是否走 HD。
    返回 1024x1024 / 1536x1024 / 1024x1536 / 2048x2048 / auto。
    """
    horizontals = {"3:2", "4:3", "16:9", "21:9", "5:4", "8:1", "4:1"}
    verticals = {"2:3", "3:4", "9:16", "4:5", "1:8", "1:4"}

    is_horizontal = aspect in horizontals
    is_vertical = aspect in verticals
    is_square = aspect == "1:1"

    want_hd = size_token == "2K"
    if size_token == "4K":
        print("提示：gpt-image-2 不支持 4K，降级为 2048x2048", file=sys.stderr)
        want_hd = True
    if size_token == "512":
        print("提示：gpt-image-2 不支持 512，升级为 1024x1024", file=sys.stderr)

    if is_horizontal:
        return "1536x1024"
    if is_vertical:
        return "1024x1536"
    if is_square:
        return "2048x2048" if want_hd else "1024x1024"
    return "auto"


def _download_url_to_tempfile(url: str) -> str:
    """把 URL 参考图下载到临时文件，返回本地路径。"""
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "gpt-image-2-skill/1.0"})
    with urllib.request.urlopen(req, context=ctx, timeout=60) as resp:
        ext = mimetypes.guess_extension(resp.headers.get_content_type() or "") or ".png"
        fd, path = tempfile.mkstemp(prefix="ref_", suffix=ext)
        with os.fdopen(fd, "wb") as f:
            shutil.copyfileobj(resp, f)
    return path


def _build_multipart(fields, files):
    """
    构造 multipart/form-data body（纯标准库）。
    fields: [(name, value_str), ...]
    files:  [(name, filename, content_type, bytes), ...]
    返回 (body_bytes, content_type_header)
    """
    boundary = "----gpt-image-2-skill-" + uuid.uuid4().hex
    parts = []
    for name, value in fields:
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        parts.append(str(value).encode("utf-8"))
        parts.append(b"\r\n")
    for name, filename, ctype, data in files:
        parts.append(f"--{boundary}\r\n".encode())
        parts.append(
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode()
        )
        parts.append(f"Content-Type: {ctype}\r\n\r\n".encode())
        parts.append(data)
        parts.append(b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)
    return body, f"multipart/form-data; boundary={boundary}"


def _request_json(url, api_key, payload):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _request_multipart(url, api_key, fields, files):
    body, ctype = _build_multipart(fields, files)
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": ctype,
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _save_image(b64, output_dir, ts, seq):
    os.makedirs(output_dir, exist_ok=True)
    suffix = f"_{seq}" if seq > 0 else ""
    target = os.path.join(output_dir, f"gpt_image_2_{ts}{suffix}.png")
    with open(target, "wb") as f:
        f.write(base64.b64decode(b64))
    return target


def _one_call(base_url, api_key, prompt, size, quality, ref_paths):
    """
    单次调用 CLIProxyAPI。
    有 ref → /v1/images/edits（multipart）
    无 ref → /v1/images/generations（JSON）
    """
    if ref_paths:
        url = f"{base_url}/v1/images/edits"
        fields = [
            ("model", "gpt-image-2"),
            ("prompt", prompt),
            ("size", size),
            ("quality", quality),
        ]
        files = []
        for p in ref_paths:
            ctype, _ = mimetypes.guess_type(p)
            ctype = ctype or "application/octet-stream"
            with open(p, "rb") as f:
                files.append(("image[]", os.path.basename(p), ctype, f.read()))
        return _request_multipart(url, api_key, fields, files)
    else:
        url = f"{base_url}/v1/images/generations"
        payload = {
            "model": "gpt-image-2",
            "prompt": prompt,
            "size": size,
            "quality": quality,
        }
        return _request_json(url, api_key, payload)


def _one_call_with_retries(base_url, api_key, prompt, size, quality, ref_paths):
    """对 auth_unavailable/503/504 等临时错误做退避重试。"""
    for attempt in range(len(RETRY_DELAYS) + 1):
        try:
            return _one_call(base_url, api_key, prompt, size, quality, ref_paths)
        except urllib.error.HTTPError as e:
            try:
                body = e.read().decode("utf-8", "replace")
            except Exception:
                body = "<unreadable>"

            if attempt < len(RETRY_DELAYS) and _is_retryable_http_error(e.code, body):
                delay = RETRY_DELAYS[attempt]
                print(
                    f"错误：HTTP {e.code} {e.reason}，疑似 GPT-Image-2 OAuth 暂不可用，"
                    f"{delay}s 后重试（{attempt + 1}/{len(RETRY_DELAYS)}）\n{body[:500]}",
                    file=sys.stderr,
                )
                time.sleep(delay)
                continue

            print(f"错误：HTTP {e.code} {e.reason}\n{body[:1000]}", file=sys.stderr)
            return None
        except urllib.error.URLError as e:
            print(f"错误：连接 CLIProxyAPI 失败 ({base_url}): {e}", file=sys.stderr)
            print(
                "提示：确认 CLIPROXY_BASE_URL 可达，且 CLIPROXY_API_KEY 已由 secret/env 注入。",
                file=sys.stderr,
            )
            return None


def generate_image(
    prompt,
    output_dir,
    image_size="1K",
    aspect_ratio="1:1",
    quality="auto",
    n=1,
    reference_images=None,
):
    base_url, api_key = _resolve_config()
    mapped_size = _map_size(image_size, aspect_ratio)

    # URL 参考图 → 下载到本地临时文件
    ref_paths = []
    cleanup_paths = []
    for r in reference_images or []:
        if r.startswith(("http://", "https://")):
            try:
                local = _download_url_to_tempfile(r)
                ref_paths.append(local)
                cleanup_paths.append(local)
            except (urllib.error.URLError, OSError) as e:
                print(f"错误：下载参考图失败 {r}: {e}", file=sys.stderr)
                return []
        else:
            local = os.path.expanduser(r)
            if not os.path.isfile(local):
                print(f"错误：参考图不存在: {r}", file=sys.stderr)
                return []
            ref_paths.append(local)

    ts = int(time.time())
    all_saved = []

    def _task(seq_index):
        resp = _one_call_with_retries(base_url, api_key, prompt, mapped_size, quality, ref_paths)
        if not resp:
            return []

        data_list = resp.get("data") or []
        if not data_list:
            print(
                f"警告：响应中无 data 字段。原始响应：{json.dumps(resp)[:500]}",
                file=sys.stderr,
            )
            return []

        saved = []
        for idx, item in enumerate(data_list):
            b64 = item.get("b64_json")
            if not b64:
                print(f"警告：data[{idx}] 无 b64_json", file=sys.stderr)
                continue
            seq = seq_index if n > 1 else 0
            local_seq = seq + (idx * 100 if idx > 0 else 0)
            target = _save_image(b64, output_dir, ts, local_seq)
            saved.append(target)
            usage = resp.get("usage", {})
            print(
                f"[图{seq_index + 1}] 已保存: {target}"
                f"（tokens: {usage.get('total_tokens', '?')}）"
            )

            revised = (item.get("revised_prompt") or "").strip()
            if revised and revised != prompt:
                print(
                    f"[图{seq_index + 1}] 模型重写 prompt: {revised[:200]}",
                    file=sys.stderr,
                )
        return saved

    with _GptImage2Lock(LOCK_PATH):
        if n > 1:
            print(
                "提示：GPT-Image-2 已启用单飞队列，多图将串行生成，避免 OAuth 池被并发打爆",
                file=sys.stderr,
            )
        for i in range(n):
            all_saved.extend(_task(i))

    for p in cleanup_paths:
        try:
            os.unlink(p)
        except OSError:
            pass

    return all_saved


def main():
    parser = argparse.ArgumentParser(
        description="GPT-Image-2 图像生成（通过平台 CLIProxyAPI 中转）"
    )
    parser.add_argument("prompt", help="图像生成提示词")
    parser.add_argument("-o", "--output-dir", required=True, help="输出目录")
    parser.add_argument(
        "-s", "--size", default="1K", choices=sorted(VALID_SIZES),
        help="尺寸偏好：512(降级 1K)/1K(默认)/2K(走 2048)/4K(降级 2K)；"
             "与 -a 共同映射到 gpt-image-2 实际尺寸",
    )
    parser.add_argument(
        "-a", "--aspect-ratio", default="1:1",
        help=f"宽高比（决定最终尺寸方向），可选: {', '.join(sorted(VALID_ASPECTS))}",
    )
    parser.add_argument(
        "-q", "--quality", default="auto", choices=sorted(VALID_QUALITY),
        help="质量：low(最便宜)/medium/high/auto(默认)，影响烧配额速度",
    )
    parser.add_argument(
        "-n", "--num", type=int, default=1,
        help="生成数量（串行生成；gpt-image-2 已启用跨进程单飞锁）",
    )
    parser.add_argument(
        "--ref", action="append", dest="refs", metavar="IMAGE",
        help="参考图（本地路径或 URL，可多次指定，URL 自动下载）。"
             "传 --ref 时走 /v1/images/edits 以图生图端点",
    )

    args = parser.parse_args()

    if args.aspect_ratio not in VALID_ASPECTS:
        print(f"错误：不支持的宽高比 '{args.aspect_ratio}'", file=sys.stderr)
        print(f"可选: {', '.join(sorted(VALID_ASPECTS))}", file=sys.stderr)
        sys.exit(1)

    if args.num < 1 or args.num > 10:
        print("错误：生成数量建议在 1-10 之间", file=sys.stderr)
        sys.exit(1)

    paths = generate_image(
        prompt=args.prompt,
        output_dir=args.output_dir,
        image_size=args.size,
        aspect_ratio=args.aspect_ratio,
        quality=args.quality,
        n=args.num,
        reference_images=args.refs,
    )

    if not paths:
        print("未成功保存任何图片", file=sys.stderr)
        sys.exit(1)

    print(f"\n共生成 {len(paths)} 张图片")


if __name__ == "__main__":
    main()
