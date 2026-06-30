#!/usr/bin/env python3
"""
Seedance 视频生成脚本
调用火山引擎方舟平台 Seedance 2.0 系列 API 异步生成视频，轮询结果并下载到本地。

依赖：仅 Python 3 标准库（urllib + json + threading）
"""

import argparse
import base64
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request


CREATE_URL = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks"
QUERY_URL = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}"

MODEL_PRO = "doubao-seedance-2-0-260128"
MODEL_FAST = "doubao-seedance-2-0-fast-260128"
DEFAULT_MODEL = MODEL_PRO

VALID_RESOLUTIONS = ["480p", "720p", "1080p"]
VALID_RATIOS = ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]

# 单文件大小软警告阈值（base64 编码后请求体会膨胀 ~33%）
LOCAL_FILE_WARN_MB = 5

IMAGE_MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif",
    ".webp": "image/webp", ".bmp": "image/bmp",
}
VIDEO_MIME = {
    ".mp4": "video/mp4", ".mov": "video/quicktime",
    ".webm": "video/webm", ".m4v": "video/x-m4v",
    ".mkv": "video/x-matroska",
}
AUDIO_MIME = {
    ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".m4a": "audio/mp4", ".aac": "audio/aac",
    ".ogg": "audio/ogg", ".flac": "audio/flac",
}


def _eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)


def _read_local_as_data_uri(path: str, mime_map: dict, kind: str) -> str:
    """读取本地文件并返回 data URI。kind 用于日志（图片/视频/音频）。"""
    abs_path = os.path.expanduser(path)
    if not os.path.isfile(abs_path):
        _eprint(f"错误：{kind}文件不存在: {abs_path}")
        sys.exit(1)
    ext = os.path.splitext(abs_path)[1].lower()
    mime = mime_map.get(ext)
    if not mime:
        _eprint(f"错误：{kind}文件类型不支持: {ext}（支持 {list(mime_map.keys())}）")
        sys.exit(1)
    size_mb = os.path.getsize(abs_path) / (1024 * 1024)
    if size_mb > LOCAL_FILE_WARN_MB:
        _eprint(f"警告：{kind} {os.path.basename(abs_path)} 大小 {size_mb:.1f}MB，建议不超过 {LOCAL_FILE_WARN_MB}MB（base64 编码后体积会进一步增大）")
    with open(abs_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    print(f"  {kind}: {os.path.basename(abs_path)} ({size_mb:.1f}MB, {mime})")
    return f"data:{mime};base64,{b64}"


def _resolve_ref(ref: str, mime_map: dict, kind: str) -> str:
    """将参考素材（URL 或本地路径）转为 API 接受的 URL 字段值。"""
    if ref.startswith(("http://", "https://", "data:")):
        return ref
    return _read_local_as_data_uri(ref, mime_map, kind)


def build_content(prompt: str, ref_images: list, ref_videos: list, ref_audios: list) -> list:
    """构建 API 请求的 content 数组，保留传入顺序。"""
    content = [{"type": "text", "text": prompt}]
    for img in ref_images or []:
        content.append({
            "type": "image_url",
            "image_url": {"url": _resolve_ref(img, IMAGE_MIME, "参考图")},
            "role": "reference_image",
        })
    for vid in ref_videos or []:
        content.append({
            "type": "video_url",
            "video_url": {"url": _resolve_ref(vid, VIDEO_MIME, "参考视频")},
            "role": "reference_video",
        })
    for aud in ref_audios or []:
        content.append({
            "type": "audio_url",
            "audio_url": {"url": _resolve_ref(aud, AUDIO_MIME, "参考音频")},
            "role": "reference_audio",
        })
    return content


def _post_json(url: str, body: dict, api_key: str, timeout: int = 60) -> dict:
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        _eprint(f"API 错误 (HTTP {e.code}): {err_body}")
        raise
    except urllib.error.URLError as e:
        _eprint(f"网络错误: {e.reason}")
        raise


def _get_json(url: str, api_key: str, timeout: int = 30) -> dict:
    req = urllib.request.Request(
        url, method="GET",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        _eprint(f"查询任务错误 (HTTP {e.code}): {err_body}")
        raise
    except urllib.error.URLError as e:
        _eprint(f"网络错误: {e.reason}")
        raise


def _download(url: str, dst_path: str, timeout: int = 300):
    """流式下载到本地文件。视频 URL 有效期 24h，必须立即下载。"""
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dst_path, "wb") as f:
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)


