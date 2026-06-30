#!/usr/bin/env python3
"""
豆包（火山引擎）TTS V3 — hyperframes 中文 / 中英混读语音合成

替代 `npx hyperframes tts`（本地 Kokoro 中文效果差）。输出 MP3，可直接喂给
`npx hyperframes transcribe` 取词级时间轴，或在合成 HTML 里用 <audio>/<video> 播放。
逻辑与 server/src/integrations/tts/ttsClient.ts 对齐，纯标准库、无第三方依赖。

凭证：默认只读取环境变量 DOUBAO_APP_ID / DOUBAO_ACCESS_TOKEN。
      如确需本地配置文件，必须显式设置 DOUBAO_CONFIG_PATH，且不得把真实凭证放进 skill 目录。

用法：
  python doubao_tts.py "你好，这是一段旁白" -o narration.mp3
  python doubao_tts.py script.txt --voice jieshuo --speed 1.1 -o narration.mp3
  python doubao_tts.py --list
"""
import argparse
import base64
import json
import os
import re
import sys
import uuid
import urllib.request
import urllib.error

API_URL = "https://openspeech.bytedance.com/api/v3/tts/unidirectional"
RESOURCE_ID = "seed-tts-1.0"

# 别名 -> 豆包 speaker id（与 ttsClient.ts 的 DOUBAO_VOICES 保持一致）
# 这些 *_bigtts 大模型音色原生支持中英混读，纯英文内容也能用。
DOUBAO_VOICES = {
    "cancan":  "zh_female_cancan_mars_bigtts",         # 女·灿灿（默认，甜美）
    "vivi":    "zh_female_vv_uranus_bigtts",           # 女·vivi（活力）
    "tianmei": "zh_female_tianmeixiaoyuan_moon_bigtts", # 女·甜美小源
    "kefu":    "zh_female_kefunvsheng_mars_bigtts",    # 女·客服女声
    "wennuan": "zh_male_wennuanahu_moon_bigtts",       # 男·温暖阿虎
    "jieshuo": "zh_male_jieshuoxiaoming_moon_bigtts",  # 男·解说小明
}

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def load_config():
    """读取凭证。环境变量优先；配置文件必须通过 DOUBAO_CONFIG_PATH 显式指定。"""
    cfg = {}
    config_path = os.environ.get("DOUBAO_CONFIG_PATH", "")
    if config_path:
        with open(config_path, encoding="utf-8") as f:
            raw = re.sub(r"^\s*//.*$", "", f.read(), flags=re.M)  # 容忍 // 行注释
            cfg = json.loads(raw)
    app_id = os.environ.get("DOUBAO_APP_ID") or cfg.get("doubaoAppId", "")
    token = os.environ.get("DOUBAO_ACCESS_TOKEN") or cfg.get("doubaoApiKey", "")
    return app_id, token, cfg.get("defaultVoice", "cancan"), cfg.get("defaultSpeed", 1.2)


def synthesize(text, app_id, token, voice, speed, volume):
    """调用豆包 V3 unidirectional，返回完整 MP3 字节。"""
    speaker = DOUBAO_VOICES.get(voice, voice)
    # speed/volume(0.5-2.0) -> 豆包 rate(-50~100)，与 ttsClient.ts 换算一致
    speech_rate = max(-50, min(100, int(round((speed - 1.0) * 100))))
    loudness_rate = max(-50, min(100, int(round((volume - 1.0) * 100))))

    body = json.dumps({
        "user": {"uid": "hyperframes_tts"},
        "req_params": {
            "text": text,
            "speaker": speaker,
            "audio_params": {
                "format": "mp3",
                "sample_rate": 24000,
                "speech_rate": speech_rate,
                "loudness_rate": loudness_rate,
            },
        },
    }).encode("utf-8")

    req = urllib.request.Request(API_URL, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "X-Api-App-Id": app_id,
        "X-Api-Access-Key": token,
        "X-Api-Resource-Id": RESOURCE_ID,
        "X-Api-Request-Id": str(uuid.uuid4()),
    })

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        sys.exit(f"[豆包TTS] HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:300]}")
    except urllib.error.URLError as e:
        sys.exit(f"[豆包TTS] 网络错误: {e}")

    # 响应是 NDJSON 流，逐行解析，data 为 base64 音频分片
    chunks = []
    for line in raw.decode("utf-8", "ignore").split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        code = obj.get("code")
        if code not in (None, 0, 20000000):
            sys.exit(f"[豆包TTS] 合成失败 code={code}: {obj.get('message', '')}")
        if obj.get("data"):
            chunks.append(base64.b64decode(obj["data"]))

    if not chunks:
        sys.exit("[豆包TTS] 未返回音频数据（检查文本 / 音色 / 凭证）")
    return b"".join(chunks)


def estimate_seconds(path):
    """优先 ffprobe（hyperframes 流程本就依赖 ffmpeg），失败按 ~8KB/s 粗估。"""
    import shutil
    import subprocess
    if shutil.which("ffprobe"):
        try:
            out = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=nw=1:nk=1", path],
                capture_output=True, text=True, timeout=20)
            if out.returncode == 0 and out.stdout.strip():
                return float(out.stdout.strip())
        except Exception:
            pass
    return os.path.getsize(path) / 8000.0


def main():
    ap = argparse.ArgumentParser(description="豆包 TTS — 中文 / 中英混读语音合成")
    ap.add_argument("input", nargs="?", help="要朗读的文本，或 .txt 脚本文件路径")
    ap.add_argument("-o", "--output", default="narration.mp3", help="输出 MP3 路径（默认 narration.mp3）")
    ap.add_argument("-v", "--voice", help="音色别名或 speaker id（默认取配置 defaultVoice）")
    ap.add_argument("-s", "--speed", type=float, help="语速 0.5-2.0（默认取配置 defaultSpeed）")
    ap.add_argument("--volume", type=float, default=1.0, help="音量 0.5-2.0（默认 1.0）")
    ap.add_argument("--list", action="store_true", help="列出内置中文音色")
    args = ap.parse_args()

    if args.list:
        print("内置音色别名 → 豆包 speaker：")
        for k, vid in DOUBAO_VOICES.items():
            print(f"  {k:8s} {vid}")
        print("\n也可直接把任意豆包 speaker id 传给 --voice。")
        return

    app_id, token, default_voice, default_speed = load_config()
    if not app_id or not token:
        sys.exit("[豆包TTS] 缺少凭证。请由 ACS secret/env 注入 DOUBAO_APP_ID / "
                 "DOUBAO_ACCESS_TOKEN，或显式设置 DOUBAO_CONFIG_PATH 指向受控配置文件；"
                 "不要把真实凭证写进 skill 目录或对话。")
    if not args.input:
        sys.exit("[豆包TTS] 需要文本或 .txt 文件路径，见 --help")

    text = (open(args.input, encoding="utf-8").read().strip()
            if os.path.isfile(args.input) else args.input)
    if not text:
        sys.exit("[豆包TTS] 文本为空")

    voice = args.voice or default_voice
    speed = args.speed if args.speed is not None else default_speed

    audio = synthesize(text, app_id, token, voice, speed, args.volume)
    out = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    with open(out, "wb") as f:
        f.write(audio)

    print(f"✓ {out}")
    print(f"  音色 {voice} · 语速 {speed} · {len(audio) // 1024} KB · ~{estimate_seconds(out):.1f}s")


if __name__ == "__main__":
    main()
