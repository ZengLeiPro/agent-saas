import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useColors, spacing, typography, radius } from '../theme';
import type { ThemeColors } from '../theme';

interface Props {
  children: ReactNode;
  fallbackMessage?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    appFallback: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: spacing['2xl'],
      backgroundColor: colors.background,
    },
    appTitle: {
      ...typography.title,
      color: colors.foreground,
      marginBottom: spacing.md,
    },
    appError: {
      ...typography.caption,
      color: colors.mutedForeground,
      textAlign: 'center',
      marginBottom: spacing.xl,
    },
    restartBtn: {
      backgroundColor: colors.primary,
      paddingHorizontal: spacing['2xl'],
      paddingVertical: spacing.md,
      borderRadius: radius.lg,
    },
    restartText: {
      ...typography.subtitle,
      color: colors.primaryForeground,
    },
    msgFallback: {
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      marginVertical: spacing.xs,
      backgroundColor: colors.secondary,
      borderRadius: radius.md,
    },
    msgError: {
      ...typography.caption,
      color: colors.destructive,
    },
  });
}

interface InternalProps extends Props {
  colors: ThemeColors;
}

/** App-level error boundary with restart button */
class AppErrorBoundaryInner extends Component<InternalProps, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('AppErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    const styles = createStyles(this.props.colors);
    if (this.state.hasError) {
      return (
        <View style={styles.appFallback}>
          <Text style={styles.appTitle}>出错了</Text>
          <Text style={styles.appError} numberOfLines={4}>
            {this.state.error?.message}
          </Text>
          <TouchableOpacity
            style={styles.restartBtn}
            onPress={() => this.setState({ hasError: false, error: null })}
          >
            <Text style={styles.restartText}>重试</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

export function AppErrorBoundary({ children, fallbackMessage }: Props) {
  const colors = useColors();
  return (
    <AppErrorBoundaryInner colors={colors} fallbackMessage={fallbackMessage}>
      {children}
    </AppErrorBoundaryInner>
  );
}

/** Lightweight error boundary for wrapping individual messages */
class MessageErrorBoundaryInner extends Component<InternalProps, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('MessageErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    const styles = createStyles(this.props.colors);
    if (this.state.hasError) {
      return (
        <View style={styles.msgFallback}>
          <Text style={styles.msgError}>
            {this.props.fallbackMessage || '消息渲染失败'}
          </Text>
        </View>
      );
    }
    return this.props.children;
  }
}

export function MessageErrorBoundary({ children, fallbackMessage }: Props) {
  const colors = useColors();
  return (
    <MessageErrorBoundaryInner colors={colors} fallbackMessage={fallbackMessage}>
      {children}
    </MessageErrorBoundaryInner>
  );
}
