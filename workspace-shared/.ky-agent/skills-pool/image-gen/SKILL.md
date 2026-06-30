---
name: image-gen
description: AI 图像生成，根据文字描述生成图片、信息图、配图。当用户要求画图、生成图片、AI 绘图、文生图、做一张图、做信息图时触发。也适用于「帮我画一个XX」「生成一张XX的图」「做个封面图」「配图」「做张信息图」等场景。如果用户提供了参考图片要求以图生图，也应触发。不要在用户只是讨论图片、查看已有图片、或进行图片格式转换时触发。
---

# Image Gen - AI 图像生成

支持四个后端引擎：**GPT-Image-2**（OpenAI 最新图像模型，默认）、**Gemini**（Google Nano Banana 系列，备选）、**Seedream**（火山引擎豆包系列，备选）、**Gemini Web UI**（浏览器模式，备选）。

## 引擎选择

| 引擎 | 脚本 | 适用场景 | 依赖 |
|------|------|---------|------|
| GPT-Image-2（默认） | `scripts/generate_gpt_image_2.py` | 通用生图，OpenAI 最新图像模型，质量最高、速度快（10-15s/张），支持文生图与以图生图。中英文 prompt 均可 | 本机 CLIProxyAPI 已启动 + ChatGPT Plus/Pro OAuth 已登录 |
| Gemini（备选） | `scripts/generate_gemini.py` | 需要精确尺寸/宽高比/多图/URL 参考图 | `GEMINI_API_KEY` |
| Seedream（备选） | `scripts/generate.py` | 中文场景、联网搜索生图 | `ARK_API_KEY` |
| Gemini Web UI（备选）| `scripts/generate_browser.py` | gemini.google.com，每日 30 次免费 | 浏览器已登录 |

默认使用 GPT-Image-2。若需要更细的结构化宽高比（21:9 / 4:5 等 gpt-image-2 不支持的比例）或希望走免费 Gemini 额度，切到 Gemini 引擎。

---

## GPT-Image-2 引擎（默认）

### 使用方式

```bash
python3 {SKILL_DIR}/scripts/generate_gpt_image_2.py "<prompt>" -o <output_dir> [options]
```

### 参数

| 参数 | 说明 |
|------|------|
| `prompt` | 图像描述提示词（必需，位置参数） |
| `-o, --output-dir` | 输出目录（必需） |
| `-s, --size` | 尺寸偏好：`512`（降级 1K）、`1K`（默认）、`2K`（走 2048×2048）、`4K`（降级 2K）。与 `-a` 共同映射到 gpt-image-2 实际支持的尺寸 |
| `-a, --aspect-ratio` | 宽高比，默认 `1:1`。决定最终尺寸方向（横/竖/方） |
| `-q, --quality` | 质量：`low` / `medium` / `high` / `auto`（默认）。影响 5h 配额消耗速度 |
| `-n, --num` | 生成数量，默认 1（**真并发**，最多 5 并发） |
| `--ref IMAGE` | 参考图（本地路径或 URL，可多次指定，URL 自动下载）。**传 `--ref` 时自动走 `/v1/images/edits` 以图生图端点** |

### 工作原理

直调本机 CLIProxyAPI 的 OpenAI 兼容端点：
- 无 `--ref` → `POST /v1/images/generations`（JSON）
- 有 `--ref` → `POST /v1/images/edits`（multipart/form-data）

底层 OAuth 走 ChatGPT Plus/Pro 订阅配额，**不烧 API key 余额**，但消耗 Codex 5h 滚动配额池（每张图约抵 3-5 条普通 message，Plus 池每 5 小时约可画 6-50 张）。

### 尺寸映射

`-s` × `-a` 映射到 gpt-image-2 实际支持的 size：

| 输入 | 最终尺寸 |
|------|----------|
| `-a 1:1 -s 1K`（默认） | 1024×1024 |
| `-a 1:1 -s 2K` | 2048×2048 |
| `-a 16:9` / `4:3` / `3:2` / `21:9` 等横向 | 1536×1024 |
| `-a 9:16` / `3:4` / `2:3` 等竖向 | 1024×1536 |
| 其他/`-s 4K` | 2048×2048（自动降级）/`auto` |

