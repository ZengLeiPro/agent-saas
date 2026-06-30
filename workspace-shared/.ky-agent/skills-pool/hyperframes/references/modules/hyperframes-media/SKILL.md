---
name: hyperframes-media
description: Asset preprocessing for HyperFrames compositions — text-to-speech narration (豆包/火山引擎 TTS for Chinese & mixed CN/EN; Kokoro for English & other languages), audio/video transcription (Whisper), and background removal for transparent overlays (u2net). Use when generating voiceover from text, transcribing speech for captions, removing the background from a video or image to use as a transparent overlay, choosing a TTS voice or whisper model, or chaining these (TTS → transcribe → captions). 豆包 TTS calls an external Volcengine API and requires ACS secret/env credentials; Kokoro/Whisper/u2net may download local models on first run.
---

# HyperFrames Media Preprocessing

Three CLI commands that produce assets for compositions: `tts` (speech), `transcribe` (timestamps), and `remove-background` (transparent video). 豆包 TTS calls Volcengine's external API and can incur cost/data egress; Kokoro, Whisper, and u2net may download models on first run and cache them under `~/.cache/hyperframes/`. User-facing outputs should go under `assets/yyyymmdd/` unless a HyperFrames project explicitly needs them in its local assets directory. Reference generated media from the composition HTML — see the `hyperframes` skill for the audio/video element conventions.

## Text-to-Speech (`tts`)

两条通道，按语言选：**中文 / 中英混读用豆包**（开沿默认，效果远好于本地 Kokoro 的中文）；**纯英文 / 其他语言用 Kokoro**（本地免费、54 音色）。下游完全一致——两者都产出一个音频文件，再交给 `transcribe` 取词级时间轴、在合成 HTML 里用 `<audio>`/`<video>` 播放。

### 中文 / 中英混读（默认）— 豆包 / 火山引擎

调用本模块自带脚本（火山引擎 TTS V3，输出 24kHz MP3）。脚本在本模块 `scripts/` 目录下，必须按当前 `SKILL.md` 所在目录解析脚本路径，不要假设 cwd 是 HyperFrames skill 根。

凭证必须由 ACS secret/env 注入 `DOUBAO_APP_ID` 和 `DOUBAO_ACCESS_TOKEN`。不要把真实凭证写进 skill、报告、命令示例、日志或对话；缺凭证时停止并提示管理员配置 secret，不要要求用户把 token 粘贴进上下文。

```bash
SK="<hyperframes-media skill dir>/scripts/doubao_tts.py"
python3 "$SK" "开沿科技，让企业真正用得起 AI Agent。" -o assets/20260630/narration.mp3
python3 "$SK" script.txt --voice jieshuo --speed 1.1 -o assets/20260630/narration.mp3
python3 "$SK" --list                              # 列出内置音色，不需要凭证
```

音色（`--voice` 传别名，或直接传任意豆包 speaker id）：

| 别名      | 音色                  | 适用          |
| --------- | --------------------- | ------------- |
| `cancan`  | 女·灿灿（默认，甜美） | 产品片 / 通用 |
| `vivi`    | 女·vivi（活力）       | 营销 / 社交   |
| `tianmei` | 女·甜美小源           | 温柔 / 亲和   |
| `kefu`    | 女·客服女声           | 教程 / 说明   |
| `wennuan` | 男·温暖阿虎           | 沉稳 / 叙事   |
| `jieshuo` | 男·解说小明           | 解说 / 权威   |

- `--speed` 0.5–2.0（默认 1.2）、`--volume` 0.5–2.0（默认 1.0）。位置参数可以是字面文本，也可以是 `.txt` 脚本文件路径。
- 这些 `*_bigtts` 大模型音色**原生支持中英混读**，文案里夹英文术语（API、AI Agent、SaaS）发音正常，无需像 Kokoro 那样把字母逐个拆开。
- 输出是 MP3，`npx hyperframes transcribe narration.mp3 --language zh` 直接可用。
- 凭证：脚本默认只读 `DOUBAO_APP_ID` / `DOUBAO_ACCESS_TOKEN`。如确需本地配置文件，必须显式设置 `DOUBAO_CONFIG_PATH` 指向受控位置；不要使用 skill 目录下的配置文件作为凭证来源。底层调用豆包 V3 接口。

