#!/usr/bin/env python3
"""从视频/音频平台下载媒体，或从本地视频提取音频。"""

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

PLATFORMS = {
    'bilibili':  ([r'bilibili\.com', r'b23\.tv'],              '高清（≥1080p）需 cookies，无 cookies 仅 360/480p'),
    'douyin':    ([r'douyin\.com', r'iesdouyin\.com'],          None),
    'xiaohongshu': ([r'xiaohongshu\.com', r'xhslink\.com'],    '视频下载通常需 cookies'),
    'weibo':     ([r'weibo\.com', r'weibo\.cn'],                None),
    'tencent':   ([r'v\.qq\.com', r'film\.qq\.com'],            'VIP 内容需 cookies'),
    'youku':     ([r'youku\.com'],                              'VIP 内容需 cookies'),
    'iqiyi':     ([r'iqiyi\.com'],                              'VIP 内容需 cookies'),
    'xigua':     ([r'ixigua\.com'],                             None),
    'acfun':     ([r'acfun\.cn'],                               None),
    'tiktok':    ([r'tiktok\.com', r'vm\.tiktok\.com'],         None),
    'twitter':   ([r'twitter\.com', r'x\.com', r't\.co'],        None),
    'youtube':   ([r'youtube\.com', r'youtu\.be'],              None),
    'sohu':      ([r'tv\.sohu\.com', r'sohu\.com/a/'],          None),
}

FORMAT_MAP = {
    'best':   'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '1080p':  'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best',
    '720p':   'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best',
    '480p':   'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best',
}

CODEC_MAP = {
    'mp3': 'libmp3lame', 'm4a': 'aac', 'wav': 'pcm_s16le',
    'aac': 'aac', 'flac': 'flac', 'opus': 'libopus',
}


def detect_platform(url):
    for name, (patterns, tip) in PLATFORMS.items():
        if any(re.search(p, url, re.I) for p in patterns):
            return name, tip
    return None, None


def is_url(s):
    return bool(re.match(r'https?://', s, re.I))


def default_output_dir():
    path = Path("assets") / dt.datetime.now().strftime("%Y%m%d") / "media-download"
    path.mkdir(parents=True, exist_ok=True)
    return path


def require_cmd(name):
    if shutil.which(name):
        return
    print(
        f"缺少依赖: {name}。ACS Sandbox 应由镜像预置该命令，"
        "不要在 skill 运行期使用 Homebrew、apt-get 或系统级安装；请复核镜像依赖。",
        file=sys.stderr,
    )
    sys.exit(2)


def resolve_local_output(input_file, output_arg, audio_format):
    if output_arg:
        out = Path(output_arg)
        if output_arg.endswith(os.sep) or (out.exists() and out.is_dir()):
            out.mkdir(parents=True, exist_ok=True)
            return out / f"{Path(input_file).stem}.{audio_format}"
        out.parent.mkdir(parents=True, exist_ok=True)
        return out
    return default_output_dir() / f"{Path(input_file).stem}.{audio_format}"


def resolve_download_template(output_arg):
    if output_arg:
        out = Path(output_arg)
        if output_arg.endswith(os.sep) or out.suffix == "" or (out.exists() and out.is_dir()):
            out.mkdir(parents=True, exist_ok=True)
            return str(out / "%(title)s.%(ext)s")
        out.parent.mkdir(parents=True, exist_ok=True)
        return str(out)
    return str(default_output_dir() / "%(title)s.%(ext)s")


def extract_audio_local(input_file, output_file, audio_format, overwrite=False):
    """用 ffmpeg 从本地视频提取音频。"""
    require_cmd('ffmpeg')
    if os.path.exists(output_file) and not overwrite:
        print(f"输出文件已存在: {output_file}。如需覆盖请显式传 --overwrite。", file=sys.stderr)
        sys.exit(1)
    codec = CODEC_MAP.get(audio_format, 'libmp3lame')
    cmd = ['ffmpeg', '-i', input_file, '-vn', '-acodec', codec]
    # mp3/m4a/aac 加质量参数
    if audio_format in ('mp3', 'm4a', 'aac'):
        cmd += ['-q:a', '2']
    cmd += ['-y' if overwrite else '-n', str(output_file)]

    print(f"提取音频: {input_file} -> {output_file}", file=sys.stderr)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        # 只打印 stderr 最后 500 字符，避免刷屏
        print(f"音频提取失败:\n{r.stderr[-500:]}", file=sys.stderr)
        sys.exit(1)

    mb = os.path.getsize(output_file) / 1048576
    print(f"完成: {output_file} ({mb:.1f} MB)")


