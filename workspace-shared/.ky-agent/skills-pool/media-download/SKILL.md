---
name: media-download
description: 从视频/音频平台下载媒体文件，或从本地视频提取纯音频。当用户提供视频链接（B站、抖音、YouTube、小红书、微博、腾讯视频、优酷、西瓜、TikTok、X/Twitter 等）需要下载，或需要从本地视频中提取音频轨时使用。本 skill 只负责「获取文件」——下载视频/音频、提取音频轨，不做语音识别，不做字幕。与 audio-transcribe 配合构成「视频链接 → 音频 → 转录文字」完整链路。不要在用户只是讨论视频内容而不需要下载时触发。
---

# Media Download

从各视频/音频平台下载媒体文件，或从本地视频提取纯音频。底层：yt-dlp（URL 下载）+ ffmpeg（本地音频提取）。

## 支持平台

| 平台 | 需要 Cookies | 备注 |
|------|:---:|------|
| YouTube | 否 | 完整支持 |
| B站 Bilibili | 高清需要 | 无 cookies 仅 360/480p |
| 抖音 Douyin | 否 | |
| 西瓜视频 | 否 | |
| 微博视频 | 否 | |
| TikTok | 否 | |
| X / Twitter | 否 | 含 Spaces 录音 |
| AcFun | 否 | |
| 搜狐视频 | 否 | |
| 小红书 | 通常需要 | |
| 腾讯视频 | VIP 需要 | |
| 优酷 | VIP 需要 | |
| 爱奇艺 | VIP 需要 | |

以及 yt-dlp 支持的其他 1000+ 站点。**不支持快手、芒果TV**。

## 使用方式

```bash
# === 从 URL 下载 ===

# 下载视频（最佳质量 MP4，默认输出到 assets/yyyymmdd/media-download/）
python3 <media-download skill dir>/scripts/download.py "URL"

# 仅提取音频（最核心场景 —— 下载后交给 audio-transcribe 转录）
python3 <media-download skill dir>/scripts/download.py -a "URL"

# 指定输出目录
python3 <media-download skill dir>/scripts/download.py -a -o assets/20260630/media-download/ "URL"

# 指定视频质量
python3 <media-download skill dir>/scripts/download.py -q 720p "URL"

# 使用浏览器 cookies（B站高清/VIP内容/需登录平台）
python3 <media-download skill dir>/scripts/download.py --cookies uploads/site.cookies.txt "URL"

# 查看视频信息（不下载）
python3 <media-download skill dir>/scripts/download.py --info "URL"

# 下载播放列表
python3 <media-download skill dir>/scripts/download.py --playlist "URL"

# === 本地视频提取音频 ===

# 从本地视频提取 mp3 音频
python3 <media-download skill dir>/scripts/download.py -a uploads/video.mp4

# 指定音频格式
python3 <media-download skill dir>/scripts/download.py -a --audio-format m4a uploads/video.mp4

# 指定输出路径
python3 <media-download skill dir>/scripts/download.py -a -o assets/20260630/media-download/video.mp3 uploads/video.mp4
```

脚本路径必须从当前 skill 目录解析，不要假设 workspace 下存在 `.claude/skills/media-download/`。

## 参数说明

| 参数 | 说明 |
|------|------|
| `input` | 视频 URL 或本地文件路径（必需） |
| `-a, --audio-only` | 仅提取音频（URL 用 yt-dlp -x，本地用 ffmpeg） |
| `--audio-format` | 音频格式：mp3（默认）/ m4a / wav / aac / flac / opus |
| `-q, --quality` | 视频质量：best（默认）/ 1080p / 720p / 480p |
| `-o, --output` | 输出文件路径或目录 |
| `--cookies` | cookies 文件路径（Netscape 格式，优先使用用户上传到 `uploads/` 的文件） |
| `--cookies-from-browser` | 从容器内浏览器 profile 导入 cookies（chrome / firefox）；仅在用户确认授权且 profile 确实存在时使用 |
| `--info` | 仅显示视频信息，不下载 |
| `--playlist` | 下载完整播放列表（默认仅单个视频） |

## 核心工作流

### 视频链接 → 转录文字（最常用）

```
1. media-download -a "URL"  →  得到 mp3 文件
2. audio-transcribe mp3文件  →  得到转录文本
```

这是本 skill 存在的核心价值：补上「URL → 本地音频」这一环，让 audio-transcribe 能覆盖任意视频平台。

### 视频链接 → 加字幕

```
1. media-download "URL"  →  得到视频文件
2. video-subtitle  →  提取/翻译/烧录字幕
```

## 下载失败排查

| 症状 | 解法 |
|------|------|
| 平台不支持 | 手动在浏览器下载，然后传本地文件路径 |
| 需要登录 | 优先请用户导出/上传 Netscape cookies 文件到 `uploads/`，再用 `--cookies uploads/site.cookies.txt` |
| yt-dlp 报错 | 先用 `--info` 只读探测；若是 extractor 过旧，报告 ACS 镜像依赖缺口 |
| 链接无法解析 | 先用 `--info` 测试 |

## 行为规范

- 当用户给出视频链接并要求「转录」「转文字」「听写」时，自动串联本 skill + audio-transcribe 完成全流程
- 输出文件默认保存到 `assets/yyyymmdd/media-download/`
- 下载完成后告知用户文件路径和大小
- 如果平台需要 cookies 且用户未传入，先提示再尝试下载（可能得到低清版本）
- 本地音频提取默认不覆盖已有文件；只有用户明确要求时才传 `--overwrite`

## 依赖

- **yt-dlp**：应由 ACS 镜像预置，或由平台批准后装入 workspace `.venv`
- **ffmpeg**：应由 ACS 镜像预置（本地音频提取和 URL 音频抽取需要）

缺依赖时停止并报告镜像/运行环境缺口；不要在普通 skill 流程里使用 Homebrew、`apt-get`、`sudo pip`、`--user`、`--break-system-packages` 或自建 venv。