### 纯英文 / 其他语言 — Kokoro（本地，免费）

Generate speech audio locally with Kokoro-82M. No API key.

```bash
npx hyperframes tts "Text here" --voice af_nova --output narration.wav
npx hyperframes tts script.txt --voice bf_emma --output narration.wav
npx hyperframes tts --list                       # all 54 voices
```

Default is `af_heart`. Match voice to content:

| Content type      | Voice                 | Why                           |
| ----------------- | --------------------- | ----------------------------- |
| Product demo      | `af_heart`/`af_nova`  | Warm, professional            |
| Tutorial / how-to | `am_adam`/`bf_emma`   | Neutral, easy to follow       |
| Marketing / promo | `af_sky`/`am_michael` | Energetic or authoritative    |
| Documentation     | `bf_emma`/`bm_george` | Clear British English, formal |
| Casual / social   | `af_heart`/`af_sky`   | Approachable, natural         |

Voice IDs encode language in the first letter: `a`=American English, `b`=British English, `e`=Spanish, `f`=French, `h`=Hindi, `i`=Italian, `j`=Japanese, `p`=Brazilian Portuguese, `z`=Mandarin. The CLI auto-detects the phonemizer locale from the prefix. Non-English phonemization requires `espeak-ng`; in ACS this should be preinstalled in the image. Do not run Homebrew, `apt-get`, `sudo pip`, `pip install --user`, `--break-system-packages`, or create a new venv from a skill invocation. **注意：Kokoro 的中文（`z` 前缀）质量一般 —— 中文一律走上面的豆包通道，不要用 Kokoro 出中文。**

Speed: `0.7-0.8` tutorials/accessibility · `1.0` natural (default) · `1.1-1.2` intros/upbeat. For long scripts, write to a `.txt` file and pass the path.

Requirements: Python 3.8+ with `kokoro-onnx` and `soundfile`; if missing, install only into the workspace `.venv` with `python3 -m pip install kokoro-onnx soundfile`, or stop and report the image dependency gap. Model downloads on first use (~311 MB + ~27 MB voices, cached in `~/.cache/hyperframes/tts/`).

## Transcription (`transcribe`)

Produce a normalized `transcript.json` with word-level timestamps.

```bash
npx hyperframes transcribe audio.mp3
npx hyperframes transcribe video.mp4 --model small --language es
npx hyperframes transcribe subtitles.srt          # import existing
npx hyperframes transcribe subtitles.vtt
npx hyperframes transcribe openai-response.json
```

### Language Rule (Non-Negotiable)

**Never use `.en` models unless the user explicitly states the audio is English.** `.en` models (`small.en`, `medium.en`) **translate** non-English audio into English instead of transcribing it. This silently destroys the original language.

1. Language known and non-English → `--model small --language <code>` (no `.en` suffix)
2. Language known and English → `--model small.en`
3. Language unknown → `--model small` (no `.en`, no `--language`) — whisper auto-detects

**Default model is `small`, not `small.en`.**

### Model Sizes

| Model      | Size   | Speed    | When to use                           |
| ---------- | ------ | -------- | ------------------------------------- |
| `tiny`     | 75 MB  | Fastest  | Quick previews, testing pipeline      |
| `base`     | 142 MB | Fast     | Short clips, clear audio              |
| `small`    | 466 MB | Moderate | **Default** — most content            |
| `medium`   | 1.5 GB | Slow     | Important content, noisy audio, music |
| `large-v3` | 3.1 GB | Slowest  | Production quality                    |