def show_info(url, args):
    """查看视频信息，不下载。"""
    require_cmd('yt-dlp')
    cmd = ['yt-dlp', '--dump-json', '--no-download']
    if args.cookies:
        cmd += ['--cookies', args.cookies]
    elif args.cookies_from_browser:
        cmd += ['--cookies-from-browser', args.cookies_from_browser]
    cmd.append(url)

    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"获取信息失败:\n{r.stderr[-500:]}", file=sys.stderr)
        sys.exit(1)

    info = json.loads(r.stdout)
    d = info.get('duration', 0)
    parts = []
    if d:
        if d >= 3600: parts.append(f"{d // 3600}h")
        parts.append(f"{d % 3600 // 60}m{d % 60}s")
    dur = ''.join(parts) or 'N/A'

    print(f"标题: {info.get('title', 'N/A')}")
    print(f"时长: {dur}")
    print(f"平台: {info.get('extractor', 'N/A')}")
    print(f"上传者: {info.get('uploader', 'N/A')}")

    heights = sorted(set(
        f.get('height', 0) for f in (info.get('formats') or []) if f.get('height')
    ))
    if heights:
        print(f"分辨率: {', '.join(f'{h}p' for h in heights)}")


def download_url(url, args):
    """用 yt-dlp 从 URL 下载。"""
    require_cmd('yt-dlp')
    if args.audio_only:
        require_cmd('ffmpeg')
    platform, tip = detect_platform(url)

    cmd = ['yt-dlp']

    # Cookies 处理
    if args.cookies:
        cmd += ['--cookies', args.cookies]
    elif args.cookies_from_browser:
        cmd += ['--cookies-from-browser', args.cookies_from_browser]
    elif tip:
        print(f"提示: {platform} - {tip}", file=sys.stderr)
        print("  推荐让用户上传 Netscape cookies 文件到 uploads/ 后用 --cookies 指定", file=sys.stderr)

    # 音频 or 视频
    if args.audio_only:
        cmd += ['-x', '--audio-format', args.audio_format]
    else:
        cmd += ['-f', FORMAT_MAP.get(args.quality, FORMAT_MAP['best'])]

    # 输出路径
    cmd += ['-o', resolve_download_template(args.output)]

    # 默认不下载播放列表
    if not args.playlist:
        cmd.append('--no-playlist')

    # 下载完成后打印最终文件路径到 stdout
    cmd += ['--print', 'after_move:filepath']
    cmd += ['--newline', url]

    label = platform or '未知平台'
    mode = '音频' if args.audio_only else '视频'
    print(f"[{label}] 下载{mode}...", file=sys.stderr)

    r = subprocess.run(cmd)
    if r.returncode != 0:
        print(f"\n下载失败（退出码 {r.returncode}）", file=sys.stderr)
        if tip:
            print(f"建议: {tip}", file=sys.stderr)
            print("  优先请用户上传 Netscape cookies 文件到 uploads/ 后用 --cookies 指定", file=sys.stderr)
        print(f"如果 yt-dlp 无法处理该链接，可手动下载后传本地文件路径", file=sys.stderr)
        sys.exit(1)


def main():
    p = argparse.ArgumentParser(
        description='从视频平台下载媒体文件，或从本地视频提取音频',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  %(prog)s "https://www.bilibili.com/video/BV1xx411c7mD"
  %(prog)s -a "https://www.douyin.com/video/xxx"
  %(prog)s -a --cookies uploads/site.cookies.txt "URL"
  %(prog)s -a local_video.mp4
  %(prog)s --info "URL"
""")
    p.add_argument('input', help='视频 URL 或本地文件路径')
    p.add_argument('-a', '--audio-only', action='store_true',
                   help='仅提取音频（URL 场景用 yt-dlp -x，本地场景用 ffmpeg）')
    p.add_argument('--audio-format', default='mp3',
                   choices=['mp3', 'm4a', 'wav', 'aac', 'flac', 'opus'],
                   help='音频格式（默认 mp3）')
    p.add_argument('-q', '--quality', default='best',
                   choices=['best', '1080p', '720p', '480p'],
                   help='视频质量（默认 best）')
    p.add_argument('-o', '--output', help='输出文件路径或目录')
    p.add_argument('--cookies', help='cookies 文件路径（Netscape 格式）')
    p.add_argument('--cookies-from-browser', metavar='BROWSER',
                   choices=['chrome', 'firefox'],
                   help='从容器内浏览器 profile 导入 cookies（仅在用户确认授权且 profile 存在时使用）')
    p.add_argument('--info', action='store_true',
                   help='仅查看视频信息，不下载')
    p.add_argument('--playlist', action='store_true',
                   help='下载完整播放列表（默认仅单视频）')
    p.add_argument('--overwrite', action='store_true',
                   help='允许覆盖已存在的本地音频提取输出文件')

    args = p.parse_args()

    if not is_url(args.input):
        # 本地文件
        if not os.path.exists(args.input):
            print(f"文件不存在: {args.input}", file=sys.stderr)
            sys.exit(1)
        if not args.audio_only:
            print("本地文件无需下载。如需提取音频，请加 -a 参数", file=sys.stderr)
            sys.exit(1)
        out = resolve_local_output(args.input, args.output, args.audio_format)
        extract_audio_local(args.input, out, args.audio_format, args.overwrite)
    elif args.info:
        show_info(args.input, args)
    else:
        download_url(args.input, args)


if __name__ == '__main__':
    main()
