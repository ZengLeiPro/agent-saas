#!/usr/bin/env python3
"""
录音文件转文字工具 - 基于阿里云百炼 fun-asr 模型

用法：
  python3 transcribe.py <音频文件或URL> [选项]

示例：
  python3 transcribe.py meeting.mp3
  python3 transcribe.py meeting.wav --speaker        # 启用说话人分离
  python3 transcribe.py meeting.mp3 -o output.txt    # 指定输出文件
  python3 transcribe.py 'https://xxx.com/audio.mp3'  # 直接传URL
  python3 transcribe.py meeting.mp3 --model paraformer-v2  # 更便宜的模型

支持格式：mp3, wav, aac, ogg, flac, m4a, mp4, mov 等主流音视频格式
单文件上限：12小时 / 2GB
费用：fun-asr ≈ 0.79 元/小时，paraformer-v2 ≈ 0.29 元/小时

环境变量：
  DASHSCOPE_API_KEY  - 百炼 API Key（必需）
  OSS_ACCESS_KEY_ID  - 阿里云 AK（本地文件上传需要，必须由 secret/env 注入）
  OSS_ACCESS_KEY_SECRET - 阿里云 SK（必须由 secret/env 注入）
  OSS_BUCKET - OSS bucket（必须由 secret/env 注入）
"""

import argparse
from datetime import datetime
import json
import os
import sys
import time
import urllib.request
from urllib.parse import urlparse
import uuid
from pathlib import Path

API_KEY = os.environ.get("DASHSCOPE_API_KEY", "")

# OSS 配置（用于本地大文件上传）
OSS_AK = os.environ.get("OSS_ACCESS_KEY_ID")
OSS_SK = os.environ.get("OSS_ACCESS_KEY_SECRET")
OSS_BUCKET = os.environ.get("OSS_BUCKET")
OSS_ENDPOINT = os.environ.get("OSS_ENDPOINT", "https://oss-cn-shenzhen.aliyuncs.com")

try:
    import dashscope
    from dashscope.audio.asr import Transcription
except ImportError:
    print("错误：请先安装 dashscope SDK")
    print("请在工作区内置 .venv 中安装依赖：")
    print("  python3 -m pip install dashscope oss2")
    sys.exit(1)


def upload_to_oss(file_path: str) -> str:
    """上传本地文件到 OSS，返回签名 URL"""
    missing = [
        name for name, value in {
            "OSS_ACCESS_KEY_ID": OSS_AK,
            "OSS_ACCESS_KEY_SECRET": OSS_SK,
            "OSS_BUCKET": OSS_BUCKET,
        }.items()
        if not value
    ]
    if missing:
        print("错误：本地文件转写需要先上传到 OSS，但缺少以下环境变量：")
        for name in missing:
            print(f"  - {name}")
        print("请由管理员通过 ACS secret/env 注入，不要把 AK/SK 写入 skill 或对话。")
        sys.exit(1)

    try:
        import oss2
    except ImportError:
        print("错误：大文件上传需要 oss2 SDK")
        print("请在工作区内置 .venv 中安装依赖：")
        print("  python3 -m pip install dashscope oss2")
        sys.exit(1)

    suffix = Path(file_path).suffix.lower()
    if len(suffix) > 12:
        suffix = ""
    oss_key = f"tmp/transcribe/{uuid.uuid4().hex}{suffix}"

    print(f"上传到 OSS 临时对象: {oss_key} ...")
    auth = oss2.Auth(OSS_AK, OSS_SK)
    bucket = oss2.Bucket(auth, OSS_ENDPOINT, OSS_BUCKET)

    oss2.resumable_upload(
        bucket, oss_key, file_path,
        multipart_threshold=50 * 1024 * 1024,
        part_size=10 * 1024 * 1024,
        num_threads=4,
    )

    # 签名 URL，24小时有效
    file_url = bucket.sign_url("GET", oss_key, 86400)
    print("上传完成")
    return file_url, bucket, oss_key


def submit_task(file_urls: list, model: str, enable_speaker: bool) -> str:
    """提交转写任务，返回 task_id"""
    params = {
        "model": model,
        "file_urls": file_urls,
        "language_hints": ["zh", "en"],
        "api_key": API_KEY,
    }
    if enable_speaker:
        params["diarization_enabled"] = True
        params["speaker_count"] = 0

    print(f"提交转写任务 (模型: {model}, 说话人分离: {'是' if enable_speaker else '否'}) ...")
    resp = Transcription.async_call(**params)

    if resp.status_code != 200:
        raise RuntimeError(f"提交失败: {resp.status_code} - {resp.message}")

    task_id = resp.output.task_id
    print(f"任务已提交, task_id: {task_id}")
    return task_id


def wait_result(task_id: str):
    """轮询等待转写结果"""
    print("等待转写完成", end="", flush=True)
    start = time.time()
    while True:
        resp = Transcription.fetch(task=task_id, api_key=API_KEY)
        status = resp.output.task_status

        if status == "SUCCEEDED":
            elapsed = time.time() - start
            print(f" 完成! (耗时 {elapsed:.0f}s)")
            return resp.output
        elif status == "FAILED":
            print(" 失败!")
            raise RuntimeError(f"转写失败: {resp.output}")
        else:
            print(".", end="", flush=True)
            time.sleep(5)


