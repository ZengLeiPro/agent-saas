#!/usr/bin/env python3
"""
视频字幕提取模块

使用 Whisper 从视频中提取字幕，支持多种模型和输出格式。
"""

import argparse
from datetime import datetime
import os
import platform
import sys
from pathlib import Path

def extract_subtitles(video_path: str, output_dir: str = None, model: str = "medium"):
    """
    从视频中提取字幕

    Args:
        video_path: 视频文件路径
        output_dir: 输出目录（默认与视频同目录）
        model: Whisper 模型名称（tiny/base/medium/large）

    Returns:
        dict: 包含生成的文件路径
    """
    video_path = Path(video_path).resolve()
    if not video_path.exists():
        raise FileNotFoundError(f"视频文件不存在: {video_path}")

    # 设置输出目录
    if output_dir is None:
        output_dir = Path("assets") / datetime.now().strftime("%Y%m%d") / "video-subtitle" / video_path.stem
    else:
        output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    output_name = video_path.stem
    srt_path = output_dir / f"{output_name}.srt"
    txt_path = output_dir / f"{output_name}.txt"

    print(f"正在提取字幕...")
    print(f"视频: {video_path}")
    print(f"模型: {model}")

    # Linux/ACS 优先使用 faster-whisper；macOS 且已安装时可回退 MLX Whisper。
    try:
        from faster_whisper import WhisperModel

        model_name = "large-v3" if model == "large" else model
        device = os.environ.get("WHISPER_DEVICE", "cpu")
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
        whisper = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments_iter, info = whisper.transcribe(str(video_path), vad_filter=True)
        segments = []
        text_parts = []
        for segment in segments_iter:
            text = segment.text.strip()
            segments.append({
                "start": segment.start,
                "end": segment.end,
                "text": text,
            })
            if text:
                text_parts.append(text)
        result = {
            "segments": segments,
            "text": "\n".join(text_parts),
            "language": getattr(info, "language", "unknown"),
        }
        backend = "faster-whisper"
    except ImportError:
        if platform.system() != "Darwin":
            print("错误: 当前环境未安装 Linux 可用的 faster-whisper。")
            print("请在工作区内置 .venv 中安装依赖，或由 ACS 镜像预置：")
            print("  python3 -m pip install faster-whisper")
            print("不要使用 mlx-whisper；它主要面向 Apple Silicon。")
            sys.exit(1)
        try:
            import mlx_whisper
        except ImportError:
            print("错误: 未安装 faster-whisper 或 mlx-whisper。")
            print("请在工作区内置 .venv 中安装依赖，不要写系统 Python。")
            sys.exit(1)
        result = mlx_whisper.transcribe(
            str(video_path),
            path_or_hf_repo=f'mlx-community/whisper-{model}'
        )
        backend = "mlx-whisper"
    print(f"后端: {backend}")

    # 保存 SRT 字幕
    def format_time(seconds):
        """将秒数转换为 SRT 时间格式"""
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        millis = int((seconds % 1) * 1000)
        return f'{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}'

    with open(srt_path, 'w', encoding='utf-8') as f:
        for i, segment in enumerate(result['segments'], 1):
            f.write(f'{i}\n')
            f.write(f'{format_time(segment["start"])} --> {format_time(segment["end"])}\n')
            f.write(f'{segment["text"].strip()}\n\n')

    # 保存 TXT 文本
    with open(txt_path, 'w', encoding='utf-8') as f:
        f.write(result['text'])

    detected_lang = result.get('language', 'unknown')

    print(f'\n✅ 字幕提取完成！')
    print(f'SRT 文件: {srt_path}')
    print(f'TXT 文件: {txt_path}')
    print(f'检测到的语言: {detected_lang}')

    return {
        'srt': str(srt_path),
        'txt': str(txt_path),
        'language': detected_lang
    }


def main():
    parser = argparse.ArgumentParser(description='从视频中提取字幕')
    parser.add_argument('video', help='视频文件路径')
    parser.add_argument('-o', '--output', help='输出目录')
    parser.add_argument('-m', '--model', default='medium',
                        choices=['tiny', 'base', 'medium', 'large'],
                        help='Whisper 模型（默认: medium）')

    args = parser.parse_args()
    extract_subtitles(args.video, args.output, args.model)


if __name__ == '__main__':
    main()
