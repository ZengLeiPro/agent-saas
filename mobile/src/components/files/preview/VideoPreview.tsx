/**
 * 视频预览 —— `expo-video` 内联播放，与聊天里的 `InlineVideoPlayer` 同一套播放器，
 * 只是铺满预览页而不是限定在气泡宽度内。
 */
import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useColors, radius, spacing } from '../../../theme';

export interface VideoPreviewProps {
  /** 已解析好的播放地址（工作区鉴权 URL 或本地缓存 file://） */
  uri: string | null;
}

export function VideoPreview({ uri }: VideoPreviewProps) {
  const colors = useColors();
  const containerStyle = useMemo(
    () => [styles.container, { backgroundColor: colors.codeBlockBg }],
    [colors.codeBlockBg],
  );

  if (!uri) {
    return (
      <View style={[styles.fill, styles.center]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.fill, styles.center]} testID="video-preview">
      <View style={containerStyle}>
        <VideoPlayerSurface uri={uri} />
      </View>
    </View>
  );
}

/** 独立子组件：确保 useVideoPlayer 只在拿到 uri 后调用一次 */
function VideoPlayerSurface({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = false;
  });
  return (
    <VideoView
      player={player}
      style={StyleSheet.absoluteFill}
      nativeControls
      contentFit="contain"
      fullscreenOptions={{ enable: true }}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  container: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginHorizontal: spacing.md,
  },
});