def _make_body(args, content: list, seed: int) -> dict:
    body = {
        "model": args.model,
        "content": content,
        "resolution": args.resolution,
        "ratio": args.aspect_ratio,
        "duration": args.duration,
        "seed": seed,
        "watermark": bool(args.watermark),
        "generate_audio": not args.no_audio,
        "return_last_frame": bool(args.last_frame),
        "priority": int(args.priority),
    }
    if args.callback_url:
        body["callback_url"] = args.callback_url
    return body


def submit_and_wait(
    idx: int,
    total: int,
    args,
    content: list,
    seed: int,
    api_key: str,
    output_dir: str,
    ts: int,
) -> dict:
    """提交单个任务、轮询、下载。返回 dict 包含 task_id/status/files/usage/error。"""
    tag = f"[任务{idx+1}/{total}]" if total > 1 else "[任务]"
    body = _make_body(args, content, seed)
    try:
        create_resp = _post_json(CREATE_URL, body, api_key, timeout=60)
    except Exception as e:
        return {"index": idx, "status": "failed", "error": f"提交失败: {e}"}

    task_id = create_resp.get("id")
    if not task_id:
        return {"index": idx, "status": "failed", "error": f"提交未返回 id，原始响应: {create_resp}"}

    print(f"{tag} 已提交 task_id={task_id} seed={seed}")

    started = time.time()
    last_status = None
    while True:
        elapsed = int(time.time() - started)
        if elapsed > args.max_wait:
            return {
                "index": idx, "task_id": task_id, "status": "timeout",
                "error": f"任务等待超过 {args.max_wait}s 仍未完成（最后状态: {last_status}）",
            }
        try:
            q = _get_json(QUERY_URL.format(id=task_id), api_key, timeout=30)
        except Exception as e:
            print(f"{tag} 查询失败（将重试）: {e}")
            time.sleep(args.poll_interval)
            continue

        status = q.get("status")
        if status != last_status:
            print(f"{tag} status={status} 已等待 {elapsed}s")
        last_status = status

        if status == "succeeded":
            content_out = q.get("content", {}) or {}
            video_url = content_out.get("video_url")
            last_frame_url = content_out.get("last_frame_url")
            if not video_url:
                return {"index": idx, "task_id": task_id, "status": "failed",
                        "error": f"succeeded 但无 video_url，原始: {q}"}

            suffix = f"_{idx+1}" if total > 1 else ""
            video_name = f"seedance_{ts}{suffix}.mp4"
            video_path = os.path.join(output_dir, video_name)
            print(f"{tag} 下载视频到 {video_path}（24h 内有效）")
            try:
                _download(video_url, video_path)
            except Exception as e:
                return {"index": idx, "task_id": task_id, "status": "failed",
                        "error": f"视频下载失败: {e}"}

            files = [video_path]
            if last_frame_url:
                lf_name = f"seedance_{ts}{suffix}_last.png"
                lf_path = os.path.join(output_dir, lf_name)
                print(f"{tag} 下载尾帧到 {lf_path}")
                try:
                    _download(last_frame_url, lf_path)
                    files.append(lf_path)
                except Exception as e:
                    print(f"{tag} 尾帧下载失败（忽略）: {e}")

            return {
                "index": idx, "task_id": task_id, "status": "succeeded",
                "files": files, "usage": q.get("usage", {}),
                "duration": q.get("duration"), "resolution": q.get("resolution"),
                "ratio": q.get("ratio"), "framespersecond": q.get("framespersecond"),
                "seed": q.get("seed"), "elapsed_sec": elapsed,
            }
        elif status == "failed":
            return {"index": idx, "task_id": task_id, "status": "failed",
                    "error": q.get("error") or "任务失败但未返回 error 字段"}
        elif status == "cancelled":
            return {"index": idx, "task_id": task_id, "status": "cancelled",
                    "error": "任务被取消"}
        elif status == "expired":
            return {"index": idx, "task_id": task_id, "status": "expired",
                    "error": "任务超过 execution_expires_after 自动过期"}
        # queued / running 继续轮询
        time.sleep(args.poll_interval)