def format_output(result, enable_speaker: bool, show_timestamp: bool) -> str:
    """格式化转写结果为可读文本"""
    lines = []

    if hasattr(result, "results"):
        results = result.results
    elif isinstance(result, dict):
        results = result.get("results", [])
    else:
        results = []

    if not results:
        return "（无转写结果）"

    for file_result in results:
        if isinstance(file_result, dict):
            trans_url = file_result.get("transcription_url", "")
        else:
            trans_url = getattr(file_result, "transcription_url", "")

        if not trans_url:
            continue

        with urllib.request.urlopen(trans_url, timeout=30) as resp:
            detail = json.loads(resp.read().decode("utf-8"))

        transcripts = detail.get("transcripts", [])
        for t in transcripts:
            sentences = t.get("sentences", [])
            for s in sentences:
                text = s.get("text", "").strip()
                if not text:
                    continue

                prefix = ""
                if show_timestamp:
                    begin_time = s.get("begin_time", 0) / 1000
                    h = int(begin_time // 3600)
                    m = int((begin_time % 3600) // 60)
                    sec = int(begin_time % 60)
                    prefix = f"[{h:02d}:{m:02d}:{sec:02d}] "

                if enable_speaker and "speaker_id" in s:
                    speaker = f"说话人{s['speaker_id']}"
                    lines.append(f"{prefix}{speaker}: {text}")
                else:
                    lines.append(f"{prefix}{text}")

    return "\n".join(lines) if lines else "（无转写结果）"


def main():
    parser = argparse.ArgumentParser(
        description="录音文件转文字 (阿里云百炼 fun-asr)",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("input", help="音频文件路径或 URL")
    parser.add_argument("-o", "--output", help="输出文件路径（默认保存到 assets/yyyymmdd/）")
    parser.add_argument(
        "--speaker", action="store_true",
        help="启用说话人分离（多人对话场景推荐）",
    )
    parser.add_argument(
        "--model", default="fun-asr",
        choices=["fun-asr", "paraformer-v2", "paraformer-v1"],
        help="识别模型（默认 fun-asr，效果最好；paraformer-v2 最便宜）",
    )
    parser.add_argument(
        "--no-timestamp", action="store_true",
        help="输出不带时间戳",
    )

    args = parser.parse_args()

    if not API_KEY:
        print("错误：未设置 DASHSCOPE_API_KEY 环境变量")
        print()
        print("获取方式：")
        print("  1. 访问 https://bailian.console.aliyun.com/#/api-key")
        print("  2. 创建或复制一个 API Key")
        print('  3. export DASHSCOPE_API_KEY="sk-xxxxxxxx"')
        sys.exit(1)

    dashscope.api_key = API_KEY

    input_path = args.input
    oss_bucket = None
    oss_key = None

    if input_path.startswith("http://") or input_path.startswith("https://"):
        file_url = input_path
    else:
        abs_path = str(Path(input_path).resolve())
        if not os.path.isfile(abs_path):
            print(f"错误：文件不存在: {abs_path}")
            sys.exit(1)
        size_mb = os.path.getsize(abs_path) / (1024 * 1024)
        print(f"文件大小: {size_mb:.1f} MB")
        if size_mb > 2048:
            print("错误：文件超过 2GB 上限")
            sys.exit(1)
        file_url, oss_bucket, oss_key = upload_to_oss(abs_path)

    try:
        task_id = submit_task([file_url], args.model, args.speaker)
        result = wait_result(task_id)
        show_ts = not args.no_timestamp
        text = format_output(result, args.speaker, show_ts)

        if args.output:
            out_path = Path(args.output)
        else:
            today = datetime.now().strftime("%Y%m%d")
            if input_path.startswith("http://") or input_path.startswith("https://"):
                parsed_name = Path(urlparse(input_path).path).stem or "音频转写"
            else:
                parsed_name = Path(input_path).stem or "音频转写"
            out_path = Path("assets") / today / f"{parsed_name}-转写.txt"

        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        print(f"\n结果已保存到: {out_path}")
        preview = text.split("\n")[:5]
        print("预览：")
        for line in preview:
            print(f"  {line}")
        total = len(text.split("\n"))
        if total > 5:
            print(f"  ... (共 {total} 行)")

        rate = {"fun-asr": 0.79, "paraformer-v2": 0.29, "paraformer-v1": 0.29}
        print(f"\n模型: {args.model}，参考价格: {rate.get(args.model, 0.79):.2f} 元/小时")
    finally:
        # 清理 OSS 临时文件
        if oss_bucket and oss_key:
            try:
                oss_bucket.delete_object(oss_key)
                print("OSS 临时文件已清理")
            except Exception as exc:
                print(f"警告：OSS 临时文件清理失败，请人工检查: {oss_key} ({exc})")


if __name__ == "__main__":
    main()