### 已知约束

1. **配额烧得快**：每张图烧 3-5× 普通 message 配额，Plus 池 5h 上限约 6-50 张
2. **size 不可任意指定**：gpt-image-2 只支持上面 5 档，比 Gemini 的连续尺寸自由度低
3. **依赖本机 CLIProxyAPI 服务**：若 8317 端口不响应，脚本会报错并提示检查 `lsof -iTCP:8317 -sTCP:LISTEN`

### 环境变量

| 变量 | 默认值 |
|------|--------|
| `CLIPROXY_BASE_URL` | `http://127.0.0.1:8317` |
| `CLIPROXY_API_KEY` | 缺省时从 `~/.cli-proxy-api/config.yaml` 自动读取第一个 api-keys |

---

## Gemini 引擎（备选）

### 使用方式

```bash
python3 {SKILL_DIR}/scripts/generate_gemini.py "<prompt>" -o <output_dir> [options]
```

### 参数

| 参数 | 说明 |
|------|------|
| `prompt` | 图像描述提示词（必需，位置参数） |
| `-o, --output-dir` | 输出目录（必需） |
| `-s, --size` | 图片尺寸：`512`、`1K`（默认）、`2K`、`4K` |
| `-a, --aspect-ratio` | 宽高比，默认 `1:1` |
| `-n, --num` | 生成数量，默认 1（每张独立调用） |
| `-m, --model` | 模型 ID，默认 `gemini-3.1-flash-image-preview` |
| `--ref IMAGE` | 参考图（本地路径或 URL），可多次指定 |

### 可选模型

| 模型 | Model ID | 特点 |
|------|----------|------|
| Nano Banana 2 | `gemini-3.1-flash-image-preview` | 默认，速度快，更多宽高比支持 |
| Nano Banana Pro | `gemini-3-pro-image-preview` | 最高质量，推理能力强 |

### 支持的宽高比

`1:1`（默认）、`2:3`、`3:2`、`3:4`、`4:3`、`4:5`、`5:4`、`9:16`、`16:9`、`21:9`、`1:4`、`4:1`、`1:8`、`8:1`

### 尺寸 × 用途对照

| 用途 | 推荐尺寸 | 推荐宽高比 |
|------|---------|-----------|
| 社交媒体配图 | `1K` | `1:1` |
| 横版封面/Banner | `2K` | `16:9` |
| 手机壁纸/竖版海报 | `2K` | `9:16` |
| PPT 配图 | `1K` | `4:3` |
| 头像 | `512` | `1:1` |
| 高清印刷 | `4K` | 按需 |

---

## Seedream 引擎（备选）

### 使用方式

```bash
python3 {SKILL_DIR}/scripts/generate.py "<prompt>" -o <output_dir> [options]
```

### 参数

| 参数 | 说明 |
|------|------|
| `prompt` | 图像描述提示词（必需，位置参数） |
| `-o, --output-dir` | 输出目录（必需） |
| `-s, --size` | 分辨率，默认 `2048x2048`（5.0 最小约 1920x1920） |
| `-n, --num` | 生成数量，1-15，默认 1 |
| `--quality` | 质量：`standard` 或 `hd` |
| `--style` | 风格描述 |
| `--web-search` | 联网搜索（仅 5.0 模型） |
| `--seed` | 随机种子（可复现结果） |
| `--ref IMAGE` | 参考图（本地路径或 URL），可多次指定 |

### Seedream 模型

固定使用 Seedream 5.0-lite（`doubao-seedream-5-0-260128`），¥0.22/张。

---

## Gemini Web UI 引擎（浏览器模式）

### 使用场景

备选方案，且每日有数十次免费额度。

### 使用方式

```bash
python3 {SKILL_DIR}/scripts/generate_browser.py "<prompt>" -o <output_dir>
```

### 参数

| 参数 | 说明 |
|------|------|
| `prompt` | 图像描述提示词（必需） |
| `-o, --output-dir` | 输出目录（必需） |

### 操作流程（固化流水线）

