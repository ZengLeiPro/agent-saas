#!/usr/bin/env python3
"""
完整流程：提取字幕 → 翻译字幕 → 烧录字幕

整合所有模块的完整工作流程。
"""

import argparse
import sys
from pathlib import Path

# 导入各模块
from extract import extract_subtitles
from translate import translate_subtitles
from burn import burn_subtitles


def full_process(
    video_path: str,
    target_lang: str = "zh",
    output_dir: str = None,
    model: str = "medium",
    style: str = None,
    api_key: str = None,
    base_url: str = None,
    ai_model: str = "glm-4.7",
    keep_temp: bool = False
):
    """
    完整的字幕处理流程

    Args:
        video_path: 视频文件路径
        target_lang: 目标翻译语言
        output_dir: 输出目录
        model: Whisper 模型
        style: 字幕样式
        api_key: 翻译 API Key
        base_url: 翻译 API Base URL
        ai_model: 翻译 AI 模型
        keep_temp: 是否保留中间文件

    Returns:
        dict: 包含所有输出文件路径
    """
    print("=" * 60)
    print("视频字幕处理完整流程")
    print("=" * 60)

    video_path = Path(video_path).resolve()
    if not video_path.exists():
        raise FileNotFoundError(f"视频文件不存在: {video_path}")

    # 设置输出目录
    if output_dir is None:
        output_dir = video_path.parent
    else:
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)

    results = {}

    # 步骤 1: 提取字幕
    print("\n[步骤 1/3] 提取字幕")
    print("-" * 60)
    extract_result = extract_subtitles(
        str(video_path),
        output_dir=str(output_dir),
        model=model
    )
    results['original_srt'] = extract_result['srt']
    results['original_txt'] = extract_result['txt']

    # 步骤 2: 翻译字幕
    print("\n[步骤 2/3] 翻译字幕")
    print("-" * 60)
    translated_srt = translate_subtitles(
        results['original_srt'],
        target_lang=target_lang,
        api_key=api_key,
        base_url=base_url,
        model=ai_model
    )
    results['translated_srt'] = translated_srt

    # 步骤 3: 烧录字幕
    print("\n[步骤 3/3] 烧录字幕到视频")
    print("-" * 60)
    output_video = burn_subtitles(
        str(video_path),
        translated_srt,
        output_path=str(output_dir / f"{video_path.stem}_with_subtitles{video_path.suffix}"),
        style=style
    )
    results['output_video'] = output_video

    # 清理临时文件
    if not keep_temp:
        print("\n[清理] 删除中间文件...")
        temp_files = [
            results['original_srt'],
            results['original_txt'],
            results['translated_srt']
        ]
        for temp_file in temp_files:
            try:
                Path(temp_file).unlink()
                print(f"  删除: {temp_file}")
            except Exception as e:
                print(f"  警告: 无法删除 {temp_file}: {e}")

    # 输出摘要
    print("\n" + "=" * 60)
    print("✅ 处理完成！")
    print("=" * 60)
    print(f"\n生成的文件:")
    print(f"  • 带字幕视频: {results['output_video']}")
    if keep_temp:
        print(f"  • 原始字幕: {results['original_srt']}")
        print(f"  • 原始文本: {results['original_txt']}")
        print(f"  • 翻译字幕: {results['translated_srt']}")

    return results


def main():
    parser = argparse.ArgumentParser(
        description='视频字幕处理完整流程（提取 → 翻译 → 烧录）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例用法:
  # 基本用法：翻译成中文
  python full.py video.mp4

  # 翻译成英文
  python full.py video.mp4 --to en

  # 指定输出目录
  python full.py video.mp4 --output ./output

  # 使用大型 Whisper 模型（更准确但更慢）
  python full.py video.mp4 --model large

  # 保留中间文件
  python full.py video.mp4 --keep-temp

  # 自定义字幕样式
  python full.py video.mp4 --style "FontSize=20,Alignment=2"
        """
    )

    parser.add_argument('video', help='视频文件路径')
    parser.add_argument('-t', '--to', default='zh',
                        help='目标语言（默认: zh=中文）')
    parser.add_argument('-o', '--output', help='输出目录')
    parser.add_argument('-m', '--model', default='medium',
                        choices=['tiny', 'base', 'medium', 'large'],
                        help='Whisper 模型（默认: medium）')
    parser.add_argument('-s', '--style',
                        help='字幕样式（ASS 格式）')
    parser.add_argument('-k', '--api-key', help='翻译 API Key')
    parser.add_argument('-u', '--base-url', help='翻译 API Base URL')
    parser.add_argument('--ai-model', default='glm-4.7',
                        help='翻译 AI 模型（默认: glm-4.7）')
    parser.add_argument('--keep-temp', action='store_true',
                        help='保留中间文件（字幕文件）')

    args = parser.parse_args()

    try:
        full_process(
            args.video,
            target_lang=args.to,
            output_dir=args.output,
            model=args.model,
            style=args.style,
            api_key=args.api_key,
            base_url=args.base_url,
            ai_model=args.ai_model,
            keep_temp=args.keep_temp
        )
    except Exception as e:
        print(f"\n错误: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
