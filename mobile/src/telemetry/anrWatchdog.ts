export interface AnrWatchdogOptions {
  thresholdMs?: number;
  intervalMs?: number;
  now?: () => number;
  isForeground: () => boolean;
  isDebuggerAttached: () => boolean;
  emit: (durationMs: number) => void;
}

/** Event-loop watchdog with lifecycle/debugger policy injected by the native adapter. */
export class EventLoopAnrWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expected = 0;
  private readonly thresholdMs: number;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AnrWatchdogOptions) {
    this.thresholdMs = options.thresholdMs ?? 5_000;
    this.intervalMs = options.intervalMs ?? 500;
    this.now = options.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.expected = this.now() + this.intervalMs;
    const tick = () => {
      const current = this.now();
      const delay = Math.max(0, current - this.expected);
      if (
        this.options.isForeground() &&
        !this.options.isDebuggerAttached() &&
        delay >= this.thresholdMs
      ) {
        this.options.emit(delay);
      }
      this.expected = current + this.intervalMs;
      this.timer = setTimeout(tick, this.intervalMs);
    };
    this.timer = setTimeout(tick, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