```
1. ensure_browser()           # 调用浏览器 API 启动
2. playwright open             # 打开浏览器 session
3. goto gemini.google.com/app  # 导航到 Gemini
4. snapshot() → click "🖼️ 制作图片"  # 固定按钮名称
5. snapshot() → fill textbox → click "发送"  # 输入 prompt 并发送
6. sleep 60 → 轮询 console log 等 "Downloading file"  # 等待生成
7. 复制下载文件到输出目录
```

**Element ref 只从最新 snapshot 中获取**，每步操作后都重新 snapshot。

### 注意事项

- 生成时间约 60-90 秒，脚本会自动轮询等待
- 浏览器 session 名称自动生成（格式：`img-gen-xxxxxx`）
- 下载完成后自动关闭浏览器，无需手动清理
- prompt 中的中文会直接渲染进图片，无需特殊处理

### 核心交互流程

当用户提出图像生成需求时，按以下流程执行。目标：生成准确匹配用户意图的图片，而不是猜着画。

#### 第一步：确认 Prompt 模式

使用 **AskUserQuestion 工具**（不要用纯文本提问）向用户确认 prompt 方式，提供三个选项：

- **A. 帮忙设计提示语（继续提问）** — agent 给出风格/构图/色调等选项，用户挑选，agent 组装专业 prompt
- **B. 帮忙设计提示语（直接开始）** — agent 基于用户的简短描述自主扩展，不再追问，直接生成
- **C. 直接使用我的描述** — 用户的原文就是 prompt，原样发送给模型

在 AskUserQuestion 的提问文本中加上选项建议，帮用户快速决策：
- 用户描述短/模糊（"画一只猫"、"做个封面"）→ 建议 A 或 B
- 用户描述已包含风格、构图、氛围等细节 → 建议 C

**快捷跳过**：如果用户明确说了"你来想"、"随便画"、"surprise me"之类的话，不需要提问，直接按 B（直接开始）处理。

#### 第二步：Prompt 准备

**选项 A — 继续提问：**

使用 AskUserQuestion **一次性**问完关键问题（合并为一次提问，不要逐个问）：
- 主体/场景：画面核心元素是什么？
- 风格偏好：写实摄影 / 插画 / 水彩 / 油画 / 3D渲染 / 扁平设计 / 动漫 / 像素风 等
- 色调/氛围：暖色/冷色/高对比/柔和/赛博朋克/复古 等
- 构图偏好：特写/中景/全景/俯视/仰视 等
- 用途（影响尺寸选择）：社交媒体 / PPT / 海报 / 壁纸 / 头像 等
- 在提问末尾注明："以上任何一项没有想法可以留空，由我来决定"

根据用户回答组装完整 prompt。

**选项 B — 直接开始：**

基于用户的简短描述，自主扩充为 50-150 字的完整画面描述。主动补充风格质感、光线色调、构图视角、氛围情绪等。

**选项 C — 原样使用：**

直接使用用户的原文作为 prompt，不做任何修改。

#### 第三步：生成

- **选项 A 和 B**：先在回复中展示你设计的完整 prompt，然后**立即调用脚本生成**（展示是为了透明，不是等审批；用户如有异议会主动说，到时再调整重来）
- **选项 C**：直接生成，无需额外展示
- 根据用途自动选择合适的尺寸和宽高比

#### 第四步：展示结果

1. 用 markdown 图片语法内联展示：`![描述](assets/yyyymmdd/gpt_image_2_xxx.png)`（Gemini 引擎是 `gemini_xxx.png`）
2. 如果脚本输出了模型回复文本（如 revised_prompt），展示出来供参考
3. 一句话提示后续可选操作：调整描述重新生成 / 换风格或尺寸 / 生成多张变体

### Prompt 语言

- **GPT-Image-2**：中英文均可，英文 prompt 通常更稳定（OpenAI 模型对英文构图词敏感）
- **Gemini**：中英文均可，英文 prompt 通常效果更好（国际化模型）
- **Seedream**：始终用中文（中文原生模型）

### 参考图（图生图）

当用户上传了图片时，对话上下文中会出现类似"用户上传了一张图片，路径是 /path/to/image.jpg"的系统提示。agent 应：

