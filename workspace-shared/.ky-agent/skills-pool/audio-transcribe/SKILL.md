---
name: audio-transcribe
description: 语音识别转文字（ASR），基于阿里云百炼 fun-asr。接受本地音频/视频文件（mp3, wav, m4a, mp4 等）或音频直链 URL，输出纯文本。典型场景：会议录音转文字、访谈整理、语音备忘录转文本。如果用户给的是视频平台链接（B站/抖音/YouTube 等页面链接，非音频直链），需先用 media-download 下载或提取音频，再传给本 skill。本 skill 只做语音识别转写，不生成 SRT 字幕、不翻译、不烧录字幕（那些是 video-subtitle 的职责）。
---

# Transcribe - 音频/视频转文字

将录音或视频文件转录为纯文本。使用阿里云百炼 fun-asr 模型（中文效果最好），通过异步 API 完成转写，本地大文件自动经 OSS 中转。

## 能力边界

- 支持格式：mp3, wav, aac, ogg, flac, m4a, mp4, mov 等主流音视频格式
- 单文件上限：12 小时时长 / 2GB 体积
- 支持中文（含粤语、四川话、闽南语等方言）、英文及多种外语
- 支持说话人分离（10 人以内效果好）
- 支持句子级时间戳

## 使用方式

```bash
# 基本转录（默认 fun-asr 模型，效果最好）
python3 scripts/transcribe.py <音频文件路径或URL> -o output.txt

# 启用说话人分离（多人会议/对话推荐）
python3 scripts/transcribe.py recording.m4a --speaker -o output.txt

# 不带时间戳（纯文本）
python3 scripts/transcribe.py recording.mp3 --no-timestamp -o output.txt

# 使用更便宜的模型（0.29 元/小时 vs 0.79 元/小时）
python3 scripts/transcribe.py recording.mp3 --model paraformer-v2 -o output.txt

# 也支持直接传音频 URL
python3 scripts/transcribe.py 'https://example.com/audio.mp3' -o output.txt
```

脚本路径是相对于本 skill 目录的，实际调用时从用户 workspace 根目录使用：
```bash
python3 .ky-agent/skills/audio-transcribe/scripts/transcribe.py ...
```

## 参数说明

| 参数 | 说明 |
|------|------|
| `input` | 音频/视频文件路径或 HTTP URL（必需） |
| `-o, --output` | 输出文件路径。不指定则打印到终端 |
| `--speaker` | 启用说话人分离，输出会标注"说话人0"、"说话人1"等 |
| `--model` | 识别模型：`fun-asr`（默认，效果最好）、`paraformer-v2`（最便宜） |
| `--no-timestamp` | 输出不带 `[HH:MM:SS]` 时间戳前缀 |

## 模型选择

| 模型 | 价格 | 适用场景 |
|------|------|---------|
| `fun-asr` | ≈ 0.79 元/小时 | 中文会议、访谈、直播（默认推荐） |
| `paraformer-v2` | ≈ 0.29 元/小时 | 预算敏感、效果要求不高的场景 |

## 环境依赖

脚本依赖两个 Python 包（`dashscope` 和 `oss2`），以及环境变量 `DASHSCOPE_API_KEY`。
如果运行报错缺包，执行：
```bash
pip3 install --break-system-packages dashscope oss2
```

## 行为规范

- 多人对话/会议场景默认加 `--speaker`，除非用户明确不需要
- 输出文件默认保存到用户工作区的 `assets/yyyymmdd/` 下，文件名基于原始音频名
- 转录结果不做任何内容修改，原样输出识别文本
- 如果用户要求"整理"或"总结"录音内容，先转录再对文本做后处理，两步分开
- 转录完成后告知用户文件路径、总行数，并展示前几行预览
