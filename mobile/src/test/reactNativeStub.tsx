/**
 * vitest 用的 react-native stub（仅测试环境加载，见 vitest.config.ts）。
 *
 * 目的：react-native 的 Flow 入口（`import typeof ...`）无法被
 * Vite/Rollup 解析，导致任何真实 import RN 组件的测试无法加载。
 * 这里提供最小 DOM 实现，让应用组件可在 jsdom 中渲染；
 * 具体行为断言由各测试文件的 vi.mock 精确控制（本 stub 不参与断言）。
 */
import React from 'react';

type Props = { children?: React.ReactNode; testID?: string };

const make =
  (tag: string) =>
  ({ children, testID }: Props) =>
    React.createElement(tag, { 'data-testid': testID ?? undefined }, children);

export const View = make('div');
export const Text = make('span');
export const Pressable = make('button');
export const TouchableOpacity = make('button');
export const TouchableHighlight = make('button');
export const TouchableWithoutFeedback = make('button');
export const ScrollView = make('div');
export const FlatList = make('div');
export const ActivityIndicator = make('div');
export const Switch = make('button');
export const TextInput = make('input');
export const Image = make('img');
export const Modal = make('div');
export const RefreshControl = make('div');
export const KeyboardAvoidingView = make('div');
export const SafeAreaView = make('div');
export const StatusBar = () => null;
export const SectionList = make('div');
export const VirtualizedList = make('div');

export const StyleSheet = {
  create: <T,>(styles: T): T => styles,
  hairlineWidth: 1 as const,
  absoluteFillObject: { position: 'absolute' as const, top: 0, left: 0, right: 0, bottom: 0 },
  flatten: (style: unknown) => style,
};

export const Alert = {
  alert: (..._args: unknown[]) => undefined,
};

export const Linking = {
  openURL: async (..._args: unknown[]) => undefined,
  canOpenURL: async () => false,
  getInitialURL: async () => null as string | null,
  addEventListener: () => ({ remove: () => undefined }),
};

export const Platform = {
  OS: 'ios' as const,
  select: <T,>(obj: Record<string, T>) => obj.ios,
};

export const Dimensions = {
  get: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
  addEventListener: () => ({ remove: () => undefined }),
  removeEventListener: () => undefined,
};

export const AppState = {
  addEventListener: () => ({ remove: () => undefined }),
  removeEventListener: () => undefined,
};

export const InteractionManager = {
  runAfterInteractions: async (cb?: () => unknown) => (cb ? cb() : undefined),
};

export const BackHandler = {
  addEventListener: () => ({ remove: () => undefined }),
  removeEventListener: () => undefined,
};

export const Appearance = {
  getColorScheme: () => 'light' as const,
  addChangeListener: () => ({ remove: () => undefined }),
};

export default {
  View,
  Text,
  Pressable,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  Alert,
  Linking,
  Platform,
  Dimensions,
};