def run(args):
    api_key = os.environ.get("ARK_API_KEY")
    if not api_key:
        _eprint("错误：未设置 ARK_API_KEY 环境变量（与 image-gen 共用）")
        sys.exit(1)

    # 处理 --fast 与 --model 互斥
    if args.fast:
        args.model = MODEL_FAST

    # fast 不支持 1080p：自动 fallback + warn
    if args.model == MODEL_FAST and args.resolution == "1080p":
        _eprint("警告：Seedance 2.0 fast 不支持 1080p，自动降到 720p")
        args.resolution = "720p"

    # 校验：音频不可单独
    if args.ref_audio and not (args.ref_image or args.ref_video):
        _eprint("错误：参考音频不可单独传入，必须配合至少一个 --ref-image 或 --ref-video")
        sys.exit(1)

    # 校验 duration
    if args.duration != -1 and not (4 <= args.duration <= 15):
        _eprint("错误：--duration 必须是 -1（智能）或 [4, 15] 的整数")
        sys.exit(1)

    # 校验 n
    if not (1 <= args.num <= 5):
        _eprint("错误：-n/--num 必须在 [1, 5] 之间")
        sys.exit(1)

    # 校验 priority
    if not (0 <= args.priority <= 9):
        _eprint("错误：--priority 必须在 [0, 9] 之间")
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    # 一次性构建 content（n>1 时 content 复用，只换 seed）
    print(f"模型: {args.model}")
    print(f"分辨率: {args.resolution} | 宽高比: {args.aspect_ratio} | 时长: {args.duration}s | 音频: {'是' if not args.no_audio else '否'} | 水印: {'是' if args.watermark else '否'}")
    if args.ref_image or args.ref_video or args.ref_audio:
        print("参考素材:")
    content = build_content(args.prompt, args.ref_image, args.ref_video, args.ref_audio)

    ts = int(time.time())
    # 为多任务生成不同 seed
    if args.num == 1:
        seeds = [args.seed]
    else:
        import random
        if args.seed == -1:
            seeds = [random.randint(0, 2**32 - 1) for _ in range(args.num)]
        else:
            # 用户指定了基准 seed，按 +i 偏移生成多个
            seeds = [args.seed + i for i in range(args.num)]
        print(f"多视频模式 n={args.num}，seeds={seeds}")

    results = [None] * args.num
    threads = []

    def _worker(i):
        results[i] = submit_and_wait(
            idx=i, total=args.num, args=args,
            content=content, seed=seeds[i],
            api_key=api_key, output_dir=args.output_dir, ts=ts,
        )

    for i in range(args.num):
        t = threading.Thread(target=_worker, args=(i,), daemon=True)
        t.start()
        threads.append(t)

    for t in threads:
        t.join()

    # 汇总
    print("\n========== 汇总 ==========")
    all_files = []
    total_tokens = 0
    any_failed = False
    for r in results:
        idx = r["index"]
        if r["status"] == "succeeded":
            files_str = ", ".join(r["files"])
            usage = r.get("usage") or {}
            ct = usage.get("completion_tokens") or 0
            total_tokens += ct
            print(f"[任务{idx+1}] succeeded | {r.get('duration')}s {r.get('resolution')} {r.get('ratio')} @ {r.get('framespersecond')}fps | seed={r.get('seed')} | 耗时 {r.get('elapsed_sec')}s | tokens={ct}")
            print(f"            文件: {files_str}")
            all_files.extend(r["files"])
        else:
            any_failed = True
            print(f"[任务{idx+1}] {r['status']} | {r.get('error')}")

    if total_tokens:
        # TODO: 待火山公示后写入 Seedance 2.0 / fast 真实单价（completion_tokens 计费）
        print(f"\nToken 总计: {total_tokens}（费用估算需查火山方舟最新公示单价）")

    if not all_files:
        _eprint("\n所有任务均未产出文件")
        sys.exit(1)

    print(f"\n共生成 {len(all_files)} 个文件（{sum(1 for p in all_files if p.endswith('.mp4'))} 视频）")
    if any_failed:
        sys.exit(2)  # 部分成功