1. 识别出这是参考图，在调用脚本时通过 `--ref` 参数传入该路径
2. 多张参考图就多次 `--ref`：`--ref /path/a.jpg --ref /path/b.jpg`
3. **GPT-Image-2 / Gemini / Seedream 三个引擎都支持 URL 参考图**，URL 自动下载到本地后再传给模型

**GPT-Image-2 参考图**：传 `--ref` 时自动走 `/v1/images/edits` 端点（multipart），不需要 mask。直接在 prompt 里描述要改什么（如"把图中的苹果改成绿色，其它保持不变"），模型会输出 `revised_prompt` 字段说明它最终理解的编辑意图。

**Seedream 参考图编号规则**：`--ref` 的传入顺序 = 图1/图2/图3。prompt 中**必须用「图1」「图2」来指代**。

**Gemini 参考图**：直接在 prompt 中描述参考图的用途即可（如"参照上传的照片，生成油画风格版本"），Gemini 能自行理解图文关系。多图时也可用「第一张图」「第二张图」辅助说明。

**限制**：
- GPT-Image-2：最多 16 张参考图（推荐 1-4 张，过多影响理解）；单张 ≤ 20MB
- Seedream：参考图 + 生成图 ≤ 15，单张 ≤ 5MB
- Gemini：最多约 10 张参考图，单张 ≤ 5MB

### 其他规则

- **输出目录**：图片保存到用户工作区的 `assets/yyyymmdd/` 下
- **默认参数**：GPT-Image-2 用 1K + 1:1 + quality=auto，Gemini 用 1K + 1:1，Seedream 用 2048x2048。除非用户或上下文另有指定
- **尺寸智选**：社交媒体 → 1:1、Banner/封面 → 16:9、手机壁纸/竖版海报 → 9:16、PPT → 4:3
- **质量智选**（GPT-Image-2）：信息图/海报/插画 → `-q high`，社交媒体配图 → `-q low`，不确定 → `-q auto`
- **多图生成**：用户要多方案/变体时用 `-n` 参数，每张图都内联展示。GPT-Image-2 下 `-n` 是**真并发**（最多 5 并发），Gemini/Seedream 是各自的实现
- **引擎切换触发**：用户明确要求 21:9 / 4:5 等 gpt-image-2 不支持的严格宽高比 / 要免费 Gemini 额度 → 切 Gemini。GPT-Image-2 出错（CLIProxyAPI 不可达、HTTP 错误等）→ 报错并提示检查本机服务
- **错误处理**：API Key 或本机服务未就绪时，提示用户检查对应依赖
- **不重复确认**：第一步已做过意图确认，后续不要再问"确定吗""要生成吗"

## 环境依赖

- Python 3（标准库即可，无第三方依赖）
- 本机 CLIProxyAPI 服务已启动（监听 `127.0.0.1:8317`）+ ChatGPT Plus/Pro OAuth 已登录（GPT-Image-2 引擎）
  - 环境变量 `CLIPROXY_BASE_URL` / `CLIPROXY_API_KEY`（缺省时 fallback 到 `127.0.0.1:8317` + 从 config.yaml 读取）
- 环境变量 `GEMINI_API_KEY`：Google AI Studio API Key（Gemini 引擎）
- 环境变量 `ARK_API_KEY`：火山引擎方舟平台 API Key（Seedream 引擎）

## 风格 Prompt 参考库

`references/` 目录下存放了经过验证的风格 prompt 模板（来源：op7418/Document-illustrator-skill），可在设计 prompt 时参考或直接拼接使用：

| 文件 | 风格 | 适用场景 |
|------|------|---------|
| `references/gradient-glass.md` | 渐变毛玻璃卡片 | 科技产品、数据报告、Apple Keynote 风 |
| `references/ticket.md` | 数字极简票券 | 信息图表、黑白高级感、杂志排版 |
| `references/vector-illustration.md` | 扁平矢量插画 | 教育内容、故事叙述、复古温暖风 |

使用方式：读取对应风格文件内容，作为 prompt 前缀拼接用户的具体内容描述。
