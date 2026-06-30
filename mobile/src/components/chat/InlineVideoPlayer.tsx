import React, { useState, useMemo } from 'react';
import { View, StyleSheet, Dimensions, ActivityIndicator } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { resolveImageSrc } from '@agent/shared';
import { useColors, radius } from '../../theme';

const VIDEO_MAX_WIDTH = Dimensions.get('window').width - 48;
const VIDEO_HEIGHT = Math.round(VIDEO_MAX_WIDTH * 9 / 16);

interface InlineVideoPlayerProps {
  src: string;
  owner?: string;
}

export function InlineVideoPlayer({ src, owner }: InlineVideoPlayerProps) {
  const colors = useColors();
  const [resolvedUri, setResolvedUri] = useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    resolveImageSrc(src, owner)
      .then(uri => { if (!cancelled) setResolvedUri(uri); })
      .catch(() => { if (!cancelled) setResolvedUri(src); });
    return () => { cancelled = true; };
  }, [src, owner]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      width: VIDEO_MAX_WIDTH,
      height: VIDEO_HEIGHT,
      borderRadius: radius.md,
      overflow: 'hidden',
      backgroundColor: colors.codeBlockBg,
      marginVertical: 4,
    },
    loading: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: 'center',
      alignItems: 'center',
    },
  }), [colors]);

  if (!resolvedUri) {
    return (
      <View style={styles.container}>
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={colors.primary} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <VideoPlayerInner uri={resolvedUri} />
    </View>
  );
}

/** Separate component so useVideoPlayer hook is only called once URI is resolved */
function VideoPlayerInner({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
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
