#!/usr/bin/env python3
"""
Seedream 图像生成脚本
调用火山引擎方舟平台 Seedream API 生成图片，下载到本地。
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error


API_URL = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
DEFAULT_MODEL = "doubao-seedream-5-0-260128"

# Seedream 5.0 要求最小 3686400 像素（约 1920x1920）
# 默认使用 2048x2048，比较安全
DEFAULT_SIZE = "2048x2048"


MIME_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp",
}


def _resolve_ref_image(ref: str) -> dict:
    """将参考图路径/URL 转为 API 所需的 {"url": "..."} 格式。
    本地文件转为 base64 data URI，URL 直接使用。"""
    if ref.startswith(("http://", "https://", "data:")):
        return {"url": ref}

    import base64
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
        print(f"警告：参考图 {os.path.basename(path)} 大小 {size_mb:.1f}MB，建议不超过 5MB", file=sys.stderr)

    print(f"参考图: {os.path.basename(path)} ({size_mb:.1f}MB, {mime})")
    return {"url": f"data:{mime};base64,{b64}"}


def generate_image(
    prompt: str,
    output_dir: str,
    size: str = DEFAULT_SIZE,
    n: int = 1,
    model: str = DEFAULT_MODEL,
    quality: str | None = None,
    style: str | None = None,
    response_format: str = "url",
    web_search: bool = False,
    seed: int | None = None,
    reference_images: list[str] | None = None,
    watermark: bool = True,
) -> list[str]:
    """调用 Seedream API 生成图片并下载到 output_dir，返回本地文件路径列表。"""

    api_key = os.environ.get("ARK_API_KEY")
    if not api_key:
        print(
            "错误：未设置 ARK_API_KEY 环境变量。\n"
            "  请由平台/租户 secret/env 注入，不要把长期 key 写入 skill、日志或对话。",
            file=sys.stderr,
        )
        sys.exit(1)

    # 处理参考图
    ref_images_payload = None
    if reference_images:
        ref_images_payload = [_resolve_ref_image(r) for r in reference_images]
        ref_count = len(ref_images_payload)
        if ref_count + n > 15:
            print(f"错误：参考图({ref_count}张) + 生成数({n}张) = {ref_count + n}，超过上限 15", file=sys.stderr)
            sys.exit(1)

    # 构建请求体
    body: dict = {
        "model": model,
        "prompt": prompt,
        "size": size,
        "n": n,
        "response_format": response_format,
    }
    if quality:
        body["quality"] = quality
    if style:
        body["style"] = style
    if web_search:
        body["web_search"] = True
    if seed is not None:
        body["seed"] = seed
    if not watermark:
        body["watermark"] = False
    if ref_images_payload:
        body["reference_images"] = ref_images_payload

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(API_URL, data=data, headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        print(f"API 错误 (HTTP {e.code}): {error_body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"网络错误: {e.reason}", file=sys.stderr)
        sys.exit(1)

    images = result.get("data", [])
    if not images:
        print("API 未返回图片数据", file=sys.stderr)
        print(f"完整响应: {json.dumps(result, ensure_ascii=False)}", file=sys.stderr)
        sys.exit(1)

    # 打印 usage 信息
    usage = result.get("usage", {})
    if usage:
        print(f"Token 使用: prompt={usage.get('prompt_tokens', '?')}, total={usage.get('total_tokens', '?')}")

    os.makedirs(output_dir, exist_ok=True)
    ts = int(time.time())
    saved_paths = []

    for i, img in enumerate(images):
        revised = img.get("revised_prompt", "")
        if revised:
            print(f"[图{i+1}] 优化后 prompt: {revised}")

        suffix = f"_{i+1}" if n > 1 else ""
        ext = "png" if "5-0" in model else "jpeg"

        if response_format == "b64_json":
            import base64
            b64_data = img.get("b64_json", "")
            if not b64_data:
                print(f"[图{i+1}] 无 base64 数据，跳过", file=sys.stderr)
                continue
            filename = f"seedream_{ts}{suffix}.{ext}"
            filepath = os.path.join(output_dir, filename)
            with open(filepath, "wb") as f:
                f.write(base64.b64decode(b64_data))
        else:
            url = img.get("url", "")
            if not url:
                print(f"[图{i+1}] 无 URL，跳过", file=sys.stderr)
                continue
            filename = f"seedream_{ts}{suffix}.{ext}"
            filepath = os.path.join(output_dir, filename)
            dl_req = urllib.request.Request(url)
            with urllib.request.urlopen(dl_req, timeout=60) as dl_resp:
                with open(filepath, "wb") as f:
                    f.write(dl_resp.read())

        saved_paths.append(filepath)
        print(f"[图{i+1}] 已保存: {filepath}")

    return saved_paths


def main():
    parser = argparse.ArgumentParser(description="Seedream 图像生成")
    parser.add_argument("prompt", help="图像生成提示词")
    parser.add_argument("-o", "--output-dir", required=True, help="输出目录")
    parser.add_argument("-s", "--size", default=DEFAULT_SIZE, help=f"分辨率 (默认 {DEFAULT_SIZE})")
    parser.add_argument("-n", "--num", type=int, default=1, help="生成数量 (1-15, 默认 1)")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help="模型 ID")
    parser.add_argument("--quality", choices=["standard", "hd"], help="图片质量")
    parser.add_argument("--style", help="图片风格")
    parser.add_argument("--b64", action="store_true", help="使用 base64 返回格式（而非 URL）")
    parser.add_argument("--web-search", action="store_true", help="启用联网搜索（仅 5.0）")
    parser.add_argument("--seed", type=int, help="随机种子（可复现）")
    parser.add_argument("--no-watermark", action="store_true", help="去除图片右下角「AI生成」水印")
    parser.add_argument("--ref", action="append", dest="refs", metavar="IMAGE",
                        help="参考图（本地路径或 URL），可多次指定")

    args = parser.parse_args()

    if args.num < 1 or args.num > 15:
        print("错误：生成数量必须在 1-15 之间", file=sys.stderr)
        sys.exit(1)

    resp_fmt = "b64_json" if args.b64 else "url"

    paths = generate_image(
        prompt=args.prompt,
        output_dir=args.output_dir,
        size=args.size,
        n=args.num,
        model=args.model,
        quality=args.quality,
        style=args.style,
        response_format=resp_fmt,
        web_search=args.web_search,
        seed=args.seed,
        reference_images=args.refs,
        watermark=not args.no_watermark,
    )

    if not paths:
        print("未成功保存任何图片", file=sys.stderr)
        sys.exit(1)

    print(f"\n共生成 {len(paths)} 张图片")


if __name__ == "__main__":
    main()
