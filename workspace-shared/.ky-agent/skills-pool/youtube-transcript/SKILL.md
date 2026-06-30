---
name: youtube-transcript
description: 从 YouTube 视频提取已有的字幕/CC 文本（不做语音识别，零成本零延迟）。仅适用于 YouTube 且视频必须已有字幕。当用户给了 YouTube 链接并需要文字内容时，优先尝试本 skill（最快）。如果视频无字幕会失败，此时应改用 media-download -a + audio-transcribe 组合。非 YouTube 平台不要触发本 skill。
---

# YouTube Transcript

Extract transcripts from YouTube videos using `youtube-transcript-api`.

## Preconditions (common failure causes)

- Network must be able to reach `youtube.com`.
  - If your environment requires a proxy, ensure `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` are set correctly.
- The target video **must** have subtitles/captions available.
  - If the video has **no subtitles** / **auto-captions disabled**, this skill cannot extract anything.
  - Typical error message from `youtube-transcript-api`: `Could not retrieve a transcript...` / `Subtitles are disabled for this video`.

Quick check (optional, if `yt-dlp` is available):
```bash
yt-dlp --list-subs "https://www.youtube.com/watch?v=VIDEO_ID"
```

## Usage

### Preferred (when `uv` is installed)

```bash
uv run scripts/get_transcript.py "VIDEO_URL_OR_ID"
```

With timestamps:
```bash
uv run scripts/get_transcript.py "VIDEO_URL_OR_ID" --timestamps
```

### Fallback (no `uv` available)

Use the current workspace Python environment. Do not create a separate venv inside the workspace.

```bash
python scripts/get_transcript.py "VIDEO_URL_OR_ID"
python scripts/get_transcript.py "VIDEO_URL_OR_ID" --timestamps
```

If `youtube-transcript-api` is missing, stop and report the missing dependency. Do not run `pip install --user`, create a new venv, or install into system Python. ACS runtime dependencies should be fixed in the base image or current workspace `.venv`.

If a file output is requested, write it under `assets/yyyymmdd/` unless the user provides a path.

Example:
```bash
mkdir -p assets/$(date +%Y%m%d)
python scripts/get_transcript.py "VIDEO_URL_OR_ID" > assets/$(date +%Y%m%d)/VIDEO_ID-transcript.txt
```

## Defaults

- Without timestamps (default): plain text, one line per caption segment
- With timestamps: `[MM:SS] text` (or `[HH:MM:SS]` for longer videos)

## Supported URL Formats

- `https://www.youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://youtube.com/embed/VIDEO_ID`
- Raw video ID (11 characters)

## Output rules

- CRITICAL: Do **not** change the transcript wording/content.
  - Reflowing whitespace/line breaks (e.g., paragraph formatting) is allowed.
- If asked to save to a specific file, save to that file.
- If no output file is specified, use `assets/yyyymmdd/<VIDEO_ID>-transcript.txt`.

## Notes

- Prefers manually added captions when available; otherwise uses auto-generated captions.
- If the video has no captions, the script will error. In that case, you must switch to ASR (upload audio/video and transcribe) instead of trying to extract subtitles.
