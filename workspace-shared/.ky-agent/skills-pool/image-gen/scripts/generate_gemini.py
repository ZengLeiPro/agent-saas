#!/usr/bin/env python3
"""
Gemini 图像生成脚本
调用 Google Gemini API (Nano Banana 系列) 生成图片。
"""

import argparse
import base64
import json
import os
import sys
import time
import urllib.request
import urllib.error


API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
DEFAULT_MODEL = "gemini-3.1-flash-image-preview"

VALID_SIZES = {"512", "1K", "2K", "4K"}
VALID_ASPECTS = {
    "1:1", "1:4", "1:8", "2:3", "3:2", "3:4",
    "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
}

MIME_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp",
}


def _load_ref_image(ref: str) -> dict:
    """将参考图路径/URL 转为 Gemini inline_data 格式。"""
    if ref.startswith(("http://", "https://")):
        # 下载远程图片并转为 base64
        req = urllib.request.Request(ref)
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
            content_type = resp.headers.get("Content-Type", "image/jpeg")
            mime = content_type.split(";")[0].strip()
        b64 = base64.b64encode(data).decode("ascii")
        print(f"参考图(URL): {ref[:80]}... ({len(data)/1024/1024:.1f}MB)")
        return {"inline_data": {"mime_type": mime, "data": b64}}

    # 本地文件
    path = os.path.expanduser(ref)
    if not os.path.isfile(path):
        print(f"错误：参考图文件不存在: {path}", file=sys.stderr)
        sys.exit(1)

    ext = os.path.splitext(path)[1].lower()
    mime = MIME_TYPES.get(ext, "image/jpeg")
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")

    size_mb = os.path.getsize(path) / (1024 * 1024)
    if size_mb > 5:
        print(f"警告：参考图 {os.path.basename(path)} 大小 {size_mb:.1f}MB，建议不超过 5MB",
              file=sys.stderr)

    print(f"参考图: {os.path.basename(path)} ({size_mb:.1f}MB, {mime})")
    return {"inline_data": {"mime_type": mime, "data": b64}}


def generate_image(
    prompt: str,
    output_dir: str,
    model: str = DEFAULT_MODEL,
    image_size: str = "1K",
    aspect_ratio: str = "1:1",
    n: int = 1,
    reference_images: list[str] | None = None,
) -> list[str]:
    """调用 Gemini API 生成图片并保存到 output_dir。"""

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("错误：未设置 GEMINI_API_KEY 环境变量", file=sys.stderr)
        sys.exit(1)

    # 构建 parts
    parts = []

    # 参考图放在 prompt 前面
    if reference_images:
        for i, ref in enumerate(reference_images):
            parts.append(_load_ref_image(ref))
            # 不需要额外标注图片编号 — Gemini 按 parts 顺序理解

    parts.append({"text": prompt})

    # 构建请求体
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {
                "imageSize": image_size,
                "aspectRatio": aspect_ratio,
            },
        },
    }

    url = f"{API_BASE}/{model}:generateContent?key={api_key}"
    headers = {"Content-Type": "application/json"}

    os.makedirs(output_dir, exist_ok=True)
    ts = int(time.time())
    saved_paths = []

    for attempt in range(n):
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")

        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            error_body = e.read().decode("utf-8", errors="replace")
            print(f"API 错误 (HTTP {e.code}): {error_body}", file=sys.stderr)
            if attempt == 0:
                sys.exit(1)
            continue
        except urllib.error.URLError as e:
            print(f"网络错误: {e.reason}", file=sys.stderr)
            if attempt == 0:
                sys.exit(1)
            continue

        # 解析响应：提取非 thought 的图片 parts
        candidates = result.get("candidates", [])
        if not candidates:
            # 检查是否被安全过滤
            block_reason = result.get("promptFeedback", {}).get("blockReason", "")
            if block_reason:
                print(f"请求被安全过滤: {block_reason}", file=sys.stderr)
            else:
                print(f"API 未返回候选结果: {json.dumps(result, ensure_ascii=False)[:500]}",
                      file=sys.stderr)
            if attempt == 0:
                sys.exit(1)
            continue

        content_parts = candidates[0].get("content", {}).get("parts", [])
        img_count = 0

        for part in content_parts:
            # 跳过 thinking 中间图片
            if part.get("thought"):
                continue

            # API 返回 camelCase (inlineData/mimeType)，兼容两种写法
            img_data = part.get("inlineData") or part.get("inline_data")
            if img_data:
                mime = img_data.get("mimeType") or img_data.get("mime_type", "image/png")
                ext = "png" if "png" in mime else "jpeg"
                b64_data = img_data.get("data", "")
                if not b64_data:
                    continue

                suffix = f"_{attempt + 1}" if n > 1 else ""
                if img_count > 0:
                    suffix += f"_{chr(97 + img_count)}"  # _a, _b, ...
                filename = f"gemini_{ts}{suffix}.{ext}"
                filepath = os.path.join(output_dir, filename)

                with open(filepath, "wb") as f:
                    f.write(base64.b64decode(b64_data))

                saved_paths.append(filepath)
                print(f"[图{len(saved_paths)}] 已保存: {filepath}")
                img_count += 1

            elif "text" in part:
                text = part["text"].strip()
                if text:
                    print(f"模型回复: {text}")

    # 打印 usage
    usage = result.get("usageMetadata", {})
    if usage:
        print(f"Token 使用: prompt={usage.get('promptTokenCount', '?')}, "
              f"candidates={usage.get('candidatesTokenCount', '?')}, "
              f"total={usage.get('totalTokenCount', '?')}")

    return saved_paths


def main():
    parser = argparse.ArgumentParser(description="Gemini 图像生成 (Nano Banana)")
    parser.add_argument("prompt", help="图像生成提示词")
    parser.add_argument("-o", "--output-dir", required=True, help="输出目录")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help=f"模型 ID (默认 {DEFAULT_MODEL})")
    parser.add_argument("-s", "--size", default="1K", choices=sorted(VALID_SIZES),
                        help="图片尺寸: 512, 1K, 2K, 4K (默认 1K)")
    parser.add_argument("-a", "--aspect-ratio", default="1:1",
                        help=f"宽高比 (默认 1:1)，可选: {', '.join(sorted(VALID_ASPECTS))}")
    parser.add_argument("-n", "--num", type=int, default=1,
                        help="生成数量 (默认 1，每张独立调用)")
    parser.add_argument("--ref", action="append", dest="refs", metavar="IMAGE",
                        help="参考图（本地路径或 URL），可多次指定")

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
        model=args.model,
        image_size=args.size,
        aspect_ratio=args.aspect_ratio,
        n=args.num,
        reference_images=args.refs,
    )

    if not paths:
        print("未成功保存任何图片", file=sys.stderr)
        sys.exit(1)

    print(f"\n共生成 {len(paths)} 张图片")


if __name__ == "__main__":
    main()
