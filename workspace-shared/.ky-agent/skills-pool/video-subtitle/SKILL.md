---
name: video-subtitle
description: 视频字幕制作全流程：Whisper 生成 SRT 字幕 → AI 翻译字幕 → FFmpeg 烧录硬字幕到视频。仅在用户明确需要「加字幕」「烧字幕」「翻译字幕」「生成 SRT 文件」时触发。如果用户只想把视频/音频内容转成文字用于阅读、总结、分析，不要用本 skill，应使用 media-download + audio-transcribe 组合。
---

# Video Subtitle

视频字幕处理全流程工具，覆盖从下载到烧录的完整链路。

## 功能模块

| 模块 | 功能 | 输入 | 输出 |
|------|------|------|------|
| **download** | 下载在线视频 | URL | 视频文件 |
| **extract** | 提取视频字幕 | 视频文件 | SRT + TXT |
| **translate** | 翻译字幕内容 | SRT 文件 | 翻译后 SRT |
| **burn** | 烧录字幕到视频 | 视频 + SRT | 带字幕视频 |
| **full** | 完整字幕流程 | 视频文件 | 带字幕视频 |

## 视频下载

使用 yt-dlp 从 YouTube 及其他平台下载视频。

### 基本下载

```bash
# 默认下载（最佳质量 MP4）
yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]" -o "assets/20260630/video-subtitle/%(title)s.%(ext)s" "URL"

# 指定分辨率
yt-dlp -f "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]" -o "%(title)s.%(ext)s" "URL"

# 仅下载音频（MP3）
yt-dlp -x --audio-format mp3 -o "%(title)s.%(ext)s" "URL"

# 下载播放列表
yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]" -o "%(playlist_index)s-%(title)s.%(ext)s" "PLAYLIST_URL"
```

### 质量选项

| 参数 | 说明 |
|------|------|
| `bestvideo[height<=2160]` | 4K |
| `bestvideo[height<=1080]` | 1080p |
| `bestvideo[height<=720]` | 720p |
| `bestvideo[height<=480]` | 480p |

### 注意事项

- 仅下载有权限的视频，遵守版权法和平台服务条款
- 指定质量可减小文件体积（720p vs 1080p）
- 播客或音乐场景使用音频下载模式

## 字幕处理

### 使用方法

```bash
# 完整流程：提取 + 翻译 + 烧录
python <skill_dir>/scripts/full.py uploads/video.mp4

# 仅提取字幕
python <skill_dir>/scripts/extract.py uploads/video.mp4

# 仅翻译字幕
python <skill_dir>/scripts/translate.py assets/20260630/video-subtitle/video.srt --to zh

# 仅烧录字幕
python <skill_dir>/scripts/burn.py uploads/video.mp4 assets/20260630/video-subtitle/video_zh.srt
```

### extract.py - 提取字幕

```bash
python scripts/extract.py video.mp4 [选项]

选项:
  -o, --output    输出目录
  -m, --model     Whisper 模型 (tiny/base/medium/large)
```

### translate.py - 翻译字幕

```bash
python scripts/translate.py subtitle.srt [选项]

选项:
  -t, --to        目标语言 (zh/en/ja/ko 等)
  -o, --output    输出文件路径
  -k, --api-key   API Key
  -u, --base-url  API Base URL
  -m, --model     AI 模型 (默认: glm-4.7)
```

### burn.py - 烧录字幕

```bash
python scripts/burn.py video.mp4 subtitle.srt [选项]

选项:
  -o, --output    输出视频路径
  -s, --style     字幕样式
```

### full.py - 完整流程

```bash
python scripts/full.py video.mp4 [选项]

选项:
  -t, --to        目标语言 (默认: zh)
  -o, --output    输出目录
  -m, --model     Whisper 模型
  -s, --style     字幕样式
  -k, --api-key   API Key
  -u, --base-url  API Base URL
  --ai-model      AI 模型
  --keep-temp     保留中间文件
```

## 依赖要求

- **ffmpeg**: 视频处理和字幕烧录，应由 ACS 镜像预置或管理员配置
- **Python 3.10+**: 运行脚本
- **faster-whisper**: Linux/ACS 默认语音识别后端，安装到工作区内置 `.venv/`
- **mlx-whisper**: 仅作为 macOS Apple Silicon 本机备用后端，不是 ACS 主路径
- **anthropic SDK**: AI 翻译，安装到工作区内置 `.venv/`
- **yt-dlp**: 视频下载，应由 ACS 镜像或工作区 `.venv/` 提供

禁止使用 Homebrew、`sudo pip`、`pip install --user`、`--break-system-packages` 或自建 venv。缺依赖时停止并报告镜像/`.venv` 依赖缺口。

## 配置

### AI 翻译

使用智谱 AI 的 Anthropic 兼容接口：

```bash
export ANTHROPIC_API_KEY="your-zhipuai-api-key"
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/anthropic"
```

### 字幕样式

默认样式（可通过 `--style` 覆盖）：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `Fontname` | Noto Sans CJK SC | 字体（需支持中文；烧录前可用 `fc-match` 复核） |
| `FontSize` | 18 | 字号（短视频 16-20，长视频 18-24） |
| `PrimaryColour` | 白色 | 文字颜色 |
| `OutlineColour` | 黑色 | 描边颜色 |
| `Alignment` | 2 | 对齐（1=左下, 2=中下, 3=右下） |
| `MarginV` | 30 | 底部边距 |

```bash
# 自定义示例
python scripts/full.py video.mp4 --style "FontSize=24,Alignment=8"
```

## 输出文件

| 输入 | 输出 |
|------|------|
| `video.mp4` | `video.srt` - 提取的字幕 |
| `video.srt` | `video_zh.srt` - 翻译后的字幕 |
| `video.mp4` + SRT | `video_with_subtitles.mp4` - 带字幕视频 |

默认输出目录为 `assets/yyyymmdd/video-subtitle/<视频名>/`。中间 SRT/TXT 默认保留，便于复核；只有用户明确不需要时才传 `--delete-temp` 删除本次生成的中间文件。

## 工作流程

```
在线视频 URL
    |
[download] yt-dlp 下载
    |
视频文件 (MP4)
    |
[extract] Whisper 提取字幕
    |
原始 SRT + TXT
    |
[translate] AI 翻译
    |
翻译后 SRT
    |
[burn] FFmpeg 烧录字幕
    |
带字幕视频 (MP4)
```

## Whisper 模型选择

| 模型 | 速度 | 准确度 | 适用场景 |
|------|------|--------|----------|
| `tiny` | 最快 | 一般 | 快速预览 |
| `base` | 快 | 中等 | 日常使用 |
| `medium` | 中等 | 高 | 推荐 |
| `large` | 慢 | 最高 | 精准要求 |

## 故障排查

**Whisper 依赖错误**: 检查工作区 `.venv` 是否有 `faster-whisper`；不要安装 `mlx-whisper` 作为 ACS 方案。

**字幕显示乱码**: 使用支持中文的字体 `--style "Fontname=Noto Sans CJK SC"`

**翻译失败**: 检查 `$ANTHROPIC_API_KEY` 和 `$ANTHROPIC_BASE_URL` 是否正确配置
