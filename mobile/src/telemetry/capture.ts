import { useEffect } from 'react';
import { AppState } from 'react-native';
import { configureMobileTelemetry, installTelemetryAppState, telemetryClient } from './runtime';
import { EventLoopAnrWatchdog } from './anrWatchdog';

const processStartedAt = globalThis.performance?.now?.() ?? Date.now();
let startupEmitted = false;
let screenReadyEmitted = false;
let globalHandlersInstalled = false;

interface ErrorUtilsLike {
  getGlobalHandler?: () => (error: Error, isFatal?: boolean) => void;
  setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
}

function stackFrames(
  error: Error,
): Array<{ moduleHash: string; inApp: boolean; line?: number; column?: number }> {
  const client = telemetryClient();
  if (!client) return [];
  return String(error.stack ?? '')
    .split('\n')
    .slice(1, 65)
    .map((line) => {
      const match = line.match(/(?:at\s+)?(?:[^ (]+\s+\()?(.+?):(\d+):(\d+)\)?$/);
      const module = match?.[1]?.split(/[\\/]/).slice(-2).join('/') || 'unknown-module';
      return {
        moduleHash: client.pseudonym(module),
        inApp: !/node_modules|react-native/.test(module),
        ...(match ? { line: Number(match[2]), column: Number(match[3]) } : {}),
      };
    });
}

export function captureJsCrash(error: Error, correlationId = 'js-crash'): void {
  const stack = stackFrames(error);
  if (!stack.length)
    stack.push({
      moduleHash: telemetryClient()?.pseudonym('unknown-module') ?? `h1:${'0'.repeat(64)}`,
      inApp: false,
    });
  telemetryClient()?.capture('crash_js', { correlationId, stack });
}

export function installGlobalJsFatalCapture(): () => void {
  if (globalHandlersInstalled) return () => undefined;
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (!errorUtils?.setGlobalHandler) return () => undefined;
  const previous = errorUtils.getGlobalHandler?.();
  errorUtils.setGlobalHandler((error, isFatal) => {
    captureJsCrash(error, isFatal ? 'global-js-fatal' : 'global-js-error');
    previous?.(error, isFatal);
  });
  globalHandlersInstalled = true;
  return () => {
    if (previous) errorUtils.setGlobalHandler?.(previous);
    globalHandlersInstalled = false;
  };
}

export function useMobileTelemetry(owner: { tenantId: string; userId: string } | null): void {
  useEffect(() => {
    let cancelled = false;
    let cleanupState: () => void = () => undefined;
    let cleanupFatal: () => void = () => undefined;
    const watchdog = new EventLoopAnrWatchdog({
      isForeground: () => AppState.currentState === 'active',
      isDebuggerAttached: () =>
        globalThis.__MOBILE_TELEMETRY_BRIDGE__?.isDebuggerAttached?.() ?? false,
      emit: (durationMs) =>
        telemetryClient()?.capture('anr', {
          correlationId: 'event-loop-anr',
          measurements: { durationMs, foreground: true },
        }),
    });
    void configureMobileTelemetry(owner).then((client) => {
      if (cancelled || !client) return;
      cleanupState = installTelemetryAppState();
      cleanupFatal = installGlobalJsFatalCapture();
      watchdog.start();
      if (!screenReadyEmitted) {
        screenReadyEmitted = true;
        client.capture('screen_ready', {
          correlationId: 'screen-root',
          measurements: {
            durationMs: Math.max(
              0,
              (globalThis.performance?.now?.() ?? Date.now()) - processStartedAt,
            ),
          },
        });
      }
      if (!startupEmitted) {
        startupEmitted = true;
        client.capture('startup', {
          correlationId: 'app-startup',
          measurements: {
            durationMs: Math.max(
              0,
              (globalThis.performance?.now?.() ?? Date.now()) - processStartedAt,
            ),
            cold: true,
          },
        });
      }
      void client.flush();
    });
    return () => {
      cancelled = true;
      watchdog.stop();
      cleanupState();
      cleanupFatal();
      if (!owner) void configureMobileTelemetry(null);
    };
  }, [owner?.tenantId, owner?.userId]);
}

export function useTelemetryScreenReady(screen = 'root'): void {
  useEffect(() => {
    if (screenReadyEmitted) return;
    screenReadyEmitted = true;
    telemetryClient()?.capture('screen_ready', {
      correlationId: `screen-${screen}`,
      measurements: {
        durationMs: Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - processStartedAt),
      },
    });
  }, [screen]);
}