Music with vocals: start at `medium` minimum; produced tracks often need manual SRT/VTT import. For caption-quality checks (mandatory after every transcription), the cleaning JS, retry rules, and the OpenAI/Groq API import path, see [transcript-guide.md](../../transcript-guide.md).

### Output Shape

Compositions consume a flat array of word objects. The `id` field (`w0`, `w1`, ...) is added during normalization for stable references in caption overrides; it's optional for backwards compatibility.

```json
[
  { "id": "w0", "text": "Hello", "start": 0.0, "end": 0.5 },
  { "id": "w1", "text": "world.", "start": 0.6, "end": 1.2 }
]
```

## Background Removal (`remove-background`)

Remove the background from a video or image so the subject (typically a person — avatar, presenter, talking head) sits as a transparent overlay in a composition.

```bash
npx hyperframes remove-background subject.mp4 -o transparent.webm  # default: VP9 alpha WebM
npx hyperframes remove-background subject.mp4 -o transparent.mov   # ProRes 4444 (editing)
npx hyperframes remove-background portrait.jpg -o cutout.png       # single-image cutout
npx hyperframes remove-background subject.mp4 -o subject.webm \
  --background-output plate.webm                                   # both layers in one pass
npx hyperframes remove-background subject.mp4 -o transparent.webm --device cpu
npx hyperframes remove-background --info                           # detected providers
```

Uses `u2net_human_seg` (MIT). First run downloads ~168 MB of weights to `~/.cache/hyperframes/background-removal/models/`.

### Layer separation (`--background-output`)

Pass `--background-output` (or `-b`) to emit a **second** transparent video alongside the cutout: same source RGB, alpha is `255 − mask` instead of `mask`. The cutout is the subject with a transparent background; the plate is the original surroundings with a transparent hole where the subject was.

| File                             | Alpha is…                                                 | Use it for                                                      |
| -------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| `-o subject.webm`                | The mask — subject opaque, background transparent         | Foreground layer, place on top                                  |
| `--background-output plate.webm` | Inverse — surroundings opaque, subject region transparent | Bottom layer; put text or graphics between this and the subject |

Both outputs share the same `--quality` preset and run from a single inference pass — encode cost roughly doubles, segmentation cost stays the same. Only valid for video inputs and `.webm`/`.mov` outputs.

**Hole-cut plate, not an inpainted clean plate.** The subject region in `plate.webm` is fully transparent — composite something opaque under it to fill the hole. The single test for whether `--background-output` is the right tool: _will anything ever be visible through the subject's silhouette where the subject used to be?_

