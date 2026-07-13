import React, { useMemo } from 'react';
import { Modal, View, Text, Pressable, StyleSheet, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { WebView } from 'react-native-webview';
import { marked } from 'marked';
import { useColors, typography, spacing } from '../../theme';
import { useFontSize } from '../../theme';
import type { ThemeColors } from '../../theme';

interface TextSelectModalProps {
  visible: boolean;
  onClose: () => void;
  content: string;
}

export function TextSelectModal({ visible, onClose, content }: TextSelectModalProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { scale } = useFontSize();

  const html = useMemo(() => {
    if (!content) return '';
    const rendered = marked.parse(content, { breaks: true }) as string;
    return buildHtml(rendered, colors, scale);
  }, [content, colors, scale]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.card,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      paddingTop: Platform.OS === 'android' ? insets.top + spacing.sm : spacing.sm,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerSpacer: {
      width: 32,
    },
    headerTitle: {
      ...typography.subtitle,
      color: colors.foreground,
      flex: 1,
      textAlign: 'center',
    },
    closeButton: {
      width: 32,
      alignItems: 'flex-end' as const,
      padding: 4,
    },
  }), [colors, insets.top]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
      onRequestClose={onClose}
      statusBarTranslucent={Platform.OS === 'android'}
    >
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerSpacer} />
          <Text style={styles.headerTitle}>选择文本</Text>
          <Pressable onPress={onClose} style={styles.closeButton} hitSlop={8}>
            <X size={24} color={colors.foreground} strokeWidth={2} />
          </Pressable>
        </View>
        <WebView
          source={{ html }}
          style={{ flex: 1, backgroundColor: colors.card }}
          originWhitelist={['*']}
          scrollEnabled
        />
      </View>
    </Modal>
  );
}

function buildHtml(bodyHtml: string, colors: ThemeColors, fontScale: number): string {
  const baseFontSize = Math.round(15 * fontScale);
  const monoFontSize = Math.round(13 * fontScale);
  const h1Size = Math.round(20 * fontScale);
  const h2Size = Math.round(16 * fontScale);
  const smallSize = Math.round(13 * fontScale);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: ${baseFontSize}px;
  line-height: 1.6;
  color: ${colors.foreground};
  background: ${colors.card};
  padding: 16px;
  -webkit-user-select: text;
  user-select: text;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
h1 { font-size: ${h1Size}px; font-weight: 600; margin: 12px 0; }
h2 { font-size: ${h2Size}px; font-weight: 600; margin: 12px 0; }
h3 { font-size: ${baseFontSize}px; font-weight: 600; margin: 10px 0; }
p { margin: 10px 0; }
a { color: ${colors.link}; text-decoration: none; }
strong { font-weight: 600; }
em { font-style: italic; }
code {
  font-family: Menlo, 'Courier New', monospace;
  font-size: ${monoFontSize}px;
  background: ${colors.muted};
  padding: 1px 4px;
  border-radius: 3px;
}
pre {
  background: ${colors.codeBlockBg};
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 8px 0;
  -webkit-overflow-scrolling: touch;
}
pre code {
  background: none;
  padding: 0;
  font-size: ${monoFontSize}px;
  line-height: 1.5;
  white-space: pre;
}
blockquote {
  border-left: 3px solid ${colors.borderStrong};
  background: ${colors.secondary};
  padding: 8px 12px;
  margin: 8px 0;
  border-radius: 4px;
}
ul, ol { margin: 10px 0; padding-left: 24px; }
li { margin: 4px 0; }
hr { border: none; height: 1px; background: ${colors.border}; margin: 16px 0; }
table {
  border-collapse: collapse;
  margin: 8px 0;
  width: 100%;
  display: block;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
th, td {
  border: 1px solid ${colors.borderStrong};
  padding: 6px 8px;
  font-size: ${smallSize}px;
  text-align: left;
  white-space: nowrap;
}
th {
  background: ${colors.secondary};
  font-weight: 600;
}
img { max-width: 100%; border-radius: 8px; margin: 4px 0; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}
