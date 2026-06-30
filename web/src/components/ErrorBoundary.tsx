import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 自定义 fallback UI；不提供则使用默认全屏/行内 fallback */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** 行内模式：用于包裹单条消息等局部组件，fallback 更紧凑 */
  inline?: boolean;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { fallback, inline } = this.props;

    if (typeof fallback === "function") return fallback(error, this.reset);
    if (fallback !== undefined) return fallback;

    if (inline) {
      return (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <span>渲染出错</span>
          <button
            onClick={this.reset}
            className="ml-2 underline hover:no-underline"
          >
            重试
          </button>
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="text-4xl">:(</div>
        <h2 className="text-lg font-medium text-foreground">应用发生错误</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {error.message}
        </p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
        >
          刷新页面
        </button>
      </div>
    );
  }
}