| Use case                                                                            | Right tool                                                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Text/graphics between the cutout and the plate (this command's reason for existing) | **Hole-cut** (`--background-output`)                                               |
| Subject onto an unrelated scene                                                     | Just `subject.webm`; ignore the plate                                              |
| Show the room _without_ the person, alone over no other content                     | **Clean plate** — needs an inpainter (LaMa, ProPainter, E2FGVI). Not this command. |
| Replace the subject with a different subject                                        | **Clean plate** — same as above                                                    |

If a user asks for "the room with the person removed" and intends to display it standalone, do **not** reach for `--background-output`. Tell them they need an inpainter.

Typical layered composition (the canonical hole-cut use case):

```html
<!-- z=1 the inverse-alpha plate fills everything except the subject region -->
<video
  src="plate.webm"
  data-start="0"
  data-duration="6"
  data-track-index="0"
  muted
  playsinline
></video>

<!-- z=2 graphics / text live between the two layers -->
<h1 id="headline" style="z-index:2; ...">MAKE IT IN HYPERFRAMES</h1>

<!-- z=3 the cutout floats the subject back over the headline -->
<div class="cutout-wrap" style="position:absolute;inset:0;z-index:3">
  <video
    src="subject.webm"
    data-start="0"
    data-duration="6"
    data-track-index="1"
    muted
    playsinline
  ></video>
</div>
```

This is functionally equivalent to the text-behind-subject pattern below, but you don't need the original `presenter.mp4` in the project — the plate replaces it. Useful when you want to ship just the two transparent layers and let the user drop arbitrary content between them.

### Output Format

| Format                | When                                                          |
| --------------------- | ------------------------------------------------------------- |
| `.webm` (VP9 + alpha) | Default. Compositions play this directly via `<video>`.       |
| `.mov` (ProRes 4444)  | Editing in DaVinci/Premiere/FCP. Large files.                 |
| `.png`                | Single-image cutout (still subject, layered over a backdrop). |

Chrome decodes VP9 alpha natively, so the `.webm` plugs into a composition like any other muted-autoplay video — see the `hyperframes` skill for the `<video>` track conventions.

### Quality presets

`--quality fast|balanced|best` controls only the VP9 encoder's CRF — segmentation quality is fixed.

| Preset     | CRF | When                                                  |
| ---------- | --- | ----------------------------------------------------- |
| `fast`     | 30  | Iterating, smaller file, looser color match           |
| `balanced` | 18  | Default. Visually identical for most uses             |
| `best`     | 12  | Master / final delivery. Largest file, tightest match |

### Compositing patterns — pick the right one

The cutout webm is a **re-encoded copy** of the source mp4's RGB. That choice has consequences depending on what you put behind it:

| Pattern                                                  | What's behind the cutout                   | Result                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cutout over a different scene** (most common)          | Static image, gradient, or unrelated video | Looks great. The cutout's RGB is the only source of the subject — no doubling, no edge halo. This is what `remove-background` is built for.                                                                                       |
| **Cutout over its own source mp4** (text-behind-subject) | Same mp4 the cutout was generated from     | Two RGB sources for the same person. At default `--quality balanced` (crf 18) the doubling is barely visible; at `--quality fast` (crf 30) you'll see a faint color shift / edge halo. Use `--quality best` (crf 12) for masters. |
| **Cutout over a _different_ take of the same person**    | Footage of the same subject                | Will look like two separate people overlapping. Don't do this.                                                                                                                                                                    |

**Text-behind-subject** (headline behind a presenter):

```html
<video
  src="presenter.mp4"
  id="bg"
  data-start="0"
  data-duration="6"
  data-track-index="0"
  muted
  playsinline
></video>
<h1 id="headline" style="z-index:2; ...">MAKE IT IN HYPERFRAMES</h1>
<div class="cutout-wrap" style="position:absolute;inset:0;z-index:3;opacity:0">
  <video
    src="presenter.webm"
    data-start="0"
    data-duration="6"
    data-track-index="1"
    muted
    playsinline
  ></video>
</div>
```

Two key rules:

1. **Wrap the cutout video in a non-timed `<div>`** and animate the wrapper's opacity, not the video element's. The framework forces opacity:1 on active clips (any element with `data-start`/`data-duration`), so animating the video's opacity directly is silently overridden. The wrapper has no `data-*` attributes, so it's owned by your CSS/GSAP.
2. **Both videos use `data-start="0"` and `data-media-start="0"`** so the framework decodes them in sync from t=0. Late-mounting the cutout (`data-start=3.3`) introduces a seek + warm-up that lands a frame off the base mp4 — visible as one frame of misalignment at the cut.

Then GSAP-flip the wrapper opacity at the cut: `tl.set(cutoutWrap, { opacity: 1 }, 3.3)`.

## TTS → Transcribe → Captions

When there's no pre-recorded voiceover, generate one and transcribe it back to get word-level timestamps for captions:

```bash
npx hyperframes tts script.txt --voice af_heart --output narration.wav
npx hyperframes transcribe narration.wav   # → transcript.json
```

Whisper extracts precise word boundaries from the generated audio, so caption timing matches delivery without hand-tuning.
