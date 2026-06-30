#!/usr/bin/env python3
"""
字幕翻译模块

使用 AI 将字幕文件翻译成目标语言，支持多种翻译服务。
"""

import argparse
import os
import sys
from pathlib import Path

def translate_subtitles(
    srt_path: str,
    target_lang: str = "zh",
    output_path: str = None,
    api_key: str = None,
    base_url: str = None,
    model: str = "glm-4.7"
):
    """
    翻译字幕文件

    Args:
        srt_path: 原始 SRT 文件路径
        target_lang: 目标语言（zh=中文, en=英文等）
        output_path: 输出文件路径（默认在原文件名后加 _{lang}）
        api_key: AI API Key
        base_url: AI API Base URL
        model: 使用的模型

    Returns:
        str: 翻译后的 SRT 文件路径
    """
    try:
        import anthropic
    except ImportError:
        print("错误: 未安装 anthropic SDK")
        print("请运行: pip3 install anthropic")
        sys.exit(1)

    srt_path = Path(srt_path).resolve()
    if not srt_path.exists():
        raise FileNotFoundError(f"字幕文件不存在: {srt_path}")

    # 读取原始字幕
    with open(srt_path, 'r', encoding='utf-8') as f:
        srt_content = f.read()

    # 设置输出路径
    if output_path is None:
        output_path = srt_path.parent / f"{srt_path.stem}_{target_lang}.srt"
    else:
        output_path = Path(output_path)

    # 获取 API 配置
    if api_key is None:
        api_key = os.environ.get('ANTHROPIC_API_KEY')
    if base_url is None:
        base_url = os.environ.get('ANTHROPIC_BASE_URL', 'https://api.anthropic.com')

    if not api_key:
        raise ValueError("未设置 API Key，请通过 --api-key 参数或 ANTHROPIC_API_KEY 环境变量设置")

    print(f"正在翻译字幕...")
    print(f"源文件: {srt_path}")
    print(f"目标语言: {target_lang}")
    print(f"模型: {model}")

    # 创建客户端
    client = anthropic.Anthropic(
        api_key=api_key,
        base_url=base_url
    )

    # 根据目标语言设置翻译提示
    lang_map = {
        'zh': '中文',
        'en': '英文',
        'ja': '日文',
        'ko': '韩文',
        'es': '西班牙文',
        'fr': '法文',
        'de': '德文',
    }
    target_lang_name = lang_map.get(target_lang, target_lang)

    # 翻译请求
    prompt = f'''请将以下 SRT 字幕翻译成{target_lang_name}。要求：
1. 保持 SRT 格式不变（序号、时间轴）
2. 只翻译字幕文本内容
3. 保持时间轴格式完全一致
4. 翻译要准确、自然、符合{target_lang_name}表达习惯
5. 保留专有名词不翻译（如人名、产品名、技术术语等）
6. 保留完整的内容，不要遗漏任何字幕

原始字幕：
{srt_content}

请直接返回翻译后的完整 SRT 内容，不要添加任何解释。'''

    resp = client.messages.create(
        model=model,
        max_tokens=8192,
        messages=[{
            'role': 'user',
            'content': prompt
        }]
    )

    translated_content = resp.content[0].text

    # 保存翻译结果
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(translated_content)

    print(f'\n✅ 字幕翻译完成！')
    print(f'输出文件: {output_path}')

    return str(output_path)


def main():
    parser = argparse.ArgumentParser(description='翻译字幕文件')
    parser.add_argument('srt', help='SRT 字幕文件路径')
    parser.add_argument('-t', '--to', default='zh',
                        help='目标语言（默认: zh=中文）')
    parser.add_argument('-o', '--output', help='输出文件路径')
    parser.add_argument('-k', '--api-key', help='API Key')
    parser.add_argument('-u', '--base-url', help='API Base URL')
    parser.add_argument('-m', '--model', default='glm-4.7',
                        help='使用的模型（默认: glm-4.7）')

    args = parser.parse_args()
    translate_subtitles(
        args.srt,
        args.to,
        args.output,
        args.api_key,
        args.base_url,
        args.model
    )


if __name__ == '__main__':
    main()
