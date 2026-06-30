#!/usr/bin/env python3
"""
字幕烧录模块

使用 FFmpeg 将字幕烧录到视频中，支持自定义样式。
"""

import argparse
import os
import subprocess
import sys
from pathlib import Path


def burn_subtitles(
    video_path: str,
    srt_path: str,
    output_path: str = None,
    style: str = None
):
    """
    将字幕烧录到视频中

    Args:
        video_path: 视频文件路径
        srt_path: SRT 字幕文件路径
        output_path: 输出视频路径（默认在原文件名后加 _with_subtitles）
        style: 字幕样式（ASS 样式格式）

    Returns:
        str: 输出视频路径
    """
    video_path = Path(video_path).resolve()
    srt_path = Path(srt_path).resolve()

    if not video_path.exists():
        raise FileNotFoundError(f"视频文件不存在: {video_path}")
    if not srt_path.exists():
        raise FileNotFoundError(f"字幕文件不存在: {srt_path}")

    # 设置输出路径
    if output_path is None:
        output_path = video_path.parent / f"{video_path.stem}_with_subtitles{video_path.suffix}"
    else:
        output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists():
        raise FileExistsError(f"输出文件已存在，避免覆盖: {output_path}")

    # 默认字幕样式
    if style is None:
        style = 'Fontname=Noto Sans CJK SC,FontSize=18,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=30'

    print(f"正在烧录字幕到视频...")
    print(f"视频: {video_path}")
    print(f"字幕: {srt_path}")
    print(f"输出: {output_path}")

    # 构建 ffmpeg 命令
    # 需要转义字幕路径中的特殊字符
    srt_path_escaped = str(srt_path).replace(':', '\\:').replace(',', '\\,')

    cmd = [
        'ffmpeg',
        '-i', str(video_path),
        '-vf', f"subtitles={srt_path_escaped}:force_style='{style}'",
        '-c:a', 'copy',  # 音频直接复制，不重新编码
        '-n',  # 不覆盖输出文件
        str(output_path)
    ]

    # 执行 ffmpeg
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=True
        )
    except subprocess.CalledProcessError as e:
        print(f"错误: ffmpeg 执行失败")
        print(f"stderr: {e.stderr}")
        sys.exit(1)
    except FileNotFoundError:
        print("错误: 未安装 ffmpeg")
        print("请确认 ACS 镜像已预置 ffmpeg，或由管理员处理运行时依赖。")
        sys.exit(1)

    # 获取输出文件大小
    file_size = output_path.stat().st_size
    size_mb = file_size / (1024 * 1024)

    print(f'\n✅ 字幕烧录完成！')
    print(f'输出文件: {output_path}')
    print(f'文件大小: {size_mb:.1f} MB')

    return str(output_path)


def main():
    parser = argparse.ArgumentParser(description='将字幕烧录到视频中')
    parser.add_argument('video', help='视频文件路径')
    parser.add_argument('srt', help='SRT 字幕文件路径')
    parser.add_argument('-o', '--output', help='输出视频路径')
    parser.add_argument('-s', '--style',
                        help='字幕样式（ASS 格式，如: "FontSize=20,Alignment=2"）')

    args = parser.parse_args()
    burn_subtitles(args.video, args.srt, args.output, args.style)


if __name__ == '__main__':
    main()