def main():
    p = argparse.ArgumentParser(
        description="Seedance 2.0 视频生成（火山引擎方舟平台）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
示例:
  # 文生视频，默认 pro + 1080p + adaptive + 智能时长 + 有声
  python3 generate.py "夕阳下海边奔跑的少年，电影感长镜头" -o assets/20260527

  # 图生视频 + 9:16 竖屏 + 8 秒
  python3 generate.py "镜头缓慢推近，主角微笑" -o out --ref-image hero.jpg -a 9:16 -d 8

  # 多模态参考（图+视频+音频）
  python3 generate.py "全程使用视频1的第一视角构图，BGM 用音频1" -o out \\
      --ref-image scene.jpg --ref-video ref.mp4 --ref-audio bgm.mp3

  # fast 模型 + 3 个变体并发
  python3 generate.py "国风水墨长卷动画" -o out --fast -n 3 -a 21:9
""",
    )
    p.add_argument("prompt", help="视频生成提示词（文本）")
    p.add_argument("-o", "--output-dir", required=True, help="输出目录（mp4 与可选尾帧 png）")
    p.add_argument("-r", "--resolution", default="1080p", choices=VALID_RESOLUTIONS,
                   help="分辨率，默认 1080p（fast 不支持 1080p 会自动降到 720p）")
    p.add_argument("-a", "--aspect-ratio", default="adaptive", choices=VALID_RATIOS,
                   help="宽高比，默认 adaptive（由模型按提示词/参考素材自适应）")
    p.add_argument("-d", "--duration", type=int, default=-1,
                   help="时长（秒），4-15 的整数；-1（默认）由模型智能选择")
    p.add_argument("-n", "--num", type=int, default=1,
                   help="并发生成的视频数量（不同 seed 的变体），1-5，默认 1")
    p.add_argument("-m", "--model", default=DEFAULT_MODEL,
                   help=f"完整 model id，默认 {DEFAULT_MODEL}（pro）")
    p.add_argument("--fast", action="store_true",
                   help=f"等价于 -m {MODEL_FAST}（与 -m 互斥；同时指定时 --fast 优先）")
    p.add_argument("--no-audio", action="store_true",
                   help="生成无声视频（默认有声，模型会基于 prompt 与画面自动生成人声/音效/BGM）")
    p.add_argument("--watermark", action="store_true",
                   help="开启右下角 AI 水印（默认关闭）")
    p.add_argument("--seed", type=int, default=-1,
                   help="随机种子（-1 随机；n>1 时按 +i 偏移生成多个 seed）")
    p.add_argument("--ref-image", action="append", default=[], metavar="PATH_OR_URL",
                   help="参考图（本地路径或 URL），可多次。prompt 中用「图1」「图2」按传入顺序指代")
    p.add_argument("--ref-video", action="append", default=[], metavar="PATH_OR_URL",
                   help="参考视频（仅 Seedance 2.0 支持），可多次。prompt 中用「视频1」「视频2」指代")
    p.add_argument("--ref-audio", action="append", default=[], metavar="PATH_OR_URL",
                   help="参考音频（仅 Seedance 2.0 支持），可多次。必须配合至少一个 --ref-image 或 --ref-video")
    p.add_argument("--last-frame", action="store_true",
                   help="同时下载视频尾帧 png（用于做连续视频）")
    p.add_argument("--priority", type=int, default=0,
                   help="任务优先级 0-9，数值越大越优先（同 endpoint 内生效），默认 0")
    p.add_argument("--max-wait", type=int, default=1800,
                   help="单任务最大等待秒数，超时返回 timeout 状态，默认 1800（30 分钟）")
    p.add_argument("--poll-interval", type=int, default=30,
                   help="任务状态轮询间隔秒数，默认 30（火山官方推荐）")
    p.add_argument("--callback-url",
                   help="可选 webhook，任务状态变化时火山会 POST 推送")
    args = p.parse_args()
    run(args)


if __name__ == "__main__":
    main()
