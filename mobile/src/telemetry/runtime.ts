import { AppState, Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import {
  createReleasePseudonymizer,
  type MobileTelemetryBatch,
  type MobileTelemetryRelease,
} from '@agent/shared';
import { authFetch } from '@agent/shared';
import { mobileStorage } from '../platform/mobileStorage';
import { MobileTelemetryClient } from './telemetryClient';

export interface NativeCrashFrame {
  module: string;
  inApp: boolean;
  line?: number;
  column?: number;
}

/** Provider-neutral native side contract. Implemented by a reviewed native adapter, never a vendor SDK here. */
export interface MobileTelemetryNativeBridge {
  getExternalSecrets(): Promise<{ pseudonymKey: string; intakeSigningKey: string } | null>;
  installNativeCrashHandler?(handler: (frames: NativeCrashFrame[]) => void): () => void;
  isDebuggerAttached?(): boolean;
  excludeBufferFromBackup?(namespace: string): Promise<void>;
}

declare global {
  // Intentionally injected by native/release configuration. No DSN or secret is compiled here.
  var __MOBILE_TELEMETRY_BRIDGE__: MobileTelemetryNativeBridge | undefined;
}

function keyedDigest(key: string, value: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(key), utf8ToBytes(value)));
}

function signingDigest(key: string, body: string): string {
  return bytesToHex(hmac(sha256, utf8ToBytes(key), utf8ToBytes(body)));
}

function releaseFacts(): MobileTelemetryRelease | null {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const manifest = extra?.releaseManifest as Record<string, unknown> | undefined;
  const commit = manifest?.sourceGitSha;
  const profile = manifest?.profile;
  const build =
    Platform.OS === 'ios' ? Application.nativeBuildVersion : Application.nativeApplicationVersion;
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) return null;
  if (profile !== 'development' && profile !== 'preview' && profile !== 'production') return null;
  if (!Application.nativeApplicationVersion || !build) return null;
  return { commit, profile, appVersion: Application.nativeApplicationVersion, build };
}

let activeClient: MobileTelemetryClient | null = null;
let activeOwner = '';
let detachNativeCrash: (() => void) | undefined;
let signingKey = '';
let appStateTransitionAt = globalThis.performance?.now?.() ?? Date.now();

function secureSessionCorrelation(): string {
  return (
    (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID?.() ??
    'secure-random-unavailable'
  );
}

export function telemetryClient(): MobileTelemetryClient | null {
  return activeClient;
}

export async function configureMobileTelemetry(
  owner: { tenantId: string; userId: string } | null,
): Promise<MobileTelemetryClient | null> {
  const nextOwner = owner ? `${owner.tenantId}:${owner.userId}` : '';
  if (!owner) {
    if (activeClient) await activeClient.clearOwner().catch(() => undefined);
    activeClient = null;
    activeOwner = '';
    signingKey = '';
    detachNativeCrash?.();
    detachNativeCrash = undefined;
    return null;
  }
  if (activeClient && activeOwner === nextOwner) return activeClient;
  if (activeClient) await activeClient.clearOwner().catch(() => undefined);
  const bridge = globalThis.__MOBILE_TELEMETRY_BRIDGE__;
  const release = releaseFacts();
  if (!bridge || !release) return null;
  const secrets = await bridge.getExternalSecrets().catch(() => null);
  if (!secrets) return null;
  try {
    const pseudonymizer = createReleasePseudonymizer({
      releaseCommit: release.commit,
      profile: release.profile,
      externalKey: secrets.pseudonymKey,
      keyedDigest,
    });
    signingKey = secrets.intakeSigningKey;
    const client = new MobileTelemetryClient({
      storage: mobileStorage,
      pseudonymizer,
      owner,
      release,
      runtime: { deviceClass: 'unknown', os: Platform.OS === 'android' ? 'android' : 'ios' },
      transport: {
        async send(batch: MobileTelemetryBatch) {
          const body = JSON.stringify(batch);
          const response = await authFetch('/api/mobile/telemetry', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Telemetry-Signature': `v1=${signingDigest(signingKey, body)}`,
              'X-Telemetry-Release': release.commit,
              'Idempotency-Key': batch.batchId,
            },
            body,
          });
          const receipt = (await response.json().catch(() => ({}))) as { receiptId?: string };
          return {
            accepted: response.ok,
            ...(receipt.receiptId ? { receiptId: receipt.receiptId } : {}),
          };
        },
      },
    });
    await bridge.excludeBufferFromBackup?.(client.bufferKey).catch(() => undefined);
    activeClient = client;
    activeOwner = nextOwner;
    detachNativeCrash?.();
    detachNativeCrash = bridge.installNativeCrashHandler?.((frames) => {
      const stack = frames.slice(0, 64).map((frame) => ({
        moduleHash: pseudonymizer.pseudonym(frame.module),
        inApp: frame.inApp,
        ...(frame.line !== undefined ? { line: frame.line } : {}),
        ...(frame.column !== undefined ? { column: frame.column } : {}),
      }));
      client.capture('crash_native', { correlationId: 'native-crash', stack });
    });
    client.capture('session_start', { correlationId: secureSessionCorrelation() });
    return client;
  } catch {
    return null;
  }
}

export function installTelemetryAppState(): () => void {
  const subscription = AppState.addEventListener('change', (state) => {
    const transitionAt = globalThis.performance?.now?.() ?? Date.now();
    appStateTransitionAt = transitionAt;
    const client = activeClient;
    if (!client) return;
    const foreground = state === 'active';
    client.setForeground(foreground);
    if (foreground) {
      setTimeout(() => {
        if (appStateTransitionAt !== transitionAt) return;
        client.capture('startup', {
          correlationId: secureSessionCorrelation(),
          measurements: {
            durationMs: Math.max(0, (globalThis.performance?.now?.() ?? Date.now()) - transitionAt),
            cold: false,
          },
        });
      }, 0);
      void client.flush();
    }
  });
  return () => subscription.remove();
}
