import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Linking, Pressable, TouchableOpacity, Alert } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { DropdownMenu, type DropdownSection } from '../../src/components/overlays/DropdownMenu';
import { BackButton } from '../../src/components/BackButton';
import * as Clipboard from 'expo-clipboard';
import { WebView } from 'react-native-webview';
import { getPlatform } from '@agent/shared';
import { fileCacheService } from '../../src/services/fileCacheService';
import { getPreviewToken } from '../../src/services/previewTokenCache';
import { useColors, typography } from '../../src/theme';
import { glassFree } from '../../src/lib/headerItems';

export default function HtmlPreviewScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { filePath, owner, root } = useLocalSearchParams<{ filePath: string; owner?: string; root?: string }>();
  const isRootMode = root === 'true';

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [serverOrigin, setServerOrigin] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fileName = filePath ? filePath.split('/').pop() || filePath : '';
  const dirPath = filePath && filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';

  const handleDownload = useCallback(async () => {
    if (!filePath) return;
    try {
      const { openOrShareFile } = await import('../../src/utils/openOrShareFile');
      const uri = await fileCacheService.getOrDownload(filePath, 0, 0, owner, isRootMode || undefined);
      await openOrShareFile(uri);
    } catch (err: any) {
      Alert.alert('下载失败', err?.message || String(err));
    }
  }, [filePath, fileName, owner, isRootMode]);

  const [headerMenuVisible, setHeaderMenuVisible] = useState(false);
  const [headerMenuAnchor, setHeaderMenuAnchor] = useState(0);
  const headerMenuTriggerRef = useRef<View>(null);

  const handleOpenHeaderMenu = useCallback(() => {
    headerMenuTriggerRef.current?.measureInWindow((_x, y, _w, h) => {
      setHeaderMenuAnchor(y + h);
      setHeaderMenuVisible(true);
    });
  }, []);

  const menuSections = useMemo<DropdownSection[]>(() => [{
    id: 'actions',
    actions: [
      { id: 'copy-path', label: '复制路径' },
      { id: 'download', label: '下载' },
    ],
  }], []);

  const handleMenuSelect = useCallback(async (actionId: string) => {
    switch (actionId) {
      case 'copy-path':
        await Clipboard.setStringAsync(filePath || '');
        break;
      case 'download':
        await handleDownload();
        break;
    }
  }, [filePath, handleDownload]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    centered: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: 12,
    },
    errorText: {
      ...typography.body,
      color: colors.mutedForeground,
    },
  }), [colors]);

  useEffect(() => {
    if (!filePath) {
      setError('未提供文件路径');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    getPreviewToken(owner, isRootMode || undefined)
      .then((token) => {
        if (cancelled) return;
        const platform = getPlatform();
        const baseUrl = platform.platformConfig.getBaseUrl();
        setServerOrigin(baseUrl);
        const encodedPath = filePath.split('/').map(s => encodeURIComponent(s)).join('/');
        setPreviewUrl(`${baseUrl}/preview/${token}/${encodedPath}`);
      })
      .catch((err) => {
        if (cancelled) return;
        setError((err as Error).message || '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [filePath, owner, isRootMode]);

  // 注入 JS：删除 RN bridge，防止 HTML 内 JS 访问原生层
  const injectedJS = `
    (function() {
      try {
        delete window.ReactNativeWebView;
        Object.defineProperty(window, 'ReactNativeWebView', { value: undefined, writable: false, configurable: false });
      } catch(e) {}
    })();
    true;
  `;

  return (
    <View style={styles.container}>
      <Stack.Screen options={{
        title: fileName,
        headerLeft: () => <BackButton />,
        unstable_headerLeftItems: () => [glassFree(
          <BackButton />
        )],
        headerRight: () => (
          <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu} hitSlop={8}>
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.foreground} />
          </Pressable>
        ),
        unstable_headerRightItems: () => [glassFree(
          <Pressable ref={headerMenuTriggerRef} onPress={handleOpenHeaderMenu} hitSlop={8}>
            <Ionicons name="ellipsis-horizontal" size={22} color={colors.foreground} />
          </Pressable>
        )],
      }} />

      {loading && (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      )}

      {error && (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {!loading && !error && previewUrl !== null && (
        <WebView
          source={{ uri: previewUrl }}
          style={{ flex: 1, backgroundColor: colors.background }}
          originWhitelist={['https://*', 'http://*']}
          javaScriptEnabled={true}
          injectedJavaScriptBeforeContentLoaded={injectedJS}
          onShouldStartLoadWithRequest={(request) => {
            // 允许预览端点的请求（同服务器 /preview/ 路径）
            if (serverOrigin && request.url.startsWith(`${serverOrigin}/preview/`)) return true;
            // 允许 data: URI
            if (request.url.startsWith('data:')) return true;
            // 允许 about:blank
            if (request.url === 'about:blank') return true;
            // 高德地图链接：优先唤起 App，失败则 Safari 打开
            if (request.url.includes('uri.amap.com/marker')) {
              try {
                const pos = new URL(request.url).searchParams.get('position');
                if (pos) {
                  const [lng, lat] = pos.split(',');
                  const nativeUrl = `iosamap://viewMap?sourceApplication=album&poiname=Photo&lat=${lat}&lon=${lng}&dev=0`;
                  void Linking.openURL(nativeUrl).catch(() => Linking.openURL(request.url));
                  return false;
                }
              } catch { /* fall through */ }
            }
            // 外部链接用系统浏览器打开
            void Linking.openURL(request.url);
            return false;
          }}
          allowFileAccess={false}
          allowUniversalAccessFromFileURLs={false}
          mediaPlaybackRequiresUserAction={true}
          scrollEnabled={true}
          startInLoadingState={true}
          renderLoading={() => (
            <View style={[styles.centered, StyleSheet.absoluteFill, { backgroundColor: colors.background }]}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          )}
          onError={(e) => setError(e.nativeEvent.description)}
        />
      )}

      {/* Header dropdown menu */}
      <DropdownMenu
        visible={headerMenuVisible}
        onClose={() => setHeaderMenuVisible(false)}
        sections={menuSections}
        onSelect={handleMenuSelect}
        anchorTop={headerMenuAnchor}
        align="right"
      />
    </View>
  );
}
