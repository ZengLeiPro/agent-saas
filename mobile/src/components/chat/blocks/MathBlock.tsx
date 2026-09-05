/**
 * 块级数学公式（对齐 Web MessageItem 的 remark-math + rehype-katex 渲染）。
 *
 * RN 原生渲染不了公式，这里用局部 WebView 承载 KaTeX 产出的 MathML：
 * - 只喂本地字符串（`source={{ html }}`），originWhitelist 收到 about:blank，
 *   CSP `default-src 'none'`，不加载任何远程资源、图片与字体；
 * - WebView 里的脚本只有一段内联的高度回传，没有第三方脚本；
 * - KaTeX 解析失败或包不可用时，降级为等宽源码，不吞内容。
 *
 * 行内公式（`$…$`）本轮不接：一个公式一个 WebView 的代价在正文里不可接受，
 * 只切块级，行内保持原文（见 shared splitMathSegments 的 inline 开关）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { renderTexToMathml } from '../../../lib/katexMathml';
import { useColors, useChatTypography, spacing, radius, monoFamily } from '../../../theme';
import type { ThemeColors } from '../../../theme';

/** 首帧高度与上限：公式极少超过几行，上限防异常内容把列表撑爆 */
const INITIAL_HEIGHT = 44;
const MIN_HEIGHT = 24;
const MAX_HEIGHT = 320;

export function buildMathHtml(mathml: string, colors: ThemeColors, fontSize: number): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  color: ${colors.foreground};
  background: transparent;
  font-size: ${fontSize}px;
  padding: 2px 0;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
math { font-size: 1.15em; }
</style>
</head>
<body>${mathml}
<script>
(function () {
  function report() {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(String(document.documentElement.scrollHeight));
    }
  }
  window.addEventListener('load', report);
  setTimeout(report, 60);
})();
</script>
</body>
</html>`;
}

export function MathBlock({ tex }: { tex: string }) {
  const colors = useColors();
  const typo = useChatTypography();
  const [mathml, setMathml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [height, setHeight] = useState(INITIAL_HEIGHT);

  useEffect(() => {
    let cancelled = false;
    setMathml(null);
    setFailed(false);
    setHeight(INITIAL_HEIGHT);
    renderTexToMathml(tex, true)
      .then((rendered) => {
        if (!cancelled) setMathml(rendered);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tex]);

  const styles = useMemo(
    () =>
      StyleSheet.create({
        wrap: { marginVertical: spacing.xs },
        source: {
          ...typo.bodySmall,
          fontFamily: monoFamily,
          color: colors.foreground,
          backgroundColor: colors.codeBlockBg,
          borderRadius: radius.md,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xs,
        },
        web: { backgroundColor: 'transparent' },
      }),
    [colors, typo],
  );

  // 正文字号跟随聊天排版档位（typography.body 恒带 fontSize）
  const bodyFontSize = typo.body.fontSize!;
  const html = useMemo(
    () => (mathml ? buildMathHtml(mathml, colors, bodyFontSize) : ''),
    [mathml, colors, bodyFontSize],
  );

  // 未渲染完 / 渲染失败：都退回等宽源码，保证内容不丢
  if (failed || !mathml) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.source} testID="math-block-source">
          {tex}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { height }]} testID="math-block">
      <WebView
        source={{ html }}
        style={styles.web}
        originWhitelist={['about:blank']}
        javaScriptEnabled
        allowFileAccess={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        onShouldStartLoadWithRequest={(request) => request.url === 'about:blank'}
        scrollEnabled={false}
        setSupportMultipleWindows={false}
        onMessage={(event) => {
          const next = Number(event.nativeEvent.data);
          if (Number.isFinite(next)) {
            setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(next))));
          }
        }}
      />
    </View>
  );
}
